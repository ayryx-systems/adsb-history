/**
 * Extract temporal features from timestamps
 * 
 * Features extracted:
 * - Hour of day (0-23)
 * - Day of week (0-6, Sunday=0)
 * - Month (1-12)
 * - Weekend indicator
 * - Holiday indicator (to be extended)
 */

class TemporalFeatureExtractor {
  constructor(config = {}) {
    this.holidayCalendar = config.holidayCalendar || this.getDefaultHolidayCalendar();
  }

  /**
   * Extract all temporal features from a timestamp
   * @param {number|Date|string} timestamp - Unix timestamp, Date object, or ISO string
   * @returns {Object} Feature object
   */
  extract(timestamp) {
    const date = this.parseTimestamp(timestamp);
    if (!date) {
      return null;
    }

    return {
      hour: date.getUTCHours(),
      day_of_week: date.getUTCDay(),
      month: date.getUTCMonth() + 1,
      day_of_month: date.getUTCDate(),
      is_weekend: this.isWeekend(date),
      is_holiday: this.isHoliday(date),
      holiday_name: this.getHolidayName(date),
      quarter: Math.floor(date.getUTCMonth() / 3) + 1,
    };
  }

  /**
   * Parse various timestamp formats to Date object
   */
  parseTimestamp(timestamp) {
    if (timestamp instanceof Date) {
      return timestamp;
    }

    if (typeof timestamp === 'number') {
      return new Date(timestamp * 1000);
    }

    if (typeof timestamp === 'string') {
      const date = new Date(timestamp);
      if (!isNaN(date.getTime())) {
        return date;
      }
    }

    return null;
  }

  /**
   * Check if date is weekend (Saturday or Sunday)
   */
  isWeekend(date) {
    const day = date.getUTCDay();
    return day === 0 || day === 6;
  }

  /**
   * Check if date is a holiday
   */
  isHoliday(date) {
    return this.getHolidayName(date) !== null;
  }

  /**
   * Get holiday name if date is a holiday
   */
  getHolidayName(date) {
    const year = date.getUTCFullYear();
    const month = date.getUTCMonth() + 1;
    const day = date.getUTCDate();
    const key = `${year}-${month.toString().padStart(2, '0')}-${day.toString().padStart(2, '0')}`;

    return this.holidayCalendar[key] || null;
  }

  /**
   * Get default US holiday calendar
   * Can be extended with more holidays or different countries
   */
  getDefaultHolidayCalendar() {
    const holidays = {};

    for (let year = 2020; year <= 2030; year++) {
      holidays[`${year}-01-01`] = 'New Years Day';
      holidays[`${year}-07-04`] = 'Independence Day';
      holidays[`${year}-12-25`] = 'Christmas';
      holidays[`${year}-11-11`] = 'Veterans Day';

      const thanksgiving = this.getThanksgiving(year);
      holidays[thanksgiving] = 'Thanksgiving';

      const memorialDay = this.getMemorialDay(year);
      holidays[memorialDay] = 'Memorial Day';

      const laborDay = this.getLaborDay(year);
      holidays[laborDay] = 'Labor Day';
    }

    return holidays;
  }

  /**
   * Calculate Thanksgiving (4th Thursday in November)
   */
  getThanksgiving(year) {
    const nov1 = new Date(Date.UTC(year, 10, 1));
    const firstThursday = (4 - nov1.getUTCDay() + 7) % 7 || 7;
    const thanksgiving = new Date(Date.UTC(year, 10, firstThursday + 21));
    return `${year}-11-${thanksgiving.getUTCDate().toString().padStart(2, '0')}`;
  }

  /**
   * Calculate Memorial Day (last Monday in May)
   */
  getMemorialDay(year) {
    const may31 = new Date(Date.UTC(year, 4, 31));
    const lastMonday = may31.getUTCDate() - ((may31.getUTCDay() + 6) % 7);
    return `${year}-05-${lastMonday.toString().padStart(2, '0')}`;
  }

  /**
   * Calculate Labor Day (first Monday in September)
   */
  getLaborDay(year) {
    const sep1 = new Date(Date.UTC(year, 8, 1));
    const firstMonday = (1 - sep1.getUTCDay() + 7) % 7 || 7;
    return `${year}-09-${firstMonday.toString().padStart(2, '0')}`;
  }

  /**
   * Add custom holidays to calendar
   * @param {Object} customHolidays - Object mapping date strings to holiday names
   */
  addHolidays(customHolidays) {
    this.holidayCalendar = { ...this.holidayCalendar, ...customHolidays };
  }
}

export default TemporalFeatureExtractor;

