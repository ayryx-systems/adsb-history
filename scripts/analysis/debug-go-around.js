#!/usr/bin/env node

import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import TraceReader from '../../src/processing/TraceReader.js';
import FlightAnalyzer from '../../src/analysis/FlightAnalyzer.js';
import fs from 'fs';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function debugGoAround(icao, airport, date) {
  const traceReader = new TraceReader();
  const analyzer = new FlightAnalyzer();
  
  const airportConfigPath = path.join(__dirname, '../../config/airports.json');
  const airportConfig = JSON.parse(fs.readFileSync(airportConfigPath, 'utf-8'));
  const airportData = airportConfig.airports.find(a => a.icao === airport);
  
  if (!airportData) {
    console.error(`Airport ${airport} not found`);
    process.exit(1);
  }
  
  console.log(`\nExamining trace for ${icao} at ${airport} on ${date}`);
  console.log(`Airport elevation: ${airportData.elevation_ft}ft\n`);
  
  const extractDir = await traceReader.downloadExtractedTraces(airport, date);
  if (!extractDir) {
    console.error(`Extracted traces not found for ${airport} on ${date}`);
    console.error(`Please run: node scripts/extraction/extract-all-airports.js --start-date ${date} --end-date ${date} --airports ${airport}`);
    process.exit(1);
  }
  
  const traceData = await traceReader.getTraceByICAO(extractDir, icao);
  if (!traceData || !traceData.trace) {
    console.error(`Trace not found for ${icao}`);
    process.exit(1);
  }
  
  const trace = traceData.trace;
  console.log(`Trace loaded: ${trace.length} positions`);
  console.log(`Aircraft: ${traceData.aircraftType || 'Unknown'} (${traceData.registration || 'N/A'})\n`);
  
  const airportElevation = airportData.elevation_ft;
  const airportLat = airportData.coordinates.lat;
  const airportLon = airportData.coordinates.lon;
  
  function calculateDistance(lat1, lon1, lat2, lon2) {
    const R = 3440.065;
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
      Math.sin(dLon / 2) * Math.sin(dLon / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c;
  }
  
  function parsePosition(posArray, baseTimestamp = null) {
    if (!posArray || posArray.length < 6) return null;
    
    let timestamp = posArray[0];
    if (baseTimestamp !== null && timestamp >= 0 && timestamp < 86400 * 2) {
      timestamp = baseTimestamp + timestamp;
    }
    
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
  
  const dateObj = new Date(date + 'T00:00:00Z');
  const baseTimestamp = Math.floor(dateObj.getTime() / 1000);
  
  const positions = trace
    .map(pos => parsePosition(pos, baseTimestamp))
    .filter(pos => pos !== null && pos.alt_baro !== null);
  
  const positionsWithDistance = positions.map(pos => ({
    ...pos,
    distance: calculateDistance(pos.lat, pos.lon, airportLat, airportLon),
    agl: pos.alt_baro - airportElevation,
  }));
  
  console.log(`Analyzing ${positionsWithDistance.length} positions with distance\n`);
  
  const boundary = analyzer.goAroundBoundary;
  const maxAGL = analyzer.goAroundMaxAGL;
  
  console.log(`Go-around detection parameters:`);
  console.log(`  Boundary: ${boundary}nm`);
  console.log(`  Max AGL: ${maxAGL}ft`);
  console.log(`  Min distance: ${analyzer.goAroundMinDistance}nm`);
  console.log(`  Max time: ${analyzer.goAroundMaxTime}s`);
  console.log(`  Min approach distance: ${analyzer.goAroundMinApproachDistance}nm`);
  console.log(`  Max approach time: ${analyzer.goAroundMaxApproachTime}s\n`);
  
  const timeWindowStart = new Date('2025-01-15T15:00:00Z').getTime() / 1000;
  const timeWindowEnd = new Date('2025-01-15T15:10:00Z').getTime() / 1000;
  
  const relevantPositions = positionsWithDistance.filter(pos => 
    pos.timestamp >= timeWindowStart && pos.timestamp <= timeWindowEnd
  );
  
  console.log(`Positions around 15:05 UTC (${relevantPositions.length} positions):`);
  console.log('─'.repeat(100));
  console.log('Time (UTC)          Distance (nm)  Alt (ft)  AGL (ft)   GS (kt)  Track');
  console.log('─'.repeat(100));
  
  for (const pos of relevantPositions) {
    const timeStr = new Date(pos.timestamp * 1000).toISOString().substring(11, 19);
    const distanceStr = pos.distance.toFixed(2).padStart(8);
    const altStr = pos.alt_baro.toFixed(0).padStart(8);
    const aglStr = pos.agl.toFixed(0).padStart(8);
    const gsStr = (pos.gs || 0).toFixed(0).padStart(6);
    const trackStr = (pos.track || 0).toFixed(0).padStart(5);
    
    const marker = pos.distance <= boundary ? ' <-- IN BOUNDARY' : '';
    const aglMarker = pos.agl < maxAGL && pos.agl > -500 ? ' <-- BELOW MAX AGL' : '';
    
    console.log(`${timeStr}  ${distanceStr}  ${altStr}  ${aglStr}${aglMarker}  ${gsStr}  ${trackStr}${marker}`);
  }
  
  console.log('─'.repeat(100));
  console.log('');
  
  const goAround = analyzer.detectGoAround(positionsWithDistance, airportElevation, positionsWithDistance);
  
  if (goAround) {
    console.log('✓ Go-around DETECTED:');
    console.log(`  Entry time: ${new Date(goAround.entryTime * 1000).toISOString()}`);
    console.log(`  Exit time: ${new Date(goAround.exitTime * 1000).toISOString()}`);
    console.log(`  Entry altitude AGL: ${goAround.entryAltitudeAGL.toFixed(0)}ft`);
    console.log(`  Exit altitude AGL: ${goAround.exitAltitudeAGL.toFixed(0)}ft`);
    console.log(`  Max altitude AGL: ${goAround.maxAltitudeAGL.toFixed(0)}ft`);
    console.log(`  Duration: ${(goAround.exitTime - goAround.entryTime).toFixed(0)}s`);
  } else {
    console.log('✗ Go-around NOT detected');
    console.log('\nDebugging detection steps:\n');
    
    let entryPos = null;
    let entryIndex = -1;
    
    for (let i = 0; i < positionsWithDistance.length; i++) {
      const pos = positionsWithDistance[i];
      const agl = pos.alt_baro - airportElevation;
      
      const wasOutside = i === 0 || positionsWithDistance[i - 1].distance > boundary;
      if (wasOutside && pos.distance <= boundary && agl < maxAGL) {
        entryPos = { ...pos, agl };
        entryIndex = i;
        break;
      }
    }
    
    if (!entryPos) {
      console.log('  ✗ Step 1: No entry found into boundary below max AGL');
      console.log('    Looking for: distance <= 2nm AND AGL < 1000ft');
      
      const nearBoundary = positionsWithDistance.filter(pos => 
        pos.distance <= boundary + 0.5 && pos.distance >= boundary - 0.5
      );
      
      if (nearBoundary.length > 0) {
        console.log(`\n    Found ${nearBoundary.length} positions near boundary:`);
        for (const pos of nearBoundary.slice(0, 10)) {
          const timeStr = new Date(pos.timestamp * 1000).toISOString().substring(11, 19);
          console.log(`      ${timeStr}: distance=${pos.distance.toFixed(2)}nm, AGL=${pos.agl.toFixed(0)}ft`);
        }
      }
    } else {
      console.log(`  ✓ Step 1: Entry found at ${new Date(entryPos.timestamp * 1000).toISOString()}`);
      console.log(`    Distance: ${entryPos.distance.toFixed(2)}nm, AGL: ${entryPos.agl.toFixed(0)}ft`);
      
      const positionsBeforeEntry = positionsWithDistance.slice(0, entryIndex);
      if (positionsBeforeEntry.length === 0) {
        console.log('  ✗ Step 2: No positions before entry');
      } else {
        let thresholdCrossTime = null;
        for (let i = positionsBeforeEntry.length - 1; i >= 0; i--) {
          const pos = positionsBeforeEntry[i];
          if (pos.distance >= analyzer.goAroundMinDistance) {
            thresholdCrossTime = pos.timestamp;
            break;
          }
        }
        
        if (!thresholdCrossTime) {
          console.log('  ✗ Step 2: Never passed threshold distance (5nm)');
        } else {
          const timeFromThreshold = entryPos.timestamp - thresholdCrossTime;
          console.log(`  ✓ Step 2: Passed threshold at ${new Date(thresholdCrossTime * 1000).toISOString()}`);
          console.log(`    Time from threshold: ${timeFromThreshold.toFixed(0)}s`);
          
          if (timeFromThreshold < 0 || timeFromThreshold > analyzer.goAroundMaxTimeFromThreshold) {
            console.log(`  ✗ Step 3: Time from threshold too long (max: ${analyzer.goAroundMaxTimeFromThreshold}s)`);
          } else {
            console.log('  ✓ Step 3: Time from threshold OK');
            
            const lookbackStartTime = entryPos.timestamp - analyzer.goAroundMaxApproachTime;
            const relevantPositions = positionsWithDistance.filter(pos => 
              pos.timestamp >= lookbackStartTime && pos.timestamp <= entryPos.timestamp
            );
            
            if (relevantPositions.length === 0) {
              console.log('  ✗ Step 4: No positions in lookback window');
            } else {
              const maxDistanceInWindow = Math.max(...relevantPositions.map(pos => pos.distance));
              console.log(`  ✓ Step 4: Max distance in window: ${maxDistanceInWindow.toFixed(2)}nm`);
              
              if (maxDistanceInWindow < analyzer.goAroundMinApproachDistance) {
                console.log(`  ✗ Step 4: Max distance too small (min: ${analyzer.goAroundMinApproachDistance}nm)`);
              } else {
                console.log('  ✓ Step 4: Approach distance OK');
                
                if (positionsBeforeEntry.length >= 3) {
                  const recentBefore = positionsBeforeEntry.slice(-5);
                  const altitudes = recentBefore.map(pos => pos.alt_baro).filter(alt => alt !== null);
                  if (altitudes.length >= 2) {
                    const firstAlt = altitudes[0];
                    const lastAlt = altitudes[altitudes.length - 1];
                    console.log(`  ✓ Step 5: Altitude check - first: ${firstAlt.toFixed(0)}ft, last: ${lastAlt.toFixed(0)}ft`);
                    
                    if (lastAlt > firstAlt + 500) {
                      console.log('  ✗ Step 5: Was climbing before entry');
                    } else {
                      console.log('  ✓ Step 5: Descending pattern OK');
                      
                      let exitPos = null;
                      let exitIndex = -1;
                      for (let i = entryIndex + 1; i < positionsWithDistance.length; i++) {
                        const pos = positionsWithDistance[i];
                        if (pos.distance > boundary) {
                          exitPos = { ...pos, agl: pos.alt_baro - airportElevation };
                          exitIndex = i;
                          break;
                        }
                      }
                      
                      if (!exitPos) {
                        console.log('  ✗ Step 6: No exit from boundary found');
                      } else {
                        const duration = exitPos.timestamp - entryPos.timestamp;
                        console.log(`  ✓ Step 6: Exit found at ${new Date(exitPos.timestamp * 1000).toISOString()}`);
                        console.log(`    Duration: ${duration.toFixed(0)}s`);
                        
                        if (duration < 10 || duration > analyzer.goAroundMaxTime) {
                          console.log(`  ✗ Step 6: Duration out of range (min: 10s, max: ${analyzer.goAroundMaxTime}s)`);
                        } else {
                          console.log('  ✓ Step 6: Duration OK');
                          
                          const positionsAfterEntry = positionsWithDistance.slice(entryIndex, exitIndex + 1);
                          let maxAltitudeAGL = entryPos.agl;
                          let climbedAboveThreshold = false;
                          
                          for (const pos of positionsAfterEntry) {
                            const agl = pos.alt_baro - airportElevation;
                            if (agl > maxAltitudeAGL) {
                              maxAltitudeAGL = agl;
                            }
                            if (agl > maxAGL) {
                              climbedAboveThreshold = true;
                            }
                          }
                          
                          console.log(`  ✓ Step 7: Max altitude AGL after entry: ${maxAltitudeAGL.toFixed(0)}ft`);
                          console.log(`    Entry AGL: ${entryPos.agl.toFixed(0)}ft`);
                          console.log(`    Climbed above ${maxAGL}ft: ${climbedAboveThreshold}`);
                          
                          if (!climbedAboveThreshold) {
                            console.log(`  ✗ Step 7: Did not climb above ${maxAGL}ft AGL`);
                            
                            console.log('\n  Positions after entry:');
                            for (const pos of positionsAfterEntry.slice(0, 20)) {
                              const timeStr = new Date(pos.timestamp * 1000).toISOString().substring(11, 19);
                              console.log(`    ${timeStr}: AGL=${pos.agl.toFixed(0)}ft, alt=${pos.alt_baro.toFixed(0)}ft, dist=${pos.distance.toFixed(2)}nm`);
                            }
                          } else {
                            console.log('  ✓ Step 7: Climbed above threshold');
                          }
                        }
                      }
                    }
                  }
                }
              }
            }
          }
        }
      }
    }
  }
}

const icao = process.argv[2] || 'a5fc42';
const airport = process.argv[3] || 'KORD';
const date = process.argv[4] || '2025-01-15';

debugGoAround(icao, airport, date).catch(error => {
  console.error('Error:', error);
  process.exit(1);
});

