import logger from '../utils/logger.js';

/**
 * Calculate distance between two coordinates using Haversine formula
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
  
  // Handle timestamp
  let timestamp = posArray[0];
  if (baseTimestamp !== null && timestamp >= 0 && timestamp < 86400 * 2) {
    timestamp = baseTimestamp + timestamp;
  }
  
  // Handle altitude: can be "ground" string or number
  let alt_baro = posArray[3];
  if (alt_baro === "ground" || alt_baro === null) {
    alt_baro = 0;
  } else if (typeof alt_baro === 'string') {
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
 * Analyzes a flight trace to extract detailed flight information
 * including distance milestones and touchdown times
 */
class FlightAnalyzer {
  constructor(config = {}) {
    this.airportProximityRadius = config.airportProximityRadius || 5; // nm
    this.groundAltitudeThreshold = config.groundAltitudeThreshold || 500; // feet
    this.touchdownProximity = config.touchdownProximity || 1; // nm
    this.missedApproachBoundary = config.missedApproachBoundary || 2; // nm
    this.missedApproachMaxAGL = config.missedApproachMaxAGL || 1000; // feet AGL
    this.missedApproachMaxTime = config.missedApproachMaxTime || 2 * 60; // 2 minutes in seconds
  }

  /**
   * Analyze a flight trace for a specific airport
   * @param {string} icao - Aircraft ICAO code
   * @param {Array} trace - Readsb trace data (array of position reports)
   * @param {object} airport - Airport object with coordinates
   * @param {string} date - Date in YYYY-MM-DD format
   * @returns {object|null} Flight analysis result or null if not relevant
   */
  analyzeFlight(icao, trace, airport, date) {
    if (!trace || !Array.isArray(trace) || trace.length < 5) {
      return null;
    }

    const airportLat = airport.coordinates.lat;
    const airportLon = airport.coordinates.lon;

    // Calculate base timestamp
    let baseTimestamp = null;
    if (date) {
      const dateObj = new Date(date + 'T00:00:00Z');
      baseTimestamp = Math.floor(dateObj.getTime() / 1000);
    }

    // Parse all valid positions
    const positions = trace
      .map(pos => parsePosition(pos, baseTimestamp))
      .filter(pos => pos && pos.lat !== null && pos.lon !== null && pos.alt_baro !== null);

    if (positions.length < 5) {
      return null;
    }

    // Calculate distance from airport for each position
    const positionsWithDistance = positions.map(pos => ({
      ...pos,
      distance: calculateDistance(pos.lat, pos.lon, airportLat, airportLon),
    }));

    // Sort by timestamp
    positionsWithDistance.sort((a, b) => a.timestamp - b.timestamp);

    // Find closest approach
    const closestApproach = positionsWithDistance.reduce((min, pos) => 
      pos.distance < min.distance ? pos : min, positionsWithDistance[0]);

    // If never got close to airport, skip
    if (closestApproach.distance > this.airportProximityRadius) {
      return null;
    }

    // Check for missed approach before classifying
    const airportElevation = airport.elevation_ft || 0;
    const missedApproach = this.detectMissedApproach(
      positionsWithDistance,
      airportElevation
    );

    // Classify as arrival or departure
    const classification = this.classifyFlight(
      positionsWithDistance,
      closestApproach,
      missedApproach
    );

    if (!classification) {
      return null;
    }

    // Analyze based on classification
    if (classification === 'arrival') {
      return this.analyzeArrival(icao, positionsWithDistance, airport, closestApproach, airportElevation);
    } else if (classification === 'departure') {
      return this.analyzeDeparture(icao, positionsWithDistance, airport, closestApproach, airportElevation);
    } else if (classification === 'missed_approach') {
      // Missed approach - return detailed info
      return {
        icao,
        classification: 'missed_approach',
        closestApproach: {
          distance: closestApproach.distance,
          altitude: closestApproach.alt_baro,
          altitudeAGL: closestApproach.alt_baro - airportElevation,
          timestamp: closestApproach.timestamp,
          lat: closestApproach.lat,
          lon: closestApproach.lon,
        },
        missedApproach: {
          entryTime: missedApproach.entryTime,
          exitTime: missedApproach.exitTime,
          duration: missedApproach.exitTime - missedApproach.entryTime,
          entryAltitudeAGL: missedApproach.entryAltitudeAGL,
        },
        timeRange: {
          first: positionsWithDistance[0].timestamp,
          last: positionsWithDistance[positionsWithDistance.length - 1].timestamp,
        },
      };
    } else {
      // Overflight or other - return basic info (but filter these out as not interesting)
      return {
        icao,
        classification,
        closestApproach: {
          distance: closestApproach.distance,
          altitude: closestApproach.alt_baro,
          altitudeAGL: closestApproach.alt_baro - airportElevation,
          timestamp: closestApproach.timestamp,
          lat: closestApproach.lat,
          lon: closestApproach.lon,
        },
        timeRange: {
          first: positionsWithDistance[0].timestamp,
          last: positionsWithDistance[positionsWithDistance.length - 1].timestamp,
        },
      };
    }
  }

