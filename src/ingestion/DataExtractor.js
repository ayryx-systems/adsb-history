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
      fs.mkdirSync(extractDir, { recursive: true });
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
   * Process extracted directory: find trace files and aircraft.json
   * @param {string} extractDir - Directory containing extracted data
   * @returns {object} Information about extracted files
   */
  async analyzeExtractedData(extractDir) {
    logger.info('Analyzing extracted data', { directory: extractDir });

    const info = {
      extractDir,
      traceFiles: [],
      aircraftFile: null,
      chunkDirs: [],
    };

    try {
      // Look for chunks directory
      const chunksDir = path.join(extractDir, 'chunks');
      
      if (!fs.existsSync(chunksDir)) {
        logger.warn('No chunks directory found', { extractDir });
        return info;
      }

      // List chunk subdirectories (000, 001, 002, ...)
      const chunkSubdirs = fs.readdirSync(chunksDir)
        .filter(name => {
          const fullPath = path.join(chunksDir, name);
          return fs.statSync(fullPath).isDirectory();
        })
        .sort();

      info.chunkDirs = chunkSubdirs.map(name => path.join(chunksDir, name));

      // Count trace files
      let totalTraceFiles = 0;
      for (const chunkDir of info.chunkDirs) {
        const files = fs.readdirSync(chunkDir)
          .filter(f => f.startsWith('trace_full_') && f.endsWith('.json'));
        totalTraceFiles += files.length;
      }

      logger.info('Found trace files', {
        chunkDirs: info.chunkDirs.length,
        traceFiles: totalTraceFiles,
      });

      // Look for aircraft.json
      const aircraftPath = path.join(extractDir, 'aircraft.json');
      if (fs.existsSync(aircraftPath)) {
        info.aircraftFile = aircraftPath;
        logger.info('Found aircraft.json', { path: aircraftPath });
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
   * Stream process trace files from a chunk directory
   * Yields decompressed JSON objects one at a time to conserve memory
   * @param {string} chunkDir - Path to chunk directory (e.g., chunks/000)
   * @yields {object} { filename, data } - Decompressed trace data
   */
  async *streamTraceFiles(chunkDir) {
    const files = fs.readdirSync(chunkDir)
      .filter(f => f.startsWith('trace_full_') && f.endsWith('.json'))
      .sort();

    logger.info('Streaming trace files', {
      chunkDir: path.basename(chunkDir),
      count: files.length,
    });

    for (const filename of files) {
      const filePath = path.join(chunkDir, filename);
      
      try {
        const jsonString = await this.decompressJSONString(filePath);
        const data = JSON.parse(jsonString);
        
        yield { filename, data, path: filePath };
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

