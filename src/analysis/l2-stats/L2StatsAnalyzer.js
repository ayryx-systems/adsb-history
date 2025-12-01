import logger from '../../utils/logger.js';
import { getSeason } from '../../utils/dst.js';

/**
 * Analyzes L1 statistics to calculate time-of-day volumes in local time
 * 
 * Calculates volumes for:
 * - Morning: 06:00-12:00 local
 * - Afternoon: 12:00-18:00 local
 * - Evening: 18:00-24:00 local
 */
class L2StatsAnalyzer {
  constructor(config = {}) {
    this.config = config;
  }

  /**
   * Get UTC offset in hours for a given date and airport
   * Uses DST season to determine winter/summer offset
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

    // Standard UTC offsets for US timezones
    // Winter = standard time, Summer = daylight time
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
   * Convert UTC timestamp to local date string (YYYY-MM-DD)
   * Uses the UTC date to determine DST season for accurate conversion
   */
  utcToLocalDate(utcTimestamp, airportConfig) {
    // First, get UTC date to determine DST season
    const utcDateObj = new Date(utcTimestamp * 1000);
    const utcDateStr = utcDateObj.toISOString().split('T')[0];
    
    // Use UTC date to determine offset (DST is based on local date, but we approximate with UTC date)
    // For more accuracy, we'd need to iterate, but this is close enough for our use case
    const offsetHours = this.getUTCOffsetHours(airportConfig, utcDateStr);
    const offsetSeconds = offsetHours * 3600;
    const localTimestamp = utcTimestamp + offsetSeconds;
    const localDate = new Date(localTimestamp * 1000);
    return localDate.toISOString().split('T')[0];
  }

  /**
   * Convert UTC timestamp to local hour (0-23)
   * Uses the UTC date to determine DST season for accurate conversion
   */
  utcToLocalHour(utcTimestamp, airportConfig) {
    // First, get UTC date to determine DST season
    const utcDateObj = new Date(utcTimestamp * 1000);
    const utcDateStr = utcDateObj.toISOString().split('T')[0];
    
    // Use UTC date to determine offset
    const offsetHours = this.getUTCOffsetHours(airportConfig, utcDateStr);
    const offsetSeconds = offsetHours * 3600;
    const localTimestamp = utcTimestamp + offsetSeconds;
    const localDate = new Date(localTimestamp * 1000);
    return localDate.getUTCHours();
  }

  /**
   * Get time period for a local hour
   * Returns: 'morning', 'afternoon', 'evening', or null (outside defined periods)
   */
  getTimePeriod(localHour) {
    if (localHour >= 6 && localHour < 12) {
      return 'morning';
    } else if (localHour >= 12 && localHour < 18) {
      return 'afternoon';
    } else if (localHour >= 18 && localHour < 24) {
      return 'evening';
    }
    return null;
  }

  /**
   * Get UTC dates that might contain data for a given local date
   * A local day can span 2 UTC days due to timezone offset
   */
  getRelevantUTCDates(localDate, airportConfig) {
    const offsetHours = this.getUTCOffsetHours(airportConfig, localDate);
    
    // Local midnight in UTC = UTC midnight - offset
    // If offset is -6 (Chicago), local midnight = UTC 06:00 same day
    // If offset is +5 (example), local midnight = UTC 19:00 previous day
    
    // Create UTC date representing local midnight
    // Parse local date as UTC, then subtract offset to get actual UTC time
    const localMidnightUTC = new Date(localDate + 'T00:00:00Z');
    const utcMidnight = new Date(localMidnightUTC.getTime() - offsetHours * 3600 * 1000);
    const utcDateStartStr = utcMidnight.toISOString().split('T')[0];
    
    // Local end of day (23:59:59) in UTC
    const localEndUTC = new Date(localDate + 'T23:59:59Z');
    const utcEnd = new Date(localEndUTC.getTime() - offsetHours * 3600 * 1000);
    const utcDateEndStr = utcEnd.toISOString().split('T')[0];
    
    const dates = [utcDateStartStr];
    if (utcDateEndStr !== utcDateStartStr) {
      dates.push(utcDateEndStr);
    }
    
    return dates;
  }

  /**
   * Analyze L1 stats to calculate time-of-day volumes
   * @param {Array} l1StatsArray - Array of L1 stats objects (one per UTC day)
   * @param {object} airportConfig - Airport configuration
   * @param {string} localDate - Local date in YYYY-MM-DD format
   * @returns {object} L2 statistics
   */
  analyze(l1StatsArray, airportConfig, localDate) {
    logger.info('Starting L2 analysis', {
      airport: airportConfig.icao,
      localDate,
      l1StatsCount: l1StatsArray.length,
    });

    const volumes = {
      morning: 0,
      afternoon: 0,
      evening: 0,
    };

    // Process all L1 stats entries
    for (const l1Stats of l1StatsArray) {
      if (!l1Stats || !l1Stats.overall || !l1Stats.overall.byTouchdownTimeSlot) {
        continue;
      }

      const byTimeSlot = l1Stats.overall.byTouchdownTimeSlot;

      // Process each time slot
      for (const [slot, slotData] of Object.entries(byTimeSlot)) {
        if (!slotData.aircraft || !Array.isArray(slotData.aircraft)) {
          continue;
        }

        // Process each aircraft in this time slot
        for (const aircraft of slotData.aircraft) {
          if (!aircraft.touchdown || !aircraft.touchdown.utc) {
            continue;
          }

          // Parse UTC timestamp from ISO string
          const utcDate = new Date(aircraft.touchdown.utc);
          const utcTimestamp = Math.floor(utcDate.getTime() / 1000);

          // Check if this flight belongs to the local date we're analyzing
          const flightLocalDate = this.utcToLocalDate(utcTimestamp, airportConfig);
          if (flightLocalDate !== localDate) {
            continue;
          }

          // Convert to local hour (only for flights on the target local date)
          const localHour = this.utcToLocalHour(utcTimestamp, airportConfig);

          // Get time period
          const period = this.getTimePeriod(localHour);
          if (period) {
            volumes[period]++;
          }
        }
      }
    }

    logger.info('L2 analysis complete', {
      airport: airportConfig.icao,
      localDate,
      volumes,
    });

    return {
      airport: airportConfig.icao,
      localDate,
      generatedAt: new Date().toISOString(),
      volumes: {
        morning: volumes.morning,
        afternoon: volumes.afternoon,
        evening: volumes.evening,
        total: volumes.morning + volumes.afternoon + volumes.evening,
      },
    };
  }
}

export default L2StatsAnalyzer;

