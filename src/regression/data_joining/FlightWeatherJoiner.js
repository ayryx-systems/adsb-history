/**
 * Join flight arrival data with weather (METAR) data
 * 
 * Matches each flight's touchdown time to the nearest METAR observation
 * within a specified time window.
 */

import fs from 'fs';
import path from 'path';
import logger from '../../utils/logger.js';

class FlightWeatherJoiner {
  constructor(config = {}) {
    this.timeWindowMinutes = config.timeWindowMinutes || 30;
    this.cacheDir = config.cacheDir || './cache';
  }

  /**
   * Load METAR data for an airport and year
   * @param {string} airport - Airport ICAO code
   * @param {number} year - Year
   * @returns {Array} Array of METAR records
   */
  loadMetarData(airport, year) {
    const metarPath = path.join(
      this.cacheDir,
      'metar',
      airport,
      `${airport}_${year}.json`
    );

    if (!fs.existsSync(metarPath)) {
      logger.warn('METAR file not found', { airport, year, path: metarPath });
      return [];
    }

    try {
      const data = JSON.parse(fs.readFileSync(metarPath, 'utf-8'));
      return data.records || [];
    } catch (error) {
      logger.error('Failed to load METAR data', {
        airport,
        year,
        error: error.message,
      });
      return [];
    }
  }

  /**
   * Load flight summary data for an airport and date
   * @param {string} airport - Airport ICAO code
   * @param {string} date - Date in YYYY-MM-DD format
   * @returns {Object|null} Flight summary data
   */
  loadFlightSummary(airport, date) {
    const [year, month, day] = date.split('-');
    const summaryPath = path.join(
      this.cacheDir,
      airport,
      year,
      month,
      `summary-${day}.json`
    );

    if (!fs.existsSync(summaryPath)) {
      logger.warn('Flight summary not found', { airport, date, path: summaryPath });
      return null;
    }

    try {
      return JSON.parse(fs.readFileSync(summaryPath, 'utf-8'));
    } catch (error) {
      logger.error('Failed to load flight summary', {
        airport,
        date,
        error: error.message,
      });
      return null;
    }
  }

  /**
   * Parse timestamp from METAR valid field
   * @param {string} valid - Timestamp string (e.g., "2024-01-01 02:27:00")
   * @returns {number|null} Unix timestamp
   */
  parseMetarTimestamp(valid) {
    if (!valid) return null;

    try {
      const date = new Date(valid);
      if (isNaN(date.getTime())) {
        return null;
      }
      return Math.floor(date.getTime() / 1000);
    } catch (error) {
      return null;
    }
  }

  /**
   * Find nearest METAR observation to a timestamp
   * @param {Array} metarRecords - Array of METAR records
   * @param {number} targetTimestamp - Target Unix timestamp
   * @param {number} maxWindowSeconds - Maximum time window in seconds
   * @returns {Object|null} Nearest METAR record or null
   */
  findNearestMetar(metarRecords, targetTimestamp, maxWindowSeconds = null) {
    const window = maxWindowSeconds || (this.timeWindowMinutes * 60);

    let nearest = null;
    let minDiff = Infinity;

    for (const metar of metarRecords) {
      const metarTimestamp = this.parseMetarTimestamp(metar.valid);
      if (metarTimestamp === null) continue;

      const diff = Math.abs(metarTimestamp - targetTimestamp);

      if (diff <= window && diff < minDiff) {
        minDiff = diff;
        nearest = metar;
      }
    }

    return nearest ? { metar: nearest, timeDiffSeconds: minDiff } : null;
  }

  /**
   * Join flight arrivals with weather data
   * @param {string} airport - Airport ICAO code
   * @param {string} date - Date in YYYY-MM-DD format
   * @returns {Array} Array of joined records
   */
  join(airport, date) {
    logger.info('Joining flight and weather data', { airport, date });

    const flightSummary = this.loadFlightSummary(airport, date);
    if (!flightSummary || !flightSummary.flights) {
      logger.warn('No flight data available', { airport, date });
      return [];
    }

    const year = parseInt(date.split('-')[0]);
    const metarRecords = this.loadMetarData(airport, year);
    if (metarRecords.length === 0) {
      logger.warn('No METAR data available', { airport, year });
      return [];
    }

    const arrivals = flightSummary.flights.filter(
      (f) => f.classification === 'arrival' && f.touchdown && f.touchdown.timestamp
    );

    logger.info('Processing arrivals', {
      airport,
      date,
      totalArrivals: arrivals.length,
      metarRecords: metarRecords.length,
    });

    const joined = [];

    for (const arrival of arrivals) {
      const touchdownTimestamp = arrival.touchdown.timestamp;
      const match = this.findNearestMetar(metarRecords, touchdownTimestamp);

      if (match) {
        joined.push({
          flight: arrival,
          weather: match.metar,
          timeDiffSeconds: match.timeDiffSeconds,
          airport,
          date,
        });
      } else {
        logger.debug('No METAR match found for arrival', {
          icao: arrival.icao,
          timestamp: touchdownTimestamp,
        });
      }
    }

    logger.info('Join complete', {
      airport,
      date,
      matched: joined.length,
      unmatched: arrivals.length - joined.length,
      matchRate: ((joined.length / arrivals.length) * 100).toFixed(1) + '%',
    });

    return joined;
  }

  /**
   * Join multiple dates
   * @param {string} airport - Airport ICAO code
   * @param {Array<string>} dates - Array of dates in YYYY-MM-DD format
   * @returns {Array} Array of joined records
   */
  joinMultiple(airport, dates) {
    const allJoined = [];

    for (const date of dates) {
      const joined = this.join(airport, date);
      allJoined.push(...joined);
    }

    return allJoined;
  }
}

export default FlightWeatherJoiner;


