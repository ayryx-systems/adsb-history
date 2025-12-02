import logger from '../../utils/logger.js';
import { getSeason } from '../../utils/dst.js';

/**
 * Analyzes L1 statistics to convert UTC time slots to local time slots
 * 
 * Converts all time slot data from UTC to local time:
 * - Re-groups aircraft by local time slot (15-minute intervals)
 * - Preserves all statistics (counts, medians, percentiles, aircraft lists)
 * - Calculates time-of-day volumes (morning/afternoon/evening)
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
   */
  utcToLocalDate(utcTimestamp, airportConfig) {
    const utcDateObj = new Date(utcTimestamp * 1000);
    const utcDateStr = utcDateObj.toISOString().split('T')[0];
    const offsetHours = this.getUTCOffsetHours(airportConfig, utcDateStr);
    const offsetSeconds = offsetHours * 3600;
    const localTimestamp = utcTimestamp + offsetSeconds;
    const localDate = new Date(localTimestamp * 1000);
    return localDate.toISOString().split('T')[0];
  }

  /**
   * Convert UTC timestamp to local time slot (HH:MM format)
   */
  utcToLocalTimeSlot(utcTimestamp, airportConfig) {
    const utcDateObj = new Date(utcTimestamp * 1000);
    const utcDateStr = utcDateObj.toISOString().split('T')[0];
    const offsetHours = this.getUTCOffsetHours(airportConfig, utcDateStr);
    const offsetSeconds = offsetHours * 3600;
    const localTimestamp = utcTimestamp + offsetSeconds;
    const localDate = new Date(localTimestamp * 1000);
    
    const hour = localDate.getUTCHours();
    const minute = localDate.getUTCMinutes();
    const slotMinute = Math.floor(minute / 15) * 15;
    
    const hourStr = hour.toString().padStart(2, '0');
    const minStr = slotMinute.toString().padStart(2, '0');
    return `${hourStr}:${minStr}`;
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
    
    const localMidnightUTC = new Date(localDate + 'T00:00:00Z');
    const utcMidnight = new Date(localMidnightUTC.getTime() - offsetHours * 3600 * 1000);
    const utcDateStartStr = utcMidnight.toISOString().split('T')[0];
    
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
   * Calculate median of an array
   */
  calculateMedian(values) {
    if (!values || values.length === 0) return null;
    const sorted = [...values].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 0
      ? (sorted[mid - 1] + sorted[mid]) / 2
      : sorted[mid];
  }

  /**
   * Calculate statistics for an array of values
   */
  calculateStats(values) {
    if (!values || values.length === 0) {
      return {
        count: 0,
        mean: null,
        median: null,
        min: null,
        max: null,
        stdDev: null,
        percentiles: {
          p10: null,
          p25: null,
          p50: null,
          p75: null,
          p90: null,
          p95: null,
          p99: null,
        },
      };
    }

    const sorted = [...values].sort((a, b) => a - b);
    const count = sorted.length;
    const sum = sorted.reduce((a, b) => a + b, 0);
    const mean = sum / count;
    
    const variance = sorted.reduce((acc, val) => acc + Math.pow(val - mean, 2), 0) / count;
    const stdDev = Math.sqrt(variance);

    const percentiles = {
      p10: this.getPercentile(sorted, 10),
      p25: this.getPercentile(sorted, 25),
      p50: this.getPercentile(sorted, 50),
      p75: this.getPercentile(sorted, 75),
      p90: this.getPercentile(sorted, 90),
      p95: this.getPercentile(sorted, 95),
      p99: this.getPercentile(sorted, 99),
    };

    return {
      count,
      mean: Math.round(mean * 100) / 100,
      median: Math.round(percentiles.p50 * 100) / 100,
      min: sorted[0],
      max: sorted[sorted.length - 1],
      stdDev: Math.round(stdDev * 100) / 100,
      percentiles: Object.fromEntries(
        Object.entries(percentiles).map(([k, v]) => [k, v !== null ? Math.round(v * 100) / 100 : null])
      ),
    };
  }

  /**
   * Get percentile value from sorted array
   */
  getPercentile(sorted, percentile) {
    if (sorted.length === 0) return null;
    const index = Math.ceil((percentile / 100) * sorted.length) - 1;
    return sorted[Math.max(0, Math.min(index, sorted.length - 1))];
  }

  /**
   * Generate all possible time slots (00:00 to 23:45 in 15-minute intervals)
   */
  getAllTimeSlots() {
    const slots = [];
    for (let hour = 0; hour < 24; hour++) {
      for (let minute = 0; minute < 60; minute += 15) {
        const hourStr = hour.toString().padStart(2, '0');
        const minStr = minute.toString().padStart(2, '0');
        slots.push(`${hourStr}:${minStr}`);
      }
    }
    return slots;
  }

  /**
   * Analyze L1 stats to convert UTC time slots to local time slots
   * @param {Array} l1StatsArray - Array of L1 stats objects (one per UTC day)
   * @param {object} airportConfig - Airport configuration
   * @param {string} localDate - Local date in YYYY-MM-DD format
   * @returns {object} L2 statistics with local time slots
   */
  analyze(l1StatsArray, airportConfig, localDate) {
    logger.debug('Starting L2 analysis (full time slot conversion)', {
      airport: airportConfig.icao,
      localDate,
      l1StatsCount: l1StatsArray.length,
    });

    // Initialize local time slot buckets
    const allTimeSlots = this.getAllTimeSlots();
    const byLocalTimeSlot = {};
    for (const slot of allTimeSlots) {
      byLocalTimeSlot[slot] = {
        timeFrom100nm: [],
        timeFrom50nm: [],
        timeFrom20nm: [],
        aircraft: [],
        goArounds: [],
      };
    }

    const volumes = {
      morning: 0,
      afternoon: 0,
      evening: 0,
    };

    const overallMilestones = {
      timeFrom100nm: [],
      timeFrom50nm: [],
      timeFrom20nm: [],
    };

    let totalArrivals = 0;
    let totalGoArounds = 0;

    // Process all L1 stats entries
    for (const l1Stats of l1StatsArray) {
      if (!l1Stats || !l1Stats.overall || !l1Stats.overall.byTouchdownTimeSlot) {
        continue;
      }

      const byTimeSlot = l1Stats.overall.byTouchdownTimeSlot;

      // Process each UTC time slot
      for (const [utcSlot, slotData] of Object.entries(byTimeSlot)) {
        if (!slotData.aircraft || !Array.isArray(slotData.aircraft)) {
          continue;
        }

        // Process each aircraft in this UTC slot
        for (const aircraft of slotData.aircraft) {
          if (!aircraft.touchdown || !aircraft.touchdown.utc) {
            continue;
          }

          // Parse UTC timestamp
          const utcDate = new Date(aircraft.touchdown.utc);
          const utcTimestamp = Math.floor(utcDate.getTime() / 1000);

          // Check if this flight belongs to the local date we're analyzing
          const flightLocalDate = this.utcToLocalDate(utcTimestamp, airportConfig);
          if (flightLocalDate !== localDate) {
            continue;
          }

          // Convert to local time slot
          const localSlot = this.utcToLocalTimeSlot(utcTimestamp, airportConfig);
          
          if (!byLocalTimeSlot[localSlot]) {
            byLocalTimeSlot[localSlot] = {
              timeFrom100nm: [],
              timeFrom50nm: [],
              timeFrom20nm: [],
              aircraft: [],
              goArounds: [],
            };
          }

          // Add aircraft to local slot
          byLocalTimeSlot[localSlot].aircraft.push(aircraft);

          // Add milestones
          if (aircraft.milestones) {
            if (aircraft.milestones.timeFrom100nm !== undefined && aircraft.milestones.timeFrom100nm !== null) {
              byLocalTimeSlot[localSlot].timeFrom100nm.push(aircraft.milestones.timeFrom100nm);
              overallMilestones.timeFrom100nm.push(aircraft.milestones.timeFrom100nm);
            }
            if (aircraft.milestones.timeFrom50nm !== undefined && aircraft.milestones.timeFrom50nm !== null) {
              byLocalTimeSlot[localSlot].timeFrom50nm.push(aircraft.milestones.timeFrom50nm);
              overallMilestones.timeFrom50nm.push(aircraft.milestones.timeFrom50nm);
            }
            if (aircraft.milestones.timeFrom20nm !== undefined && aircraft.milestones.timeFrom20nm !== null) {
              byLocalTimeSlot[localSlot].timeFrom20nm.push(aircraft.milestones.timeFrom20nm);
              overallMilestones.timeFrom20nm.push(aircraft.milestones.timeFrom20nm);
            }
          }

          totalArrivals++;

          // Count time-of-day volumes
          const localHour = parseInt(localSlot.split(':')[0], 10);
          const period = this.getTimePeriod(localHour);
          if (period) {
            volumes[period]++;
          }
        }

        // Process go-arounds (they're already grouped by UTC slot in L1)
        if (slotData.goArounds && Array.isArray(slotData.goArounds)) {
          for (const goAround of slotData.goArounds) {
            if (goAround.touchdown && goAround.touchdown.utc) {
              const goAroundUtcDate = new Date(goAround.touchdown.utc);
              const goAroundUtcTimestamp = Math.floor(goAroundUtcDate.getTime() / 1000);
              const goAroundLocalDate = this.utcToLocalDate(goAroundUtcTimestamp, airportConfig);
              
              if (goAroundLocalDate === localDate) {
                const goAroundLocalSlot = this.utcToLocalTimeSlot(goAroundUtcTimestamp, airportConfig);
                if (byLocalTimeSlot[goAroundLocalSlot]) {
                  byLocalTimeSlot[goAroundLocalSlot].goArounds.push(goAround);
                  totalGoArounds++;
                }
              }
            }
          }
        }
      }
    }

    // Calculate statistics for each local time slot
    const timeSlotData = {};
    const timeSlotMedians = {};
    const milestoneKeys = ['timeFrom100nm', 'timeFrom50nm', 'timeFrom20nm'];

    for (const slot of allTimeSlots) {
      const slotData = byLocalTimeSlot[slot];
      timeSlotData[slot] = {
        count: slotData.aircraft.length,
        aircraft: slotData.aircraft,
        goArounds: slotData.goArounds || [],
        goAroundCount: (slotData.goArounds || []).length,
      };

      timeSlotMedians[slot] = {};

      for (const key of milestoneKeys) {
        const median = this.calculateMedian(slotData[key]);
        if (median !== null) {
          const medianValue = Math.round(median * 100) / 100;
          timeSlotData[slot][key] = medianValue;
          timeSlotMedians[slot][key] = medianValue;
        }
      }
    }

    const overall = {
      count: totalArrivals,
      goAroundCount: totalGoArounds,
      milestones: {
        timeFrom100nm: this.calculateStats(overallMilestones.timeFrom100nm),
        timeFrom50nm: this.calculateStats(overallMilestones.timeFrom50nm),
        timeFrom20nm: this.calculateStats(overallMilestones.timeFrom20nm),
      },
      byTouchdownTimeSlotLocal: timeSlotData,
      byTouchdownTimeSlotMediansLocal: timeSlotMedians,
    };

    logger.info('L2 analysis complete', {
      airport: airportConfig.icao,
      localDate,
      totalArrivals,
      totalGoArounds,
      volumes,
    });

    return {
      airport: airportConfig.icao,
      localDate,
      generatedAt: new Date().toISOString(),
      totalArrivals,
      totalGoArounds,
      overall,
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
