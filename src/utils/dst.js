/**
 * DST (Daylight Saving Time) configuration and utilities
 * 
 * Handles DST date calculations for different airports and years.
 * Supports US standard DST rules and custom per-airport/year overrides.
 */

/**
 * Calculate the second Sunday in March for a given year (US DST start)
 */
function getSecondSundayInMarch(year) {
  const date = new Date(year, 2, 1);
  const dayOfWeek = date.getDay();
  const daysToAdd = dayOfWeek === 0 ? 7 : 14 - dayOfWeek;
  date.setDate(1 + daysToAdd);
  return date;
}

/**
 * Calculate the first Sunday in November for a given year (US DST end)
 */
function getFirstSundayInNovember(year) {
  const date = new Date(year, 10, 1);
  const dayOfWeek = date.getDay();
  const daysToAdd = dayOfWeek === 0 ? 0 : 7 - dayOfWeek;
  date.setDate(1 + daysToAdd);
  return date;
}

/**
 * DST configuration per airport and year
 * Format: { airport: { year: { start: "YYYY-MM-DD", end: "YYYY-MM-DD" } } }
 * 
 * If not specified, defaults to US standard rules:
 * - Start: Second Sunday in March
 * - End: First Sunday in November
 */
const dstConfig = {
  KORD: {
    2025: {
      start: '2025-03-09',
      end: '2025-11-02',
    },
  },
};

/**
 * Get DST start date for an airport and year
 */
export function getDSTStart(airport, year) {
  const config = dstConfig[airport]?.[year];
  if (config?.start) {
    return new Date(config.start + 'T00:00:00Z');
  }
  return getSecondSundayInMarch(year);
}

/**
 * Get DST end date for an airport and year
 */
export function getDSTEnd(airport, year) {
  const config = dstConfig[airport]?.[year];
  if (config?.end) {
    return new Date(config.end + 'T00:00:00Z');
  }
  return getFirstSundayInNovember(year);
}

/**
 * Determine if a date is in summer (DST) or winter (standard time)
 * @param {string|Date} date - Date string (YYYY-MM-DD) or Date object
 * @param {string} airport - Airport ICAO code
 * @param {string|number} year - Year (YYYY)
 * @returns {string} 'summer' or 'winter'
 */
export function getSeason(date, airport, year) {
  const dateObj = typeof date === 'string' ? new Date(date + 'T00:00:00Z') : date;
  const yearNum = typeof year === 'string' ? parseInt(year, 10) : year;
  
  const dstStart = getDSTStart(airport, yearNum);
  const dstEnd = getDSTEnd(airport, yearNum);
  
  if (dateObj >= dstStart && dateObj < dstEnd) {
    return 'summer';
  }
  return 'winter';
}

/**
 * Get all DST transition dates for a year
 * Returns an object with start and end dates
 */
export function getDSTDates(airport, year) {
  const yearNum = typeof year === 'string' ? parseInt(year, 10) : year;
  return {
    start: getDSTStart(airport, yearNum),
    end: getDSTEnd(airport, yearNum),
  };
}

const airportTimezones = {
  KORD: { standard: -6, dst: -5 },
  KLAX: { standard: -8, dst: -7 },
  KJFK: { standard: -5, dst: -4 },
  KLGA: { standard: -5, dst: -4 },
  KSFO: { standard: -8, dst: -7 },
  KATL: { standard: -5, dst: -4 },
  KDFW: { standard: -6, dst: -5 },
  KDEN: { standard: -7, dst: -6 },
  KMIA: { standard: -5, dst: -4 },
  KBOS: { standard: -5, dst: -4 },
};

/**
 * Get UTC offset for an airport on a specific date
 * @param {string} airport - Airport ICAO code
 * @param {string} dateStr - Date string (YYYY-MM-DD)
 * @returns {number} UTC offset in hours (negative for west of UTC)
 */
export function getUTCOffset(airport, dateStr) {
  const tz = airportTimezones[airport] || { standard: -6, dst: -5 };
  const year = parseInt(dateStr.split('-')[0], 10);
  const season = getSeason(dateStr, airport, year);
  return season === 'summer' ? tz.dst : tz.standard;
}
