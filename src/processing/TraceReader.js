import fs from 'fs';
import path from 'path';
import zlib from 'zlib';
import { promisify } from 'util';
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import DataExtractor from '../ingestion/DataExtractor.js';
import ExtractedTraceData from '../extraction/ExtractedTraceData.js';
import logger from '../utils/logger.js';
import { describeAwsError } from '../utils/awsErrorUtils.js';

const gunzip = promisify(zlib.gunzip);

/**
 * Reads and parses trace files from S3 tar archives
 * 
 * Trace files are organized in subdirectories by last 2 hex digits of ICAO:
 *   traces/d0/trace_full_<icao>.json
 *   traces/d1/trace_full_<icao>.json
 *   ...
 *   traces/ff/trace_full_<icao>.json
 * 
 * Each trace file contains position reports for a single aircraft on that day.
 */
class TraceReader {
  constructor(config = {}) {
    // Get temp directory from config, env, or default
    let tempDir = config.tempDir || process.env.TEMP_DIR || './temp';
    
    // Convert relative paths to absolute
    if (!path.isAbsolute(tempDir)) {
      tempDir = path.resolve(process.cwd(), tempDir);
    }
    
    this.tempDir = tempDir;
    this.bucketName = config.bucketName || process.env.S3_BUCKET_NAME || 'ayryx-adsb-history';
    this.region = config.region || process.env.AWS_REGION || 'us-west-1';
    
    // Ensure temp directory exists and is writable
    try {
      if (!fs.existsSync(this.tempDir)) {
        fs.mkdirSync(this.tempDir, { recursive: true, mode: 0o755 });
        logger.info('Created temp directory', { path: this.tempDir });
      }
      
      // Test write permissions
      const testFile = path.join(this.tempDir, '.test-write');
      fs.writeFileSync(testFile, 'test');
      fs.unlinkSync(testFile);
    } catch (error) {
      logger.error('Failed to create or verify temp directory', {
        path: this.tempDir,
        error: error.message,
      });
      throw new Error(`Cannot use temp directory ${this.tempDir}: ${error.message}`);
    }
    
    this.extractor = new DataExtractor({ tempDir: this.tempDir });
    this.extractedTraceData = new ExtractedTraceData(config);
    
    // Initialize S3 client
    // Don't set credentials - let SDK use default credential chain
    // This will automatically use instance profile on EC2
    const clientConfig = { region: this.region };
    
    // Only set explicit credentials if provided (for local development)
    // Otherwise, SDK will use default chain: env vars -> credentials file -> instance metadata
    if (process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY) {
      clientConfig.credentials = {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
      };
    }
    // If no explicit credentials, SDK will automatically use instance profile on EC2
    
    this.s3Client = new S3Client(clientConfig);
  }

  /**
   * Get S3 key for a date's tar file
   */
  getTarS3Key(date) {
    const [year, month, day] = date.split('-');
    // Note: The filename uses dots (v2025.11.08) not dashes
    const dateWithDots = `${year}.${month}.${day}`;
    return `raw/${year}/${month}/${day}/v${dateWithDots}-planes-readsb-prod-0.tar`;
  }

  /**
   * Download tar file from S3 to local temp directory
   */
  async downloadTarFromS3(date) {
    const s3Key = this.getTarS3Key(date);
    const localTarPath = path.join(this.tempDir, date, `${date}.tar`);

    // Create directory if needed
    const dirPath = path.dirname(localTarPath);
    if (!fs.existsSync(dirPath)) {
      fs.mkdirSync(dirPath, { recursive: true, mode: 0o755 });
    }

    // Check if already downloaded
    if (fs.existsSync(localTarPath)) {
      logger.info('Tar file already downloaded', { date, path: localTarPath });
      return localTarPath;
    }

    logger.info('Downloading tar from S3', { date, s3Key });

    try {
      const command = new GetObjectCommand({
        Bucket: this.bucketName,
        Key: s3Key,
      });

      const response = await this.s3Client.send(command);
      const writeStream = fs.createWriteStream(localTarPath);

      await new Promise((resolve, reject) => {
        response.Body.pipe(writeStream);
        writeStream.on('finish', resolve);
        writeStream.on('error', reject);
      });

      const stats = fs.statSync(localTarPath);
      logger.info('Downloaded tar from S3', {
        date,
        size: `${(stats.size / 1024 / 1024 / 1024).toFixed(2)} GB`,
        path: localTarPath,
      });

      return localTarPath;
    } catch (error) {
      const details = describeAwsError(error);
      logger.error('Failed to download tar from S3', {
        date,
        s3Key,
        error: details,
      });
      console.error(`[TraceReader] Failed to download ${s3Key}: ${details}`);
      error.message = details;
      throw error;
    }
  }

