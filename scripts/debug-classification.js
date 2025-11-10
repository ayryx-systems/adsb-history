#!/usr/bin/env node

/**
 * Debug script to understand why flights aren't being classified
 * Examines sample traces and their relationship to the airport
 * 
 * Usage:
 *   node scripts/debug-classification.js --airport KLGA --date 2025-11-08 --samples 10
 */

import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import TraceReader from '../src/processing/TraceReader.js';
import FlightClassifier from '../src/processing/FlightClassifier.js';
import logger from '../src/utils/logger.js';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function parseArgs() {
  const args = process.argv.slice(2);
  const options = {
    airport: null,
    date: null,
    samples: 20,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--airport' && i + 1 < args.length) {
      options.airport = args[i + 1].toUpperCase();
      i++;
    } else if (arg === '--date' && i + 1 < args.length) {
      options.date = args[i + 1];
      i++;
    } else if (arg === '--samples' && i + 1 < args.length) {
      options.samples = parseInt(args[i + 1]);
      i++;
    }
  }

  if (!options.airport || !options.date) {
    console.error('Error: --airport and --date are required');
    process.exit(1);
  }

  return options;
}

function loadAirportConfig(icao) {
  const configPath = path.join(__dirname, '..', 'config', 'airports.json');
  const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
  const airport = config.airports.find(a => a.icao === icao);
  if (!airport) {
    throw new Error(`Airport ${icao} not found`);
  }
  return airport;
}

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

function parsePosition(posArray) {
  if (!posArray || posArray.length < 6) return null;
  return {
    timestamp: posArray[0],
    lat: posArray[1],
    lon: posArray[2],
    alt_baro: posArray[3],
    gs: posArray[4],
    track: posArray[5],
  };
}

