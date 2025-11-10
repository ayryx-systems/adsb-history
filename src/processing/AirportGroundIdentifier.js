import TraceReader from './TraceReader.js';
import logger from '../utils/logger.js';

/**
 * Identifies aircraft that have been on the ground at a specific airport
 * 
 * Criteria:
 * - Within 1nm of airport coordinates
 * - Altitude below 500ft or "ground"
 */
class AirportGroundIdentifier {
  constructor(config = {}) {
    this.traceReader = new TraceReader(config);
    this.proximityRadius = config.proximityRadius || 1.0; // nautical miles
    this.maxAltitude = config.maxAltitude || 500; // feet
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

    // Calculate base timestamp
    let baseTimestamp = null;
    if (date) {
      const dateObj = new Date(date + 'T00:00:00Z');
      baseTimestamp = Math.floor(dateObj.getTime() / 1000);
    }

    // Parse positions
    const positions = trace
      .map(pos => this.parsePosition(pos, baseTimestamp))
      .filter(pos => pos && pos.lat !== null && pos.lon !== null && pos.alt_baro !== null);

    if (positions.length === 0) {
      return false;
    }

    // Check if any position is on ground at airport
    for (const pos of positions) {
      const distance = this.calculateDistance(pos.lat, pos.lon, airportLat, airportLon);
      
      if (distance <= this.proximityRadius && pos.alt_baro <= this.maxAltitude) {
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
      // Step 1: Download and extract tar from S3
      console.log(`[${new Date().toISOString()}] Step 1: Downloading tar from S3 for ${date}`);
      logger.info('Step 1: Downloading tar from S3', { date });
      const tarPath = await this.traceReader.downloadTarFromS3(date);
      console.log(`[${new Date().toISOString()}] ✓ Tar downloaded: ${tarPath}`);

      console.log(`[${new Date().toISOString()}] Step 2: Extracting tar`);
      logger.info('Step 2: Extracting tar', { date });
      const extractDir = await this.traceReader.extractTar(tarPath);
      console.log(`[${new Date().toISOString()}] ✓ Tar extracted to: ${extractDir}`);

      // Step 3: Stream and check all traces
      logger.info('Step 3: Processing traces', { date, airport: airport.icao });
      
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

      // Clean up
      console.log(`[${new Date().toISOString()}] Cleaning up extracted data`);
      logger.info('Cleaning up extracted data', { date });
      this.traceReader.cleanup(date);

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

