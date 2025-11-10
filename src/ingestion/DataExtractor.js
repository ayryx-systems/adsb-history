import fs from 'fs';
import path from 'path';
import tar from 'tar';
import zlib from 'zlib';
import { promisify } from 'util';
import { pipeline } from 'stream/promises';
import logger from '../utils/logger.js';

const gunzip = promisify(zlib.gunzip);

/**
 * Extracts tar archives and decompresses gzipped JSON files
 * Note: Individual JSON files inside the tar are gzipped despite .json extension
 */
class DataExtractor {
  constructor(config = {}) {
    this.tempDir = config.tempDir || process.env.TEMP_DIR || './temp';
  }

  /**
   * Extract a tar file
   * @param {string} tarPath - Path to tar file
   * @param {string} extractDir - Directory to extract to (optional)
   * @returns {string} Path to extraction directory
   */
  async extractTar(tarPath, extractDir = null) {
    if (!extractDir) {
      extractDir = path.join(path.dirname(tarPath), 'extracted');
    }

    logger.info('Extracting tar file', {
      source: path.basename(tarPath),
      destination: extractDir,
    });

    // Ensure extract directory exists
    if (!fs.existsSync(extractDir)) {
      fs.mkdirSync(extractDir, { recursive: true, mode: 0o755 });
    }

    try {
      await tar.extract({
        file: tarPath,
        cwd: extractDir,
        onentry: (entry) => {
          // Log progress for large directories
          if (Math.random() < 0.01) { // Log ~1% of files to avoid spam
            logger.debug('Extracting', { file: entry.path });
          }
        },
      });

      logger.info('Tar extraction completed', {
        source: path.basename(tarPath),
        destination: extractDir,
      });

      return extractDir;
    } catch (error) {
      logger.error('Failed to extract tar', {
        source: tarPath,
        error: error.message,
      });
      throw error;
    }
  }

  /**
   * Decompress a gzipped JSON file
   * @param {string} gzippedPath - Path to gzipped file
   * @param {string} outputPath - Where to save decompressed file (optional)
   * @returns {object} Parsed JSON object
   */
  async decompressJSON(gzippedPath, outputPath = null) {
    try {
      const gzippedData = fs.readFileSync(gzippedPath);
      const decompressed = await gunzip(gzippedData);
      const jsonString = decompressed.toString('utf-8');
      
      // Optionally save decompressed file
      if (outputPath) {
        fs.writeFileSync(outputPath, jsonString);
      }
      
      return JSON.parse(jsonString);
    } catch (error) {
      logger.error('Failed to decompress JSON', {
        file: path.basename(gzippedPath),
        error: error.message,
      });
      throw error;
    }
  }

  /**
   * Decompress a gzipped JSON file and return as string (more memory efficient)
   * @param {string} gzippedPath - Path to gzipped file
   * @returns {string} JSON string
   */
  async decompressJSONString(gzippedPath) {
    try {
      const gzippedData = fs.readFileSync(gzippedPath);
      const decompressed = await gunzip(gzippedData);
      return decompressed.toString('utf-8');
    } catch (error) {
      logger.error('Failed to decompress JSON string', {
        file: path.basename(gzippedPath),
        error: error.message,
      });
      throw error;
    }
  }

  /**
   * Process extracted directory: find trace files and ACAS data
   * Structure: ./traces/d0/, ./traces/d1/, ... ./traces/ff/ (256 hex subdirs)
   * @param {string} extractDir - Directory containing extracted data
   * @returns {object} Information about extracted files
   */
  async analyzeExtractedData(extractDir) {
    logger.info('Analyzing extracted data', { directory: extractDir });

    const info = {
      extractDir,
      traceFiles: 0,
      traceDirs: [],
      acasFiles: [],
    };

    try {
      // Look for traces directory
      const tracesDir = path.join(extractDir, 'traces');
      
      if (!fs.existsSync(tracesDir)) {
        logger.warn('No traces directory found', { extractDir });
        return info;
      }

      // List trace subdirectories (d0, d1, d2, ..., ff - organized by last 2 hex digits)
      const traceSubdirs = fs.readdirSync(tracesDir)
        .filter(name => {
          const fullPath = path.join(tracesDir, name);
          return fs.statSync(fullPath).isDirectory();
        })
        .sort();

      info.traceDirs = traceSubdirs.map(name => path.join(tracesDir, name));

      // Count trace files
      for (const traceDir of info.traceDirs) {
        const files = fs.readdirSync(traceDir)
          .filter(f => f.startsWith('trace_full_') && f.endsWith('.json'));
        info.traceFiles += files.length;
      }

      logger.info('Found trace files', {
        traceDirs: info.traceDirs.length,
        traceFiles: info.traceFiles,
      });

      // Look for ACAS data
      const acasDir = path.join(extractDir, 'acas');
      if (fs.existsSync(acasDir)) {
        info.acasFiles = fs.readdirSync(acasDir);
        logger.info('Found ACAS data', { files: info.acasFiles });
      }

      return info;
    } catch (error) {
      logger.error('Failed to analyze extracted data', {
        directory: extractDir,
        error: error.message,
      });
      throw error;
    }
  }

  /**
   * Stream process trace files from a trace directory
   * Note: Files are plain JSON (not gzipped)
   * @param {string} traceDir - Path to trace directory (e.g., traces/d0)
   * @yields {object} { filename, data, icao } - Parsed trace data
   */
  async *streamTraceFiles(traceDir) {
    const files = fs.readdirSync(traceDir)
      .filter(f => f.startsWith('trace_full_') && f.endsWith('.json'))
      .sort();

    logger.info('Streaming trace files', {
      traceDir: path.basename(traceDir),
      count: files.length,
    });

    for (const filename of files) {
      const filePath = path.join(traceDir, filename);
      
      try {
        // Files are plain JSON (not gzipped)
        const jsonString = fs.readFileSync(filePath, 'utf-8');
        const data = JSON.parse(jsonString);
        
        // Extract ICAO from filename: trace_full_781ed0.json -> 781ed0
        const icao = filename.replace('trace_full_', '').replace('.json', '');
        
        yield { filename, data, icao, path: filePath };
      } catch (error) {
        logger.error('Failed to process trace file', {
          file: filename,
          error: error.message,
        });
        // Continue with next file
      }
    }
  }

  /**
   * Clean up extracted directory
   * @param {string} extractDir - Directory to remove
   */
  cleanup(extractDir) {
    try {
      if (fs.existsSync(extractDir)) {
        fs.rmSync(extractDir, { recursive: true, force: true });
        logger.info('Cleaned up extracted directory', { path: extractDir });
      }
    } catch (error) {
      logger.error('Failed to cleanup directory', {
        path: extractDir,
        error: error.message,
      });
    }
  }
}

export default DataExtractor;

