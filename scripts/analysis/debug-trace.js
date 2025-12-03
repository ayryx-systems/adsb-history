#!/usr/bin/env node

import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import TraceReader from '../../src/processing/TraceReader.js';
import fs from 'fs';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function debugTrace(icao, airport, date) {
  const traceReader = new TraceReader();
  
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
  
  console.log(`Analyzing ${positionsWithDistance.length} positions\n`);
  
  const goAroundEntryTime = new Date('2025-01-01T20:26:44Z').getTime() / 1000;
  const timeWindowStart = goAroundEntryTime - 30 * 60;
  const timeWindowEnd = goAroundEntryTime + 5 * 60;
  
  const relevantPositions = positionsWithDistance.filter(pos => 
    pos.timestamp >= timeWindowStart && pos.timestamp <= timeWindowEnd
  );
  
  console.log(`Positions around go-around detection (${relevantPositions.length} positions):`);
  console.log('─'.repeat(120));
  console.log('Time (UTC)          Distance (nm)  Alt (ft)  AGL (ft)   GS (kt)  Track  Direction');
  console.log('─'.repeat(120));
  
  for (let i = 0; i < relevantPositions.length; i++) {
    const pos = relevantPositions[i];
    const timeStr = new Date(pos.timestamp * 1000).toISOString().substring(11, 19);
    const distanceStr = pos.distance.toFixed(2).padStart(8);
    const altStr = pos.alt_baro.toFixed(0).padStart(8);
    const aglStr = pos.agl.toFixed(0).padStart(8);
    const gsStr = (pos.gs || 0).toFixed(0).padStart(6);
    const trackStr = (pos.track || 0).toFixed(0).padStart(5);
    
    let direction = '';
    if (i > 0) {
      const prevDist = relevantPositions[i - 1].distance;
      if (pos.distance < prevDist) {
        direction = '→ APPROACHING';
      } else if (pos.distance > prevDist) {
        direction = '← DEPARTING';
      }
    }
    
    const marker = pos.timestamp >= goAroundEntryTime && pos.timestamp <= goAroundEntryTime + 60 ? ' <-- GO-AROUND WINDOW' : '';
    
    console.log(`${timeStr}  ${distanceStr}  ${altStr}  ${aglStr}  ${gsStr}  ${trackStr}  ${direction}${marker}`);
  }
  
  console.log('─'.repeat(120));
  console.log('');
  
  const positionsBeforeEntry = positionsWithDistance.filter(pos => pos.timestamp < goAroundEntryTime);
  console.log(`\nChecking approach history before entry:`);
  console.log(`  Total positions before entry: ${positionsBeforeEntry.length}`);
  
  if (positionsBeforeEntry.length > 0) {
    const distances = positionsBeforeEntry.map(pos => pos.distance);
    const maxDistance = Math.max(...distances);
    const minDistance = Math.min(...distances);
    console.log(`  Max distance before entry: ${maxDistance.toFixed(2)}nm`);
    console.log(`  Min distance before entry: ${minDistance.toFixed(2)}nm`);
    
    const recentBefore = positionsBeforeEntry.slice(-10);
    console.log(`\n  Last 10 positions before entry:`);
    for (const pos of recentBefore) {
      const timeStr = new Date(pos.timestamp * 1000).toISOString().substring(11, 19);
      console.log(`    ${timeStr}: ${pos.distance.toFixed(2)}nm, AGL=${pos.agl.toFixed(0)}ft`);
    }
    
    let passed5nm = false;
    for (let i = positionsBeforeEntry.length - 1; i >= 0; i--) {
      if (positionsBeforeEntry[i].distance >= 5) {
        passed5nm = true;
        const timeStr = new Date(positionsBeforeEntry[i].timestamp * 1000).toISOString().substring(11, 19);
        console.log(`\n  ✓ Passed 5nm threshold at ${timeStr} (${positionsBeforeEntry[i].distance.toFixed(2)}nm)`);
        break;
      }
    }
    
    if (!passed5nm) {
      console.log(`\n  ✗ Never passed 5nm threshold`);
    }
    
    const last5Positions = positionsBeforeEntry.slice(-5);
    if (last5Positions.length >= 2) {
      const firstDist = last5Positions[0].distance;
      const lastDist = last5Positions[last5Positions.length - 1].distance;
      const isApproaching = lastDist < firstDist;
      console.log(`\n  Movement pattern in last 5 positions:`);
      console.log(`    First: ${firstDist.toFixed(2)}nm, Last: ${lastDist.toFixed(2)}nm`);
      console.log(`    ${isApproaching ? '→ APPROACHING' : '← DEPARTING/STATIONARY'}`);
    }
  }
}

const icao = process.argv[2] || 'a732ae';
const airport = process.argv[3] || 'KORD';
const date = process.argv[4] || '2025-01-01';

debugTrace(icao, airport, date).catch(error => {
  console.error('Error:', error);
  process.exit(1);
});

