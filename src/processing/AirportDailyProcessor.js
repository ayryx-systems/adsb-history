import fs from 'fs';
import path from 'path';
import TraceReader from './TraceReader.js';
import FlightClassifier from './FlightClassifier.js';
import logger from '../utils/logger.js';

/**
 * Processes all flights for a specific airport on a given day
 * 
 * This creates the abstraction layer: processes raw trace data once
 * and generates structured flight information.
 */
class AirportDailyProcessor {
  constructor(config = {}) {
    this.traceReader = new TraceReader(config);
    this.flightClassifier = new FlightClassifier(config);
  }

  /**
   * Process all flights for an airport on a specific date
   * @param {string} date - Date in YYYY-MM-DD format
   * @param {object} airport - Airport configuration
   * @returns {object} Processed flight data
   */
  async processAirportDay(date, airport) {
    logger.info('Processing airport day', { date, airport: airport.icao });

    const startTime = Date.now();
    const results = {
      date,
      airport: airport.icao,
      airportName: airport.name,
      flights: {
        arrivals: [],
        departures: [],
        touch_and_go: [],
        overflights: [],
      },
      statistics: {
        total: 0,
        arrivals: 0,
        departures: 0,
        touch_and_go: 0,
        overflights: 0,
      },
      processingInfo: {
        startTime,
        endTime: null,
        duration: null,
        tracesProcessed: 0,
        tracesClassified: 0,
      },
    };

    try {
      // Step 1: Download extracted traces for this airport from S3
      logger.info('Step 1: Downloading extracted traces from S3', { date, airport: airport.icao });
      const extractDir = await this.traceReader.downloadExtractedTraces(airport.icao, date);
      
      if (!extractDir) {
        throw new Error(`Extracted traces not found for ${airport.icao} on ${date}. Run extraction phase first.`);
      }
      
      logger.info('Extracted traces downloaded and extracted', { date, airport: airport.icao, extractDir });

      // Step 2: Stream and classify all traces
      logger.info('Step 2: Processing traces', { date, airport: airport.icao });
      
      let processedCount = 0;
      const progressInterval = 10000; // Log every 10k traces

      for await (const { icao, trace } of this.traceReader.streamAllTraces(extractDir)) {
        processedCount++;
        results.processingInfo.tracesProcessed = processedCount;

        if (processedCount % progressInterval === 0) {
          logger.info('Processing progress', {
            date,
            airport: airport.icao,
            tracesProcessed: processedCount,
            classified: results.processingInfo.tracesClassified,
          });
        }

        // Classify the flight
        const classification = this.flightClassifier.classifyFlight(trace, airport, date);

        if (classification) {
          results.processingInfo.tracesClassified++;

          // Get flight summary
          const summary = this.flightClassifier.getFlightSummary(trace, classification);

          const flightInfo = {
            icao,
            ...summary,
            timestamp: classification.timeRange.first,
            dateTime: new Date(classification.timeRange.first * 1000).toISOString(),
          };

          // Add to appropriate category
          // Map singular classification to plural key
          const categoryMap = {
            'arrival': 'arrivals',
            'departure': 'departures',
            'touch_and_go': 'touch_and_go',
            'overflight': 'overflights',
          };
          const category = categoryMap[classification.classification] || classification.classification;
          
          if (results.flights[category]) {
            results.flights[category].push(flightInfo);
          }

          results.statistics.total++;
          if (results.statistics[category] !== undefined) {
            results.statistics[category]++;
          }
        }
      }

      // Sort flights by timestamp
      for (const category of Object.keys(results.flights)) {
        results.flights[category].sort((a, b) => a.timestamp - b.timestamp);
      }

      // Update processing info
      results.processingInfo.endTime = Date.now();
      results.processingInfo.duration = results.processingInfo.endTime - startTime;

      logger.info('Airport day processing complete', {
        date,
        airport: airport.icao,
        statistics: results.statistics,
        duration: `${(results.processingInfo.duration / 1000).toFixed(1)}s`,
      });

      // Clean up extracted traces directory
      logger.info('Cleaning up extracted data', { date, airport: airport.icao });
      const extractedTarPath = path.join(this.traceReader.tempDir, 'extracted', airport.icao, date, `${airport.icao}-${date}.tar`);
      const extractedExtractDir = path.join(path.dirname(extractedTarPath), 'extracted');
      if (fs.existsSync(extractedExtractDir)) {
        fs.rmSync(extractedExtractDir, { recursive: true, force: true });
      }

      return results;

    } catch (error) {
      logger.error('Failed to process airport day', {
        date,
        airport: airport.icao,
        error: error.message,
        stack: error.stack,
      });
      throw error;
    }
  }

  /**
   * Get just arrivals for an airport on a specific date
   * Optimized version that only returns arrival list
   */
  async getArrivals(date, airport) {
    const results = await this.processAirportDay(date, airport);
    return results.flights.arrivals;
  }

  /**
   * Get just departures for an airport on a specific date
   */
  async getDepartures(date, airport) {
    const results = await this.processAirportDay(date, airport);
    return results.flights.departures;
  }
}

export default AirportDailyProcessor;

