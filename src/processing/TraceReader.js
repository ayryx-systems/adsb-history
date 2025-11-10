import fs from 'fs';
import path from 'path';
import zlib from 'zlib';
import { promisify } from 'util';
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import DataExtractor from '../ingestion/DataExtractor.js';
import logger from '../utils/logger.js';

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
    this.tempDir = config.tempDir || process.env.TEMP_DIR || './temp';
    this.bucketName = config.bucketName || process.env.S3_BUCKET_NAME || 'ayryx-adsb-history';
    this.region = config.region || process.env.AWS_REGION || 'us-west-1';
    this.extractor = new DataExtractor({ tempDir: this.tempDir });
    
    // Initialize S3 client
    const clientConfig = { region: this.region };
    if (process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY) {
      clientConfig.credentials = {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
      };
    }
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
      fs.mkdirSync(dirPath, { recursive: true });
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
      logger.error('Failed to download tar from S3', {
        date,
        s3Key,
        error: error.message,
      });
      throw error;
    }
  }

  /**
   * Extract tar file and return extraction directory
   */
  async extractTar(tarPath) {
    const extractDir = path.join(path.dirname(tarPath), 'extracted');
    
    if (fs.existsSync(extractDir)) {
      logger.info('Tar already extracted', { extractDir });
      return extractDir;
    }

    logger.info('Extracting tar', { tarPath });
    return await this.extractor.extractTar(tarPath, extractDir);
  }

  /**
   * Read a single trace file and parse it
   * Note: Files have .json extension but are actually gzipped
   * @param {string} tracePath - Path to trace JSON file
   * @returns {object} { icao, trace } - Parsed trace data
   */
  async readTraceFile(tracePath) {
    try {
      // Read gzipped data
      const gzippedData = fs.readFileSync(tracePath);
      
      // Decompress
      const decompressed = await gunzip(gzippedData);
      const jsonString = decompressed.toString('utf-8');
      
      // Parse JSON
      const data = JSON.parse(jsonString);
      
      // Extract ICAO from filename: trace_full_781ed0.json -> 781ed0
      const filename = path.basename(tracePath);
      const icao = filename.replace('trace_full_', '').replace('.json', '');
      
      return { icao, trace: data };
    } catch (error) {
      logger.error('Failed to read trace file', {
        file: path.basename(tracePath),
        error: error.message,
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

    logger.info('Streaming traces', {
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
   * Clean up downloaded and extracted data for a date
   */
  cleanup(date) {
    const dateTempDir = path.join(this.tempDir, date);
    
    try {
      if (fs.existsSync(dateTempDir)) {
        fs.rmSync(dateTempDir, { recursive: true, force: true });
        logger.info('Cleaned up date temp directory', { date, path: dateTempDir });
      }
    } catch (error) {
      logger.error('Failed to cleanup date directory', {
        date,
        path: dateTempDir,
        error: error.message,
      });
    }
  }
}

export default TraceReader;

