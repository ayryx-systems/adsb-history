/**
 * Extract weather features from normalized METAR JSON records
 * 
 * Features extracted:
 * - Visibility (statute miles)
 * - Ceiling (feet AGL)
 * - Wind speed, direction, gusts
 * - Crosswind/headwind components (requires runway heading)
 * - Temperature, dewpoint
 * - Precipitation indicators
 * - Flight category (VFR/MVFR/IFR/LIFR)
 */

class WeatherFeatureExtractor {
  constructor(config = {}) {
    this.defaultRunwayHeading = config.defaultRunwayHeading || null;
  }

  /**
   * Extract all weather features from a METAR record
   * @param {Object} metarRecord - Normalized METAR JSON record
   * @param {number} runwayHeading - Runway heading in degrees (optional)
   * @returns {Object} Feature object
   */
  extract(metarRecord, runwayHeading = null) {
    const heading = runwayHeading || this.defaultRunwayHeading;

    return {
      visibility_sm: this.extractVisibility(metarRecord),
      ceiling_ft: this.extractCeiling(metarRecord),
      wind_speed_kt: this.extractWindSpeed(metarRecord),
      wind_dir_deg: this.extractWindDirection(metarRecord),
      wind_gust_kt: this.extractWindGust(metarRecord),
      crosswind_kt: heading ? this.calculateCrosswind(metarRecord, heading) : null,
      headwind_kt: heading ? this.calculateHeadwind(metarRecord, heading) : null,
      temperature_F: this.extractTemperature(metarRecord),
      dewpoint_F: this.extractDewpoint(metarRecord),
      relative_humidity_pct: this.extractRelativeHumidity(metarRecord),
      altimeter_inHg: this.extractAltimeter(metarRecord),
      has_precipitation: this.hasPrecipitation(metarRecord),
      precipitation_type: this.extractPrecipitationType(metarRecord),
      flight_category: this.calculateFlightCategory(metarRecord),
      raw_metar: metarRecord.metar_raw || null,
    };
  }

  /**
   * Extract visibility in statute miles
   */
  extractVisibility(metarRecord) {
    const vis = metarRecord.visibility_sm_v;
    if (vis === null || vis === undefined || isNaN(vis)) {
      return null;
    }
    return vis;
  }

  /**
   * Extract ceiling (lowest cloud base) in feet AGL
   * Returns null if no ceiling (clear skies)
   */
  extractCeiling(metarRecord) {
    const cloudGroups = metarRecord.cloud_groups_raw || [];
    
    if (cloudGroups.length === 0) {
      return null;
    }

    let lowestCeiling = null;
    for (const cloud of cloudGroups) {
      const height = cloud.height_raw;
      if (height && height !== 'M' && !isNaN(parseFloat(height))) {
        const heightFt = parseFloat(height) * 100;
        if (lowestCeiling === null || heightFt < lowestCeiling) {
          lowestCeiling = heightFt;
        }
      }
    }

    return lowestCeiling;
  }

  /**
   * Extract wind speed in knots
   */
  extractWindSpeed(metarRecord) {
    const speed = metarRecord.wind_spd_kt_v;
    if (speed === null || speed === undefined || isNaN(speed)) {
      return 0;
    }
    return speed;
  }

  /**
   * Extract wind direction in degrees
   */
  extractWindDirection(metarRecord) {
    const dir = metarRecord.wind_dir_deg_v;
    if (dir === null || dir === undefined || isNaN(dir)) {
      return null;
    }
    return dir;
  }

  /**
   * Extract wind gust in knots
   */
  extractWindGust(metarRecord) {
    const gust = metarRecord.gust_kt_v;
    if (gust === null || gust === undefined || isNaN(gust)) {
      return 0;
    }
    return gust;
  }

  /**
   * Calculate crosswind component in knots
   * @param {Object} metarRecord - METAR record
   * @param {number} runwayHeading - Runway heading in degrees (0-360)
   * @returns {number} Crosswind component (always positive)
   */
  calculateCrosswind(metarRecord, runwayHeading) {
    const windSpeed = this.extractWindSpeed(metarRecord);
    const windDir = this.extractWindDirection(metarRecord);

    if (windDir === null || windSpeed === 0) {
      return 0;
    }

    const windAngle = Math.abs(windDir - runwayHeading);
    const windAngleRad = (windAngle * Math.PI) / 180;
    const crosswind = Math.abs(windSpeed * Math.sin(windAngleRad));

    return crosswind;
  }

