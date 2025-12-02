import logger from '../../utils/logger.js';

/**
 * Analyzes arrival flight data to generate L1 statistics
 * Calculates milestone statistics for all arrivals
 */
class L1StatsAnalyzer {
  constructor(config = {}) {
    this.config = config;
  }

  /**
   * Calculate statistics for an array of values
   * @param {Array<number>} values - Array of numeric values
   * @returns {object} Statistics object
   */
  calculateStats(values) {
    if (!values || values.length === 0) {
      return null;
    }

    const sorted = [...values].sort((a, b) => a - b);
    const count = sorted.length;
    const sum = sorted.reduce((acc, val) => acc + val, 0);
    const mean = sum / count;
    const min = sorted[0];
    const max = sorted[sorted.length - 1];

    // Calculate median
    const median = count % 2 === 0
      ? (sorted[count / 2 - 1] + sorted[count / 2]) / 2
      : sorted[Math.floor(count / 2)];

    // Calculate percentiles
    const percentile = (p) => {
      const index = Math.ceil((p / 100) * count) - 1;
      return sorted[Math.max(0, Math.min(index, count - 1))];
    };

    // Calculate standard deviation
    const variance = sorted.reduce((acc, val) => acc + Math.pow(val - mean, 2), 0) / count;
    const stdDev = Math.sqrt(variance);

    return {
      count,
      mean: Math.round(mean * 100) / 100,
      median: Math.round(median * 100) / 100,
      min: Math.round(min * 100) / 100,
      max: Math.round(max * 100) / 100,
      stdDev: Math.round(stdDev * 100) / 100,
      percentiles: {
        p10: Math.round(percentile(10) * 100) / 100,
        p25: Math.round(percentile(25) * 100) / 100,
        p50: Math.round(percentile(50) * 100) / 100, // Same as median
        p75: Math.round(percentile(75) * 100) / 100,
        p90: Math.round(percentile(90) * 100) / 100,
        p95: Math.round(percentile(95) * 100) / 100,
        p99: Math.round(percentile(99) * 100) / 100,
      },
    };
  }

  /**
   * Calculate median for an array of values
   * @param {Array<number>} values - Array of numeric values
   * @returns {number|null} Median value or null if empty
   */
  calculateMedian(values) {
    if (!values || values.length === 0) {
      return null;
    }
    const sorted = [...values].sort((a, b) => a - b);
    const count = sorted.length;
    return count % 2 === 0
      ? (sorted[count / 2 - 1] + sorted[count / 2]) / 2
      : sorted[Math.floor(count / 2)];
  }

  /**
   * Get time of day category from hour (UTC)
   * @param {number} hour - Hour of day (0-23)
   * @returns {string} Time of day category
   */
  getTimeOfDay(hour) {
    if (hour >= 0 && hour < 6) return '00-06';
    if (hour >= 6 && hour < 12) return '06-12';
    if (hour >= 12 && hour < 16) return '12-16';
    return '16-00'; // 16-24 (16-00)
  }

  /**
   * Get 15-minute time slot key from hour and minute
   * @param {number} hour - Hour of day (0-23)
   * @param {number} minute - Minute of hour (0-59)
   * @returns {string} Time slot key (e.g., "00:00", "00:15", "23:45")
   */
  getTimeSlot(hour, minute) {
    const slotMinute = Math.floor(minute / 15) * 15;
    const hourStr = hour.toString().padStart(2, '0');
    const minStr = slotMinute.toString().padStart(2, '0');
    return `${hourStr}:${minStr}`;
  }

  /**
   * Generate all 15-minute time slots for a day (00:00 through 23:45)
   * @returns {Array<string>} Array of time slot keys
   */
  getAllTimeSlots() {
    const slots = [];
    for (let hour = 0; hour < 24; hour++) {
      for (let minute = 0; minute < 60; minute += 15) {
        slots.push(this.getTimeSlot(hour, minute));
      }
    }
    return slots;
  }