  /**
   * Detect missed approach: enters 2nm boundary below 1000ft AGL, leaves within 2 minutes
   */
  detectMissedApproach(positionsWithDistance, airportElevation) {
    const boundary = this.missedApproachBoundary;
    
    // Find entry and exit points for the boundary
    let entryPos = null;
    let entryIndex = -1;
    
    // Find first entry into boundary below 1000ft AGL
    for (let i = 0; i < positionsWithDistance.length; i++) {
      const pos = positionsWithDistance[i];
      const agl = pos.alt_baro - airportElevation;
      
      // Check if entering boundary (was outside, now inside) and below max AGL
      const wasOutside = i === 0 || positionsWithDistance[i - 1].distance > boundary;
      if (wasOutside && pos.distance <= boundary && agl < this.missedApproachMaxAGL) {
        entryPos = { ...pos, agl };
        entryIndex = i;
        break;
      }
    }
    
    if (!entryPos) {
      return null;
    }
    
    // Find first exit from boundary after entry
    let exitPos = null;
    for (let i = entryIndex + 1; i < positionsWithDistance.length; i++) {
      const pos = positionsWithDistance[i];
      
      // Check if exiting boundary (was inside, now outside)
      if (pos.distance > boundary) {
        exitPos = { ...pos, agl: pos.alt_baro - airportElevation };
        break;
      }
    }
    
    if (!exitPos) {
      return null;
    }
    
    const duration = exitPos.timestamp - entryPos.timestamp;
    
    // Check if left within 2 minutes
    if (duration <= this.missedApproachMaxTime) {
      return {
        entryTime: entryPos.timestamp,
        exitTime: exitPos.timestamp,
        entryAltitudeAGL: entryPos.agl,
      };
    }
    
    return null;
  }

  /**
   * Classify flight as arrival, departure, missed approach, or other
   */
  classifyFlight(positionsWithDistance, closestApproach, missedApproach = null) {
    const nearbyPositions = positionsWithDistance.filter(
      pos => pos.distance <= this.airportProximityRadius
    );

    if (nearbyPositions.length === 0) {
      return null;
    }

    nearbyPositions.sort((a, b) => a.timestamp - b.timestamp);
    const firstNearby = nearbyPositions[0];
    const lastNearby = nearbyPositions[nearbyPositions.length - 1];

    // Get positions before and after airport proximity
    const beforeAirport = positionsWithDistance.filter(
      pos => pos.timestamp < firstNearby.timestamp
    );
    const afterAirport = positionsWithDistance.filter(
      pos => pos.timestamp > lastNearby.timestamp
    );

    // Check altitude profiles
    const avgAltitudeBefore = beforeAirport.length > 0
      ? beforeAirport.reduce((sum, pos) => sum + pos.alt_baro, 0) / beforeAirport.length
      : null;
    const avgAltitudeAfter = afterAirport.length > 0
      ? afterAirport.reduce((sum, pos) => sum + pos.alt_baro, 0) / afterAirport.length
      : null;
    const minAltitudeNearby = Math.min(...nearbyPositions.map(pos => pos.alt_baro));

    // Arrival: high altitude before, low altitude near airport
    const isArrival = (
      avgAltitudeBefore !== null &&
      avgAltitudeBefore > 5000 &&
      minAltitudeNearby < 5000 &&
      closestApproach.distance < 5
    );

    // Departure: low altitude near airport, high altitude after
    const isDeparture = (
      avgAltitudeAfter !== null &&
      avgAltitudeAfter > 5000 &&
      minAltitudeNearby < 5000 &&
      closestApproach.distance < 5
    );

    // If both patterns exist, check if it's a true touch-and-go or separate flights
    if (isArrival && isDeparture) {
      // Calculate time between first and last nearby positions
      const timeOnGround = lastNearby.timestamp - firstNearby.timestamp;
      const maxTouchAndGoTime = 2 * 60; // 2 minutes in seconds
      
      // True touch-and-go: short time on ground (< 2 minutes)
      // Separate flights: long time on ground (>= 2 minutes) - classify as arrival only
      // (The departure will be captured when we process the departure portion separately)
      if (timeOnGround < maxTouchAndGoTime) {
        return 'touch_and_go';
      } else {
        // Long time on ground - treat as separate flights
        // Prefer arrival classification since we're analyzing from the arrival perspective
        return 'arrival';
      }
    }

    if (isArrival && !isDeparture) {
      return 'arrival';
    } else if (isDeparture && !isArrival) {
      return 'departure';
    }

    // Check for missed approach before defaulting to overflight
    if (missedApproach) {
      return 'missed_approach';
    }

    return 'overflight';
  }

