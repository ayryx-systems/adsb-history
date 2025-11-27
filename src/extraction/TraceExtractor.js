import fs from 'fs';
import path from 'path';
import tar from 'tar';
import TraceReader from '../processing/TraceReader.js';
import GroundAircraftData from '../processing/GroundAircraftData.js';
import logger from '../utils/logger.js';

class TraceExtractor {
  constructor(config = {}) {
    this.traceReader = new TraceReader(config);
    this.groundAircraftData = new GroundAircraftData(config);
    this.tempDir = config.tempDir || process.env.TEMP_DIR || './temp';
    
    if (!path.isAbsolute(this.tempDir)) {
      this.tempDir = path.resolve(process.cwd(), this.tempDir);
    }
  }

  async extractTracesForAirport(airport, date) {
    logger.info('Starting trace extraction', { airport, date });

    const [year, month, day] = date.split('-');
    const workDir = path.join(this.tempDir, 'extraction', airport, date);
    const extractedTarPath = path.join(workDir, `${airport}-${date}.tar`);

    if (fs.existsSync(extractedTarPath)) {
      logger.info('Extracted tar already exists locally', { path: extractedTarPath });
      return extractedTarPath;
    }

    if (!fs.existsSync(workDir)) {
      fs.mkdirSync(workDir, { recursive: true, mode: 0o755 });
    }

    const extractDir = path.join(workDir, 'extracted');

    logger.info('Step 1: Loading ground aircraft list', { airport, date });
    const aircraftIds = await this.groundAircraftData.load(airport, date);
    
    if (!aircraftIds || aircraftIds.length === 0) {
      logger.warn('No ground aircraft found, nothing to extract', { airport, date });
      return null;
    }

    logger.info('Loaded ground aircraft list', {
      airport,
      date,
      count: aircraftIds.length,
    });

    logger.info('Step 2: Downloading raw tar from S3', { date });
    const rawTarPath = await this.traceReader.downloadTarFromS3(date);

    logger.info('Step 3: Extracting raw tar', { date });
    const rawExtractDir = await this.traceReader.extractTar(rawTarPath);

    logger.info('Step 4: Creating extracted tar with filtered traces', {
      airport,
      date,
      aircraftCount: aircraftIds.length,
    });

    const tracesDir = path.join(rawExtractDir, 'traces');
    
    if (!fs.existsSync(tracesDir)) {
      throw new Error(`Traces directory not found: ${tracesDir}`);
    }

    const outputTracesDir = path.join(extractDir, 'traces');
    if (!fs.existsSync(outputTracesDir)) {
      fs.mkdirSync(outputTracesDir, { recursive: true, mode: 0o755 });
    }

    let extractedCount = 0;
    const icaosBySubdir = new Map();
    
    for (const icao of aircraftIds) {
      const hexSubdir = icao.toLowerCase().slice(-2);
      if (!icaosBySubdir.has(hexSubdir)) {
        icaosBySubdir.set(hexSubdir, []);
      }
      icaosBySubdir.get(hexSubdir).push(icao.toLowerCase());
    }

    for (const [hexSubdir, icaos] of icaosBySubdir) {
      const sourceSubdir = path.join(tracesDir, hexSubdir);
      const destSubdir = path.join(outputTracesDir, hexSubdir);

      if (!fs.existsSync(sourceSubdir)) {
        continue;
      }

      if (!fs.existsSync(destSubdir)) {
        fs.mkdirSync(destSubdir, { recursive: true, mode: 0o755 });
      }

      for (const icao of icaos) {
        const filename = `trace_full_${icao}.json`;
        const sourcePath = path.join(sourceSubdir, filename);
        const destPath = path.join(destSubdir, filename);

        if (fs.existsSync(sourcePath)) {
          fs.copyFileSync(sourcePath, destPath);
          extractedCount++;
        }
      }
    }

    logger.info('Copied trace files', {
      airport,
      date,
      extractedCount,
      expectedCount: aircraftIds.length,
    });

    logger.info('Step 5: Creating tar archive', { airport, date });
    
    await tar.create(
      {
        file: extractedTarPath,
        cwd: extractDir,
        gzip: false,
      },
      ['traces']
    );

    const stats = fs.statSync(extractedTarPath);
    const sizeMB = (stats.size / 1024 / 1024).toFixed(2);

    logger.info('Created extracted tar archive', {
      airport,
      date,
      path: extractedTarPath,
      sizeMB,
      traceCount: extractedCount,
    });

    logger.info('Cleaning up temporary extraction directory', { extractDir });
    if (fs.existsSync(extractDir)) {
      fs.rmSync(extractDir, { recursive: true, force: true });
    }

    logger.info('Cleaning up raw tar file and extracted directory', {
      rawTarPath,
      rawExtractDir,
    });
    
    if (fs.existsSync(rawTarPath)) {
      try {
        fs.unlinkSync(rawTarPath);
        logger.info('Deleted raw tar file', { path: rawTarPath });
      } catch (error) {
        logger.warn('Failed to delete raw tar file', {
          path: rawTarPath,
          error: error.message,
        });
      }
    }
    
    if (fs.existsSync(rawExtractDir)) {
      try {
        fs.rmSync(rawExtractDir, { recursive: true, force: true });
        logger.info('Deleted raw extracted directory', { path: rawExtractDir });
      } catch (error) {
        logger.warn('Failed to delete raw extracted directory', {
          path: rawExtractDir,
          error: error.message,
        });
      }
    }
    
    const rawTarDateDir = path.dirname(rawTarPath);
    if (fs.existsSync(rawTarDateDir)) {
      try {
        const files = fs.readdirSync(rawTarDateDir);
        if (files.length === 0) {
          fs.rmdirSync(rawTarDateDir);
          logger.info('Removed empty raw tar date directory', { path: rawTarDateDir });
        }
      } catch (error) {
        logger.warn('Failed to remove raw tar date directory', {
          path: rawTarDateDir,
          error: error.message,
        });
      }
    }

    return extractedTarPath;
  }
}

export default TraceExtractor;

