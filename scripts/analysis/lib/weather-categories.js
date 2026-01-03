/**
 * Weather categorization utilities for situation matching
 * 
 * These categories are used to group similar weather conditions
 * for matching historical arrival patterns.
 */

/**
 * Categorize visibility into flight category bands
 * Based on FAA flight categories
 * @param {number} visibilitySM - Visibility in statute miles
 * @returns {string} Category: VFR, MVFR, IFR, or LIFR
 */
export function categorizeVisibility(visibilitySM) {
  if (visibilitySM === null || visibilitySM === undefined) return 'unknown';
  if (visibilitySM >= 5) return 'VFR';
  if (visibilitySM >= 3) return 'MVFR';
  if (visibilitySM >= 1) return 'IFR';
  return 'LIFR';
}

/**
 * Categorize ceiling into flight category bands
 * Based on FAA flight categories
 * @param {number|null} ceilingFt - Ceiling in feet AGL, null if unlimited
 * @returns {string} Category: VFR, MVFR, IFR, LIFR, or unlimited
 */
export function categorizeCeiling(ceilingFt) {
  if (ceilingFt === null || ceilingFt === undefined) return 'unlimited';
  if (ceilingFt >= 3000) return 'VFR';
  if (ceilingFt >= 1000) return 'MVFR';
  if (ceilingFt >= 500) return 'IFR';
  return 'LIFR';
}

/**
 * Categorize wind speed
 * @param {number} windKt - Wind speed in knots
 * @returns {string} Category: calm, light, moderate, or strong
 */
export function categorizeWind(windKt) {
  if (windKt === null || windKt === undefined) return 'unknown';
  if (windKt < 5) return 'calm';
  if (windKt < 15) return 'light';
  if (windKt < 25) return 'moderate';
  return 'strong';
}

/**
 * Categorize precipitation type from weather codes
 * @param {string[]} wxCodes - Array of weather codes from METAR
 * @returns {string} Category: none, rain, snow, fog, thunderstorm, or freezing
 */
export function categorizePrecipitation(wxCodes) {
  if (!wxCodes || wxCodes.length === 0) return 'none';
  const codes = wxCodes.join(' ').toUpperCase();
  if (codes.includes('TS')) return 'thunderstorm';
  if (codes.includes('FZ')) return 'freezing';
  if (codes.includes('SN') || codes.includes('GR') || codes.includes('PL') || codes.includes('GS')) return 'snow';
  if (codes.includes('FG')) return 'fog';
  if (codes.includes('BR') || codes.includes('HZ')) return 'mist';
  if (codes.includes('RA') || codes.includes('DZ') || codes.includes('SH')) return 'rain';
  return 'none';
}

/**
 * Calculate visibility trend from lookback METARs
 * @param {Array} lookbackMetars - Array of METAR records, oldest first
 * @param {number} currentVisibility - Current visibility in SM
 * @returns {string} Trend: improving, steady, or deteriorating
 */
export function calculateTrend(lookbackMetars, currentVisibility) {
  if (!lookbackMetars || lookbackMetars.length < 2) return 'steady';
  
  const visibilities = lookbackMetars
    .map(m => m.visibility_sm_v)
    .filter(v => v !== null && v !== undefined);
  
  if (visibilities.length < 2) return 'steady';
  
  const earlierHalf = visibilities.slice(0, Math.floor(visibilities.length / 2));
  const earlierAvg = earlierHalf.reduce((a, b) => a + b, 0) / earlierHalf.length;
  
  const diff = currentVisibility - earlierAvg;
  if (diff > 1.5) return 'improving';
  if (diff < -1.5) return 'deteriorating';
  return 'steady';
}

/**
 * Compute overall flight category (worst of visibility and ceiling)
 * @param {number} visibility - Visibility in SM
 * @param {number|null} ceiling - Ceiling in feet
 * @returns {string} Flight category: VFR, MVFR, IFR, or LIFR
 */
export function computeFlightCategory(visibility, ceiling) {
  const visCat = categorizeVisibility(visibility);
  const ceilCat = categorizeCeiling(ceiling);
  
  const order = ['LIFR', 'IFR', 'MVFR', 'VFR', 'unlimited', 'unknown'];
  const visIdx = order.indexOf(visCat);
  const ceilIdx = order.indexOf(ceilCat);
  
  return order[Math.min(visIdx, ceilIdx)];
}

/**
 * Extract ceiling from METAR cloud groups
 * Ceiling is the lowest BKN or OVC layer
 * @param {Object} metar - METAR record with cloud_groups_raw
 * @returns {number|null} Ceiling in feet, or null if no ceiling
 */
export function extractCeiling(metar) {
  if (!metar || !metar.cloud_groups_raw) return null;
  
  let lowestCeiling = null;
  
  for (const cloud of metar.cloud_groups_raw) {
    const type = cloud.type_raw;
    const height = parseFloat(cloud.height_raw);
    
    if ((type === 'BKN' || type === 'OVC') && !isNaN(height)) {
      if (lowestCeiling === null || height < lowestCeiling) {
        lowestCeiling = height;
      }
    }
  }
  
  return lowestCeiling;
}

/**
 * Get time of day category from local time slot
 * @param {string} timeSlot - Time slot in HH:MM format
 * @returns {string} Category: earlyMorning, morning, midday, afternoon, evening, night
 */