  /**
   * Analyze arrival flights and generate L1 statistics
   * @param {Array} flights - Array of flight objects from summary data
   * @param {string} airport - Airport ICAO code
   * @param {string} date - Date in YYYY-MM-DD format
   * @returns {object} L1 statistics object
   */
  analyze(flights, airport, date) {
    logger.debug('Starting L1 stats analysis', { airport, date, totalFlights: flights.length });

    // Filter for arrivals only
    const arrivals = flights.filter(f => f.classification === 'arrival');
    logger.debug('Filtered arrivals', { arrivals: arrivals.length });

    // Filter for go-arounds
    const goArounds = flights.filter(f => f.classification === 'go_around');
    logger.debug('Filtered go-arounds', { goArounds: goArounds.length });

    // Track go-arounds by time slot (use entry time for go-arounds)
    const goAroundsByTimeSlot = {};
    for (const goAround of goArounds) {
      if (!goAround.goAround || !goAround.goAround.entryTime) {
        continue;
      }

      const entryDate = new Date(goAround.goAround.entryTime * 1000);
      const hour = entryDate.getUTCHours();
      const minute = entryDate.getUTCMinutes();
      const timeSlot = this.getTimeSlot(hour, minute);

      if (!goAroundsByTimeSlot[timeSlot]) {
        goAroundsByTimeSlot[timeSlot] = [];
      }

      goAroundsByTimeSlot[timeSlot].push({
        icao: goAround.icao,
        type: goAround.type || 'UNKNOWN',
        entryTime: entryDate.toISOString(),
        duration: goAround.goAround.duration,
        entryAltitudeAGL_ft: goAround.goAround.entryAltitudeAGL_ft,
        maxAltitudeAGL_ft: goAround.goAround.maxAltitudeAGL_ft,
      });
    }

    // Initialize all time slots even if no arrivals
    const allTimeSlots = this.getAllTimeSlots();
    const emptyTimeSlotData = {};
    for (const slot of allTimeSlots) {
      emptyTimeSlotData[slot] = {
        count: 0,
        aircraft: [],
        goArounds: goAroundsByTimeSlot[slot] || [],
        goAroundCount: (goAroundsByTimeSlot[slot] || []).length,
      };
    }

    if (arrivals.length === 0) {
      return {
        airport,
        date,
        generatedAt: new Date().toISOString(),
        totalArrivals: 0,
        totalGoArounds: goArounds.length,
        overall: {
          count: 0,
          goAroundCount: goArounds.length,
          milestones: {
            timeFrom100nm: null,
            timeFrom50nm: null,
            timeFrom20nm: null,
          },
          byTouchdownTimeOfDay: {
            '00-06': { count: 0, milestones: { timeFrom100nm: null, timeFrom50nm: null, timeFrom20nm: null } },
            '06-12': { count: 0, milestones: { timeFrom100nm: null, timeFrom50nm: null, timeFrom20nm: null } },
            '12-16': { count: 0, milestones: { timeFrom100nm: null, timeFrom50nm: null, timeFrom20nm: null } },
            '16-00': { count: 0, milestones: { timeFrom100nm: null, timeFrom50nm: null, timeFrom20nm: null } },
          },
          byTouchdownTimeSlot: emptyTimeSlotData,
          byTouchdownTimeSlotMedians: {},
        },
      };
    }

    // Calculate overall statistics (all arrivals regardless of type)
    // Group by time of day and 15-minute slots
    const overallMilestones = {
      timeFrom100nm: [],
      timeFrom50nm: [],
      timeFrom20nm: [],
    };

    // Group by time of day (UTC)
    const byTimeOfDay = {
      '00-06': { timeFrom100nm: [], timeFrom50nm: [], timeFrom20nm: [] },
      '06-12': { timeFrom100nm: [], timeFrom50nm: [], timeFrom20nm: [] },
      '12-16': { timeFrom100nm: [], timeFrom50nm: [], timeFrom20nm: [] },
      '16-00': { timeFrom100nm: [], timeFrom50nm: [], timeFrom20nm: [] },
    };

    // Group by 15-minute time slots
    const byTimeSlot = {};

    for (const arrival of arrivals) {
      if (!arrival.touchdown || !arrival.touchdown.timestamp) {
        continue;
      }

      // Get time of day from touchdown timestamp
      const touchdownDate = new Date(arrival.touchdown.timestamp * 1000);
      const hour = touchdownDate.getUTCHours();
      const minute = touchdownDate.getUTCMinutes();
      const timeOfDay = this.getTimeOfDay(hour);
      const timeSlot = this.getTimeSlot(hour, minute);

      // Initialize time slot if needed
      if (!byTimeSlot[timeSlot]) {
        byTimeSlot[timeSlot] = {
          timeFrom100nm: [],
          timeFrom50nm: [],
          timeFrom20nm: [],
          aircraft: [],
          goArounds: goAroundsByTimeSlot[timeSlot] || [],
        };
      } else {
        // Add go-arounds to existing time slot if not already added
        if (goAroundsByTimeSlot[timeSlot]) {
          byTimeSlot[timeSlot].goArounds = goAroundsByTimeSlot[timeSlot];
        }
      }

      // Track aircraft information for this time slot
      const aircraftInfo = {
        icao: arrival.icao,
        type: arrival.type || 'UNKNOWN',
        touchdown: {
          distance_nm: arrival.touchdown.distance_nm,
          altitude_ft: arrival.touchdown.altitude_ft,
          utc: touchdownDate.toISOString(),
        },
      };

      // Add milestones if available
      if (arrival.milestones) {
        aircraftInfo.milestones = { ...arrival.milestones };
      }

      byTimeSlot[timeSlot].aircraft.push(aircraftInfo);

      // Add to overall, time-of-day, and time-slot groups
      if (arrival.milestones) {
        if (arrival.milestones.timeFrom100nm !== undefined) {
          overallMilestones.timeFrom100nm.push(arrival.milestones.timeFrom100nm);
          byTimeOfDay[timeOfDay].timeFrom100nm.push(arrival.milestones.timeFrom100nm);
          byTimeSlot[timeSlot].timeFrom100nm.push(arrival.milestones.timeFrom100nm);
        }
        if (arrival.milestones.timeFrom50nm !== undefined) {
          overallMilestones.timeFrom50nm.push(arrival.milestones.timeFrom50nm);
          byTimeOfDay[timeOfDay].timeFrom50nm.push(arrival.milestones.timeFrom50nm);
          byTimeSlot[timeSlot].timeFrom50nm.push(arrival.milestones.timeFrom50nm);
        }
        if (arrival.milestones.timeFrom20nm !== undefined) {
          overallMilestones.timeFrom20nm.push(arrival.milestones.timeFrom20nm);
          byTimeOfDay[timeOfDay].timeFrom20nm.push(arrival.milestones.timeFrom20nm);
          byTimeSlot[timeSlot].timeFrom20nm.push(arrival.milestones.timeFrom20nm);
        }
      }
    }

    // Calculate statistics for each time of day
    const timeOfDayStats = {};
    for (const [tod, milestones] of Object.entries(byTimeOfDay)) {
      timeOfDayStats[tod] = {
        count: Math.max(
          milestones.timeFrom100nm.length,
          milestones.timeFrom50nm.length,
          milestones.timeFrom20nm.length
        ),
        milestones: {
          timeFrom100nm: this.calculateStats(milestones.timeFrom100nm),
          timeFrom50nm: this.calculateStats(milestones.timeFrom50nm),
          timeFrom20nm: this.calculateStats(milestones.timeFrom20nm),
        },
      };
    }

    // Initialize all 15-minute time slots for the day (even if no arrivals)
    for (const slot of allTimeSlots) {
      if (!byTimeSlot[slot]) {
        byTimeSlot[slot] = {
          timeFrom100nm: [],
          timeFrom50nm: [],
          timeFrom20nm: [],
          aircraft: [],
          goArounds: goAroundsByTimeSlot[slot] || [],
        };
      }
    }

    // Calculate median for each 15-minute time slot and include aircraft information
    const timeSlotData = {};
    const timeSlotMedians = {};
    const milestoneKeys = ['timeFrom100nm', 'timeFrom50nm', 'timeFrom20nm'];
    
    // Process all time slots (including empty ones)
    for (const slot of allTimeSlots) {
      const slotData = byTimeSlot[slot];
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

    // Time slots are already sorted chronologically since we iterate through allTimeSlots
    const sortedTimeSlotData = timeSlotData;
    const sortedTimeSlotMedians = timeSlotMedians;

    const overall = {
      count: arrivals.length,
      goAroundCount: goArounds.length,
      milestones: {
        timeFrom100nm: this.calculateStats(overallMilestones.timeFrom100nm),
        timeFrom50nm: this.calculateStats(overallMilestones.timeFrom50nm),
        timeFrom20nm: this.calculateStats(overallMilestones.timeFrom20nm),
      },
      byTouchdownTimeOfDay: timeOfDayStats,
      byTouchdownTimeSlot: sortedTimeSlotData,
      byTouchdownTimeSlotMedians: sortedTimeSlotMedians,
    };

    logger.info('L1 stats analysis complete', {
      airport,
      date,
      totalArrivals: arrivals.length,
    });

    return {
      airport,
      date,
      generatedAt: new Date().toISOString(),
      totalArrivals: arrivals.length,
      totalGoArounds: goArounds.length,
      overall,
    };
  }
}

export default L1StatsAnalyzer;

