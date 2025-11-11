import logger from '../utils/logger.js';

/**
 * Classifies flights as arrivals, departures, or overflights based on trace data
 * 
 * Readsb trace format (from wiedehopf/readsb):
 *   [[timestamp, lat, lon, alt_baro, gs, track, ...], ...]
 * 
 * Fields:
 *   0: timestamp (Unix epoch seconds)
 *   1: lat (degrees, null if no position)
 *   2: lon (degrees, null if no position)
 *   3: alt_baro (feet, null if no altitude)
 *   4: gs (ground speed, knots, null if no speed)
 *   5: track (degrees, null if no track)
 *   6: flags (bitmask)
 *   7: alt_geom (geometric altitude, feet)
 *   8: ias (indicated airspeed, knots)
 *   9: tas (true airspeed, knots)
 *   10: mach
 *   11: track_rate (degrees/second)
 *   12: roll (degrees)
 *   13: mag_heading (degrees)
 *   14: true_heading (degrees)
 *   15: baro_rate (feet/minute)
 *   16: geom_rate (feet/minute)
 *   17: squawk
 *   18: emergency
 *   19: category (aircraft category)
 *   20: nav_altitude_mcp
 *   21: nav_altitude_fms
 *   22: nav_qnh
 *   23: nav_heading
 *   24: nic (navigation integrity category)
 *   25: rc (radius of containment)
 *   26: seen_pos (seconds since last position)
 *   27: version
 *   28: nic_baro
 *   29: nac_p
 *   30: nac_v
 *   31: sil
 *   32: sil_type
 *   33: gva
 *   34: sda
 */

/**
 * Calculate distance between two coordinates using Haversine formula
 * @param {number} lat1 - Latitude 1 (degrees)
 * @param {number} lon1 - Longitude 1 (degrees)
 * @param {number} lat2 - Latitude 2 (degrees)
 * @param {number} lon2 - Longitude 2 (degrees)
 * @returns {number} Distance in nautical miles
 */
