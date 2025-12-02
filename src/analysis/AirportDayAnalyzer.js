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
    this.skipCleanup = config.skipCleanup || false;
  }

  /**
   * Calculate distance between two coordinates using Haversine formula
   * @param {number} lat1 - Latitude 1
   * @param {number} lon1 - Longitude 1
   * @param {number} lat2 - Latitude 2
   * @param {number} lon2 - Longitude 2
   * @returns {number} Distance in nautical miles
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
   * Extract arrival segment from trace using L1 milestone timestamps
   * Uses timeFrom100nm milestone to determine start time (no geometry calculations)
   * @param {Array} trace - Full trace array from readsb format
   * @param {object} airportConfig - Airport configuration (unused, kept for compatibility)
   * @param {number} touchdownTimestamp - Touchdown timestamp (Unix seconds)
   * @param {number} timeFrom100nm - Seconds from 100nm milestone to touchdown (from L1 milestones)
   * @param {object} metadata - Aircraft metadata
   * @param {string} date - Date string for timestamp normalization
   * @returns {object} Simplified trace data for arrival segment or null if invalid
   */
  extractArrivalSegment(trace, airportConfig, touchdownTimestamp, timeFrom100nm, metadata = {}, date = null) {
    if (!trace || !Array.isArray(trace) || trace.length === 0) {
      return null;
    }

    // Calculate start timestamp: when aircraft passed 100nm (using L1 milestone)
    const startTimestamp = touchdownTimestamp - timeFrom100nm;

    // Normalize timestamps: check if trace has relative timestamps and normalize if needed
    let baseTimestamp = null;
    if (date) {
      const dateObj = new Date(date + 'T00:00:00Z');
      baseTimestamp = Math.floor(dateObj.getTime() / 1000);
    }
    
    // Check if trace timestamps are relative (small values < 2 days) and need normalization
    const needsNormalization = trace.length > 0 && 
      Array.isArray(trace[0]) && 
      trace[0][0] < 86400 * 2 && 
      baseTimestamp !== null;
    
    const normalizeTimestamp = (ts) => {
      if (needsNormalization && ts < 86400 * 2) {
        return baseTimestamp + ts;
      }
      return ts;
    };

    const points = [];
    let minAlt = Infinity;
    let maxAlt = -Infinity;
    let startTime = null;
    let endTime = null;

    // Extract all points between startTimestamp (100nm) and touchdownTimestamp
    for (const point of trace) {
      if (!Array.isArray(point) || point.length < 4) continue;

      const timestamp = normalizeTimestamp(point[0]);
      const lat = point[1];
      const lon = point[2];
      const alt = point[3];
      const track = point[5] || null;

      if (lat === null || lon === null || alt === null) continue;

      // Include points from 100nm milestone to touchdown (inclusive)
      if (timestamp >= startTimestamp && timestamp <= touchdownTimestamp) {
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
    }

    // If no points found in the time range, return null
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
        startTime: points[0][3],
        endTime: points[points.length - 1][3],
        pointCount: points.length,
        touchdownTimestamp,
      },
    };
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
   * Merge two traces chronologically, normalizing timestamps
   * @param {Array} trace1 - First trace array (from previous day)
   * @param {Array} trace2 - Second trace array (from current day)
   * @param {string} previousDate - Previous date in YYYY-MM-DD format
   * @param {string} currentDate - Current date in YYYY-MM-DD format
   * @returns {Array} Merged trace sorted by timestamp with normalized timestamps
   */
  mergeTraces(trace1, trace2, previousDate, currentDate) {
    if (!trace1 || !Array.isArray(trace1) || trace1.length === 0) {
      return trace2 || [];
    }
    if (!trace2 || !Array.isArray(trace2) || trace2.length === 0) {
      return trace1 || [];
    }

    // Calculate base timestamps for normalization
    const previousBaseTimestamp = previousDate ? Math.floor(new Date(previousDate + 'T00:00:00Z').getTime() / 1000) : null;
    const currentBaseTimestamp = currentDate ? Math.floor(new Date(currentDate + 'T00:00:00Z').getTime() / 1000) : null;

    // Normalize timestamps: if timestamp is relative (< 86400 * 2), add base timestamp
    const normalizeTrace = (trace, baseTimestamp) => {
      if (!baseTimestamp) return trace;
      return trace.map(pos => {
        if (!Array.isArray(pos) || pos.length < 6) return pos;
        const timestamp = pos[0];
        // If timestamp is relative (seconds since midnight), normalize it
        if (timestamp >= 0 && timestamp < 86400 * 2) {
          const normalized = [...pos];
          normalized[0] = baseTimestamp + timestamp;
          return normalized;
        }
        return pos; // Already absolute
      });
    };

    const normalizedTrace1 = normalizeTrace(trace1, previousBaseTimestamp);
    const normalizedTrace2 = normalizeTrace(trace2, currentBaseTimestamp);

    const merged = [...normalizedTrace1, ...normalizedTrace2];
    merged.sort((a, b) => {
      const ts1 = Array.isArray(a) ? a[0] : 0;
      const ts2 = Array.isArray(b) ? b[0] : 0;
      return ts1 - ts2;
    });
    return merged;
  }

  /**
   * Recalculate milestones from merged trace using original touchdown as reference
   * @param {Array} mergedTrace - Merged trace array
   * @param {object} originalTouchdown - Original touchdown position with timestamp, lat, lon
   * @param {object} airportConfig - Airport configuration
   * @returns {object} Milestone times object
   */
  recalculateMilestonesFromMergedTrace(mergedTrace, originalTouchdown, airportConfig) {
    // Import parsePosition and calculateDistance from FlightAnalyzer's scope
    // For now, we'll use the flightAnalyzer to parse positions
    const airportLat = airportConfig.coordinates.lat;
    const airportLon = airportConfig.coordinates.lon;

    // Parse positions from merged trace (timestamps should already be normalized to absolute)
    const positions = mergedTrace
      .map(pos => {
        if (!Array.isArray(pos) || pos.length < 6) return null;
        let timestamp = pos[0];
        // If timestamp is still relative (shouldn't happen after mergeTraces normalization, but check anyway)
        if (timestamp >= 0 && timestamp < 86400 * 2) {
          // This shouldn't happen if mergeTraces worked correctly, but handle it
          logger.warn('Found relative timestamp in merged trace, this should not happen', { timestamp });
          return null; // Skip relative timestamps that weren't normalized
        }
        const lat = pos[1];
        const lon = pos[2];
        let alt_baro = pos[3];
        if (alt_baro === "ground" || alt_baro === null) {
          alt_baro = 0;
        } else if (typeof alt_baro === 'string') {
          alt_baro = parseFloat(alt_baro);
          if (isNaN(alt_baro)) alt_baro = null;
        }
        if (lat === null || lon === null || alt_baro === null) return null;
        return { timestamp, lat, lon, alt_baro };
      })
      .filter(pos => pos !== null);

    if (positions.length < 5) {
      return {};
    }

    // Calculate distance from airport for each position
    const positionsWithDistance = positions.map(pos => {
      // Calculate distance using haversine formula
      const R = 3440.065; // Earth radius in nautical miles
      const dLat = (pos.lat - airportLat) * Math.PI / 180;
      const dLon = (pos.lon - airportLon) * Math.PI / 180;
      const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
                Math.cos(airportLat * Math.PI / 180) * Math.cos(pos.lat * Math.PI / 180) *
                Math.sin(dLon / 2) * Math.sin(dLon / 2);
      const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
      const distance = R * c;
      
      return { ...pos, distance };
    });

    // Sort by timestamp
    positionsWithDistance.sort((a, b) => a.timestamp - b.timestamp);

    // Find the touchdown position in merged trace (match by timestamp within 60 seconds and proximity)
    const touchdownTolerance = 60; // seconds
    const touchdownPos = positionsWithDistance.find(p => 
      Math.abs(p.timestamp - originalTouchdown.timestamp) < touchdownTolerance &&
      Math.abs(p.lat - originalTouchdown.lat) < 0.01 &&
      Math.abs(p.lon - originalTouchdown.lon) < 0.01
    );

    if (!touchdownPos) {
      return {};
    }

    // Find touchdown index
    const touchdownIndex = positionsWithDistance.findIndex(p => 
      p.timestamp === touchdownPos.timestamp &&
      p.lat === touchdownPos.lat &&
      p.lon === touchdownPos.lon
    );

    if (touchdownIndex < 0) {
      return {};
    }

    // Calculate milestones working backwards from touchdown
    const milestones = [100, 50, 20];
    const milestoneTimes = {};

    for (const milestone of milestones) {
      let milestonePos = null;
      for (let i = touchdownIndex - 1; i >= 0; i--) {
        const pos = positionsWithDistance[i];
        if (pos.distance >= milestone) {
          milestonePos = pos;
          break;
        }
      }
      
      if (milestonePos) {
        const timeToTouchdown = originalTouchdown.timestamp - milestonePos.timestamp;
        if (timeToTouchdown > 0 && timeToTouchdown < 24 * 60 * 60) { // Reasonable range: 0 to 24 hours
          milestoneTimes[`timeFrom${milestone}nm`] = timeToTouchdown;
        }
      }
    }

    return milestoneTimes;
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

    logger.debug('Loading extracted traces', { airport, date });
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
          logger.debug('Loaded previous day traces for milestone lookup', {
            airport,
            date,
            previousDate,
          });
        }
      } catch (error) {
        logger.debug('Previous day traces not available', {
          airport,
          date,
          previousDate,
        });
      }
    }

    const flights = [];
    let processedCount = 0;
    let tracesSaved = 0;
    const savedArrivals = new Set(); // Track saved arrivals by icao-touchdownTimestamp
    const progressInterval = 500;
    const traceCache = new Map(); // Cache traces by ICAO to avoid re-reading

    for await (const { icao, trace, registration, aircraftType, description } of this.traceReader.streamAllTraces(extractDir)) {
      processedCount++;

      if (processedCount % progressInterval === 0) {
        logger.debug('Analysis progress', {
          airport,
          date,
          processed: processedCount,
          flightsFound: flights.length,
          tracesSaved,
        });
      }

      // Cache the current day's trace
      traceCache.set(icao, { trace, registration, aircraftType, description });

      // Analyze this flight (may return multiple events)
      let events = this.flightAnalyzer.analyzeFlight(
        icao,
        trace,
        airportConfig,
        date,
        { registration, aircraftType, description }
      );

      // Check previous day's trace for arrivals that land early on current day
      // This handles cases where the approach happened on previous day but landing is on current day
      // Always check, not just when events.length === 0, to catch arrivals that might not be detected
      // in the current day's short trace
      let mergedTrace = null;
      if (previousExtractDir) {
        const earlyDayThreshold = 2 * 60 * 60; // 2 hours after midnight UTC
        const dateObj = new Date(date + 'T00:00:00Z');
        const dayStartTimestamp = Math.floor(dateObj.getTime() / 1000);
        
        // Check if we already have an arrival that lands early on current day
        const hasEarlyArrival = events.some(event => 
          event && event.classification === 'arrival' && event.touchdown &&
          event.touchdown.timestamp >= dayStartTimestamp &&
          event.touchdown.timestamp < dayStartTimestamp + earlyDayThreshold
        );
        
        // If we don't have an early arrival, check previous day's trace
        if (!hasEarlyArrival) {
          // Look up trace in previous day
          const previousTrace = await this.traceReader.getTraceByICAO(previousExtractDir, icao);
          
          if (previousTrace && previousTrace.trace && Array.isArray(previousTrace.trace)) {
            // Merge traces chronologically with timestamp normalization
            mergedTrace = this.mergeTraces(previousTrace.trace, trace, previousDate, date);
            
            // Re-analyze merged trace to find arrivals that land on current day
            const mergedEvents = this.flightAnalyzer.analyzeFlight(
              icao,
              mergedTrace,
              airportConfig,
              null, // Pass null to preserve absolute timestamps
              { registration, aircraftType, description }
            );
            
            // Filter merged events to only include arrivals that land early on current day
            for (const event of mergedEvents) {
              if (event && event.classification === 'arrival' && event.touchdown) {
                const touchdownTime = event.touchdown.timestamp;
                const timeSinceMidnight = touchdownTime - dayStartTimestamp;
                
                if (timeSinceMidnight >= 0 && timeSinceMidnight < earlyDayThreshold) {
                  // This arrival lands early on current day, include it
                  // Mark this event as using merged trace
                  event._useMergedTrace = true;
                  events.push(event);
                  logger.debug('Found arrival from previous day trace that lands on current day', {
                    airport,
                    date,
                    icao,
                    touchdownTime: new Date(touchdownTime * 1000).toISOString(),
                  });
                }
              }
            }
          }
        }
      }

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
              logger.debug('Arrival missing milestones, checking previous day', {
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
                // Merge traces chronologically with timestamp normalization
                const mergedTrace = this.mergeTraces(previousTrace.trace, trace, previousDate, date);
                
                // Recalculate milestones from merged trace using original touchdown as reference
                const recalculatedMilestones = this.recalculateMilestonesFromMergedTrace(
                  mergedTrace,
                  event.touchdown,
                  airportConfig
                );

                // Check if we got better milestone data
                const hasBetterMilestones = 
                  (!event.milestones.timeFrom100nm && recalculatedMilestones.timeFrom100nm) ||
                  (!event.milestones.timeFrom50nm && recalculatedMilestones.timeFrom50nm) ||
                  (!event.milestones.timeFrom20nm && recalculatedMilestones.timeFrom20nm);

                if (hasBetterMilestones) {
                  // Validate milestone values are reasonable
                  const milestonesValid = 
                    (!recalculatedMilestones.timeFrom100nm || recalculatedMilestones.timeFrom100nm > 0) &&
                    (!recalculatedMilestones.timeFrom50nm || recalculatedMilestones.timeFrom50nm > 0) &&
                    (!recalculatedMilestones.timeFrom20nm || recalculatedMilestones.timeFrom20nm > 0) &&
                    (!recalculatedMilestones.timeFrom100nm || !recalculatedMilestones.timeFrom50nm || 
                     recalculatedMilestones.timeFrom100nm > recalculatedMilestones.timeFrom50nm) &&
                    (!recalculatedMilestones.timeFrom50nm || !recalculatedMilestones.timeFrom20nm || 
                     recalculatedMilestones.timeFrom50nm > recalculatedMilestones.timeFrom20nm);

                  if (milestonesValid) {
                    logger.debug('Found better milestones from previous day', {
                      airport,
                      date,
                      icao,
                      originalMilestones: Object.keys(event.milestones).length,
                      recalculatedMilestones: Object.keys(recalculatedMilestones).length,
                    });

                    // Update the event with recalculated milestones
                    const improvedEvent = {
                      ...event,
                      milestones: {
                        ...event.milestones,
                        ...recalculatedMilestones, // Override with recalculated milestones
                      },
                    };
                    
                    const eventIndex = events.indexOf(event);
                    if (eventIndex >= 0) {
                      events[eventIndex] = improvedEvent;
                    }
                  } else {
                    logger.warn('Recalculated milestones failed validation, skipping', {
                      airport,
                      date,
                      icao,
                      milestones: recalculatedMilestones,
                    });
                  }
                }
              }
            }
          }
        }
      }

      // Track classifications for this ICAO
      const classifications = [];

      // Add all events to flights array and save arrival traces
      for (const event of events) {
        if (event) {
          // Filter arrivals/departures to only include those that occur on the target date
          if (event.classification === 'arrival' && event.touchdown) {
            const touchdownDate = new Date(event.touchdown.timestamp * 1000);
            const eventDateStr = touchdownDate.toISOString().split('T')[0];
            if (eventDateStr !== date) {
              // This arrival lands on a different day, skip it
              continue;
            }

            // Save arrival trace segment (only arrivals, filtered to 100nm)
            // Convert timestamp to integer (seconds) for consistent file naming
            const touchdownTimestampInt = Math.floor(event.touchdown.timestamp);
            const arrivalKey = `${icao}-${touchdownTimestampInt}`;
            if (!savedArrivals.has(arrivalKey)) {
              try {
                // Determine which trace to use: merged trace if available, otherwise current day's trace
                const traceToUse = event._useMergedTrace && mergedTrace ? mergedTrace : trace;
                
                // Extract arrival segment using L1 milestone timestamps
                // Use timeFrom100nm milestone to determine start time (no geometry calculations)
                const timeFrom100nm = event.milestones?.timeFrom100nm;
                if (!timeFrom100nm || timeFrom100nm <= 0) {
                  logger.debug('Arrival missing timeFrom100nm milestone, skipping trace extraction', {
                    airport,
                    date,
                    icao,
                    touchdownTimestamp: event.touchdown.timestamp,
                  });
                  continue;
                }

                const arrivalSegment = this.extractArrivalSegment(
                  traceToUse,
                  airportConfig,
                  event.touchdown.timestamp,
                  timeFrom100nm,
                  { registration, aircraftType, description },
                  date // Pass date for timestamp normalization
                );

                if (arrivalSegment) {
                  // Use UTC date from touchdown timestamp for folder structure
                  // This ensures evening arrivals (next UTC day) are saved in the correct folder
                  const touchdownDate = new Date(event.touchdown.timestamp * 1000);
                  const utcDate = `${touchdownDate.getUTCFullYear()}-${String(touchdownDate.getUTCMonth() + 1).padStart(2, '0')}-${String(touchdownDate.getUTCDate()).padStart(2, '0')}`;
                  
                  await this.traceData.save(
                    airport,
                    utcDate,
                    icao,
                    {
                      icao,
                      date: utcDate,
                      airport,
                      classification: 'arrival',
                      touchdownTimestamp: event.touchdown.timestamp,
                      ...arrivalSegment,
                    },
                    touchdownTimestampInt
                  );
                  savedArrivals.add(arrivalKey);
                  tracesSaved++;
                } else {
                  logger.debug('Arrival segment extraction returned null', {
                    airport,
                    date,
                    icao,
                    touchdownTimestamp: event.touchdown.timestamp,
                    timeFrom100nm,
                    traceLength: traceToUse?.length || 0,
                    hasMergedTrace: !!mergedTrace,
                  });
                }
              } catch (error) {
                logger.warn('Failed to save arrival trace segment', {
                  airport,
                  date,
                  icao,
                  touchdownTimestamp: event.touchdown.timestamp,
                  error: error.message,
                  stack: error.stack,
                });
              }
            }
          }
          if (event.classification === 'departure' && event.takeoff) {
            const takeoffDate = new Date(event.takeoff.timestamp * 1000);
            const eventDateStr = takeoffDate.toISOString().split('T')[0];
            if (eventDateStr !== date) {
              // This departure occurs on a different day, skip it
              continue;
            }
          }
          
          flights.push(event);
          if (event.classification === 'arrival' || event.classification === 'departure') {
            classifications.push(event.classification);
          }
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

    if (!this.skipCleanup) {
      logger.debug('Cleaning up extracted data', { airport, date });
      const extractedTarPath = path.join(this.traceReader.tempDir, 'extracted', airport, date, `${airport}-${date}.tar`);
      const extractedExtractDir = path.join(path.dirname(extractedTarPath), 'extracted');
      if (fs.existsSync(extractedExtractDir)) {
        fs.rmSync(extractedExtractDir, { recursive: true, force: true });
        logger.debug('Cleaned up extracted traces directory', { airport, date });
      }

      if (previousExtractDir && previousDate) {
        const previousExtractedTarPath = path.join(this.traceReader.tempDir, 'extracted', airport, previousDate, `${airport}-${previousDate}.tar`);
        const previousExtractedExtractDir = path.join(path.dirname(previousExtractedTarPath), 'extracted');
        if (fs.existsSync(previousExtractedExtractDir)) {
          fs.rmSync(previousExtractedExtractDir, { recursive: true, force: true });
          logger.debug('Cleaned up previous day extracted traces directory', { airport, previousDate });
        }
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

