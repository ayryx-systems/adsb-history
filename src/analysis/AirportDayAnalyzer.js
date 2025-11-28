import fs from 'fs';
import path from 'path';
import TraceReader from '../processing/TraceReader.js';
import FlightAnalyzer from './FlightAnalyzer.js';
import SimplifiedTraceData from './SimplifiedTraceData.js';
import logger from '../utils/logger.js';

/**
 * Analyzes all flights for an airport on a specific day
 * Creates detailed summaries including distance milestones and timing
 */
class AirportDayAnalyzer {
  constructor(config = {}) {
    this.traceReader = new TraceReader(config);
    this.flightAnalyzer = new FlightAnalyzer(config);
    this.traceData = new SimplifiedTraceData(config);
  }

  /**
   * Simplify a trace to minimal format for visualization
   * @param {Array} trace - Full trace array from readsb format
   * @param {object} metadata - Aircraft metadata
   * @returns {object} Simplified trace data or null if invalid
   */
  simplifyTrace(trace, metadata = {}) {
    if (!trace || !Array.isArray(trace) || trace.length === 0) {
      return null;
    }

    const points = [];
    let minAlt = Infinity;
    let maxAlt = -Infinity;
    let startTime = null;
    let endTime = null;

    for (const point of trace) {
      if (!Array.isArray(point) || point.length < 4) continue;

      const timestamp = point[0];
      const lat = point[1];
      const lon = point[2];
      const alt = point[3];
      const track = point[5] || null;

      if (lat === null || lon === null || alt === null) continue;

      const altNum = typeof alt === 'number' ? alt : 0;
      if (altNum < minAlt) minAlt = altNum;
      if (altNum > maxAlt) maxAlt = altNum;

      if (startTime === null) startTime = timestamp;
      endTime = timestamp;

      points.push([
        lat,
        lon,
        altNum,
        timestamp,
        track !== null && track !== undefined ? Math.round(track) : null,
      ]);
    }

    if (points.length === 0) {
      return null;
    }

    return {
      points,
      metadata: {
        registration: metadata.registration || null,
        aircraftType: metadata.aircraftType || null,
        description: metadata.description || null,
        minAlt: minAlt === Infinity ? 0 : minAlt,
        maxAlt: maxAlt === -Infinity ? 0 : maxAlt,
        startTime,
        endTime,
        pointCount: points.length,
      },
    };
  }

  /**
   * Analyze all flights for an airport on a specific date
   * @param {string} airport - Airport ICAO code
   * @param {string} date - Date in YYYY-MM-DD format
   * @param {object} airportConfig - Airport configuration object
   * @returns {object} Analysis results with flights and summary statistics
   */
  async analyzeDay(airport, date, airportConfig) {
    logger.info('Starting airport day analysis', { airport, date });

    logger.info('Step 1: Downloading extracted traces', { airport, date });
    const extractDir = await this.traceReader.downloadExtractedTraces(airport, date);

    if (!extractDir) {
      throw new Error(
        `Extracted traces not found for ${airport} on ${date}. ` +
        `Please run extraction first: node scripts/extraction/extract-all-airports.js --start-date ${date} --end-date ${date}`
      );
    }

    logger.info('Step 2: Analyzing flights', {
      airport,
      date,
    });

    const flights = [];
    let processedCount = 0;
    let tracesSaved = 0;
    const savedIcaos = new Set();
    const progressInterval = 50;

    for await (const { icao, trace, registration, aircraftType, description } of this.traceReader.streamAllTraces(extractDir)) {
      processedCount++;

      if (processedCount % progressInterval === 0) {
        logger.info('Analysis progress', {
          airport,
          date,
          processed: processedCount,
          flightsFound: flights.length,
          tracesSaved,
        });
      }

      // Analyze this flight (may return multiple events)
      const events = this.flightAnalyzer.analyzeFlight(
        icao,
        trace,
        airportConfig,
        date,
        { registration, aircraftType, description }
      );

      // Track classifications for this ICAO
      const classifications = [];

      // Add all events to flights array
      for (const event of events) {
        if (event) {
          flights.push(event);
          if (event.classification === 'arrival' || event.classification === 'departure') {
            classifications.push(event.classification);
          }
        }
      }

      // Save simplified trace for arrivals and departures (once per ICAO)
      if (classifications.length > 0 && !savedIcaos.has(icao)) {
        try {
          const simplifiedTrace = this.simplifyTrace(trace, {
            registration,
            aircraftType,
            description,
          });

          if (simplifiedTrace) {
            await this.traceData.save(airport, date, icao, {
              icao,
              date,
              airport,
              classifications,
              ...simplifiedTrace,
            });
            savedIcaos.add(icao);
            tracesSaved++;
          }
        } catch (error) {
          logger.warn('Failed to save simplified trace', {
            airport,
            date,
            icao,
            error: error.message,
          });
        }
      }
    }

    logger.info('Flight analysis complete', {
      airport,
      date,
      processed: processedCount,
      flightsFound: flights.length,
      tracesSaved,
    });

    // Step 4: Create summary statistics
    const summary = this.createSummary(flights);

    logger.info('Analysis complete', {
      airport,
      date,
      totalFlights: flights.length,
      tracesSaved,
      summary,
    });

    // Clean up extracted traces directory
    logger.info('Cleaning up extracted data', { airport, date });
    const extractedTarPath = path.join(this.traceReader.tempDir, 'extracted', airport, date, `${airport}-${date}.tar`);
    const extractedExtractDir = path.join(path.dirname(extractedTarPath), 'extracted');
    if (fs.existsSync(extractedExtractDir)) {
      fs.rmSync(extractedExtractDir, { recursive: true, force: true });
      logger.info('Cleaned up extracted traces directory', { airport, date, path: extractedExtractDir });
    }

    return {
      airport,
      date,
      airportElevation_ft: airportConfig.elevation_ft || 0,
      flights,
      summary,
      tracesSaved,
    };
  }

  /**
   * Create summary statistics from analyzed flights
   * Excludes overflights and touch-and-go as they are not interesting
   */
  createSummary(flights) {
    const summary = {
      totalMovements: 0,
      arrivals: 0,
      departures: 0,
      missedApproaches: 0,
      other: 0,
    };

    for (const flight of flights) {
      switch (flight.classification) {
        case 'arrival':
          summary.arrivals++;
          summary.totalMovements++;
          break;
        case 'departure':
          summary.departures++;
          summary.totalMovements++;
          break;
        case 'missed_approach':
          summary.missedApproaches++;
          summary.totalMovements++;
          break;
        case 'touch_and_go':
        case 'overflight':
          // Exclude these from summary
          break;
        default:
          summary.other++;
          summary.totalMovements++;
      }
    }

    return summary;
  }
}

export default AirportDayAnalyzer;