async function main() {
  const options = parseArgs();
  const airport = loadAirportConfig(options.airport);

  console.log('\n' + '='.repeat(80));
  console.log(`Debugging Classification for ${airport.icao} (${airport.name})`);
  console.log(`Date: ${options.date}`);
  console.log(`Airport: ${airport.coordinates.lat}, ${airport.coordinates.lon}`);
  console.log('='.repeat(80) + '\n');

  // Set temp directory
  const testTempDir = path.join(__dirname, '..', 'temp-test');
  process.env.TEMP_DIR = testTempDir;

  const traceReader = new TraceReader({ tempDir: testTempDir });
  const classifier = new FlightClassifier();

  // Download and extract if needed
  console.log('Downloading/extracting tar...');
  const tarPath = await traceReader.downloadTarFromS3(options.date);
  const extractDir = await traceReader.extractTar(tarPath);

  console.log('\nAnalyzing traces...\n');

  let totalTraces = 0;
  let tracesWithPositions = 0;
  let tracesNearAirport = 0; // within 10nm
  let tracesVeryClose = 0; // within 5nm
  let classifiedCount = 0;
  const samples = [];

  for await (const { icao, trace } of traceReader.streamAllTraces(extractDir)) {
    totalTraces++;

    // Ensure trace is an array
    if (!Array.isArray(trace)) {
      console.log(`Warning: Trace for ${icao} is not an array:`, typeof trace);
      continue;
    }

    // Calculate base timestamp
    const dateObj = new Date(options.date + 'T00:00:00Z');
    const baseTimestamp = Math.floor(dateObj.getTime() / 1000);

    // Parse positions
    const positions = trace
      .map(pos => parsePosition(pos, baseTimestamp))
      .filter(pos => pos && pos.lat !== null && pos.lon !== null && pos.alt_baro !== null);

    if (positions.length < 5) {
      continue;
    }

    tracesWithPositions++;

    // Calculate distances
    const positionsWithDistance = positions.map(pos => ({
      ...pos,
      distance: calculateDistance(pos.lat, pos.lon, airport.coordinates.lat, airport.coordinates.lon),
    }));

    const closestApproach = positionsWithDistance.reduce((min, pos) => 
      pos.distance < min.distance ? pos : min, positionsWithDistance[0]);

    if (closestApproach.distance <= 10) {
      tracesNearAirport++;
    }
    if (closestApproach.distance <= 5) {
      tracesVeryClose++;
    }

    // Try to classify
    const classification = classifier.classifyFlight(trace, airport, options.date);

    if (classification) {
      classifiedCount++;
    }

    // Collect samples
    if (samples.length < options.samples) {
      const altitudes = positions.map(p => p.alt_baro);
      const minAlt = Math.min(...altitudes);
      const maxAlt = Math.max(...altitudes);
      const avgAlt = altitudes.reduce((a, b) => a + b, 0) / altitudes.length;

      samples.push({
        icao,
        positionCount: positions.length,
        closestDistance: closestApproach.distance,
        closestAltitude: closestApproach.alt_baro,
        minAltitude: minAlt,
        maxAltitude: maxAlt,
        avgAltitude: avgAlt,
        classification: classification ? classification.classification : null,
        timeRange: positions.length > 0 ? {
          first: new Date(positions[0].timestamp * 1000).toISOString(),
          last: new Date(positions[positions.length - 1].timestamp * 1000).toISOString(),
        } : null,
      });
    }

    if (totalTraces % 10000 === 0) {
      console.log(`Processed ${totalTraces} traces...`);
    }
  }

  console.log('\n' + '='.repeat(80));
  console.log('SUMMARY');
  console.log('='.repeat(80));
  console.log(`Total traces processed:     ${totalTraces.toLocaleString()}`);
  console.log(`Traces with valid positions: ${tracesWithPositions.toLocaleString()}`);
  console.log(`Traces within 10nm:         ${tracesNearAirport.toLocaleString()}`);
  console.log(`Traces within 5nm:          ${tracesVeryClose.toLocaleString()}`);
  console.log(`Traces classified:          ${classifiedCount.toLocaleString()}`);
  console.log('='.repeat(80) + '\n');

  console.log('SAMPLE TRACES (first ' + options.samples + ' with valid positions):');
  console.log('='.repeat(80));
  samples.forEach((sample, idx) => {
    console.log(`\n${idx + 1}. ICAO: ${sample.icao}`);
    console.log(`   Positions: ${sample.positionCount}`);
    console.log(`   Closest distance: ${sample.closestDistance.toFixed(2)} nm`);
    console.log(`   Closest altitude: ${sample.closestAltitude?.toFixed(0) || 'N/A'} ft`);
    console.log(`   Altitude range: ${sample.minAltitude?.toFixed(0) || 'N/A'} - ${sample.maxAltitude?.toFixed(0) || 'N/A'} ft (avg: ${sample.avgAltitude?.toFixed(0) || 'N/A'} ft)`);
    console.log(`   Classification: ${sample.classification || 'NONE'}`);
    if (sample.timeRange) {
      console.log(`   Time: ${sample.timeRange.first} to ${sample.timeRange.last}`);
    }
  });

  // Show closest traces to airport
  console.log('\n' + '='.repeat(80));
  console.log('CLOSEST TRACES TO AIRPORT:');
  console.log('='.repeat(80));
  
  const closestSamples = [...samples]
    .filter(s => s.closestDistance <= 20)
    .sort((a, b) => a.closestDistance - b.closestDistance)
    .slice(0, 10);

  closestSamples.forEach((sample, idx) => {
    console.log(`\n${idx + 1}. ICAO: ${sample.icao} - ${sample.closestDistance.toFixed(2)} nm away`);
    console.log(`   Altitude at closest: ${sample.closestAltitude?.toFixed(0) || 'N/A'} ft`);
    console.log(`   Classification: ${sample.classification || 'NONE'}`);
  });

  console.log('\n');
}

main().catch(error => {
  console.error('Error:', error);
  process.exit(1);
});

