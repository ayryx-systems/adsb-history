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
    this.goAroundBoundary = config.goAroundBoundary || this.MIN_DISTANCE_THRESHOLD; // nm
    this.goAroundMaxAGL = config.goAroundMaxAGL || 1400; // feet AGL
    this.goAroundMaxTime = config.goAroundMaxTime || 2 * 60; // 2 minutes in seconds
    this.goAroundMinDistance = config.goAroundMinDistance || 5; // nm - must have passed this distance before go-around
    this.goAroundMaxTimeFromThreshold = config.goAroundMaxTimeFromThreshold || 15 * 60; // 15 minutes - max time between passing threshold and go-around
    this.goAroundMinApproachDistance = config.goAroundMinApproachDistance || 20; // nm - must have been beyond this distance in past 90 minutes (filters pattern work)
    this.goAroundMaxApproachTime = config.goAroundMaxApproachTime || 90 * 60; // 90 minutes - look back window for approach distance check
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
    
    // First pass: detect all go-arounds across all segments
    // This allows us to exclude go-around positions when analyzing arrivals
    const goAroundsBySegment = [];
    for (let segIdx = 0; segIdx < segments.length; segIdx++) {
      const segment = segments[segIdx];
      const goAround = this.detectGoAround(segment, airportElevation, positionsWithDistance);
      goAroundsBySegment[segIdx] = goAround;
    }
    
    // Second pass: analyze segments and create events
    for (let segIdx = 0; segIdx < segments.length; segIdx++) {
      const segment = segments[segIdx];
      const segmentClosestApproach = segment.reduce((min, pos) => 
        pos.distance < min.distance ? pos : min, segment[0]);

      // Check for missed approach
      const missedApproach = this.detectMissedApproach(segment, airportElevation);

      // Get go-around for this segment (already detected in first pass)
      const goAround = goAroundsBySegment[segIdx];

      // Classify this segment (go-arounds are now independent, so don't pass to classification)
      const classification = this.classifyFlightSegment(
        segment,
        segmentClosestApproach,
        missedApproach,
        null
      );

      // Check if there's a gap after this segment (next segment starts much later)
      const hasGapAfter = segIdx < segments.length - 1 && 
        segments[segIdx + 1].length > 0 &&
        segments[segIdx + 1][0].timestamp - segment[segment.length - 1].timestamp >= 5 * 60;

      // Add go-around as independent event if detected (before other classifications)
      if (goAround) {
        events.push({
          icao,
          registration,
          type: aircraftType,
          desc: description,
          classification: 'go_around',
          closestApproach: {
            distance_nm: segmentClosestApproach.distance,
            altitude_ft: segmentClosestApproach.alt_baro,
            altitudeAGL_ft: segmentClosestApproach.alt_baro - airportElevation,
            timestamp: segmentClosestApproach.timestamp,
            lat: segmentClosestApproach.lat,
            lon: segmentClosestApproach.lon,
          },
          goAround: {
            entryTime: goAround.entryTime,
            exitTime: goAround.exitTime,
            duration: goAround.exitTime - goAround.entryTime,
            entryAltitudeAGL_ft: goAround.entryAltitudeAGL,
            exitAltitudeAGL_ft: goAround.exitAltitudeAGL,
            maxAltitudeAGL_ft: goAround.maxAltitudeAGL,
          },
          timeRange: {
            first: segment[0].timestamp,
            last: segment[segment.length - 1].timestamp,
          },
        });
      }

      // Analyze based on classification (can coexist with go-around)
      if (classification === 'arrival') {
        // Collect all go-arounds from all segments for this aircraft
        // This ensures we exclude go-around positions even if they're in different segments
        const allGoArounds = [];
        for (let i = 0; i < segments.length; i++) {
          if (goAroundsBySegment[i]) {
            const gaSegment = segments[i];
            allGoArounds.push({
              goAround: {
                entryTime: goAroundsBySegment[i].entryTime,
                exitTime: goAroundsBySegment[i].exitTime,
              },
            });
          }
        }
        const arrivalEvent = this.analyzeArrival(icao, segment, airport, segmentClosestApproach, airportElevation, { registration, aircraftType, description }, hasGapAfter, allGoArounds);
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
  classifyFlightSegment(positionsWithDistance, closestApproach, missedApproach = null, goAround = null) {
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

    // Note: Go-arounds are now detected independently, not as a classification
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
   * Detect go-around: aircraft approaches (passes 5nm), enters 2nm boundary below 1000ft AGL,
   * exits within 2 minutes, and climbs above 1000ft AGL
   * Go-arounds are distinct from missed approaches in that they climb significantly after entry
   * 
   * @param {Array} segment - Current segment being analyzed
   * @param {number} airportElevation - Airport elevation in feet
   * @param {Array} fullTrace - Full trace positions (for checking approach history to filter pattern work)
   */
  detectGoAround(segment, airportElevation, fullTrace = null) {
    const positionsWithDistance = segment;
    const boundary = this.goAroundBoundary;
    
    const traceToCheck = (fullTrace && fullTrace.length > 0) ? fullTrace : positionsWithDistance;
    
    let entryPos = null;
    let entryIndex = -1;
    
    for (let i = 0; i < traceToCheck.length; i++) {
      const pos = traceToCheck[i];
      const agl = pos.alt_baro - airportElevation;
      
      const isInsideBoundary = pos.distance <= boundary;
      
      if (!isInsideBoundary || agl >= this.goAroundMaxAGL) {
        continue;
      }
      
      const lookbackWindow = 15 * 60;
      const positionsBefore = traceToCheck.filter(p => 
        p.timestamp < pos.timestamp && 
        p.timestamp >= pos.timestamp - lookbackWindow
      );
      
      if (positionsBefore.length === 0) {
        continue;
      }
      
      const wasOutsideRecently = positionsBefore.some(p => p.distance > boundary);
      if (!wasOutsideRecently) {
        continue;
      }
      
      const wasOutside = true;
      
      if (wasOutside) {
        const segmentStartTime = positionsWithDistance[0]?.timestamp || 0;
        const segmentEndTime = positionsWithDistance[positionsWithDistance.length - 1]?.timestamp || Infinity;
        if (pos.timestamp >= segmentStartTime && pos.timestamp <= segmentEndTime) {
          entryPos = { ...pos, agl };
          entryIndex = i;
          break;
        }
      }
    }
    
    if (!entryPos) {
      return null;
    }
    
    const traceForApproachCheck = (fullTrace && fullTrace.length > 0) ? fullTrace : positionsWithDistance;
    const positionsBeforeEntry = traceForApproachCheck.filter(pos => pos.timestamp < entryPos.timestamp);
    
    if (positionsBeforeEntry.length === 0) {
      return null;
    }
    
    let passedThreshold = false;
    for (let i = positionsBeforeEntry.length - 1; i >= 0; i--) {
      if (positionsBeforeEntry[i].distance >= this.goAroundMinDistance) {
        passedThreshold = true;
        break;
      }
    }
    
    if (!passedThreshold) {
      return null;
    }
    
    const lookbackWindow = 10 * 60;
    const recentBefore = positionsBeforeEntry.filter(pos => 
      pos.timestamp >= entryPos.timestamp - lookbackWindow
    );
    
    if (recentBefore.length >= 2) {
      const firstDist = recentBefore[0].distance;
      const lastDist = recentBefore[recentBefore.length - 1].distance;
      const isApproaching = lastDist < firstDist;
      if (!isApproaching) {
        return null;
      }
    }
    
    const traceToSearch = (fullTrace && fullTrace.length > 0) ? fullTrace : positionsWithDistance;
    let exitPos = null;
    
    let searchEntryIndex = -1;
    for (let i = 0; i < traceToSearch.length; i++) {
      if (traceToSearch[i].timestamp === entryPos.timestamp &&
          Math.abs(traceToSearch[i].distance - entryPos.distance) < 0.01) {
        searchEntryIndex = i;
        break;
      }
    }
    
    const startSearchIndex = searchEntryIndex >= 0 ? searchEntryIndex + 1 : entryIndex + 1;
    
    for (let i = startSearchIndex; i < traceToSearch.length; i++) {
      const pos = traceToSearch[i];
      const wasInside = i === startSearchIndex || traceToSearch[i - 1].distance <= boundary;
      if (wasInside && pos.distance > boundary) {
        exitPos = { ...pos, agl: pos.alt_baro - airportElevation };
        break;
      }
    }
    
    if (!exitPos) {
      return null;
    }
    
    const duration = exitPos.timestamp - entryPos.timestamp;
    if (duration < 10 || duration > this.goAroundMaxTime) {
      return null;
    }
    
    const positionsAfterEntry = traceToSearch.filter(pos => 
      pos.timestamp >= entryPos.timestamp && pos.timestamp <= exitPos.timestamp
    );
    
    let maxAltitudeAGL = entryPos.agl;
    for (const pos of positionsAfterEntry) {
      const agl = pos.alt_baro - airportElevation;
      if (agl > maxAltitudeAGL) {
        maxAltitudeAGL = agl;
      }
    }
    
    return {
      entryTime: entryPos.timestamp,
      exitTime: exitPos.timestamp,
      entryAltitudeAGL: entryPos.agl,
      exitAltitudeAGL: exitPos.agl,
      maxAltitudeAGL: maxAltitudeAGL,
    };
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
   * @param {Array} goArounds - Array of go-around events for this aircraft (to exclude from touchdown detection)
   */
  analyzeArrival(icao, positionsWithDistance, airport, closestApproach, airportElevation = 0, metadata = {}, hasGapAfter = false, goArounds = []) {
    const { registration = null, aircraftType = null, description = null } = metadata;
    
    // Check for lost contact scenarios where aircraft was approaching
    const approachThresholdAGL = 1000; // feet AGL
    const approachDistanceThreshold = 2; // nm
    const lostContactTimeout = 2 * 60; // 2 minutes in seconds
    
    // CRITICAL: Exclude positions that are part of go-arounds
    // Go-arounds can cause false touchdown detection during the low-altitude phase
    const goAroundTimeRanges = goArounds.map(ga => ({
      start: ga.goAround.entryTime,
      end: ga.goAround.exitTime,
    }));
    
    // Filter out positions that fall within any go-around time window
    const positionsExcludingGoArounds = positionsWithDistance.filter(pos => {
      return !goAroundTimeRanges.some(range => 
        pos.timestamp >= range.start && pos.timestamp <= range.end
      );
    });
    
    // Find touchdown - prioritize last approach position before losing contact
    // CRITICAL: Only use positions from this segment, never from later segments
    // AND exclude positions that are part of go-arounds
    let touchdown = null;
    
    // Get the maximum timestamp in this segment to ensure we never use later data
    const segmentMaxTimestamp = positionsWithDistance.length > 0 
      ? Math.max(...positionsWithDistance.map(p => p.timestamp))
      : 0;
    
    // Find all ground positions near airport (only from this segment, excluding go-arounds)
    const groundPositions = [];
    for (const pos of positionsExcludingGoArounds) {
      // Safety check: ensure position is actually in this segment
      if (pos.timestamp > segmentMaxTimestamp) {
        continue; // Skip positions from later segments
      }
      if (pos.distance <= this.touchdownProximity && 
          pos.alt_baro <= this.groundAltitudeThreshold) {
        groundPositions.push(pos);
      }
    }
    
    // Find the last approach position before the first ground position
    // This ensures we use the approach position right before landing, not a later one
    let lastApproachPosition = null;
    if (groundPositions.length > 0) {
      // Sort ground positions to find the first one
      groundPositions.sort((a, b) => a.timestamp - b.timestamp);
      const firstGroundPos = groundPositions[0];
      
      // Find last approach position before first ground position (excluding go-arounds)
      for (let i = positionsExcludingGoArounds.length - 1; i >= 0; i--) {
        const pos = positionsExcludingGoArounds[i];
        if (pos.timestamp > segmentMaxTimestamp || pos.timestamp >= firstGroundPos.timestamp) {
          continue; // Skip positions from later segments or after first ground position
        }
        const agl = pos.alt_agl !== null ? pos.alt_agl : (pos.alt_baro !== null ? pos.alt_baro - airportElevation : null);
        if (agl !== null && agl < approachThresholdAGL && pos.distance <= approachDistanceThreshold) {
          lastApproachPosition = pos;
          break; // Found the last approach position before landing
        }
      }
    } else {
      // No ground positions - find last approach position in entire segment (excluding go-arounds)
      for (let i = positionsExcludingGoArounds.length - 1; i >= 0; i--) {
        const pos = positionsExcludingGoArounds[i];
        if (pos.timestamp > segmentMaxTimestamp) {
          continue; // Skip positions from later segments
        }
        const agl = pos.alt_agl !== null ? pos.alt_agl : (pos.alt_baro !== null ? pos.alt_baro - airportElevation : null);
        if (agl !== null && agl < approachThresholdAGL && pos.distance <= approachDistanceThreshold) {
          lastApproachPosition = pos;
          break; // Found the last approach position
        }
      }
    }
    
    // Determine touchdown: use first ground position if available, otherwise use approach position
    if (groundPositions.length > 0) {
      groundPositions.sort((a, b) => a.timestamp - b.timestamp);
      touchdown = groundPositions[0];
    } else if (lastApproachPosition) {
      touchdown = lastApproachPosition;
    }
    
    // Also check if the last position in the segment is on ground near airport
    // This handles cases where we lose contact right after landing
    // CRITICAL: This must be the actual last position in the segment (before any gap)
    // AND exclude go-around positions
    if (!touchdown && positionsExcludingGoArounds.length > 0) {
      // Find the actual last position in this segment (not from later segments, excluding go-arounds)
      const segmentPositions = positionsExcludingGoArounds.filter(p => p.timestamp <= segmentMaxTimestamp);
      if (segmentPositions.length > 0) {
        const lastPos = segmentPositions[segmentPositions.length - 1];
        if (lastPos.distance <= this.touchdownProximity && 
            lastPos.alt_baro <= this.groundAltitudeThreshold) {
          // Use this as touchdown (it's the most recent and likely the actual landing)
          touchdown = lastPos;
        }
      }
    }
    
    // If no clear touchdown, check for lost contact scenarios (excluding go-arounds)
    if (!touchdown) {
      // Check for gaps in the data where aircraft was approaching
      for (let i = 1; i < positionsExcludingGoArounds.length; i++) {
        const prevPos = positionsExcludingGoArounds[i - 1];
        const currPos = positionsExcludingGoArounds[i];
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
      // Exclude go-around positions
      if (!touchdown && positionsExcludingGoArounds.length > 0) {
        const lastPos = positionsExcludingGoArounds[positionsExcludingGoArounds.length - 1];
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
    // Exclude go-around positions
    if (!touchdown && hasGapAfter && positionsExcludingGoArounds.length > 0) {
      const lastPos = positionsExcludingGoArounds[positionsExcludingGoArounds.length - 1];
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
    // AND is not part of a go-around
    if (touchdown) {
      const touchdownInSegment = positionsWithDistance.find(p => 
        p.timestamp === touchdown.timestamp && 
        p.lat === touchdown.lat && 
        p.lon === touchdown.lon
      );
      
      if (!touchdownInSegment) {
        // Touchdown is not in this segment - reset it
        touchdown = null;
      } else {
        // Double-check it's not in a go-around time window
        const isInGoAround = goAroundTimeRanges.some(range => 
          touchdown.timestamp >= range.start && touchdown.timestamp <= range.end
        );
        if (isInGoAround) {
          // Touchdown is during a go-around - reset it
          touchdown = null;
        }
      }
    }
    
    // If still no touchdown, use closest approach from THIS segment only (excluding go-arounds)
    if (!touchdown) {
      // Recalculate closest approach from this segment, excluding go-around positions
      if (positionsExcludingGoArounds.length > 0) {
        const segmentClosest = positionsExcludingGoArounds.reduce((min, pos) => 
          pos.distance < min.distance ? pos : min, positionsExcludingGoArounds[0]);
        touchdown = segmentClosest;
      } else {
        // Fallback: use closest from all positions if no positions remain after excluding go-arounds
        const segmentClosest = positionsWithDistance.reduce((min, pos) => 
          pos.distance < min.distance ? pos : min, positionsWithDistance[0]);
        touchdown = segmentClosest;
      }
    }

    // Find distance milestones (100nm, 50nm, 20nm) before touchdown
    // Use original positionsWithDistance for milestone calculation (go-arounds don't affect milestones)
    const milestones = [100, 50, 20];
    const milestoneTimes = {};

    // Find touchdown index in original positions array
    const touchdownIndex = positionsWithDistance.findIndex(p => 
      p.timestamp === touchdown.timestamp && 
      p.lat === touchdown.lat && 
      p.lon === touchdown.lon
    );
    
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

