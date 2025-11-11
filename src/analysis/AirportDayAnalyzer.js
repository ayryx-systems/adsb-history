import TraceReader from '../processing/TraceReader.js';
import GroundAircraftData from '../processing/GroundAircraftData.js';
import FlightAnalyzer from './FlightAnalyzer.js';
import logger from '../utils/logger.js';

/**
 * Analyzes all flights for an airport on a specific day
 * Creates detailed summaries including distance milestones and timing
 */
class AirportDayAnalyzer {
  constructor(config = {}) {
    this.traceReader = new TraceReader(config);
    this.groundAircraftData = new GroundAircraftData(config);
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

    // Step 1: Load ground aircraft list
    logger.info('Step 1: Loading ground aircraft list', { airport, date });
    const aircraftIds = await this.groundAircraftData.load(airport, date);
    
    if (!aircraftIds || aircraftIds.length === 0) {
      logger.warn('No ground aircraft found', { airport, date });
      return {
        airport,
        date,
        airportElevation: airportConfig.elevation_ft || 0,
        flights: [],
        summary: {
          totalAircraft: 0,
          arrivals: 0,
          departures: 0,
          missedApproaches: 0,
          other: 0,
        },
      };
    }

    logger.info('Loaded ground aircraft list', {
      airport,
      date,
      count: aircraftIds.length,
    });

    // Step 2: Download and extract tar from S3
    logger.info('Step 2: Downloading tar from S3', { date });
    const tarPath = await this.traceReader.downloadTarFromS3(date);
    logger.info('Tar downloaded', { tarPath });

    logger.info('Step 3: Extracting tar', { date });
    const extractDir = await this.traceReader.extractTar(tarPath);
    logger.info('Tar extracted', { extractDir });

    // Step 3: Analyze flights for each aircraft
    logger.info('Step 4: Analyzing flights', {
      airport,
      date,
      aircraftCount: aircraftIds.length,
    });

    const flights = [];
    let processedCount = 0;
    const progressInterval = 50;

    // Stream only the traces we need (filtered by ICAO)
    for await (const { icao, trace } of this.traceReader.streamFilteredTraces(
      extractDir,
      aircraftIds
    )) {
      processedCount++;

      if (processedCount % progressInterval === 0) {
        logger.info('Analysis progress', {
          airport,
          date,
          processed: processedCount,
          total: aircraftIds.length,
          flightsFound: flights.length,
        });
      }

      // Analyze this flight
      const analysis = this.flightAnalyzer.analyzeFlight(
        icao,
        trace,
        airportConfig,
        date
      );

      if (analysis) {
        flights.push(analysis);
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

    // Clean up extracted data
    logger.info('Cleaning up extracted data', { date });
    this.traceReader.cleanup(date);

    return {
      airport,
      date,
      airportElevation: airportConfig.elevation_ft || 0,
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
      totalAircraft: 0,
      arrivals: 0,
      departures: 0,
      missedApproaches: 0,
      other: 0,
    };

    for (const flight of flights) {
      switch (flight.classification) {
        case 'arrival':
          summary.arrivals++;
          summary.totalAircraft++;
          break;
        case 'departure':
          summary.departures++;
          summary.totalAircraft++;
          break;
        case 'missed_approach':
          summary.missedApproaches++;
          summary.totalAircraft++;
          break;
        case 'touch_and_go':
        case 'overflight':
          // Exclude these from summary
          break;
        default:
          summary.other++;
          summary.totalAircraft++;
      }
    }

    return summary;
  }
}

export default AirportDayAnalyzer;

