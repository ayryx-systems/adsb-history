import logger from '../../utils/logger.js';

/**
 * Analyzes arrival flight data to generate L1 statistics
 * Groups arrivals by aircraft type and calculates milestone statistics
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
   * Analyze arrival flights and generate L1 statistics
   * @param {Array} flights - Array of flight objects from summary data
   * @param {string} airport - Airport ICAO code
   * @param {string} date - Date in YYYY-MM-DD format
   * @returns {object} L1 statistics object
   */
  analyze(flights, airport, date) {
    logger.info('Starting L1 stats analysis', { airport, date, totalFlights: flights.length });

    // Filter for arrivals only
    const arrivals = flights.filter(f => f.classification === 'arrival');
    logger.info('Filtered arrivals', { arrivals: arrivals.length });

    if (arrivals.length === 0) {
      return {
        airport,
        date,
        generatedAt: new Date().toISOString(),
        totalArrivals: 0,
        byAircraftType: {},
        overall: null,
      };
    }

    // Group arrivals by aircraft type
    const byType = {};
    for (const arrival of arrivals) {
      const type = arrival.type || 'UNKNOWN';
      if (!byType[type]) {
        byType[type] = [];
      }
      byType[type].push(arrival);
    }

    logger.info('Grouped by aircraft type', {
      types: Object.keys(byType).length,
      typeCounts: Object.fromEntries(
        Object.entries(byType).map(([type, flights]) => [type, flights.length])
      ),
    });

    // Analyze each aircraft type
    const typeStats = {};
    for (const [type, typeArrivals] of Object.entries(byType)) {
      const milestones = {
        timeFrom100nm: [],
        timeFrom50nm: [],
        timeFrom20nm: [],
      };

      // Extract milestone values
      for (const arrival of typeArrivals) {
        if (arrival.milestones) {
          if (arrival.milestones.timeFrom100nm !== undefined) {
            milestones.timeFrom100nm.push(arrival.milestones.timeFrom100nm);
          }
          if (arrival.milestones.timeFrom50nm !== undefined) {
            milestones.timeFrom50nm.push(arrival.milestones.timeFrom50nm);
          }
          if (arrival.milestones.timeFrom20nm !== undefined) {
            milestones.timeFrom20nm.push(arrival.milestones.timeFrom20nm);
          }
        }
      }

      // Calculate statistics for each milestone
      typeStats[type] = {
        count: typeArrivals.length,
        milestones: {
          timeFrom100nm: this.calculateStats(milestones.timeFrom100nm),
          timeFrom50nm: this.calculateStats(milestones.timeFrom50nm),
          timeFrom20nm: this.calculateStats(milestones.timeFrom20nm),
        },
      };
    }

    // Calculate overall statistics (all arrivals regardless of type)
    const overallMilestones = {
      timeFrom100nm: [],
      timeFrom50nm: [],
      timeFrom20nm: [],
    };

    for (const arrival of arrivals) {
      if (arrival.milestones) {
        if (arrival.milestones.timeFrom100nm !== undefined) {
          overallMilestones.timeFrom100nm.push(arrival.milestones.timeFrom100nm);
        }
        if (arrival.milestones.timeFrom50nm !== undefined) {
          overallMilestones.timeFrom50nm.push(arrival.milestones.timeFrom50nm);
        }
        if (arrival.milestones.timeFrom20nm !== undefined) {
          overallMilestones.timeFrom20nm.push(arrival.milestones.timeFrom20nm);
        }
      }
    }

    const overall = {
      count: arrivals.length,
      milestones: {
        timeFrom100nm: this.calculateStats(overallMilestones.timeFrom100nm),
        timeFrom50nm: this.calculateStats(overallMilestones.timeFrom50nm),
        timeFrom20nm: this.calculateStats(overallMilestones.timeFrom20nm),
      },
    };

    logger.info('L1 stats analysis complete', {
      airport,
      date,
      totalArrivals: arrivals.length,
      typesAnalyzed: Object.keys(typeStats).length,
    });

    return {
      airport,
      date,
      generatedAt: new Date().toISOString(),
      totalArrivals: arrivals.length,
      byAircraftType: typeStats,
      overall,
    };
  }
}

export default L1StatsAnalyzer;

