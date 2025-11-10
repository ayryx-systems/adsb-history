#!/usr/bin/env node

/**
 * Simple script to get arrival list for an airport
 * 
 * This demonstrates the abstraction layer API:
 * - First checks if data is already processed (in S3/cache)
 * - If not, processes raw data and saves to abstraction layer
 * - Returns list of arrivals
 * 
 * Usage:
 *   node scripts/get-arrivals.js --airport KLGA --date 2025-11-08
 */

import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import AirportDailyProcessor from '../src/processing/AirportDailyProcessor.js';
import DailyFlightData from '../src/processing/DailyFlightData.js';
import logger from '../src/utils/logger.js';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function parseArgs() {
  const args = process.argv.slice(2);
  const options = { airport: null, date: null };

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--airport' && i + 1 < args.length) {
      options.airport = args[i + 1].toUpperCase();
      i++;
    } else if (args[i] === '--date' && i + 1 < args.length) {
      options.date = args[i + 1];
      i++;
    }
  }

  if (!options.airport || !options.date) {
    console.error('Usage: node scripts/get-arrivals.js --airport KLGA --date 2025-11-08');
    process.exit(1);
  }

  return options;
}

function loadAirportConfig(icao) {
  const configPath = path.join(__dirname, '..', 'config', 'airports.json');
  const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
  return config.airports.find(a => a.icao === icao);
}

async function main() {
  const options = parseArgs();
  const airport = loadAirportConfig(options.airport);
  
  if (!airport) {
    console.error(`Airport ${options.airport} not found in configuration`);
    process.exit(1);
  }

  const dataStore = new DailyFlightData();
  
  // Try to load from abstraction layer
  let arrivals = await dataStore.getArrivals(airport.icao, options.date);
  
  if (!arrivals) {
    // Data not processed yet, process it now
    logger.info('Data not found in storage, processing now...');
    const processor = new AirportDailyProcessor();
    arrivals = await processor.getArrivals(options.date, airport);
    
    // Save for future use
    const fullData = await processor.processAirportDay(options.date, airport);
    await dataStore.save(airport.icao, options.date, fullData);
  }

  // Display results
  console.log(`\nArrivals at ${airport.name} (${airport.icao}) on ${options.date}:`);
  console.log(`Total: ${arrivals.length}\n`);
  
  console.log(`${'ICAO'.padEnd(10)} ${'Time (UTC)'.padEnd(12)} ${'Closest Approach'}`);
  console.log('-'.repeat(60));
  
  for (const flight of arrivals) {
    const time = new Date(flight.timestamp * 1000).toISOString().split('T')[1].slice(0, 8);
    const info = `${flight.closestApproach.distance.toFixed(1)} nm, ${Math.round(flight.closestApproach.altitude)} ft`;
    console.log(`${flight.icao.padEnd(10)} ${time.padEnd(12)} ${info}`);
  }
  
  console.log('');
}

main().catch(error => {
  console.error('Error:', error.message);
  process.exit(1);
});

