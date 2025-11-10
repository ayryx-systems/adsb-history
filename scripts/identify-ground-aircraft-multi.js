#!/usr/bin/env node

/**
 * Identify aircraft on ground for multiple airports on a given date
 * 
 * Usage:
 *   node scripts/identify-ground-aircraft-multi.js --date 2025-11-08
 *   node scripts/identify-ground-aircraft-multi.js --date 2025-11-08 --airports KLGA,KJFK,KLAX
 *   node scripts/identify-ground-aircraft-multi.js --date 2025-11-08 --all
 */

import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import AirportGroundIdentifier from '../src/processing/AirportGroundIdentifier.js';
import GroundAircraftData from '../src/processing/GroundAircraftData.js';
import logger from '../src/utils/logger.js';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function parseArgs() {
  const args = process.argv.slice(2);
  const options = {
    date: null,
    airports: null,
    all: false,
    force: false,
    parallel: false,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    
    if (arg === '--date' && i + 1 < args.length) {
      options.date = args[i + 1];
      i++;
    } else if (arg === '--airports' && i + 1 < args.length) {
      options.airports = args[i + 1].split(',').map(a => a.trim().toUpperCase());
      i++;
    } else if (arg === '--all') {
      options.all = true;
    } else if (arg === '--force') {
      options.force = true;
    } else if (arg === '--parallel') {
      options.parallel = true;
    } else if (arg === '--help' || arg === '-h') {
      console.log(`
Identify aircraft on ground for multiple airports

Usage:
  node scripts/identify-ground-aircraft-multi.js --date YYYY-MM-DD [options]

Options:
  --date YYYY-MM-DD     Date to process (required)
  --airports ICAO,...   Comma-separated list of airports (e.g., KLGA,KJFK,KLAX)
  --all                 Process all enabled airports from config
  --force               Reprocess even if data exists
  --parallel            Process airports in parallel (faster but uses more resources)
  --help, -h            Show this help message

Examples:
  # Process all enabled airports
  node scripts/identify-ground-aircraft-multi.js --date 2025-11-08 --all

  # Process specific airports
  node scripts/identify-ground-aircraft-multi.js --date 2025-11-08 --airports KLGA,KJFK,KLAX

  # Process in parallel (faster)
  node scripts/identify-ground-aircraft-multi.js --date 2025-11-08 --all --parallel
      `);
      process.exit(0);
    }
  }

  if (!options.date) {
    console.error('Error: --date is required');
    console.error('Run with --help for usage information');
    process.exit(1);
  }

  if (!options.airports && !options.all) {
    console.error('Error: --airports or --all is required');
    console.error('Run with --help for usage information');
    process.exit(1);
  }

  return options;
}

function loadAirportConfig() {
  const configPath = path.join(__dirname, '..', 'config', 'airports.json');
  const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
  return config.airports;
}

async function processAirport(airport, date, force) {
  const identifier = new AirportGroundIdentifier();
  const dataStore = new GroundAircraftData();

  try {
    logger.info('Starting airport processing', { 
      airport: airport.icao, 
      date,
      name: airport.name 
    });
    
    // Check if already processed
    if (!force) {
      logger.info('Checking if already processed', { airport: airport.icao, date });
      const exists = await dataStore.exists(airport.icao, date);
      if (exists) {
        const aircraftIds = await dataStore.load(airport.icao, date);
        logger.info('Already processed - skipping', {
          airport: airport.icao,
          date,
          count: aircraftIds.length,
        });
        return { airport: airport.icao, count: aircraftIds.length, skipped: true };
      }
      logger.info('Not yet processed - will process', { airport: airport.icao, date });
    }

    logger.info('Identifying ground aircraft', { airport: airport.icao, date });
    const aircraftIds = await identifier.identifyGroundAircraft(date, airport);
    
    logger.info('Saving results to S3', { 
      airport: airport.icao, 
      date,
      count: aircraftIds.length 
    });
    await dataStore.save(airport.icao, date, aircraftIds);
    
    logger.info('Airport processing completed successfully', { 
      airport: airport.icao, 
      count: aircraftIds.length 
    });
    return { airport: airport.icao, count: aircraftIds.length, skipped: false };

  } catch (error) {
    logger.error('Failed to process airport', {
      airport: airport.icao,
      date,
      error: error.message,
      stack: error.stack,
    });
    return { airport: airport.icao, error: error.message };
  }
}

