import fs from 'fs';
import path from 'path';
import TraceReader from '../processing/TraceReader.js';
import FlightAnalyzer from './FlightAnalyzer.js';
import logger from '../utils/logger.js';

/**
 * Analyzes all flights for an airport on a specific day
 * Creates detailed summaries including distance milestones and timing
 */
class AirportDayAnalyzer {
  constructor(config = {}) {
    this.traceReader = new TraceReader(config);
    this.flightAnalyzer = new FlightAnalyzer(config);
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
    const progressInterval = 50;

    for await (const { icao, trace, registration, aircraftType, description } of this.traceReader.streamAllTraces(extractDir)) {
      processedCount++;

      if (processedCount % progressInterval === 0) {
        logger.info('Analysis progress', {
          airport,
          date,
          processed: processedCount,
          flightsFound: flights.length,
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

      // Add all events to flights array
      for (const event of events) {
        if (event) {
          flights.push(event);
        }
      }
    }

    logger.info('Flight analysis complete', {
      airport,
      date,
      processed: processedCount,
      flightsFound: flights.length,
    });

    // Step 4: Create summary statistics
    const summary = this.createSummary(flights);

    logger.info('Analysis complete', {
      airport,
      date,
      totalFlights: flights.length,
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

