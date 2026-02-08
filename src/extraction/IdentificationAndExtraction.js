import fs from 'fs';
import path from 'path';
import tar from 'tar';
import TraceReader from '../processing/TraceReader.js';
import GroundAircraftData from '../processing/GroundAircraftData.js';
import ExtractedTraceData from './ExtractedTraceData.js';
import logger from '../utils/logger.js';
import { checkDiskSpace, logDiskSpace } from '../utils/diskSpace.js';

class IdentificationAndExtraction {
  constructor(config = {}) {
    this.traceReader = new TraceReader(config);
    this.groundAircraftData = new GroundAircraftData(config);
    this.extractedTraceData = new ExtractedTraceData(config);
    this.tempDir = config.tempDir || process.env.TEMP_DIR || './temp';
    this.proximityRadius = config.proximityRadius || 2.0;
    this.maxAltitudeAGL = config.maxAltitudeAGL || 800;
    
    if (!path.isAbsolute(this.tempDir)) {
      this.tempDir = path.resolve(process.cwd(), this.tempDir);
    }
  }

  calculateDistance(lat1, lon1, lat2, lon2) {
    const R = 3440.065;
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
      Math.sin(dLon / 2) * Math.sin(dLon / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c;
  }

  parsePosition(posArray, baseTimestamp = null) {
    if (!posArray || posArray.length < 6) return null;
    
    let timestamp = posArray[0];
    if (baseTimestamp !== null && timestamp >= 0 && timestamp < 86400 * 2) {
      timestamp = baseTimestamp + timestamp;
    }
    
    let alt_baro = posArray[3];
    if (alt_baro === "ground" || alt_baro === null) {
      alt_baro = 0;
    } else if (typeof alt_baro === 'string') {
      alt_baro = parseFloat(alt_baro);
      if (isNaN(alt_baro)) alt_baro = null;
    }
    
    return {
      timestamp,
      lat: posArray[1],
      lon: posArray[2],
      alt_baro,
    };
  }

  wasOnGround(trace, airport, date) {
    if (!trace || !Array.isArray(trace) || trace.length === 0) {
      return false;
    }

    const airportLat = airport.coordinates.lat;
    const airportLon = airport.coordinates.lon;
    const airportElevation = airport.elevation_ft || 0;

    let baseTimestamp = null;
    if (date) {
      const dateObj = new Date(date + 'T00:00:00Z');
      baseTimestamp = Math.floor(dateObj.getTime() / 1000);
    }

    const positions = trace
      .map(pos => {
        const parsed = this.parsePosition(pos, baseTimestamp);
        if (parsed && parsed.alt_baro !== null) {
          parsed.alt_agl = parsed.alt_baro - airportElevation;
        }
        return parsed;
      })
      .filter(pos => pos && pos.lat !== null && pos.lon !== null && pos.alt_baro !== null);

    if (positions.length === 0) {
      return false;
    }

    for (const pos of positions) {
      const distance = this.calculateDistance(pos.lat, pos.lon, airportLat, airportLon);
      
      if (distance <= this.proximityRadius && pos.alt_agl <= this.maxAltitudeAGL) {
        return true;
      }
    }

    return false;
  }

  getNextDate(date) {
    const d = new Date(date + 'T00:00:00Z');
    d.setUTCDate(d.getUTCDate() + 1);
    return d.toISOString().split('T')[0];
  }

  async identifyAndExtract(date, airport) {
    console.log(`[${new Date().toISOString()}] Starting combined identification and extraction for ${airport.icao} on ${date}`);
    logger.info('Starting combined identification and extraction', { date, airport: airport.icao });

    const startTime = Date.now();
    const aircraftIds = new Set();
    const [year, month, day] = date.split('-');
    const workDir = path.join(this.tempDir, 'extraction', airport.icao, date);
    const extractedTarPath = path.join(workDir, `${airport.icao}-${date}.tar`);

    if (fs.existsSync(extractedTarPath)) {
      logger.info('Extracted tar already exists locally', { path: extractedTarPath });
      const existingAircraftIds = await this.groundAircraftData.load(airport.icao, date);
      return { aircraftIds: existingAircraftIds || [], tarPath: extractedTarPath };
    }

    if (!fs.existsSync(workDir)) {
      fs.mkdirSync(workDir, { recursive: true, mode: 0o755 });
    }

    const extractDir = path.join(workDir, 'extracted');
    const outputTracesDir = path.join(extractDir, 'traces');
    if (!fs.existsSync(outputTracesDir)) {
      fs.mkdirSync(outputTracesDir, { recursive: true, mode: 0o755 });
    }

    try {
      logger.info('Step 1: Checking disk space', { date });
      logDiskSpace(this.tempDir);
      
      const diskCheck = checkDiskSpace(this.tempDir, 30);
      if (!diskCheck.hasSpace) {
        throw new Error(
          `Insufficient disk space: ${diskCheck.availableGB}GB available, ` +
          `but ${diskCheck.requiredGB}GB required. ` +
          `Total: ${diskCheck.totalGB}GB, Used: ${diskCheck.usedGB}GB (${diskCheck.percentUsed}%)`
        );
      }

      logger.info('Step 2: Downloading raw tar from S3', { date });
      console.log(`[${new Date().toISOString()}] Step 2: Downloading raw ADSB data from S3`);
      const rawTarPath = await this.traceReader.downloadTarFromS3(date);
      console.log(`[${new Date().toISOString()}] ✓ Raw tar downloaded: ${rawTarPath}`);

      logger.info('Step 3: Checking disk space before extraction', { date });
      logDiskSpace(this.tempDir);
      
      const preExtractCheck = checkDiskSpace(this.tempDir, 25);
      if (!preExtractCheck.hasSpace) {
        throw new Error(
          `Insufficient disk space before extraction: ${preExtractCheck.availableGB}GB available, ` +
          `but ${preExtractCheck.requiredGB}GB required. ` +
          `Total: ${preExtractCheck.totalGB}GB, Used: ${preExtractCheck.usedGB}GB (${preExtractCheck.percentUsed}%)`
        );
      }

      logger.info('Step 4: Extracting raw tar', { date });
      console.log(`[${new Date().toISOString()}] Step 4: Extracting raw tar`);
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
      console.log(`[${new Date().toISOString()}] ✓ Raw tar extracted to: ${rawExtractDir}`);

      logger.info('Step 5: Processing traces (identification + extraction)', { date, airport: airport.icao });
      console.log(`[${new Date().toISOString()}] Step 5: Processing traces to identify ground aircraft and extract traces`);
      
      const tracesDir = path.join(rawExtractDir, 'traces');
      if (!fs.existsSync(tracesDir)) {
        throw new Error(`Traces directory not found: ${tracesDir}`);
      }

      let processedCount = 0;
      const progressInterval = 10000;
      const icaosBySubdir = new Map();

      for await (const { icao, trace } of this.traceReader.streamAllTraces(rawExtractDir)) {
        processedCount++;

        if (processedCount % progressInterval === 0) {
          logger.info('Processing progress', {
            date,
            airport: airport.icao,
            tracesProcessed: processedCount,
            groundAircraft: aircraftIds.size,
          });
          console.log(`[${new Date().toISOString()}] Progress: ${processedCount.toLocaleString()} traces processed, ${aircraftIds.size} ground aircraft found`);
        }

        if (this.wasOnGround(trace, airport, date)) {
          aircraftIds.add(icao);

          const hexSubdir = icao.toLowerCase().slice(-2);
          if (!icaosBySubdir.has(hexSubdir)) {
            icaosBySubdir.set(hexSubdir, []);
          }
          icaosBySubdir.get(hexSubdir).push(icao.toLowerCase());
        }
      }

      const duration = Date.now() - startTime;
      console.log(`[${new Date().toISOString()}] Identification complete for ${airport.icao}`);
      console.log(`  Traces processed: ${processedCount.toLocaleString()}`);
      console.log(`  Ground aircraft found: ${aircraftIds.size}`);
      console.log(`  Duration: ${(duration / 1000).toFixed(1)}s`);

      logger.info('Identification complete', {
        date,
        airport: airport.icao,
        tracesProcessed: processedCount,
        groundAircraft: aircraftIds.size,
        duration: `${(duration / 1000).toFixed(1)}s`,
      });

      if (aircraftIds.size === 0) {
        logger.warn('No ground aircraft found, nothing to extract', { airport: airport.icao, date });
        
        if (fs.existsSync(rawTarPath)) {
          fs.unlinkSync(rawTarPath);
        }
        if (fs.existsSync(rawExtractDir)) {
          fs.rmSync(rawExtractDir, { recursive: true, force: true });
        }
        
        return { aircraftIds: [], tarPath: null };
      }

      const nextDate = this.getNextDate(date);
      let nextDayAircraftIds = [];
      if (nextDate) {
        try {
          nextDayAircraftIds = await this.groundAircraftData.load(airport.icao, nextDate) || [];
          logger.info('Loaded next day ground aircraft list', {
            airport: airport.icao,
            nextDate,
            count: nextDayAircraftIds.length,
          });
        } catch (error) {
          logger.warn('Could not load next day ground aircraft (may not exist yet)', {
            airport: airport.icao,
            nextDate,
            error: error.message,
          });
        }
      }

      const allAircraftIds = [...new Set([...Array.from(aircraftIds), ...nextDayAircraftIds])];
      
      logger.info('Merged ground aircraft lists', {
        airport: airport.icao,
        date,
        currentDayCount: aircraftIds.size,
        nextDayCount: nextDayAircraftIds.length,
        totalCount: allAircraftIds.length,
      });

      logger.info('Step 6: Copying trace files', {
        airport: airport.icao,
        date,
        aircraftCount: allAircraftIds.length,
      });

      let extractedCount = 0;
      const expectedCount = allAircraftIds.length;

      for (const icao of allAircraftIds) {
        const hexSubdir = icao.toLowerCase().slice(-2);
        const sourceSubdir = path.join(tracesDir, hexSubdir);
        const destSubdir = path.join(outputTracesDir, hexSubdir);

        if (!fs.existsSync(sourceSubdir)) {
          continue;
        }

        if (!fs.existsSync(destSubdir)) {
          fs.mkdirSync(destSubdir, { recursive: true, mode: 0o755 });
        }

        const filename = `trace_full_${icao.toLowerCase()}.json`;
        const sourcePath = path.join(sourceSubdir, filename);
        const destPath = path.join(destSubdir, filename);

        if (fs.existsSync(sourcePath)) {
          fs.copyFileSync(sourcePath, destPath);
          extractedCount++;
        }
      }

      logger.info('Copied trace files', {
        airport: airport.icao,
        date,
        extractedCount,
        expectedCount,
      });

      logger.info('Step 7: Creating tar archive', { airport: airport.icao, date });
      console.log(`[${new Date().toISOString()}] Step 7: Creating extracted tar archive`);
      
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
        airport: airport.icao,
        date,
        path: extractedTarPath,
        sizeMB,
        traceCount: extractedCount,
      });
      console.log(`[${new Date().toISOString()}] ✓ Created extracted tar (${sizeMB} MB, ${extractedCount} traces)`);

      logger.info('Step 8: Saving ground aircraft list to S3', { airport: airport.icao, date });
      console.log(`[${new Date().toISOString()}] Step 8: Saving ground aircraft list to S3`);
      const aircraftIdsArray = Array.from(aircraftIds).sort();
      await this.groundAircraftData.save(airport.icao, date, aircraftIdsArray);
      console.log(`[${new Date().toISOString()}] ✓ Saved ground aircraft list (${aircraftIdsArray.length} aircraft)`);

      logger.info('Step 9: Uploading extracted tar to S3', { airport: airport.icao, date });
      console.log(`[${new Date().toISOString()}] Step 9: Uploading extracted tar to S3`);
      await this.extractedTraceData.save(airport.icao, date, extractedTarPath);
      console.log(`[${new Date().toISOString()}] ✓ Uploaded extracted tar to S3`);

      logger.info('Cleaning up temporary files', { extractDir, rawTarPath, rawExtractDir });
      console.log(`[${new Date().toISOString()}] Cleaning up temporary files`);

      if (fs.existsSync(extractDir)) {
        fs.rmSync(extractDir, { recursive: true, force: true });
      }

      if (fs.existsSync(rawTarPath)) {
        fs.unlinkSync(rawTarPath);
      }

      if (fs.existsSync(rawExtractDir)) {
        fs.rmSync(rawExtractDir, { recursive: true, force: true });
      }

      const rawTarDateDir = path.dirname(rawTarPath);
      if (fs.existsSync(rawTarDateDir)) {
        try {
          const files = fs.readdirSync(rawTarDateDir);
          if (files.length === 0) {
            fs.rmdirSync(rawTarDateDir);
          }
        } catch (err) {
        }
      }

      if (global.gc) {
        global.gc();
      }

      const finalDuration = Date.now() - startTime;
      console.log(`[${new Date().toISOString()}] Combined identification and extraction complete`);
      console.log(`  Total duration: ${(finalDuration / 1000).toFixed(1)}s`);

      return { aircraftIds: aircraftIdsArray, tarPath: extractedTarPath };

    } catch (error) {
      logger.error('Failed to identify and extract', {
        date,
        airport: airport.icao,
        error: error.message,
        stack: error.stack,
      });
      throw error;
    }
  }

  async identifyAndExtractMultipleAirports(date, airports) {
    if (airports.length === 0) {
      throw new Error('No airports provided');
    }

    if (airports.length === 1) {
      return { [airports[0].icao]: await this.identifyAndExtract(date, airports[0]) };
    }

    console.log(`[${new Date().toISOString()}] Starting combined identification and extraction for ${airports.length} airports on ${date}`);
    logger.info('Starting combined identification and extraction for multiple airports', { 
      date, 
      airports: airports.map(a => a.icao),
      count: airports.length 
    });

    const startTime = Date.now();
    const results = {};
    const aircraftIdsByAirport = {};
    
    for (const airport of airports) {
      aircraftIdsByAirport[airport.icao] = new Set();
    }

    const sharedWorkDir = path.join(this.tempDir, 'extraction', 'shared', date);
    const rawTarDateDir = path.join(this.tempDir, date);

    try {
      logger.info('Step 1: Checking disk space', { date });
      logDiskSpace(this.tempDir);
      
      const diskCheck = checkDiskSpace(this.tempDir, 30);
      if (!diskCheck.hasSpace) {
        throw new Error(
          `Insufficient disk space: ${diskCheck.availableGB}GB available, ` +
          `but ${diskCheck.requiredGB}GB required. ` +
          `Total: ${diskCheck.totalGB}GB, Used: ${diskCheck.usedGB}GB (${diskCheck.percentUsed}%)`
        );
      }

      logger.info('Step 2: Downloading raw tar from S3', { date });
      console.log(`[${new Date().toISOString()}] Step 2: Downloading raw ADSB data from S3`);
      const rawTarPath = await this.traceReader.downloadTarFromS3(date);
      console.log(`[${new Date().toISOString()}] ✓ Raw tar downloaded: ${rawTarPath}`);

      logger.info('Step 3: Checking disk space before extraction', { date });
      logDiskSpace(this.tempDir);
      
      const preExtractCheck = checkDiskSpace(this.tempDir, 25);
      if (!preExtractCheck.hasSpace) {
        throw new Error(
          `Insufficient disk space before extraction: ${preExtractCheck.availableGB}GB available, ` +
          `but ${preExtractCheck.requiredGB}GB required. ` +
          `Total: ${preExtractCheck.totalGB}GB, Used: ${preExtractCheck.usedGB}GB (${preExtractCheck.percentUsed}%)`
        );
      }

      logger.info('Step 4: Extracting raw tar', { date });
      console.log(`[${new Date().toISOString()}] Step 4: Extracting raw tar`);
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
      console.log(`[${new Date().toISOString()}] ✓ Raw tar extracted to: ${rawExtractDir}`);

      logger.info('Step 5: Processing traces for all airports', { date, airports: airports.map(a => a.icao) });
      console.log(`[${new Date().toISOString()}] Step 5: Processing traces to identify ground aircraft for ${airports.length} airports`);
      
      const tracesDir = path.join(rawExtractDir, 'traces');
      if (!fs.existsSync(tracesDir)) {
        throw new Error(`Traces directory not found: ${tracesDir}`);
      }

      let processedCount = 0;
      const progressInterval = 10000;

      for await (const { icao, trace } of this.traceReader.streamAllTraces(rawExtractDir)) {
        processedCount++;

        if (processedCount % progressInterval === 0) {
          const totalGroundAircraft = Object.values(aircraftIdsByAirport).reduce((sum, set) => sum + set.size, 0);
          logger.info('Processing progress', {
            date,
            tracesProcessed: processedCount,
            totalGroundAircraft,
          });
          console.log(`[${new Date().toISOString()}] Progress: ${processedCount.toLocaleString()} traces processed, ${totalGroundAircraft} total ground aircraft found`);
        }

        for (const airport of airports) {
          if (this.wasOnGround(trace, airport, date)) {
            aircraftIdsByAirport[airport.icao].add(icao);
          }
        }
      }

      const duration = Date.now() - startTime;
      console.log(`[${new Date().toISOString()}] Identification complete for ${airports.length} airports`);
      console.log(`  Traces processed: ${processedCount.toLocaleString()}`);
      for (const airport of airports) {
        console.log(`  ${airport.icao}: ${aircraftIdsByAirport[airport.icao].size} ground aircraft`);
      }
      console.log(`  Duration: ${(duration / 1000).toFixed(1)}s`);

      logger.info('Identification complete for all airports', {
        date,
        tracesProcessed: processedCount,
        airports: airports.map(a => ({ icao: a.icao, count: aircraftIdsByAirport[a.icao].size })),
        duration: `${(duration / 1000).toFixed(1)}s`,
      });

      const nextDate = this.getNextDate(date);
      
      for (const airport of airports) {
        const aircraftIds = aircraftIdsByAirport[airport.icao];
        
        if (aircraftIds.size === 0) {
          logger.warn('No ground aircraft found', { airport: airport.icao, date });
          results[airport.icao] = { aircraftIds: [], tarPath: null };
          continue;
        }

        let nextDayAircraftIds = [];
        if (nextDate) {
          try {
            nextDayAircraftIds = await this.groundAircraftData.load(airport.icao, nextDate) || [];
          } catch (error) {
            logger.warn('Could not load next day ground aircraft', {
              airport: airport.icao,
              nextDate,
              error: error.message,
            });
          }
        }

        const allAircraftIds = [...new Set([...Array.from(aircraftIds), ...nextDayAircraftIds])];
        
        const workDir = path.join(this.tempDir, 'extraction', airport.icao, date);
        const extractedTarPath = path.join(workDir, `${airport.icao}-${date}.tar`);
        const extractDir = path.join(workDir, 'extracted');
        const outputTracesDir = path.join(extractDir, 'traces');

        if (!fs.existsSync(workDir)) {
          fs.mkdirSync(workDir, { recursive: true, mode: 0o755 });
        }
        if (!fs.existsSync(outputTracesDir)) {
          fs.mkdirSync(outputTracesDir, { recursive: true, mode: 0o755 });
        }

        logger.info('Copying trace files for airport', {
          airport: airport.icao,
          date,
          aircraftCount: allAircraftIds.length,
        });

        let extractedCount = 0;
        for (const icao of allAircraftIds) {
          const hexSubdir = icao.toLowerCase().slice(-2);
          const sourceSubdir = path.join(tracesDir, hexSubdir);
          const destSubdir = path.join(outputTracesDir, hexSubdir);

          if (!fs.existsSync(sourceSubdir)) {
            continue;
          }

          if (!fs.existsSync(destSubdir)) {
            fs.mkdirSync(destSubdir, { recursive: true, mode: 0o755 });
          }

          const filename = `trace_full_${icao.toLowerCase()}.json`;
          const sourcePath = path.join(sourceSubdir, filename);
          const destPath = path.join(destSubdir, filename);

          if (fs.existsSync(sourcePath)) {
            fs.copyFileSync(sourcePath, destPath);
            extractedCount++;
          }
        }

        logger.info('Creating tar archive for airport', { airport: airport.icao, date });
        
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
          airport: airport.icao,
          date,
          path: extractedTarPath,
          sizeMB,
          traceCount: extractedCount,
        });

        const aircraftIdsArray = Array.from(aircraftIds).sort();
        await this.groundAircraftData.save(airport.icao, date, aircraftIdsArray);
        await this.extractedTraceData.save(airport.icao, date, extractedTarPath);

        if (fs.existsSync(extractDir)) {
          fs.rmSync(extractDir, { recursive: true, force: true });
        }

        results[airport.icao] = { aircraftIds: aircraftIdsArray, tarPath: extractedTarPath };
      }

      logger.info('Cleaning up shared raw tar and extracted directory', { rawTarPath, rawExtractDir });
      console.log(`[${new Date().toISOString()}] Cleaning up shared temporary files`);

      if (fs.existsSync(rawTarPath)) {
        fs.unlinkSync(rawTarPath);
      }

      if (fs.existsSync(rawExtractDir)) {
        fs.rmSync(rawExtractDir, { recursive: true, force: true });
      }

      const rawTarDateDirPath = path.dirname(rawTarPath);
      if (fs.existsSync(rawTarDateDirPath)) {
        try {
          const files = fs.readdirSync(rawTarDateDirPath);
          if (files.length === 0) {
            fs.rmdirSync(rawTarDateDirPath);
          }
        } catch (err) {
        }
      }

      if (global.gc) {
        global.gc();
      }

      const finalDuration = Date.now() - startTime;
      console.log(`[${new Date().toISOString()}] Combined identification and extraction complete for ${airports.length} airports`);
      console.log(`  Total duration: ${(finalDuration / 1000).toFixed(1)}s`);

      return results;

    } catch (error) {
      logger.error('Failed to identify and extract for multiple airports', {
        date,
        airports: airports.map(a => a.icao),
        error: error.message,
        stack: error.stack,
      });
      throw error;
    }
  }
}

export default IdentificationAndExtraction;
