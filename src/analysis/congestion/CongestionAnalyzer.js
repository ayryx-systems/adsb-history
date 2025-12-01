import logger from '../../utils/logger.js';

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
   * Analyze congestion for a specific day
   * @param {Array} currentDayFlights - Flights from current day
   * @param {Array} nextDayFlights - Flights from next day (for 2-hour lookahead)
   * @param {object} airportConfig - Airport configuration
   * @param {string} date - Current date in YYYY-MM-DD format
   * @returns {object} Congestion statistics
   */
  analyze(currentDayFlights, nextDayFlights, airportConfig, date) {
    logger.info('Starting congestion analysis', {
      airport: airportConfig.icao,
      date,
      currentDayFlights: currentDayFlights.length,
      nextDayFlights: nextDayFlights.length,
    });

    const airportLat = airportConfig.coordinates.lat;
    const airportLon = airportConfig.coordinates.lon;
    const dateObj = new Date(date + 'T00:00:00Z');
    const dayStartTimestamp = Math.floor(dateObj.getTime() / 1000);
    const lookaheadSeconds = this.lookaheadHours * 60 * 60;

    // Filter for arrivals only
    const arrivals = [...currentDayFlights, ...nextDayFlights].filter(
      f => f.classification === 'arrival' && f.touchdown && f.touchdown.timestamp
    );

    logger.info('Filtered arrivals', { arrivals: arrivals.length });

    if (arrivals.length === 0) {
      return {
        airport: airportConfig.icao,
        date,
        generatedAt: new Date().toISOString(),
        byTimeSlot: {},
      };
    }

    // Create time slots for the day (15-minute intervals)
    const timeSlots = {};
    for (let hour = 0; hour < 24; hour++) {
      for (let minute = 0; minute < 60; minute += 15) {
        const slot = getTimeSlot(hour, minute);
        timeSlots[slot] = {
          timestamp: dayStartTimestamp + hour * 3600 + minute * 60,
          congestion: 0,
          entries: 0,
        };
      }
    }

    // First pass: Count aircraft entering 50nm in each time slot
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

      // Find which time slot this entry falls into
      // Only count entries that occur during the current day
      if (timeAt50nm >= dayStartTimestamp && timeAt50nm < dayStartTimestamp + 24 * 60 * 60) {
        const entryDate = new Date(timeAt50nm * 1000);
        const entryHour = entryDate.getUTCHours();
        const entryMinute = entryDate.getUTCMinutes();
        const entrySlot = getTimeSlot(entryHour, entryMinute);

        if (timeSlots[entrySlot]) {
          timeSlots[entrySlot].entries++;
        }
      }
    }

    // Second pass: For each time slot, count aircraft that:
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
          // Aircraft was at 50nm this many seconds before touchdown
          timeAt50nm = touchdownTime - arrival.milestones.timeFrom50nm;
        } else {
          // Estimate: typical approach from 50nm takes ~15-20 minutes
          // Use 18 minutes (1080 seconds) as default
          timeAt50nm = touchdownTime - (18 * 60);
        }

        // Check if aircraft was within 50nm at the slot time
        // Aircraft is within 50nm if slot time is between 50nm time and touchdown
        // (i.e., aircraft has passed 50nm but hasn't landed yet)
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
      byTimeSlot: Object.fromEntries(
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
