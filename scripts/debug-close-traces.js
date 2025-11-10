#!/usr/bin/env node

/**
 * Debug script to examine traces close to the airport and understand classification
 */

import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import TraceReader from '../src/processing/TraceReader.js';
import FlightClassifier from '../src/processing/FlightClassifier.js';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function loadAirportConfig(icao) {
  const configPath = path.join(__dirname, '..', 'config', 'airports.json');
  const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
  return config.airports.find(a => a.icao === icao);
}

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

async function main() {
  const airport = loadAirportConfig('KLGA');
  const date = '2025-11-08';

  const testTempDir = path.join(__dirname, '..', 'temp-test');
  process.env.TEMP_DIR = testTempDir;

  const traceReader = new TraceReader({ tempDir: testTempDir });
  const classifier = new FlightClassifier();

  const tarPath = await traceReader.downloadTarFromS3(date);
  const extractDir = await traceReader.extractTar(tarPath);

  const closeTraces = [];

  for await (const { icao, trace } of traceReader.streamAllTraces(extractDir)) {
    if (!Array.isArray(trace)) continue;

    const classification = classifier.classifyFlight(trace, airport, date);
    
    if (classification && classification.closestApproach.distance <= 10) {
      closeTraces.push({
        icao,
        classification,
        distance: classification.closestApproach.distance,
      });
    }

    if (closeTraces.length >= 20) break;
  }

  // Sort by distance
  closeTraces.sort((a, b) => a.distance - b.distance);

  console.log('\n' + '='.repeat(80));
  console.log(`CLOSEST ${closeTraces.length} TRACES TO ${airport.icao}`);
  console.log('='.repeat(80) + '\n');

  closeTraces.slice(0, 10).forEach((item, idx) => {
    const c = item.classification;
    console.log(`${idx + 1}. ICAO: ${item.icao}`);
    console.log(`   Distance: ${item.distance.toFixed(2)} nm`);
    console.log(`   Classification: ${c.classification}`);
    console.log(`   Closest altitude: ${c.closestApproach.altitude?.toFixed(0) || 'N/A'} ft`);
    console.log(`   Alt profile - Min nearby: ${c.altitudeProfile.minNearby?.toFixed(0) || 'N/A'} ft`);
    console.log(`   Alt profile - Avg before: ${c.altitudeProfile.avgBefore?.toFixed(0) || 'N/A'} ft`);
    console.log(`   Alt profile - Avg after: ${c.altitudeProfile.avgAfter?.toFixed(0) || 'N/A'} ft`);
    console.log(`   Positions - Total: ${c.positionCounts.total}, Nearby: ${c.positionCounts.nearby}, Before: ${c.positionCounts.before}, After: ${c.positionCounts.after}`);
    console.log('');
  });
}

main().catch(console.error);