function calculateDistance(lat1, lon1, lat2, lon2) {
  const R = 3440.065; // Earth radius in nautical miles
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

/**
 * Parse a position report from trace data
 */
function parsePosition(posArray, baseTimestamp = null) {
  if (!posArray || posArray.length < 6) return null;
  
  // Handle timestamp: can be relative (seconds since start of day) or absolute
  let timestamp = posArray[0];
  if (baseTimestamp !== null) {
    // If base timestamp is provided, assume position timestamps are relative
    // Add to base timestamp (start of day)
    // Only do this if timestamp looks like a relative value (reasonable range)
    if (timestamp >= 0 && timestamp < 86400 * 2) {
      // Less than 2 days - likely relative
      timestamp = baseTimestamp + timestamp;
    }
    // If timestamp is very large (> year 2000), assume it's already absolute
  }
  
  // Handle altitude: can be "ground" string or number
  let alt_baro = posArray[3];
  if (alt_baro === "ground" || alt_baro === null) {
    alt_baro = 0; // Treat ground as 0 feet
  } else if (typeof alt_baro === 'string') {
    // Try to parse if it's a string number
    alt_baro = parseFloat(alt_baro);
    if (isNaN(alt_baro)) alt_baro = null;
  }
  
  return {
    timestamp,
    lat: posArray[1],
    lon: posArray[2],
    alt_baro,
    gs: posArray[4],
    track: posArray[5],
    baro_rate: posArray[15] || null,
  };
}

/**
 * Classifies flights based on their relationship to an airport
 */
class FlightClassifier {
  constructor(config = {}) {
    // Configuration thresholds (can be adjusted based on analysis)
    this.arrivalAltitudeThreshold = config.arrivalAltitudeThreshold || 5000; // feet MSL
    this.airportProximityRadius = config.airportProximityRadius || 10; // nautical miles
    this.minPositionReports = config.minPositionReports || 5; // minimum positions to classify
    
    // Departure detection thresholds
    this.departureCloseRadius = config.departureCloseRadius || 2.0; // nautical miles - must be within this distance
    this.departureFarRadius = config.departureFarRadius || 5.0; // nautical miles - must be beyond this distance
    this.departureMinAltitudeAGL = config.departureMinAltitudeAGL || 2000; // feet AGL - minimum altitude when far away
  }

  /**
   * Classify a flight trace for a specific airport
   * @param {object} trace - Readsb trace data (array of position reports)
   * @param {object} airport - Airport object with icao, coordinates, etc.
   * @param {string} date - Date in YYYY-MM-DD format (optional, for timestamp calculation)
   * @returns {object|null} Classification result or null if not relevant
   */
  classifyFlight(trace, airport, date = null) {
    if (!trace || !Array.isArray(trace) || trace.length < this.minPositionReports) {
      return null;
    }

    const airportLat = airport.coordinates.lat;
    const airportLon = airport.coordinates.lon;
    const airportElevation = airport.elevation_ft || 0; // Airport elevation in feet AMSL

    // Calculate base timestamp (start of day) if date is provided
    let baseTimestamp = null;
    if (date) {
      const dateObj = new Date(date + 'T00:00:00Z');
      baseTimestamp = Math.floor(dateObj.getTime() / 1000);
    }

    // Parse all valid positions and convert AMSL to AGL
    const positions = trace
      .map(pos => {
        const parsed = parsePosition(pos, baseTimestamp);
        if (parsed && parsed.alt_baro !== null) {
          // Convert AMSL to AGL by subtracting airport elevation
          parsed.alt_agl = parsed.alt_baro - airportElevation;
        }
        return parsed;
      })
      .filter(pos => pos && pos.lat !== null && pos.lon !== null && pos.alt_baro !== null);

    if (positions.length < this.minPositionReports) {
      return null;
    }

    // Calculate distance from airport for each position
    const positionsWithDistance = positions.map(pos => ({
      ...pos,
      distance: calculateDistance(pos.lat, pos.lon, airportLat, airportLon),
    }));

    // Find closest approach to airport
    const closestApproach = positionsWithDistance.reduce((min, pos) => 
      pos.distance < min.distance ? pos : min, positionsWithDistance[0]);

    // If never got close to airport, classify as overflight or not relevant
    if (closestApproach.distance > this.airportProximityRadius) {
      return null; // Not relevant to this airport
    }

    // Analyze flight pattern near airport
    const nearbyPositions = positionsWithDistance.filter(
      pos => pos.distance <= this.airportProximityRadius
    );

    if (nearbyPositions.length === 0) {
      return null;
    }

    // Sort by timestamp
    nearbyPositions.sort((a, b) => a.timestamp - b.timestamp);

    const firstNearbyPos = nearbyPositions[0];
    const lastNearbyPos = nearbyPositions[nearbyPositions.length - 1];

    // Get positions before and after airport proximity
    const beforeAirport = positionsWithDistance.filter(
      pos => pos.timestamp < firstNearbyPos.timestamp
    );
    const afterAirport = positionsWithDistance.filter(
      pos => pos.timestamp > lastNearbyPos.timestamp
    );

    // Classify based on altitude profile
    // Use AGL (Above Ground Level) for ground detection and pattern analysis
    // Use AMSL (Above Mean Sea Level) for absolute altitude thresholds
    const avgAltitudeBefore = beforeAirport.length > 0
      ? beforeAirport.reduce((sum, pos) => sum + pos.alt_baro, 0) / beforeAirport.length
      : null;
    const avgAltitudeAfter = afterAirport.length > 0
      ? afterAirport.reduce((sum, pos) => sum + pos.alt_baro, 0) / afterAirport.length
      : null;
    const minAltitudeNearbyAGL = Math.min(...nearbyPositions.map(pos => pos.alt_agl));
    const minAltitudeNearbyMSL = Math.min(...nearbyPositions.map(pos => pos.alt_baro));
    const firstAltitudeNearbyAGL = nearbyPositions[0].alt_agl;
    const lastAltitudeNearbyAGL = nearbyPositions[nearbyPositions.length - 1].alt_agl;
    const firstAltitudeNearbyMSL = nearbyPositions[0].alt_baro;
    const lastAltitudeNearbyMSL = nearbyPositions[nearbyPositions.length - 1].alt_baro;

    // Calculate altitude trend within nearby positions (climbing or descending) - use AGL
    const altitudeTrendAGL = lastAltitudeNearbyAGL - firstAltitudeNearbyAGL;
    
    // Get max altitude in the entire trace (for departure detection) - use AGL
    const maxAltitudeOverallAGL = Math.max(...positions.map(pos => pos.alt_agl));
    
    // Check if aircraft was on ground (very low altitude) near airport - use AGL
    const wasOnGroundNearby = minAltitudeNearbyAGL < 500; // Within 500ft AGL of ground

    // Arrival detection: high altitude before, low altitude near airport
    // Use MSL for absolute altitude thresholds
    const isArrival = (
      avgAltitudeBefore !== null &&
      avgAltitudeBefore > this.arrivalAltitudeThreshold &&
      minAltitudeNearbyMSL < this.arrivalAltitudeThreshold &&
      closestApproach.distance < 5 // Very close to airport
    );

    // Departure detection: simple and clear logic
    // Aircraft was within close radius of airport, then later has altitude > threshold AGL and is beyond far radius
    // Find positions within close radius of airport
    const positionsWithinClose = positionsWithDistance.filter(pos => pos.distance <= this.departureCloseRadius);
    
    // Find positions beyond far radius with altitude > threshold AGL
    const positionsBeyondFarHigh = positionsWithDistance.filter(
      pos => pos.distance > this.departureFarRadius && pos.alt_agl > this.departureMinAltitudeAGL
    );
    
    // Check if aircraft was close to airport, then later far away and high
    const wasCloseToAirport = positionsWithinClose.length > 0;
    const laterFarAndHigh = positionsBeyondFarHigh.length > 0;
    
    // If we have both, check that the "far and high" positions come after the "close" positions
    let isDeparture = false;
    if (wasCloseToAirport && laterFarAndHigh) {
      const lastCloseTime = Math.max(...positionsWithinClose.map(pos => pos.timestamp));
      const firstFarHighTime = Math.min(...positionsBeyondFarHigh.map(pos => pos.timestamp));
      // Far and high must come after being close
      isDeparture = firstFarHighTime > lastCloseTime && !isArrival;
    }

    // Determine classification
    let classification = 'overflight';
    if (isArrival && !isDeparture) {
      classification = 'arrival';
    } else if (isDeparture && !isArrival) {
      classification = 'departure';
    } else if (isArrival && isDeparture) {
      // Touch-and-go or short stopover
      classification = 'touch_and_go';
    }

    return {
      classification,
      closestApproach: {
        distance: closestApproach.distance,
        altitude: closestApproach.alt_baro,
        timestamp: closestApproach.timestamp,
        lat: closestApproach.lat,
        lon: closestApproach.lon,
      },
      altitudeProfile: {
        minNearbyMSL: minAltitudeNearbyMSL,
        minNearbyAGL: minAltitudeNearbyAGL,
        maxNearbyMSL: Math.max(...nearbyPositions.map(pos => pos.alt_baro)),
        maxNearbyAGL: Math.max(...nearbyPositions.map(pos => pos.alt_agl)),
        firstNearbyMSL: firstAltitudeNearbyMSL,
        firstNearbyAGL: firstAltitudeNearbyAGL,
        lastNearbyMSL: lastAltitudeNearbyMSL,
        lastNearbyAGL: lastAltitudeNearbyAGL,
        altitudeTrendAGL: altitudeTrendAGL,
        maxOverallAGL: maxAltitudeOverallAGL,
        wasOnGroundNearby: wasOnGroundNearby,
        airportElevation: airportElevation,
        avgBefore: avgAltitudeBefore,
        avgAfter: avgAltitudeAfter,
      },
      positionCounts: {
        total: positions.length,
        nearby: nearbyPositions.length,
        before: beforeAirport.length,
        after: afterAirport.length,
      },
      timeRange: {
        first: positions[0].timestamp,
        last: positions[positions.length - 1].timestamp,
        firstNearby: firstNearbyPos.timestamp,
        lastNearby: lastNearbyPos.timestamp,
      },
    };
  }

  /**
   * Get summary statistics for a classified flight
   * @param {object} trace - Readsb trace data
   * @param {object} classification - Classification result
   * @returns {object} Flight summary
   */
  getFlightSummary(trace, classification) {
    const positions = trace
      .map(parsePosition)
      .filter(pos => pos && pos.lat !== null && pos.lon !== null);

    if (positions.length === 0) {
      return null;
    }

    const altitudes = positions.filter(p => p.alt_baro !== null).map(p => p.alt_baro);
    const speeds = positions.filter(p => p.gs !== null).map(p => p.gs);

    return {
      classification: classification.classification,
      closestApproach: classification.closestApproach,
      duration: classification.timeRange.last - classification.timeRange.first,
      altitudeRange: {
        min: Math.min(...altitudes),
        max: Math.max(...altitudes),
        avg: altitudes.reduce((a, b) => a + b, 0) / altitudes.length,
      },
      speedRange: speeds.length > 0 ? {
        min: Math.min(...speeds),
        max: Math.max(...speeds),
        avg: speeds.reduce((a, b) => a + b, 0) / speeds.length,
      } : null,
      positionCount: positions.length,
    };
  }
}

export default FlightClassifier;