  /**
   * Calculate headwind/tailwind component in knots
   * Positive = headwind, negative = tailwind
   * @param {Object} metarRecord - METAR record
   * @param {number} runwayHeading - Runway heading in degrees (0-360)
   * @returns {number} Headwind component (positive = headwind)
   */
  calculateHeadwind(metarRecord, runwayHeading) {
    const windSpeed = this.extractWindSpeed(metarRecord);
    const windDir = this.extractWindDirection(metarRecord);

    if (windDir === null || windSpeed === 0) {
      return 0;
    }

    const windAngle = windDir - runwayHeading;
    const windAngleRad = (windAngle * Math.PI) / 180;
    const headwind = windSpeed * Math.cos(windAngleRad);

    return headwind;
  }

  /**
   * Extract temperature in Fahrenheit
   */
  extractTemperature(metarRecord) {
    const temp = metarRecord.tmpf_F_v;
    if (temp === null || temp === undefined || isNaN(temp)) {
      return null;
    }
    return temp;
  }

  /**
   * Extract dewpoint in Fahrenheit
   */
  extractDewpoint(metarRecord) {
    const dew = metarRecord.dwpf_F_v;
    if (dew === null || dew === undefined || isNaN(dew)) {
      return null;
    }
    return dew;
  }

  /**
   * Extract relative humidity percentage
   */
  extractRelativeHumidity(metarRecord) {
    const rh = metarRecord.relh_pct_v;
    if (rh === null || rh === undefined || isNaN(rh)) {
      return null;
    }
    return rh;
  }

  /**
   * Extract altimeter setting in inches of mercury
   */
  extractAltimeter(metarRecord) {
    const alt = metarRecord.altim_inHg_v;
    if (alt === null || alt === undefined || isNaN(alt)) {
      return null;
    }
    return alt;
  }

  /**
   * Check if precipitation is present
   */
  hasPrecipitation(metarRecord) {
    const wxcodes = metarRecord.wxcodes_raw;
    if (!wxcodes || wxcodes === 'M') {
      return false;
    }

    const precipCodes = ['RA', 'SN', 'PL', 'DZ', 'SG', 'IC', 'GR', 'GS', 'UP', 'FZRA', 'FZSN', 'FZDZ'];
    const upperWx = wxcodes.toUpperCase();
    return precipCodes.some(code => upperWx.includes(code));
  }

  /**
   * Extract precipitation type(s)
   * @returns {Array<string>} Array of precipitation types
   */
  extractPrecipitationType(metarRecord) {
    const wxcodes = metarRecord.wxcodes_raw;
    if (!wxcodes || wxcodes === 'M') {
      return [];
    }

    const precipTypes = [];
    const upperWx = wxcodes.toUpperCase();

    const types = {
      'RA': 'rain',
      'SN': 'snow',
      'PL': 'ice_pellets',
      'DZ': 'drizzle',
      'SG': 'snow_grains',
      'IC': 'ice_crystals',
      'GR': 'hail',
      'GS': 'small_hail',
      'FZRA': 'freezing_rain',
      'FZSN': 'freezing_snow',
      'FZDZ': 'freezing_drizzle',
    };

    for (const [code, type] of Object.entries(types)) {
      if (upperWx.includes(code)) {
        precipTypes.push(type);
      }
    }

    return precipTypes;
  }

  /**
   * Calculate flight category (VFR/MVFR/IFR/LIFR)
   * Based on visibility and ceiling
   */
  calculateFlightCategory(metarRecord) {
    const visibility = this.extractVisibility(metarRecord);
    const ceiling = this.extractCeiling(metarRecord);

    if (visibility === null && ceiling === null) {
      return 'UNKNOWN';
    }

    const visMiles = visibility || 10;
    const ceilingFt = ceiling || 10000;

    if (visMiles < 1 || ceilingFt < 500) {
      return 'LIFR';
    } else if (visMiles < 3 || ceilingFt < 1000) {
      return 'IFR';
    } else if (visMiles < 5 || ceilingFt < 3000) {
      return 'MVFR';
    } else {
      return 'VFR';
    }
  }
}

export default WeatherFeatureExtractor;

