import fs from 'fs';
import path from 'path';
import TraceReader from './TraceReader.js';
import logger from '../utils/logger.js';

/**
 * Identifies aircraft that have been on the ground at a specific airport
 * 
 * Criteria:
 * - Within 2nm of airport coordinates
 * - Altitude below 800ft AGL (Above Ground Level) or "ground"
 * 
 * Note: ADSB provides altitudes in AMSL (Above Mean Sea Level), so we convert
 * to AGL by subtracting the airport elevation.
 */
class AirportGroundIdentifier {
  constructor(config = {}) {
    this.traceReader = new TraceReader(config);
    this.proximityRadius = config.proximityRadius || 2.0; // nautical miles
    this.maxAltitudeAGL = config.maxAltitudeAGL || 800; // feet AGL
  }

  /**
   * Calculate distance between two coordinates using Haversine formula
   */
  calculateDistance(lat1, lon1, lat2, lon2) {
    const R = 3440.065; // Earth radius in nautical miles
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
      Math.sin(dLon / 2) * Math.sin(dLon / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c;
  }

  /**
   * Parse a position report from trace data
   */
  parsePosition(posArray, baseTimestamp = null) {
    if (!posArray || posArray.length < 6) return null;
    
    // Handle timestamp
    let timestamp = posArray[0];
    if (baseTimestamp !== null && timestamp >= 0 && timestamp < 86400 * 2) {
      timestamp = baseTimestamp + timestamp;
    }
    
    // Handle altitude: can be "ground" string or number
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

  /**
   * Check if an aircraft was on the ground at the airport
   */
  wasOnGround(trace, airport, date) {
    if (!trace || !Array.isArray(trace) || trace.length === 0) {
      return false;
    }

    const airportLat = airport.coordinates.lat;
    const airportLon = airport.coordinates.lon;
    const airportElevation = airport.elevation_ft || 0; // Airport elevation in feet AMSL

    // Calculate base timestamp
    let baseTimestamp = null;
    if (date) {
      const dateObj = new Date(date + 'T00:00:00Z');
      baseTimestamp = Math.floor(dateObj.getTime() / 1000);
    }

    // Parse positions and convert AMSL to AGL
    const positions = trace
      .map(pos => {
        const parsed = this.parsePosition(pos, baseTimestamp);
        if (parsed && parsed.alt_baro !== null) {
          // Convert AMSL to AGL by subtracting airport elevation
          parsed.alt_agl = parsed.alt_baro - airportElevation;
        }
        return parsed;
      })
      .filter(pos => pos && pos.lat !== null && pos.lon !== null && pos.alt_baro !== null);

    if (positions.length === 0) {
      return false;
    }

    // Check if any position is on ground at airport
    // Use AGL (Above Ground Level) for ground detection
    for (const pos of positions) {
      const distance = this.calculateDistance(pos.lat, pos.lon, airportLat, airportLon);
      
      // Check if within proximity and below max altitude AGL
      if (distance <= this.proximityRadius && pos.alt_agl <= this.maxAltitudeAGL) {
        return true;
      }
    }

    return false;
  }

  /**
   * Identify all aircraft that were on the ground at the airport on a specific date
   */
  async identifyGroundAircraft(date, airport) {
    console.log(`[${new Date().toISOString()}] Starting identification for ${airport.icao} on ${date}`);
    logger.info('Identifying ground aircraft', { date, airport: airport.icao });

    const startTime = Date.now();
    const aircraftIds = new Set();

    try {
      // Step 1: Download raw tar from S3
      console.log(`[${new Date().toISOString()}] Step 1: Downloading raw ADSB data from S3`);
      logger.info('Step 1: Downloading raw tar from S3', { date, airport: airport.icao });
      const rawTarPath = await this.traceReader.downloadTarFromS3(date);
      
      console.log(`[${new Date().toISOString()}] ✓ Raw tar downloaded: ${rawTarPath}`);

      // Step 2: Extract raw tar
      console.log(`[${new Date().toISOString()}] Step 2: Extracting raw tar`);
      logger.info('Step 2: Extracting raw tar', { date, airport: airport.icao });
      const extractDir = await this.traceReader.extractTar(rawTarPath);
      
      console.log(`[${new Date().toISOString()}] ✓ Raw tar extracted to: ${extractDir}`);

      // Step 3: Stream and check all traces
      logger.info('Step 3: Processing traces', { date, airport: airport.icao });
      console.log(`[${new Date().toISOString()}] Step 3: Processing all traces to identify ground aircraft`);
      
      let processedCount = 0;
      const progressInterval = 10000;

      for await (const { icao, trace } of this.traceReader.streamAllTraces(extractDir)) {
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

        // Check if aircraft was on ground at airport
        if (this.wasOnGround(trace, airport, date)) {
          aircraftIds.add(icao);
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

      // Clean up extracted directory and tar file to free up disk space
      console.log(`[${new Date().toISOString()}] Cleaning up extracted data and tar file`);
      logger.info('Cleaning up extracted data and tar file', { date, airport: airport.icao });
      
      if (fs.existsSync(extractDir)) {
        fs.rmSync(extractDir, { recursive: true, force: true });
        logger.info('Removed extracted directory', { date, path: extractDir });
      }
      
      if (fs.existsSync(rawTarPath)) {
        const tarStats = fs.statSync(rawTarPath);
        fs.unlinkSync(rawTarPath);
        logger.info('Removed tar file', {
          date,
          path: rawTarPath,
          size: `${(tarStats.size / 1024 / 1024 / 1024).toFixed(2)} GB`,
        });
        console.log(`[${new Date().toISOString()}] ✓ Removed tar file (${(tarStats.size / 1024 / 1024 / 1024).toFixed(2)} GB freed)`);
      }
      
      // Clean up empty date directory if it exists
      const dateTempDir = path.dirname(rawTarPath);
      try {
        if (fs.existsSync(dateTempDir)) {
          const files = fs.readdirSync(dateTempDir);
          if (files.length === 0) {
            fs.rmdirSync(dateTempDir);
            logger.info('Removed empty date directory', { date, path: dateTempDir });
          }
        }
      } catch (err) {
        // Directory not empty or other error, ignore
      }

      // Return as sorted array
      const result = Array.from(aircraftIds).sort();
      console.log(`[${new Date().toISOString()}] Returning ${result.length} aircraft IDs`);
      return result;

    } catch (error) {
      logger.error('Failed to identify ground aircraft', {
        date,
        airport: airport.icao,
        error: error.message,
        stack: error.stack,
      });
      throw error;
    }
  }
}

export default AirportGroundIdentifier;