async function main() {
  console.log('Starting identify-ground-aircraft-multi.js');
  console.log('Arguments:', process.argv.slice(2));
  
  const options = parseArgs();
  console.log('Parsed options:', options);
  
  logger.info('Starting multi-airport processing', options);
  
  const allAirports = loadAirportConfig();
  console.log(`Loaded ${allAirports.length} airports from config`);
  logger.info('Loaded airport config', { totalAirports: allAirports.length });

  // Determine which airports to process
  let airportsToProcess = [];
  if (options.all) {
    airportsToProcess = allAirports.filter(a => a.enabled);
    console.log(`Processing all enabled airports: ${airportsToProcess.map(a => a.icao).join(', ')}`);
  } else if (options.airports) {
    airportsToProcess = allAirports.filter(a => 
      options.airports.includes(a.icao) && a.enabled
    );
    
    // Check for invalid airports
    const validIcaos = airportsToProcess.map(a => a.icao);
    const invalid = options.airports.filter(icao => !validIcaos.includes(icao));
    if (invalid.length > 0) {
      console.warn(`WARNING: Invalid or disabled airports: ${invalid.join(', ')}`);
      logger.warn('Invalid or disabled airports', { invalid });
    }
    console.log(`Processing specified airports: ${airportsToProcess.map(a => a.icao).join(', ')}`);
  } else {
    console.error('ERROR: No airports specified. Use --all or --airports');
    logger.error('No airports specified');
    process.exit(1);
  }

  if (airportsToProcess.length === 0) {
    console.error('ERROR: No airports to process');
    logger.error('No airports to process');
    process.exit(1);
  }

  console.log(`\n${'='.repeat(60)}`);
  console.log(`Processing ${airportsToProcess.length} airport(s) for ${options.date}`);
  console.log(`Airports: ${airportsToProcess.map(a => a.icao).join(', ')}`);
  console.log('='.repeat(60) + '\n');
  
  logger.info('Starting processing', {
    date: options.date,
    airportCount: airportsToProcess.length,
    airports: airportsToProcess.map(a => a.icao),
  });

  const startTime = Date.now();
  const results = [];

  if (options.parallel) {
    // Process in parallel
    logger.info('Processing airports in parallel');
    const promises = airportsToProcess.map(airport => 
      processAirport(airport, options.date, options.force)
    );
    const parallelResults = await Promise.all(promises);
    results.push(...parallelResults);
  } else {
    // Process sequentially
    logger.info('Processing airports sequentially');
    for (const airport of airportsToProcess) {
      const result = await processAirport(airport, options.date, options.force);
      results.push(result);
    }
  }

  const duration = Date.now() - startTime;

  // Summary
  console.log(`\n${'='.repeat(60)}`);
  console.log('SUMMARY');
  console.log('='.repeat(60));
  
  const successful = results.filter(r => !r.error);
  const skipped = results.filter(r => r.skipped);
  const processed = results.filter(r => !r.error && !r.skipped);
  const failed = results.filter(r => r.error);

  console.log(`Total airports:     ${results.length}`);
  console.log(`Successfully processed: ${processed.length}`);
  console.log(`Skipped (already exists): ${skipped.length}`);
  console.log(`Failed:             ${failed.length}`);
  console.log(`Duration:           ${(duration / 1000).toFixed(1)}s`);
  console.log('='.repeat(60) + '\n');

  if (processed.length > 0) {
    console.log('Processed airports:');
    processed.forEach(r => {
      console.log(`  ${r.airport}: ${r.count} aircraft`);
    });
    console.log('');
  }

  if (skipped.length > 0) {
    console.log('Skipped airports (already processed):');
    skipped.forEach(r => {
      console.log(`  ${r.airport}: ${r.count} aircraft`);
    });
    console.log('');
  }

  if (failed.length > 0) {
    console.log('Failed airports:');
    failed.forEach(r => {
      console.log(`  ${r.airport}: ${r.error}`);
    });
    console.log('');
    process.exit(1);
  }

  logger.info('All airports processed successfully! 🎉');
}

main().catch(error => {
  logger.error('Fatal error', {
    error: error.message,
    stack: error.stack,
  });
  process.exit(1);
});

