import logger from '../../utils/logger.js';
import { getSeason } from '../../utils/dst.js';

/**
 * Calculate distance between two coordinates using Haversine formula
 */
function calculateDistance(lat1, lon1, lat2, lon2) {
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
 * Get 15-minute time slot key from hour and minute
 */
function getTimeSlot(hour, minute) {
  const slotMinute = Math.floor(minute / 15) * 15;
  const hourStr = hour.toString().padStart(2, '0');
  const minStr = slotMinute.toString().padStart(2, '0');
  return `${hourStr}:${minStr}`;
}

/**
 * Analyzes flight data to calculate congestion metrics
 * Congestion = number of aircraft within 50nm radius that are landing in the next 2 hours
 */
class CongestionAnalyzer {
  constructor(config = {}) {
    this.congestionRadius = config.congestionRadius || 50; // nm
    this.lookaheadHours = config.lookaheadHours || 2; // hours
  }

  /**
   * Get next date string
   */
  getNextDate(date) {
    try {
      const d = new Date(date + 'T00:00:00Z');
      d.setUTCDate(d.getUTCDate() + 1);
      return d.toISOString().split('T')[0];
    } catch (error) {
      return null;
    }
  }

  /**
   * Find position in trace at a specific timestamp
   * Returns interpolated position if exact match not found
   */
  findPositionAtTime(trace, targetTimestamp, airportLat, airportLon) {
    if (!trace || !Array.isArray(trace) || trace.length === 0) {
      return null;
    }

    // Find closest positions before and after target time
    let before = null;
    let after = null;

    for (const pos of trace) {
      if (!Array.isArray(pos) || pos.length < 4) continue;
      
      const timestamp = pos[0];
      const lat = pos[1];
      const lon = pos[2];

      if (lat === null || lon === null) continue;

      if (timestamp <= targetTimestamp) {
        if (!before || timestamp > before.timestamp) {
          before = { timestamp, lat, lon };
        }
      }
      if (timestamp >= targetTimestamp) {
        if (!after || timestamp < after.timestamp) {
          after = { timestamp, lat, lon };
        }
      }
    }

    // If exact match
    if (before && before.timestamp === targetTimestamp) {
      return before;
    }

    // If we have both before and after, interpolate
    if (before && after && before.timestamp !== after.timestamp) {
      const ratio = (targetTimestamp - before.timestamp) / (after.timestamp - before.timestamp);
      return {
        timestamp: targetTimestamp,
        lat: before.lat + (after.lat - before.lat) * ratio,
        lon: before.lon + (after.lon - before.lon) * ratio,
      };
    }

    // If only before or after, use that
    if (before) return before;
    if (after) return after;

    return null;
  }

  /**
   * Get UTC offset in hours for a given date and airport
   */
  getUTCOffsetHours(airportConfig, date) {
    const timezone = airportConfig.timezone;
    if (!timezone) {
      logger.warn('No timezone configured for airport, defaulting to UTC', {
        airport: airportConfig.icao,
      });
      return 0;
    }

    const [year] = date.split('-');
    const season = getSeason(date, airportConfig.icao, year);

    const offsets = {
      'America/Los_Angeles': { winter: -8, summer: -7 },
      'America/Denver': { winter: -7, summer: -6 },
      'America/Chicago': { winter: -6, summer: -5 },
      'America/New_York': { winter: -5, summer: -4 },
    };

    const offset = offsets[timezone];
    if (!offset) {
      logger.warn('Unknown timezone, defaulting to UTC', {
        airport: airportConfig.icao,
        timezone,
      });
      return 0;
    }

    return season === 'summer' ? offset.summer : offset.winter;
  }

  /**
   * Get local date string (YYYY-MM-DD) from UTC timestamp
   */
  getLocalDateFromTimestamp(utcTimestamp, airportConfig, referenceDate) {
    const offsetHours = this.getUTCOffsetHours(airportConfig, referenceDate);
    const offsetSeconds = offsetHours * 3600;
    const localTimestamp = utcTimestamp + offsetSeconds;
    const localDateObj = new Date(localTimestamp * 1000);
    
    const year = localDateObj.getUTCFullYear();
    const month = String(localDateObj.getUTCMonth() + 1).padStart(2, '0');
    const day = String(localDateObj.getUTCDate()).padStart(2, '0');
    
    return `${year}-${month}-${day}`;
  }

  /**
   * Convert UTC timestamp to local time slot (HH:MM format)
   */
  utcToLocalTimeSlot(utcTimestamp, airportConfig, localDate) {
    const offsetHours = this.getUTCOffsetHours(airportConfig, localDate);
    const offsetSeconds = offsetHours * 3600;
    const localTimestamp = utcTimestamp + offsetSeconds;
    const localDateObj = new Date(localTimestamp * 1000);
    
    const hour = localDateObj.getUTCHours();
    const minute = localDateObj.getUTCMinutes();
    const slotMinute = Math.floor(minute / 15) * 15;
    
    return getTimeSlot(hour, slotMinute);
  }

  /**
   * Analyze congestion for a specific day
   * @param {Array} currentDayFlights - Flights from current day
   * @param {Array} nextDayFlights - Flights from next day (for 2-hour lookahead)
   * @param {object} airportConfig - Airport configuration
   * @param {string} date - Local date in YYYY-MM-DD format
   * @returns {object} Congestion statistics with local time slots
   */
  analyze(currentDayFlights, nextDayFlights, airportConfig, date) {
    logger.debug('Starting congestion analysis', {
      airport: airportConfig.icao,
      date,
      currentDayFlights: currentDayFlights.length,
      nextDayFlights: nextDayFlights.length,
    });

    const airportLat = airportConfig.coordinates.lat;
    const airportLon = airportConfig.coordinates.lon;
    const offsetHours = this.getUTCOffsetHours(airportConfig, date);
    
    // Create local time slots (00:00 to 23:45 local time)
    const timeSlots = {};
    for (let hour = 0; hour < 24; hour++) {
      for (let minute = 0; minute < 60; minute += 15) {
        const slot = getTimeSlot(hour, minute);
        // Calculate UTC timestamp for this local time slot
        const [year, month, day] = date.split('-').map(Number);
        const localDateObj = new Date(Date.UTC(year, month - 1, day, hour, minute));
        const utcTimestamp = Math.floor((localDateObj.getTime() - offsetHours * 3600 * 1000) / 1000);
        timeSlots[slot] = {
          timestamp: utcTimestamp,
          congestion: 0,
          entries: 0,
        };
      }
    }

    const lookaheadSeconds = this.lookaheadHours * 60 * 60;

    // Filter for arrivals only
    const arrivals = [...currentDayFlights, ...nextDayFlights].filter(
      f => f.classification === 'arrival' && f.touchdown && f.touchdown.timestamp
    );

    logger.debug('Filtered arrivals', { arrivals: arrivals.length });

    if (arrivals.length === 0) {
      return {
        airport: airportConfig.icao,
        date,
        generatedAt: new Date().toISOString(),
        byTimeSlotLocal: {},
      };
    }
    
    for (const arrival of arrivals) {
      const touchdownTime = arrival.touchdown.timestamp;

      // Determine when aircraft was at 50nm
      let timeAt50nm = null;

      if (arrival.milestones && arrival.milestones.timeFrom50nm) {
        // Aircraft was at 50nm this many seconds before touchdown
        timeAt50nm = touchdownTime - arrival.milestones.timeFrom50nm;
      } else {
        // Estimate: typical approach from 50nm takes ~15-20 minutes
        // Use 18 minutes (1080 seconds) as default
        timeAt50nm = touchdownTime - (18 * 60);
      }

      if (timeAt50nm >= touchdownTime) {
        continue; // Invalid: entry after touchdown
      }

      // Count entries in the local time slot where they occur
      // Convert UTC timestamp to local time slot
      const entryLocalSlot = this.utcToLocalTimeSlot(timeAt50nm, airportConfig, date);
      
      // Only count entries that occur on the current local date
      // Check if the entry timestamp falls on the same local date as the date parameter
      const entryLocalDate = this.getLocalDateFromTimestamp(timeAt50nm, airportConfig, date);
      if (entryLocalDate === date && timeSlots[entryLocalSlot]) {
        timeSlots[entryLocalSlot].entries++;
      }
    }

    // Second pass: For each local time slot, count aircraft that:
    // 1. Are landing within the next 2 hours (even if on next day)
    // 2. Were within 50nm at the slot time
    for (const [slot, slotData] of Object.entries(timeSlots)) {
      const slotTimestamp = slotData.timestamp;
      const lookaheadEnd = slotTimestamp + lookaheadSeconds;

      let congestionCount = 0;

      for (const arrival of arrivals) {
        const touchdownTime = arrival.touchdown.timestamp;

        // Check if landing is within lookahead window (next 2 hours)
        if (touchdownTime <= slotTimestamp || touchdownTime > lookaheadEnd) {
          continue;
        }

        // Determine when aircraft was at 50nm
        let timeAt50nm = null;

        if (arrival.milestones && arrival.milestones.timeFrom50nm) {
          timeAt50nm = touchdownTime - arrival.milestones.timeFrom50nm;
        } else {
          timeAt50nm = touchdownTime - (18 * 60);
        }

        // Check if aircraft was within 50nm at the slot time
        if (timeAt50nm <= slotTimestamp && slotTimestamp < touchdownTime) {
          congestionCount++;
        }
      }

      timeSlots[slot].congestion = congestionCount;
    }

    logger.info('Congestion analysis complete', {
      airport: airportConfig.icao,
      date,
      timeSlots: Object.keys(timeSlots).length,
    });

    return {
      airport: airportConfig.icao,
      date,
      generatedAt: new Date().toISOString(),
      byTimeSlotLocal: Object.fromEntries(
        Object.entries(timeSlots).map(([slot, data]) => [
          slot,
          {
            congestion: data.congestion,
            entries: data.entries,
          },
        ])
      ),
    };
  }
}

export default CongestionAnalyzer;


