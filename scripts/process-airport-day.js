#!/usr/bin/env node

/**
 * Process ADSB data for a specific airport and date
 * 
 * This script demonstrates the abstraction layer:
 * 1. Downloads raw tar from S3
 * 2. Processes all traces for the airport
 * 3. Classifies flights (arrivals/departures/overflights)
 * 4. Saves processed data to S3 (the abstraction layer)
 * 
 * Usage:
 *   node scripts/process-airport-day.js --airport KLGA --date 2025-11-08
 *   node scripts/process-airport-day.js --airport KLAX --date 2025-11-08 --show-arrivals
 */

import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import AirportDailyProcessor from '../src/processing/AirportDailyProcessor.js';
import DailyFlightData from '../src/processing/DailyFlightData.js';
import logger from '../src/utils/logger.js';

// Load environment variables
dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Parse command line arguments
function parseArgs() {
  const args = process.argv.slice(2);
  const options = {
    airport: null,
    date: null,
    showArrivals: false,
    showDepartures: false,
    showStats: true,
    skipIfExists: true,
    outputFile: null,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    
    if (arg === '--airport' && i + 1 < args.length) {
      options.airport = args[i + 1].toUpperCase();
      i++;
    } else if (arg === '--date' && i + 1 < args.length) {
      options.date = args[i + 1];
      i++;
    } else if (arg === '--show-arrivals') {
      options.showArrivals = true;
    } else if (arg === '--show-departures') {
      options.showDepartures = true;
    } else if (arg === '--no-stats') {
      options.showStats = false;
    } else if (arg === '--force') {
      options.skipIfExists = false;
    } else if (arg === '--output' && i + 1 < args.length) {
      options.outputFile = args[i + 1];
      i++;
    } else if (arg === '--help' || arg === '-h') {
      console.log(`
Process ADSB data for a specific airport and date

Usage:
  node scripts/process-airport-day.js --airport ICAO --date YYYY-MM-DD [options]

Options:
  --airport ICAO        Airport ICAO code (e.g., KLGA, KLAX)
  --date YYYY-MM-DD     Date to process
  --show-arrivals       Display arrival list
  --show-departures     Display departure list
  --no-stats            Don't display statistics
  --force               Reprocess even if data exists
  --output FILE         Save output to JSON file
  --help, -h            Show this help message

Examples:
  # Process KLGA for November 8, 2025
  node scripts/process-airport-day.js --airport KLGA --date 2025-11-08

  # Show arrival list
  node scripts/process-airport-day.js --airport KLGA --date 2025-11-08 --show-arrivals

  # Save to file
  node scripts/process-airport-day.js --airport KLGA --date 2025-11-08 --output klga-2025-11-08.json
      `);
      process.exit(0);
    }
  }

  if (!options.airport || !options.date) {
    console.error('Error: --airport and --date are required');
    console.error('Run with --help for usage information');
    process.exit(1);
  }

  return options;
}

// Load airports configuration
function loadAirportConfig(icao) {
  const configPath = path.join(__dirname, '..', 'config', 'airports.json');
  const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
  
  const airport = config.airports.find(a => a.icao === icao);
  
  if (!airport) {
    logger.error(`Airport ${icao} not found in configuration`, {
      availableAirports: config.airports.map(a => a.icao).join(', '),
    });
    throw new Error(`Airport ${icao} not found`);
  }

  if (!airport.enabled) {
    logger.warn(`Airport ${icao} is disabled in configuration`, { airport });
  }

  return airport;
}

async function main() {
  const options = parseArgs();

  logger.info('Processing airport day', options);

  try {
    // Load airport configuration
    const airport = loadAirportConfig(options.airport);
    logger.info('Airport configuration loaded', {
      icao: airport.icao,
      name: airport.name,
      coordinates: airport.coordinates,
    });

    // Initialize components
    const processor = new AirportDailyProcessor();
    const dataStore = new DailyFlightData();

    // Check if already processed
    if (options.skipIfExists) {
      const exists = await dataStore.exists(airport.icao, options.date);
      if (exists) {
        logger.info('Data already processed, loading from storage', {
          airport: airport.icao,
          date: options.date,
        });
        
        const data = await dataStore.load(airport.icao, options.date);
        displayResults(data, options);
        return;
      }
    }

    // Process the data
    logger.info('Starting processing (this may take several minutes)', {
      airport: airport.icao,
      date: options.date,
    });

    const results = await processor.processAirportDay(options.date, airport);

    // Save to abstraction layer (S3 + cache)
    logger.info('Saving processed data', {
      airport: airport.icao,
      date: options.date,
    });
    await dataStore.save(airport.icao, options.date, results);

    // Display results
    displayResults(results, options);

    // Save to file if requested
    if (options.outputFile) {
      fs.writeFileSync(options.outputFile, JSON.stringify(results, null, 2));
      logger.info('Saved output to file', { file: options.outputFile });
    }

    logger.info('Processing complete! 🎉');

  } catch (error) {
    logger.error('Processing failed', {
      error: error.message,
      stack: error.stack,
    });
    process.exit(1);
  }
}