export function getTimeOfDay(timeSlot) {
  const [hours] = timeSlot.split(':').map(Number);
  
  if (hours >= 5 && hours < 8) return 'earlyMorning';
  if (hours >= 8 && hours < 11) return 'morning';
  if (hours >= 11 && hours < 14) return 'midday';
  if (hours >= 14 && hours < 18) return 'afternoon';
  if (hours >= 18 && hours < 22) return 'evening';
  return 'night';
}

/**
 * Check if two time-of-day categories overlap (within 1 period)
 * @param {string} tod1 - First time of day
 * @param {string} tod2 - Second time of day
 * @returns {boolean} True if they overlap
 */
export function timeOfDayOverlaps(tod1, tod2) {
  const order = ['earlyMorning', 'morning', 'midday', 'afternoon', 'evening', 'night'];
  const idx1 = order.indexOf(tod1);
  const idx2 = order.indexOf(tod2);
  
  if (idx1 === -1 || idx2 === -1) return false;
  
  return Math.abs(idx1 - idx2) <= 1 || 
         (idx1 === 0 && idx2 === order.length - 1) ||
         (idx2 === 0 && idx1 === order.length - 1);
}

/**
 * Get day of week from date string
 * @param {string} dateStr - Date in YYYY-MM-DD format
 * @returns {string} Day of week: sunday, monday, etc.
 */
export function getDayOfWeek(dateStr) {
  const date = new Date(dateStr + 'T12:00:00Z');
  const days = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
  return days[date.getUTCDay()];
}

/**
 * Get day type from date
 * @param {string} dateStr - Date in YYYY-MM-DD format
 * @returns {string} Day type: weekday, weekend, or holiday identifier
 */
export function getDayType(dateStr) {
  const holiday = getHolidayOffset(dateStr);
  if (holiday) return 'holiday';
  
  const dayOfWeek = getDayOfWeek(dateStr);
  if (dayOfWeek === 'saturday' || dayOfWeek === 'sunday') return 'weekend';
  return 'weekday';
}

/**
 * Get holiday offset if date is within ±2 days of a US holiday
 * @param {string} dateStr - Date in YYYY-MM-DD format
 * @returns {string|null} Holiday identifier like "thanksgiving_-1" or null
 */
export function getHolidayOffset(dateStr) {
  const [year, month, day] = dateStr.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  
  const holidays = getUSHolidays(year);
  
  for (const holiday of holidays) {
    const holidayDate = new Date(Date.UTC(year, holiday.month - 1, holiday.day));
    const diffMs = date.getTime() - holidayDate.getTime();
    const diffDays = Math.round(diffMs / (1000 * 60 * 60 * 24));
    
    if (diffDays >= -2 && diffDays <= 2) {
      return `${holiday.key}_${diffDays}`;
    }
  }
  
  return null;
}

/**
 * Get US holidays for a given year
 * @param {number} year - Year
 * @returns {Array} Array of holiday objects with name, key, month, day
 */
function getUSHolidays(year) {
  const holidays = [];
  
  holidays.push({ name: "New Year's Day", key: 'new_years_day', month: 1, day: 1 });
  
  const mlkDay = getNthWeekday(year, 1, 1, 3);
  holidays.push({ name: 'Martin Luther King Jr. Day', key: 'mlk_day', month: 1, day: mlkDay });
  
  const presidentsDay = getNthWeekday(year, 2, 1, 3);
  holidays.push({ name: "Presidents' Day", key: 'presidents_day', month: 2, day: presidentsDay });
  
  const memorialDay = getLastWeekday(year, 5, 1);
  holidays.push({ name: 'Memorial Day', key: 'memorial_day', month: 5, day: memorialDay });
  
  holidays.push({ name: 'Independence Day', key: 'independence_day', month: 7, day: 4 });
  
  const laborDay = getNthWeekday(year, 9, 1, 1);
  holidays.push({ name: 'Labor Day', key: 'labor_day', month: 9, day: laborDay });
  
  const thanksgiving = getNthWeekday(year, 11, 4, 4);
  holidays.push({ name: 'Thanksgiving', key: 'thanksgiving', month: 11, day: thanksgiving });
  
  holidays.push({ name: 'Christmas', key: 'christmas', month: 12, day: 25 });
  
  return holidays;
}

function getNthWeekday(year, month, weekday, n) {
  const firstDay = new Date(Date.UTC(year, month - 1, 1));
  const firstWeekday = firstDay.getUTCDay();
  const offset = (weekday - firstWeekday + 7) % 7;
  return 1 + offset + (n - 1) * 7;
}

function getLastWeekday(year, month, weekday) {
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const lastDate = new Date(Date.UTC(year, month - 1, lastDay));
  const lastWeekday = lastDate.getUTCDay();
  const offset = (lastWeekday - weekday + 7) % 7;
  return lastDay - offset;
}

/**
 * Calculate percentile from sorted array
 * @param {number[]} sortedArr - Sorted array of numbers
 * @param {number} p - Percentile (0-100)
 * @returns {number|null} Percentile value
 */
export function percentile(sortedArr, p) {
  if (!sortedArr || sortedArr.length === 0) return null;
  const idx = Math.ceil((p / 100) * sortedArr.length) - 1;
  return sortedArr[Math.max(0, Math.min(idx, sortedArr.length - 1))];
}