  /**
   * Analyze an arrival flight
   */
  analyzeArrival(icao, positionsWithDistance, airport, closestApproach, airportElevation = 0) {
    // Find touchdown (first position on ground near airport)
    let touchdown = null;
    for (const pos of positionsWithDistance) {
      if (pos.distance <= this.touchdownProximity && 
          pos.alt_baro <= this.groundAltitudeThreshold) {
        touchdown = pos;
        break;
      }
    }

    // If no clear touchdown, use closest approach as proxy
    if (!touchdown) {
      touchdown = closestApproach;
    }

    // Find distance milestones (100nm, 50nm, 20nm) before touchdown
    const milestones = [100, 50, 20];
    const milestoneTimes = {};

    // Find touchdown index
    const touchdownIndex = positionsWithDistance.findIndex(p => p === touchdown);
    
    // Work backwards from touchdown to find when aircraft crossed each milestone
    for (const milestone of milestones) {
      // Find the last position before touchdown where distance >= milestone
      // This represents when the aircraft was at or just passed the milestone going towards airport
      let milestonePos = null;
      for (let i = touchdownIndex - 1; i >= 0; i--) {
        const pos = positionsWithDistance[i];
        if (pos.distance >= milestone) {
          milestonePos = pos;
          break;
        }
      }
      
      if (milestonePos) {
        const timeToTouchdown = touchdown.timestamp - milestonePos.timestamp;
        milestoneTimes[`timeFrom${milestone}nm`] = timeToTouchdown;
      }
    }

    return {
      icao,
      classification: 'arrival',
      touchdown: {
        timestamp: touchdown.timestamp,
        distance: touchdown.distance,
        altitude: touchdown.alt_baro,
        altitudeAGL: touchdown.alt_baro - airportElevation,
        lat: touchdown.lat,
        lon: touchdown.lon,
      },
      milestones: milestoneTimes,
      closestApproach: {
        distance: closestApproach.distance,
        altitude: closestApproach.alt_baro,
        altitudeAGL: closestApproach.alt_baro - airportElevation,
        timestamp: closestApproach.timestamp,
        lat: closestApproach.lat,
        lon: closestApproach.lon,
      },
      timeRange: {
        first: positionsWithDistance[0].timestamp,
        last: positionsWithDistance[positionsWithDistance.length - 1].timestamp,
      },
    };
  }

  /**
   * Analyze a departure flight
   */
  analyzeDeparture(icao, positionsWithDistance, airport, closestApproach, airportElevation = 0) {
    // Find takeoff (first position on ground near airport, then first position in air)
    let takeoff = null;
    let takeoffIndex = -1;
    
    for (let i = 0; i < positionsWithDistance.length; i++) {
      const pos = positionsWithDistance[i];
      if (pos.distance <= this.touchdownProximity && 
          pos.alt_baro <= this.groundAltitudeThreshold) {
        // Found ground position near airport
        // Look for next position that's in the air
        for (let j = i + 1; j < positionsWithDistance.length; j++) {
          const nextPos = positionsWithDistance[j];
          if (nextPos.alt_baro > this.groundAltitudeThreshold) {
            takeoff = nextPos;
            takeoffIndex = j;
            break;
          }
        }
        if (takeoff) break;
      }
    }

    // If no clear takeoff, use closest approach as proxy
    if (!takeoff) {
      takeoff = closestApproach;
      takeoffIndex = positionsWithDistance.findIndex(p => p === closestApproach);
    }

    // Find distance milestones (20nm, 50nm, 100nm) after takeoff
    const milestones = [20, 50, 100];
    const milestoneTimes = {};

    // Work forwards from takeoff to find when aircraft crossed each milestone
    for (const milestone of milestones) {
      // Find the first position after takeoff where distance >= milestone
      // This represents when the aircraft reached or passed the milestone going away from airport
      let milestonePos = null;
      for (let i = takeoffIndex + 1; i < positionsWithDistance.length; i++) {
        const pos = positionsWithDistance[i];
        if (pos.distance >= milestone) {
          milestonePos = pos;
          break;
        }
      }
      
      if (milestonePos) {
        const timeFromTakeoff = milestonePos.timestamp - takeoff.timestamp;
        milestoneTimes[`timeTo${milestone}nm`] = timeFromTakeoff;
      }
    }

    return {
      icao,
      classification: 'departure',
      takeoff: {
        timestamp: takeoff.timestamp,
        distance: takeoff.distance,
        altitude: takeoff.alt_baro,
        altitudeAGL: takeoff.alt_baro - airportElevation,
        lat: takeoff.lat,
        lon: takeoff.lon,
      },
      milestones: milestoneTimes,
      closestApproach: {
        distance: closestApproach.distance,
        altitude: closestApproach.alt_baro,
        altitudeAGL: closestApproach.alt_baro - airportElevation,
        timestamp: closestApproach.timestamp,
        lat: closestApproach.lat,
        lon: closestApproach.lon,
      },
      timeRange: {
        first: positionsWithDistance[0].timestamp,
        last: positionsWithDistance[positionsWithDistance.length - 1].timestamp,
      },
    };
  }
}

export default FlightAnalyzer;

