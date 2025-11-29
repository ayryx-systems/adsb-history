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
   * Get previous date string
   * @param {string} date - Date in YYYY-MM-DD format
   * @returns {string|null} Previous date or null if invalid
   */
  getPreviousDate(date) {
    try {
      const d = new Date(date + 'T00:00:00Z');
      d.setUTCDate(d.getUTCDate() - 1);
      return d.toISOString().split('T')[0];
    } catch (error) {
      return null;
    }
  }

  /**
   * Merge two traces chronologically
   * @param {Array} trace1 - First trace array
   * @param {Array} trace2 - Second trace array
   * @returns {Array} Merged trace sorted by timestamp
   */
  mergeTraces(trace1, trace2) {
    if (!trace1 || !Array.isArray(trace1) || trace1.length === 0) {
      return trace2 || [];
    }
    if (!trace2 || !Array.isArray(trace2) || trace2.length === 0) {
      return trace1 || [];
    }

    const merged = [...trace1, ...trace2];
    merged.sort((a, b) => {
      const ts1 = Array.isArray(a) ? a[0] : 0;
      const ts2 = Array.isArray(b) ? b[0] : 0;
      return ts1 - ts2;
    });
    return merged;
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

    const previousDate = this.getPreviousDate(date);
    let previousExtractDir = null;
    if (previousDate) {
      try {
        previousExtractDir = await this.traceReader.downloadExtractedTraces(airport, previousDate);
        if (previousExtractDir) {
          logger.info('Downloaded previous day traces for milestone lookup', {
            airport,
            date,
            previousDate,
          });
        }
      } catch (error) {
        logger.warn('Could not load previous day traces (may not exist)', {
          airport,
          date,
          previousDate,
          error: error.message,
        });
      }
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
      let events = this.flightAnalyzer.analyzeFlight(
        icao,
        trace,
        airportConfig,
        date,
        { registration, aircraftType, description }
      );

      // Check if any arrivals are missing milestones and look in previous day if available
      if (previousExtractDir) {
        const earlyDayThreshold = 2 * 60 * 60; // 2 hours after midnight UTC
        const dateObj = new Date(date + 'T00:00:00Z');
        const dayStartTimestamp = Math.floor(dateObj.getTime() / 1000);

        for (const event of events) {
          if (event && event.classification === 'arrival' && event.touchdown) {
            const touchdownTime = event.touchdown.timestamp;
            const timeSinceMidnight = touchdownTime - dayStartTimestamp;
            
            // Check if arrival is early in the day and missing milestones
            const missingMilestones = !event.milestones.timeFrom100nm || 
                                     !event.milestones.timeFrom50nm || 
                                     !event.milestones.timeFrom20nm;
            
            if (timeSinceMidnight < earlyDayThreshold && missingMilestones) {
              logger.info('Arrival missing milestones, checking previous day', {
                airport,
                date,
                icao,
                touchdownTime: new Date(touchdownTime * 1000).toISOString(),
                missingMilestones: {
                  timeFrom100nm: !event.milestones.timeFrom100nm,
                  timeFrom50nm: !event.milestones.timeFrom50nm,
                  timeFrom20nm: !event.milestones.timeFrom20nm,
                },
              });

              // Look up trace in previous day
              const previousTrace = await this.traceReader.getTraceByICAO(previousExtractDir, icao);
              
              if (previousTrace && previousTrace.trace && Array.isArray(previousTrace.trace)) {
                // Merge traces chronologically
                const mergedTrace = this.mergeTraces(previousTrace.trace, trace);
                
                // Re-analyze with merged trace
                const mergedEvents = this.flightAnalyzer.analyzeFlight(
                  icao,
                  mergedTrace,
                  airportConfig,
                  date,
                  { 
                    registration: previousTrace.registration || registration,
                    aircraftType: previousTrace.aircraftType || aircraftType,
                    description: previousTrace.description || description,
                  }
                );

                // Find the arrival event in merged results
                const mergedArrival = mergedEvents.find(e => 
                  e && 
                  e.classification === 'arrival' && 
                  e.touchdown &&
                  Math.abs(e.touchdown.timestamp - touchdownTime) < 300 // Within 5 minutes
                );

                if (mergedArrival && mergedArrival.milestones) {
                  // Check if merged trace has better milestone data
                  const hasBetterMilestones = 
                    (!event.milestones.timeFrom100nm && mergedArrival.milestones.timeFrom100nm) ||
                    (!event.milestones.timeFrom50nm && mergedArrival.milestones.timeFrom50nm) ||
                    (!event.milestones.timeFrom20nm && mergedArrival.milestones.timeFrom20nm);

                  if (hasBetterMilestones) {
                    logger.info('Found better milestones from previous day', {
                      airport,
                      date,
                      icao,
                      originalMilestones: Object.keys(event.milestones).length,
                      mergedMilestones: Object.keys(mergedArrival.milestones).length,
                    });

                    // Replace the event with the merged one
                    const eventIndex = events.indexOf(event);
                    if (eventIndex >= 0) {
                      events[eventIndex] = mergedArrival;
                    }
                  }
                }
              }
            }
          }
        }
      }

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

    // Clean up previous day's extracted traces directory if we used it
    if (previousExtractDir && previousDate) {
      const previousExtractedTarPath = path.join(this.traceReader.tempDir, 'extracted', airport, previousDate, `${airport}-${previousDate}.tar`);
      const previousExtractedExtractDir = path.join(path.dirname(previousExtractedTarPath), 'extracted');
      if (fs.existsSync(previousExtractedExtractDir)) {
        fs.rmSync(previousExtractedExtractDir, { recursive: true, force: true });
        logger.info('Cleaned up previous day extracted traces directory', { airport, previousDate, path: previousExtractedExtractDir });
      }
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