  /**
   * Extract tar file and return extraction directory
   */
  async extractTar(tarPath) {
    const extractDir = path.join(path.dirname(tarPath), 'extracted');
    
    if (fs.existsSync(extractDir)) {
      logger.debug('Tar already extracted', { extractDir });
      return extractDir;
    }

    logger.debug('Extracting tar', { tarPath });
    return await this.extractor.extractTar(tarPath, extractDir);
  }

  /**
   * Download extracted traces for an airport from S3
   * Returns the path to the extracted directory, or null if not found
   */
  async downloadExtractedTraces(airport, date) {
    const localTarPath = path.join(this.tempDir, 'extracted', airport, date, `${airport}-${date}.tar`);
    const extractDir = path.join(path.dirname(localTarPath), 'extracted');

    if (fs.existsSync(extractDir)) {
      logger.debug('Extracted traces already available', { airport, date });
      return extractDir;
    }

    const tarPath = await this.extractedTraceData.download(airport, date, localTarPath);
    
    if (!tarPath) {
      return null;
    }

    logger.info('Extracting airport traces', { airport, date });
    return await this.extractTar(tarPath);
  }

  /**
   * Read a single trace file and parse it
   * Note: Files have .json extension but are actually gzipped
   * @param {string} tracePath - Path to trace JSON file
   * @returns {object} { icao, trace } - Parsed trace data
   */
  async readTraceFile(tracePath) {
    try {
      // Check file size first
      const stats = fs.statSync(tracePath);
      if (stats.size === 0) {
        logger.warn('Trace file is empty, skipping', {
          file: path.basename(tracePath),
          path: tracePath,
        });
        return null;
      }

      // Read gzipped data
      const gzippedData = fs.readFileSync(tracePath);
      
      // Validate minimum gzip size (gzip header is at least 10 bytes)
      if (gzippedData.length < 10) {
        logger.warn('Trace file too small to be valid gzip, skipping', {
          file: path.basename(tracePath),
          size: gzippedData.length,
        });
        return null;
      }
      
      // Decompress
      const decompressed = await gunzip(gzippedData);
      const jsonString = decompressed.toString('utf-8');
      
      // Parse JSON
      const data = JSON.parse(jsonString);
      
      // Extract ICAO from filename: trace_full_781ed0.json -> 781ed0
      const filename = path.basename(tracePath);
      const icao = filename.replace('trace_full_', '').replace('.json', '');
      
      // Extract the trace array from the data object
      // The file contains an object with metadata and a 'trace' property with the position array
      const traceArray = data.trace || (Array.isArray(data) ? data : []);
      
      // Extract aircraft metadata (registration, type, description)
      const registration = data.r || null;
      const aircraftType = data.t || null;
      const description = data.desc || null;
      
      return { 
        icao, 
        trace: traceArray,
        registration,
        aircraftType,
        description,
      };
    } catch (error) {
      // Provide more context in error message
      const stats = fs.existsSync(tracePath) ? fs.statSync(tracePath) : null;
      logger.error('Failed to read trace file', {
        file: path.basename(tracePath),
        error: error.message,
        size: stats?.size ?? 'unknown',
        errorType: error.name,
      });
      return null;
    }
  }

  /**
   * Stream all trace files from an extracted tar
   * @param {string} extractDir - Directory containing extracted traces
   * @yields {object} { icao, trace, hexSubdir } - Parsed trace data
   */
  async *streamAllTraces(extractDir) {
    const tracesDir = path.join(extractDir, 'traces');
    
    if (!fs.existsSync(tracesDir)) {
      logger.warn('No traces directory found', { extractDir });
      return;
    }

    // List trace subdirectories (d0, d1, ..., ff)
    const traceSubdirs = fs.readdirSync(tracesDir)
      .filter(name => {
        const fullPath = path.join(tracesDir, name);
        return fs.statSync(fullPath).isDirectory();
      })
      .sort();

    logger.debug('Streaming traces', {
      extractDir: path.basename(extractDir),
      subdirs: traceSubdirs.length,
    });

    for (const hexSubdir of traceSubdirs) {
      const subdirPath = path.join(tracesDir, hexSubdir);
      const files = fs.readdirSync(subdirPath)
        .filter(f => f.startsWith('trace_full_') && f.endsWith('.json'))
        .sort();

      for (const filename of files) {
        const filePath = path.join(subdirPath, filename);
        const result = await this.readTraceFile(filePath);
        
        if (result) {
          yield {
            ...result,
            hexSubdir,
          };
        }
      }
    }
  }