function displayResults(results, options) {
  console.log('\n' + '='.repeat(60));
  console.log(`Results for ${results.airport} (${results.airportName}) on ${results.date}`);
  console.log('='.repeat(60));

  if (options.showStats) {
    console.log('\nStatistics:');
    console.log(`  Total Flights:    ${results.statistics.total}`);
    console.log(`  Arrivals:         ${results.statistics.arrivals}`);
    console.log(`  Departures:       ${results.statistics.departures}`);
    console.log(`  Touch & Go:       ${results.statistics.touch_and_go}`);
    console.log(`  Overflights:      ${results.statistics.overflights}`);
    
    if (results.processingInfo) {
      const duration = results.processingInfo.duration / 1000;
      console.log(`\nProcessing Info:`);
      console.log(`  Traces Processed: ${results.processingInfo.tracesProcessed.toLocaleString()}`);
      console.log(`  Traces Classified: ${results.processingInfo.tracesClassified.toLocaleString()}`);
      console.log(`  Duration:         ${duration.toFixed(1)}s`);
      console.log(`  Rate:             ${(results.processingInfo.tracesProcessed / duration).toFixed(0)} traces/sec`);
    }
  }

  if (options.showArrivals && results.flights.arrivals.length > 0) {
    console.log('\n' + '-'.repeat(60));
    console.log('Arrivals:');
    console.log('-'.repeat(60));
    console.log(`${'ICAO'.padEnd(8)} ${'Time (UTC)'.padEnd(20)} ${'Altitude'.padEnd(12)} ${'Distance'.padEnd(10)}`);
    console.log('-'.repeat(60));
    
    for (const flight of results.flights.arrivals.slice(0, 50)) { // Show first 50
      const time = new Date(flight.timestamp * 1000).toISOString().split('T')[1].slice(0, 8);
      const alt = `${Math.round(flight.closestApproach.altitude)} ft`;
      const dist = `${flight.closestApproach.distance.toFixed(1)} nm`;
      console.log(`${flight.icao.padEnd(8)} ${time.padEnd(20)} ${alt.padEnd(12)} ${dist.padEnd(10)}`);
    }
    
    if (results.flights.arrivals.length > 50) {
      console.log(`... and ${results.flights.arrivals.length - 50} more`);
    }
  }

  if (options.showDepartures && results.flights.departures.length > 0) {
    console.log('\n' + '-'.repeat(60));
    console.log('Departures:');
    console.log('-'.repeat(60));
    console.log(`${'ICAO'.padEnd(8)} ${'Time (UTC)'.padEnd(20)} ${'Altitude'.padEnd(12)} ${'Distance'.padEnd(10)}`);
    console.log('-'.repeat(60));
    
    for (const flight of results.flights.departures.slice(0, 50)) { // Show first 50
      const time = new Date(flight.timestamp * 1000).toISOString().split('T')[1].slice(0, 8);
      const alt = `${Math.round(flight.closestApproach.altitude)} ft`;
      const dist = `${flight.closestApproach.distance.toFixed(1)} nm`;
      console.log(`${flight.icao.padEnd(8)} ${time.padEnd(20)} ${alt.padEnd(12)} ${dist.padEnd(10)}`);
    }
    
    if (results.flights.departures.length > 50) {
      console.log(`... and ${results.flights.departures.length - 50} more`);
    }
  }

  console.log('\n' + '='.repeat(60) + '\n');
}

// Run
main().catch(error => {
  logger.error('Fatal error', {
    error: error.message,
    stack: error.stack,
  });
  process.exit(1);
});

