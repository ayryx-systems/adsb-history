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
    // Distance threshold for arrivals/departures (must come from/go to at least this distance)
    this.MIN_DISTANCE_THRESHOLD = 2; // nm
    
    this.airportProximityRadius = config.airportProximityRadius || 5; // nm
    this.groundAltitudeThreshold = config.groundAltitudeThreshold || 500; // feet
    this.touchdownProximity = config.touchdownProximity || 1; // nm
    this.missedApproachBoundary = config.missedApproachBoundary || this.MIN_DISTANCE_THRESHOLD; // nm
    this.missedApproachMaxAGL = config.missedApproachMaxAGL || 1000; // feet AGL
    this.missedApproachMaxTime = config.missedApproachMaxTime || 2 * 60; // 2 minutes in seconds
  }

  /**
   * Analyze a flight trace for a specific airport
   * Returns multiple events if the trace contains both arrival and departure segments
   * @param {string} icao - Aircraft ICAO code
   * @param {Array} trace - Readsb trace data (array of position reports)
   * @param {object} airport - Airport object with coordinates
   * @param {string} date - Date in YYYY-MM-DD format
   * @param {object} metadata - Aircraft metadata (registration, aircraftType, description)
   * @returns {Array} Array of flight events (can be multiple per aircraft)
   */
  analyzeFlight(icao, trace, airport, date, metadata = {}) {
    const { registration = null, aircraftType = null, description = null } = metadata;
    if (!trace || !Array.isArray(trace) || trace.length < 5) {
      return [];
    }

    const airportLat = airport.coordinates.lat;
    const airportLon = airport.coordinates.lon;
    const airportElevation = airport.elevation_ft || 0;

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
      return [];
    }

    // Calculate distance from airport for each position
    const positionsWithDistance = positions.map(pos => ({
      ...pos,
      distance: calculateDistance(pos.lat, pos.lon, airportLat, airportLon),
      alt_agl: pos.alt_baro !== null ? pos.alt_baro - airportElevation : null,
    }));

    // Sort by timestamp
    positionsWithDistance.sort((a, b) => a.timestamp - b.timestamp);

    // Find closest approach
    const closestApproach = positionsWithDistance.reduce((min, pos) => 
      pos.distance < min.distance ? pos : min, positionsWithDistance[0]);

    // If never got close to airport, skip
    if (closestApproach.distance > this.airportProximityRadius) {
      return [];
    }

    // Split trace into separate flight segments (arrival and departure)
    const segments = this.splitIntoSegments(positionsWithDistance, airportElevation);
    
    const events = [];
    
    // Analyze each segment independently
    for (let segIdx = 0; segIdx < segments.length; segIdx++) {
      const segment = segments[segIdx];
      const segmentClosestApproach = segment.reduce((min, pos) => 
        pos.distance < min.distance ? pos : min, segment[0]);

      // Check for missed approach
      const missedApproach = this.detectMissedApproach(segment, airportElevation);

      // Classify this segment
      const classification = this.classifyFlightSegment(
        segment,
        segmentClosestApproach,
        missedApproach
      );

      if (!classification) {
        continue;
      }

      // Check if there's a gap after this segment (next segment starts much later)
      const hasGapAfter = segIdx < segments.length - 1 && 
        segments[segIdx + 1].length > 0 &&
        segments[segIdx + 1][0].timestamp - segment[segment.length - 1].timestamp >= 5 * 60;

      // Analyze based on classification
      if (classification === 'arrival') {
        const arrivalEvent = this.analyzeArrival(icao, segment, airport, segmentClosestApproach, airportElevation, { registration, aircraftType, description }, hasGapAfter);
        if (arrivalEvent) events.push(arrivalEvent);
      } else if (classification === 'departure') {
        const departureEvent = this.analyzeDeparture(icao, segment, airport, segmentClosestApproach, airportElevation, { registration, aircraftType, description });
        if (departureEvent) events.push(departureEvent);
      } else if (classification === 'missed_approach') {
        events.push({
          icao,
          registration,
          type: aircraftType,
          desc: description,
          classification: 'missed_approach',
          closestApproach: {
            distance_nm: segmentClosestApproach.distance,
            altitude_ft: segmentClosestApproach.alt_baro,
            altitudeAGL_ft: segmentClosestApproach.alt_baro - airportElevation,
            timestamp: segmentClosestApproach.timestamp,
            lat: segmentClosestApproach.lat,
            lon: segmentClosestApproach.lon,
          },
          missedApproach: {
            entryTime: missedApproach.entryTime,
            exitTime: missedApproach.exitTime,
            duration: missedApproach.exitTime - missedApproach.entryTime,
            entryAltitudeAGL_ft: missedApproach.entryAltitudeAGL,
          },
          timeRange: {
            first: segment[0].timestamp,
            last: segment[segment.length - 1].timestamp,
          },
        });
      }
      // Skip overflights and touch-and-go (not interesting)
    }

    return events;
  }

  /**
   * Split trace into separate flight segments (arrival and departure)
   * Looks for periods where aircraft is on ground near airport as split points
   * Also splits on time gaps > 5 minutes (lost contact)
   */
  splitIntoSegments(positionsWithDistance, airportElevation) {
    const segments = [];
    const minSegmentLength = 5; // Minimum positions per segment
    const maxTimeGap = 5 * 60; // 5 minutes in seconds
    
    // First, find time gaps >= 5 minutes (lost contact)
    const timeGaps = [];
    for (let i = 1; i < positionsWithDistance.length; i++) {
      const timeDiff = positionsWithDistance[i].timestamp - positionsWithDistance[i - 1].timestamp;
      if (timeDiff >= maxTimeGap) {
        timeGaps.push(i);
      }
    }
    
    // Find periods where aircraft is on ground near airport
    const groundPeriods = [];
    let inGroundPeriod = false;
    let groundStartIndex = -1;
    
    for (let i = 0; i < positionsWithDistance.length; i++) {
      const pos = positionsWithDistance[i];
      const isNearAirport = pos.distance <= this.touchdownProximity;
      const isOnGround = pos.alt_baro <= this.groundAltitudeThreshold;
      
      if (isNearAirport && isOnGround) {
        if (!inGroundPeriod) {
          inGroundPeriod = true;
          groundStartIndex = i;
        }
      } else {
        if (inGroundPeriod) {
          // End of ground period
          const groundDuration = positionsWithDistance[i - 1].timestamp - positionsWithDistance[groundStartIndex].timestamp;
          // Only consider significant ground periods (> 5 minutes) as split points
          if (groundDuration > maxTimeGap) {
            groundPeriods.push({ start: groundStartIndex, end: i - 1 });
          }
          inGroundPeriod = false;
        }
      }
    }
    
    // Combine time gaps and ground periods into split points
    const splitPoints = new Set();
    for (const gap of timeGaps) {
      splitPoints.add(gap);
    }
    for (const groundPeriod of groundPeriods) {
      splitPoints.add(groundPeriod.start);
    }
    
    const sortedSplitPoints = Array.from(splitPoints).sort((a, b) => a - b);
    
    // If no split points, return entire trace as one segment
    if (sortedSplitPoints.length === 0) {
      return [positionsWithDistance];
    }
    
    // Split trace at split points
    let segmentStart = 0;
    for (const splitPoint of sortedSplitPoints) {
      // Segment before split point
      if (splitPoint > segmentStart + minSegmentLength) {
        segments.push(positionsWithDistance.slice(segmentStart, splitPoint));
      }
      segmentStart = splitPoint;
    }
    
    // Add final segment (if any)
    if (segmentStart < positionsWithDistance.length - minSegmentLength) {
      segments.push(positionsWithDistance.slice(segmentStart));
    }
    
    // If we didn't create segments, return entire trace
    if (segments.length === 0) {
      return [positionsWithDistance];
    }
    
    return segments;
  }

  /**
   * Classify a flight segment (similar to classifyFlight but for a segment)
   * Segments are already split, so we only need to classify as arrival or departure
   */
  classifyFlightSegment(positionsWithDistance, closestApproach, missedApproach = null) {
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

    // Check if aircraft was far enough away before/after
    const maxDistanceBefore = beforeAirport.length > 0
      ? Math.max(...beforeAirport.map(pos => pos.distance))
      : 0;
    const maxDistanceAfter = afterAirport.length > 0
      ? Math.max(...afterAirport.map(pos => pos.distance))
      : 0;

    // Arrival: high altitude before, low altitude near airport, came from at least 2nm
    const isArrival = (
      avgAltitudeBefore !== null &&
      avgAltitudeBefore > 5000 &&
      minAltitudeNearby < 5000 &&
      closestApproach.distance < 5 &&
      maxDistanceBefore >= this.MIN_DISTANCE_THRESHOLD
    );

    // Departure: low altitude near airport, high altitude after, goes to at least 2nm
    const isDeparture = (
      avgAltitudeAfter !== null &&
      avgAltitudeAfter > 5000 &&
      minAltitudeNearby < 5000 &&
      closestApproach.distance < 5 &&
      maxDistanceAfter >= this.MIN_DISTANCE_THRESHOLD
    );

    // First check if it's a valid arrival or departure
    if (isArrival) {
      return 'arrival';
    } else if (isDeparture) {
      return 'departure';
    }

    // Only check for missed approach if it's not a valid arrival or departure
    // Missed approaches are aircraft that approach but don't complete the landing
    if (missedApproach) {
      return 'missed_approach';
    }

    return null; // Skip overflights and other
  }

  /**
   * Detect missed approach: enters 2nm boundary below 1000ft AGL, leaves within 2 minutes
   * Must also show approach pattern (descending, coming from reasonable distance)
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
    
    // Check that aircraft was approaching from a reasonable distance (at least 5nm before entry)
    // This ensures it's not just a short segment or pattern work
    const positionsBeforeEntry = positionsWithDistance.slice(0, entryIndex);
    if (positionsBeforeEntry.length === 0) {
      return null; // No approach pattern visible
    }
    
    const maxDistanceBeforeEntry = Math.max(...positionsBeforeEntry.map(pos => pos.distance));
    if (maxDistanceBeforeEntry < 5) {
      return null; // Didn't come from far enough away - likely pattern work or short segment
    }
    
    // Check that aircraft was descending before entry (approach pattern)
    if (positionsBeforeEntry.length >= 3) {
      const recentBefore = positionsBeforeEntry.slice(-5); // Last 5 positions before entry
      const altitudes = recentBefore.map(pos => pos.alt_baro).filter(alt => alt !== null);
      if (altitudes.length >= 2) {
        const firstAlt = altitudes[0];
        const lastAlt = altitudes[altitudes.length - 1];
        // Should be descending (or at least not climbing significantly)
        if (lastAlt > firstAlt + 500) {
          return null; // Was climbing, not approaching
        }
      }
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
    
    // Check if left within 2 minutes AND was actually approaching (not just passing through)
    // Also require minimum duration of at least 10 seconds to avoid very brief passes
    if (duration >= 10 && duration <= this.missedApproachMaxTime) {
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

    // Check if aircraft was far enough away before/after
    const maxDistanceBefore = beforeAirport.length > 0
      ? Math.max(...beforeAirport.map(pos => pos.distance))
      : 0;
    const maxDistanceAfter = afterAirport.length > 0
      ? Math.max(...afterAirport.map(pos => pos.distance))
      : 0;

    // Arrival: high altitude before, low altitude near airport, came from at least 2nm
    const isArrival = (
      avgAltitudeBefore !== null &&
      avgAltitudeBefore > 5000 &&
      minAltitudeNearby < 5000 &&
      closestApproach.distance < 5 &&
      maxDistanceBefore >= this.MIN_DISTANCE_THRESHOLD
    );

    // Departure: low altitude near airport, high altitude after, goes to at least 2nm
    const isDeparture = (
      avgAltitudeAfter !== null &&
      avgAltitudeAfter > 5000 &&
      minAltitudeNearby < 5000 &&
      closestApproach.distance < 5 &&
      maxDistanceAfter >= this.MIN_DISTANCE_THRESHOLD
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
  analyzeArrival(icao, positionsWithDistance, airport, closestApproach, airportElevation = 0, metadata = {}, hasGapAfter = false) {
    const { registration = null, aircraftType = null, description = null } = metadata;
    
    // Check for lost contact scenarios where aircraft was approaching
    const approachThresholdAGL = 1000; // feet AGL
    const approachDistanceThreshold = 2; // nm
    const lostContactTimeout = 2 * 60; // 2 minutes in seconds
    
    // Find touchdown - prioritize last approach position before losing contact
    // CRITICAL: Only use positions from this segment, never from later segments
    let touchdown = null;
    
    // Get the maximum timestamp in this segment to ensure we never use later data
    const segmentMaxTimestamp = positionsWithDistance.length > 0 
      ? Math.max(...positionsWithDistance.map(p => p.timestamp))
      : 0;
    
    // Find the last position in approach configuration (low altitude, close to airport)
    // This is the most reliable indicator of when the aircraft actually landed
    let lastApproachPosition = null;
    for (let i = positionsWithDistance.length - 1; i >= 0; i--) {
      const pos = positionsWithDistance[i];
      if (pos.timestamp > segmentMaxTimestamp) {
        continue; // Skip positions from later segments
      }
      const agl = pos.alt_agl !== null ? pos.alt_agl : (pos.alt_baro !== null ? pos.alt_baro - airportElevation : null);
      if (agl !== null && agl < approachThresholdAGL && pos.distance <= approachDistanceThreshold) {
        lastApproachPosition = pos;
        break; // Found the last approach position
      }
    }
    
    // Find all ground positions near airport (only from this segment)
    const groundPositions = [];
    for (const pos of positionsWithDistance) {
      // Safety check: ensure position is actually in this segment
      if (pos.timestamp > segmentMaxTimestamp) {
        continue; // Skip positions from later segments
      }
      if (pos.distance <= this.touchdownProximity && 
          pos.alt_baro <= this.groundAltitudeThreshold) {
        groundPositions.push(pos);
      }
    }
    
    // If we have both approach and ground positions, determine which to use
    if (lastApproachPosition && groundPositions.length > 0) {
      // Sort ground positions by timestamp
      groundPositions.sort((a, b) => a.timestamp - b.timestamp);
      const firstGroundPos = groundPositions[0];
      
      // If ground positions occur after the approach position, we lost contact during approach
      // Use the approach position as touchdown
      if (firstGroundPos.timestamp > lastApproachPosition.timestamp) {
        touchdown = lastApproachPosition;
      } else {
        // Ground position is before or at same time as approach - use ground position (actual landing)
        touchdown = firstGroundPos;
      }
    } else if (lastApproachPosition) {
      // Only have approach position - use it
      touchdown = lastApproachPosition;
    } else if (groundPositions.length > 0) {
      // Only have ground positions - use first one
      groundPositions.sort((a, b) => a.timestamp - b.timestamp);
      touchdown = groundPositions[0];
    }
    
    // Also check if the last position in the segment is on ground near airport
    // This handles cases where we lose contact right after landing
    // CRITICAL: This must be the actual last position in the segment (before any gap)
    if (!touchdown && positionsWithDistance.length > 0) {
      // Find the actual last position in this segment (not from later segments)
      const segmentPositions = positionsWithDistance.filter(p => p.timestamp <= segmentMaxTimestamp);
      if (segmentPositions.length > 0) {
        const lastPos = segmentPositions[segmentPositions.length - 1];
        if (lastPos.distance <= this.touchdownProximity && 
            lastPos.alt_baro <= this.groundAltitudeThreshold) {
          // Use this as touchdown (it's the most recent and likely the actual landing)
          touchdown = lastPos;
        }
      }
    }
    
    // If no clear touchdown, check for lost contact scenarios
    if (!touchdown) {
      // Check for gaps in the data where aircraft was approaching
      for (let i = 1; i < positionsWithDistance.length; i++) {
        const prevPos = positionsWithDistance[i - 1];
        const currPos = positionsWithDistance[i];
        const timeGap = currPos.timestamp - prevPos.timestamp;
        
        // If gap is between 2 minutes and 5 minutes (lost contact but not segment split)
        // Note: gaps >= 5 minutes would have already split the segment
        if (timeGap >= lostContactTimeout && timeGap < 5 * 60) {
          // Check if previous position was in approach configuration
          const prevAGL = prevPos.alt_agl !== null ? prevPos.alt_agl : (prevPos.alt_baro !== null ? prevPos.alt_baro - airportElevation : null);
          const wasApproaching = prevAGL !== null && 
                                 prevAGL < approachThresholdAGL && 
                                 prevPos.distance <= approachDistanceThreshold;
          
          if (wasApproaching) {
            // Check if aircraft reappeared far from airport (left the area)
            const reappearedFar = currPos.distance > approachDistanceThreshold;
            
            // If aircraft didn't leave the area, consider it landed
            if (!reappearedFar) {
              touchdown = prevPos;
              break;
            }
          }
        }
      }
      
      // Also check if segment ends with aircraft in approach configuration
      // (no more data after this segment, so we lost contact)
      if (!touchdown && positionsWithDistance.length > 0) {
        const lastPos = positionsWithDistance[positionsWithDistance.length - 1];
        const lastAGL = lastPos.alt_agl !== null ? lastPos.alt_agl : (lastPos.alt_baro !== null ? lastPos.alt_baro - airportElevation : null);
        const wasApproaching = lastAGL !== null && 
                               lastAGL < approachThresholdAGL && 
                               lastPos.distance <= approachDistanceThreshold;
        
        if (wasApproaching) {
          // Since we're in a segment, if this is the last position, we lost contact
          // and aircraft was approaching - consider it landed
          touchdown = lastPos;
        }
      }
    }
    
    // If there's a gap after this segment and we still don't have a touchdown,
    // use the last position in the segment if it's in approach configuration
    // This handles cases where we lose contact during approach
    if (!touchdown && hasGapAfter && positionsWithDistance.length > 0) {
      const lastPos = positionsWithDistance[positionsWithDistance.length - 1];
      const lastAGL = lastPos.alt_agl !== null ? lastPos.alt_agl : (lastPos.alt_baro !== null ? lastPos.alt_baro - airportElevation : null);
      const wasApproaching = lastAGL !== null && 
                             lastAGL < approachThresholdAGL && 
                             lastPos.distance <= approachDistanceThreshold;
      
      if (wasApproaching) {
        touchdown = lastPos;
      }
    }

    // CRITICAL: Final safety check - ensure touchdown is from this segment only
    // Verify touchdown is actually in the positionsWithDistance array for this segment
    if (touchdown) {
      const touchdownInSegment = positionsWithDistance.find(p => 
        p.timestamp === touchdown.timestamp && 
        p.lat === touchdown.lat && 
        p.lon === touchdown.lon
      );
      
      if (!touchdownInSegment) {
        // Touchdown is not in this segment - reset it
        touchdown = null;
      }
    }
    
    // If still no touchdown, use closest approach from THIS segment only
    if (!touchdown) {
      // Recalculate closest approach from this segment to ensure it's correct
      const segmentClosest = positionsWithDistance.reduce((min, pos) => 
        pos.distance < min.distance ? pos : min, positionsWithDistance[0]);
      touchdown = segmentClosest;
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
      registration,
      type: aircraftType,
      desc: description,
      classification: 'arrival',
      touchdown: {
        timestamp: touchdown.timestamp,
        distance_nm: touchdown.distance,
        altitude_ft: touchdown.alt_baro,
        altitudeAGL_ft: touchdown.alt_baro - airportElevation,
        lat: touchdown.lat,
        lon: touchdown.lon,
      },
      milestones: milestoneTimes,
      closestApproach: {
        distance_nm: closestApproach.distance,
        altitude_ft: closestApproach.alt_baro,
        altitudeAGL_ft: closestApproach.alt_baro - airportElevation,
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
  analyzeDeparture(icao, positionsWithDistance, airport, closestApproach, airportElevation = 0, metadata = {}) {
    const { registration = null, aircraftType = null, description = null } = metadata;
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
      registration,
      type: aircraftType,
      desc: description,
      classification: 'departure',
      takeoff: {
        timestamp: takeoff.timestamp,
        distance_nm: takeoff.distance,
        altitude_ft: takeoff.alt_baro,
        altitudeAGL_ft: takeoff.alt_baro - airportElevation,
        lat: takeoff.lat,
        lon: takeoff.lon,
      },
      milestones: milestoneTimes,
      closestApproach: {
        distance_nm: closestApproach.distance,
        altitude_ft: closestApproach.alt_baro,
        altitudeAGL_ft: closestApproach.alt_baro - airportElevation,
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