  /**
   * Stream traces filtered by ICAO codes (more efficient for targeted queries)
   * @param {string} extractDir - Directory containing extracted traces
   * @param {string[]} icaoCodes - List of ICAO codes to filter
   * @yields {object} { icao, trace, hexSubdir } - Parsed trace data
   */
  async *streamFilteredTraces(extractDir, icaoCodes) {
    const icaoSet = new Set(icaoCodes.map(code => code.toLowerCase()));
    const tracesDir = path.join(extractDir, 'traces');
    
    if (!fs.existsSync(tracesDir)) {
      logger.warn('No traces directory found', { extractDir });
      return;
    }

    logger.info('Streaming filtered traces', {
      extractDir: path.basename(extractDir),
      targetICAOs: icaoCodes.length,
    });

    // Group ICAOs by their hex subdir (last 2 characters)
    const icaosBySubdir = new Map();
    for (const icao of icaoCodes) {
      const hexSubdir = icao.toLowerCase().slice(-2);
      if (!icaosBySubdir.has(hexSubdir)) {
        icaosBySubdir.set(hexSubdir, []);
      }
      icaosBySubdir.get(hexSubdir).push(icao.toLowerCase());
    }

    // Only scan relevant subdirectories
    for (const [hexSubdir, icaos] of icaosBySubdir) {
      const subdirPath = path.join(tracesDir, hexSubdir);
      
      if (!fs.existsSync(subdirPath)) {
        continue;
      }

      for (const icao of icaos) {
        const filename = `trace_full_${icao}.json`;
        const filePath = path.join(subdirPath, filename);
        
        if (fs.existsSync(filePath)) {
          const result = await this.readTraceFile(filePath);
          if (result) {
            yield {
              ...result,
              hexSubdir,
            };
          }
        }
      }
    }
  }

  /**
   * Get a specific trace by ICAO from an extraction directory
   * @param {string} extractDir - Directory containing extracted traces
   * @param {string} icao - ICAO code to look up
   * @returns {object|null} Parsed trace data or null if not found
   */
  async getTraceByICAO(extractDir, icao) {
    const tracesDir = path.join(extractDir, 'traces');
    
    if (!fs.existsSync(tracesDir)) {
      return null;
    }

    const icaoLower = icao.toLowerCase();
    const hexSubdir = icaoLower.slice(-2);
    const filename = `trace_full_${icaoLower}.json`;
    const filePath = path.join(tracesDir, hexSubdir, filename);
    
    if (!fs.existsSync(filePath)) {
      return null;
    }

    return await this.readTraceFile(filePath);
  }

  /**
   * Get previous date string
   * @param {string} date - Date in YYYY-MM-DD format
   * @returns {string|null} Previous date or null if invalid
   */
  getPreviousDate(date) {
    try {
      const d = new Date(date + 'T00:00:00Z');
      d.setUTCDate(d.getUTCDate() - 1);
      return d.toISOString().split('T')[0];
    } catch (error) {
      return null;
    }
  }

  /**
   * Clean up extracted data for a date (keeps tar file for reuse)
   */
  cleanup(date) {
    const dateTempDir = path.join(this.tempDir, date);
    const extractDir = path.join(dateTempDir, 'extracted');
    
    try {
      // Only remove the extracted directory, keep the tar file
      if (fs.existsSync(extractDir)) {
        fs.rmSync(extractDir, { recursive: true, force: true });
        logger.info('Cleaned up extracted directory', { date, path: extractDir });
      }
      
      // Optionally remove the entire date directory if it's empty (tar already removed)
      // But we keep it if tar file exists for reuse
      const tarPath = path.join(dateTempDir, `${date}.tar`);
      if (!fs.existsSync(tarPath) && fs.existsSync(dateTempDir)) {
        // Only remove if tar doesn't exist and directory is empty
        try {
          const files = fs.readdirSync(dateTempDir);
          if (files.length === 0) {
            fs.rmdirSync(dateTempDir);
            logger.info('Removed empty date directory', { date, path: dateTempDir });
          }
        } catch (err) {
          // Directory not empty or other error, ignore
        }
      }
    } catch (error) {
      logger.error('Failed to cleanup extracted directory', {
        date,
        path: extractDir,
        error: error.message,
      });
    }
  }
}

export default TraceReader;

