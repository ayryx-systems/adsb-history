import fs from 'fs';
import path from 'path';
import TraceReader from './TraceReader.js';
import logger from '../utils/logger.js';

/**
 * Identifies aircraft that have been on the ground at a specific airport
 * 
 * Criteria:
 * - Within 1nm of airport coordinates
 * - Altitude below 500ft AGL (Above Ground Level) or "ground"
 * 
 * Note: ADSB provides altitudes in AMSL (Above Mean Sea Level), so we convert
 * to AGL by subtracting the airport elevation.
 */
class AirportGroundIdentifier {
  constructor(config = {}) {
    this.traceReader = new TraceReader(config);
    this.proximityRadius = config.proximityRadius || 1.0; // nautical miles
    this.maxAltitudeAGL = config.maxAltitudeAGL || 500; // feet AGL
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
      // Step 1: Download extracted traces for this airport from S3
      console.log(`[${new Date().toISOString()}] Step 1: Downloading extracted traces for ${airport.icao} from S3`);
      logger.info('Step 1: Downloading extracted traces from S3', { date, airport: airport.icao });
      const extractDir = await this.traceReader.downloadExtractedTraces(airport.icao, date);
      
      if (!extractDir) {
        throw new Error(`Extracted traces not found for ${airport.icao} on ${date}. Run extraction phase first.`);
      }
      
      console.log(`[${new Date().toISOString()}] ✓ Extracted traces downloaded and extracted to: ${extractDir}`);

      // Step 2: Stream and check all traces
      logger.info('Step 2: Processing traces', { date, airport: airport.icao });
      
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

      // Clean up extracted traces directory
      console.log(`[${new Date().toISOString()}] Cleaning up extracted data`);
      logger.info('Cleaning up extracted data', { date, airport: airport.icao });
      const extractedTarPath = path.join(this.traceReader.tempDir, 'extracted', airport.icao, date, `${airport.icao}-${date}.tar`);
      const extractedExtractDir = path.join(path.dirname(extractedTarPath), 'extracted');
      if (fs.existsSync(extractedExtractDir)) {
        fs.rmSync(extractedExtractDir, { recursive: true, force: true });
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

