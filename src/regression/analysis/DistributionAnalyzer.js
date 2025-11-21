/**
 * Distribution Analyzer
 * 
 * Analyzes the shape and characteristics of arrival time distributions
 * to identify long-tail conditions and risk patterns.
 */

class DistributionAnalyzer {
  constructor() {
    this.data = null;
  }

  /**
   * Analyze distribution characteristics
   * @param {Array<number>} values - Array of arrival times
   * @returns {Object} Distribution characteristics
   */
  analyze(values) {
    if (!values || values.length === 0) {
      return null;
    }

    const sorted = [...values].sort((a, b) => a - b);
    const n = sorted.length;

    const mean = this.calculateMean(values);
    const median = this.calculateMedian(sorted);
    const stdDev = this.calculateStdDev(values, mean);
    const variance = stdDev * stdDev;

    const skewness = this.calculateSkewness(values, mean, stdDev);
    const kurtosis = this.calculateKurtosis(values, mean, stdDev);

    const percentiles = this.calculatePercentiles(sorted, [5, 10, 25, 50, 75, 90, 95, 99]);

    const isLongTailed = this.isLongTailed(skewness, kurtosis);
    const tailIndex = this.estimateTailIndex(sorted);

    return {
      n: n,
      mean,
      median,
      stdDev,
      variance,
      skewness,
      kurtosis,
      percentiles,
      isLongTailed,
      tailIndex,
      riskIndicators: {
        highVariance: variance > this.calculateMean(values) * 0.3,
        highSkewness: Math.abs(skewness) > 1.0,
        heavyTail: tailIndex < 2.0,
        bimodal: this.detectBimodality(sorted),
      },
    };
  }

  /**
   * Calculate mean
   */
  calculateMean(values) {
    return values.reduce((sum, val) => sum + val, 0) / values.length;
  }

  /**
   * Calculate median
   */
  calculateMedian(sorted) {
    const n = sorted.length;
    if (n % 2 === 0) {
      return (sorted[n / 2 - 1] + sorted[n / 2]) / 2;
    } else {
      return sorted[Math.floor(n / 2)];
    }
  }

  /**
   * Calculate standard deviation
   */
  calculateStdDev(values, mean) {
    const variance = values.reduce((sum, val) => sum + Math.pow(val - mean, 2), 0) / values.length;
    return Math.sqrt(variance);
  }

  /**
   * Calculate skewness (third moment)
   */
  calculateSkewness(values, mean, stdDev) {
    if (stdDev === 0) return 0;

    const n = values.length;
    const skew = values.reduce((sum, val) => {
      return sum + Math.pow((val - mean) / stdDev, 3);
    }, 0) / n;

    return skew;
  }

  /**
   * Calculate kurtosis (fourth moment, excess kurtosis)
   */
  calculateKurtosis(values, mean, stdDev) {
    if (stdDev === 0) return 0;

    const n = values.length;
    const kurt = values.reduce((sum, val) => {
      return sum + Math.pow((val - mean) / stdDev, 4);
    }, 0) / n;

    return kurt - 3;
  }

  /**
   * Calculate percentiles
   */
  calculatePercentiles(sorted, percentiles) {
    const result = {};
    const n = sorted.length;

    for (const p of percentiles) {
      const index = (p / 100) * (n - 1);
      const lower = Math.floor(index);
      const upper = Math.ceil(index);
      const weight = index - lower;

      if (lower === upper) {
        result[`p${p}`] = sorted[lower];
      } else {
        result[`p${p}`] = sorted[lower] * (1 - weight) + sorted[upper] * weight;
      }
    }

    return result;
  }

  /**
   * Check if distribution is long-tailed
   */
  isLongTailed(skewness, kurtosis) {
    return skewness > 1.0 || kurtosis > 3.0;
  }

  /**
   * Estimate tail index (Pareto tail index)
   * Lower values indicate heavier tails
   */
  estimateTailIndex(sorted) {
    const n = sorted.length;
    const top10Percent = Math.floor(n * 0.1);
    const tailValues = sorted.slice(n - top10Percent);

    if (tailValues.length < 2) return null;

    const logValues = tailValues.map((v) => Math.log(Math.max(1, v)));
    const meanLog = this.calculateMean(logValues);

    let sumSquared = 0;
    for (const logVal of logValues) {
      sumSquared += Math.pow(logVal - meanLog, 2);
    }

    const variance = sumSquared / tailValues.length;
    const tailIndex = Math.sqrt(1 / variance);

    return tailIndex;
  }

  /**
   * Detect bimodality (two distinct peaks)
   * Simple heuristic: check if there are two distinct clusters
   */
  detectBimodality(sorted) {
    const n = sorted.length;
    if (n < 20) return false;

    const q1 = sorted[Math.floor(n * 0.25)];
    const q2 = sorted[Math.floor(n * 0.5)];
    const q3 = sorted[Math.floor(n * 0.75)];

    const iqr = q3 - q1;
    const gap1 = q2 - q1;
    const gap2 = q3 - q2;

    return gap1 > iqr * 0.6 || gap2 > iqr * 0.6;
  }

  /**
   * Analyze distribution by weather conditions
   * @param {Array<Object>} data - Array of {arrivalTime, weatherFeatures}
   * @returns {Object} Distribution analysis grouped by conditions
   */
  analyzeByConditions(data) {
    const groups = {};

    for (const record of data) {
      const key = this.getConditionKey(record.weatherFeatures);
      if (!groups[key]) {
        groups[key] = [];
      }
      groups[key].push(record.arrivalTime);
    }

    const results = {};
    for (const [key, values] of Object.entries(groups)) {
      if (values.length >= 10) {
        results[key] = this.analyze(values);
      }
    }

    return results;
  }

  /**
   * Create condition key from weather features
   */
  getConditionKey(weather) {
    const vis = weather.visibility_sm || 10;
    const ceiling = weather.ceiling_ft || 10000;
    const wind = weather.wind_speed_kt || 0;
    const precip = weather.has_precipitation ? 'precip' : 'clear';

    const visCat = vis < 3 ? 'low_vis' : vis < 5 ? 'med_vis' : 'high_vis';
    const ceilingCat = ceiling < 1000 ? 'low_ceil' : ceiling < 3000 ? 'med_ceil' : 'high_ceil';
    const windCat = wind < 10 ? 'low_wind' : wind < 20 ? 'med_wind' : 'high_wind';

    return `${visCat}_${ceilingCat}_${windCat}_${precip}`;
  }
}

export default DistributionAnalyzer;


