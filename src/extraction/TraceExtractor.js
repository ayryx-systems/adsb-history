import fs from 'fs';
import path from 'path';
import tar from 'tar';
import TraceReader from '../processing/TraceReader.js';
import GroundAircraftData from '../processing/GroundAircraftData.js';
import logger from '../utils/logger.js';
import { checkDiskSpace, logDiskSpace } from '../utils/diskSpace.js';

class TraceExtractor {
  constructor(config = {}) {
    this.traceReader = new TraceReader(config);
    this.groundAircraftData = new GroundAircraftData(config);
    this.tempDir = config.tempDir || process.env.TEMP_DIR || './temp';
    
    if (!path.isAbsolute(this.tempDir)) {
      this.tempDir = path.resolve(process.cwd(), this.tempDir);
    }
  }

  getNextDate(date) {
    const d = new Date(date + 'T00:00:00Z');
    d.setUTCDate(d.getUTCDate() + 1);
    return d.toISOString().split('T')[0];
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
    
    const nextDate = this.getNextDate(date);
    let nextDayAircraftIds = [];
    if (nextDate) {
      try {
        nextDayAircraftIds = await this.groundAircraftData.load(airport, nextDate) || [];
        logger.info('Loaded next day ground aircraft list', {
          airport,
          nextDate,
          count: nextDayAircraftIds.length,
        });
      } catch (error) {
        logger.warn('Could not load next day ground aircraft (may not exist yet)', {
          airport,
          nextDate,
          error: error.message,
        });
      }
    }
    
    const allAircraftIds = [...new Set([...(aircraftIds || []), ...nextDayAircraftIds])];
    
    logger.info('Merged ground aircraft lists', {
      airport,
      date,
      currentDayCount: (aircraftIds || []).length,
      nextDayCount: nextDayAircraftIds.length,
      totalCount: allAircraftIds.length,
    });
    
    if (allAircraftIds.length === 0) {
      logger.warn('No ground aircraft found, nothing to extract', { airport, date });
      return null;
    }

    logger.info('Step 2: Checking disk space', { date });
    logDiskSpace(this.tempDir);
    
    const diskCheck = checkDiskSpace(this.tempDir, 30);
    if (!diskCheck.hasSpace) {
      throw new Error(
        `Insufficient disk space: ${diskCheck.availableGB}GB available, ` +
        `but ${diskCheck.requiredGB}GB required. ` +
        `Total: ${diskCheck.totalGB}GB, Used: ${diskCheck.usedGB}GB (${diskCheck.percentUsed}%)`
      );
    }

    logger.info('Step 3: Downloading raw tar from S3', { date });
    const rawTarPath = await this.traceReader.downloadTarFromS3(date);

    logger.info('Step 4: Checking disk space before extraction', { date });
    logDiskSpace(this.tempDir);
    
    const preExtractCheck = checkDiskSpace(this.tempDir, 25);
    if (!preExtractCheck.hasSpace) {
      throw new Error(
        `Insufficient disk space before extraction: ${preExtractCheck.availableGB}GB available, ` +
        `but ${preExtractCheck.requiredGB}GB required. ` +
        `Total: ${preExtractCheck.totalGB}GB, Used: ${preExtractCheck.usedGB}GB (${preExtractCheck.percentUsed}%)`
      );
    }

    logger.info('Step 5: Extracting raw tar', { date });
    let rawExtractDir;
    try {
      rawExtractDir = await this.traceReader.extractTar(rawTarPath);
    } catch (error) {
      if (error.code === 'ENOSPC') {
        logDiskSpace(this.tempDir);
        throw new Error(
          `No space left on device during tar extraction. ` +
          `Check disk space and cleanup old files. Original error: ${error.message}`
        );
      }
      throw error;
    }

    logger.info('Step 6: Creating extracted tar with filtered traces', {
      airport,
      date,
      aircraftCount: allAircraftIds.length,
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
    const expectedCount = allAircraftIds.length;
    const icaosBySubdir = new Map();
    
    for (const icao of allAircraftIds) {
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

    icaosBySubdir.clear();
    allAircraftIds.length = 0;

    logger.info('Copied trace files', {
      airport,
      date,
      extractedCount,
      expectedCount,
    });

    logger.info('Step 7: Creating tar archive', { airport, date });
    
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

    if (global.gc) {
      global.gc();
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

