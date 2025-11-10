#!/usr/bin/env node

/**
 * Identify aircraft that were on the ground at a specific airport on a given date
 * 
 * This creates a simple list of ICAO codes for aircraft that meet the criteria:
 * - Within 1nm of airport coordinates
 * - Altitude below 500ft or "ground"
 * 
 * Usage:
 *   node scripts/identify-ground-aircraft.js --airport KLGA --date 2025-11-08
 */

import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import AirportGroundIdentifier from '../../src/processing/AirportGroundIdentifier.js';
import GroundAircraftData from '../../src/processing/GroundAircraftData.js';
import logger from '../../src/utils/logger.js';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function parseArgs() {
  const args = process.argv.slice(2);
  const options = {
    airport: null,
    date: null,
    force: false,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    
    if (arg === '--airport' && i + 1 < args.length) {
      options.airport = args[i + 1].toUpperCase();
      i++;
    } else if (arg === '--date' && i + 1 < args.length) {
      options.date = args[i + 1];
      i++;
    } else if (arg === '--force') {
      options.force = true;
    } else if (arg === '--help' || arg === '-h') {
      console.log(`
Identify aircraft on ground at airport

Usage:
  node scripts/identify-ground-aircraft.js --airport ICAO --date YYYY-MM-DD [options]

Options:
  --airport ICAO        Airport ICAO code (e.g., KLGA, KLAX)
  --date YYYY-MM-DD     Date to process
  --force               Reprocess even if data exists
  --help, -h            Show this help message

Examples:
  node scripts/identify-ground-aircraft.js --airport KLGA --date 2025-11-08
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

function loadAirportConfig(icao) {
  const configPath = path.join(__dirname, '..', '..', 'config', 'airports.json');
  const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
  
  const airport = config.airports.find(a => a.icao === icao);
  
  if (!airport) {
    logger.error(`Airport ${icao} not found in configuration`, {
      availableAirports: config.airports.map(a => a.icao).join(', '),
    });
    throw new Error(`Airport ${icao} not found`);
  }

  return airport;
}

async function main() {
  const options = parseArgs();

  logger.info('Identifying ground aircraft', options);

  try {
    const airport = loadAirportConfig(options.airport);
    logger.info('Airport configuration loaded', {
      icao: airport.icao,
      name: airport.name,
    });

    const identifier = new AirportGroundIdentifier();
    const dataStore = new GroundAircraftData();

    // Check if already processed
    if (!options.force) {
      const exists = await dataStore.exists(airport.icao, options.date);
      if (exists) {
        logger.info('Data already exists, loading from storage', {
          airport: airport.icao,
          date: options.date,
        });
        
        const aircraftIds = await dataStore.load(airport.icao, options.date);
        console.log(`\nFound ${aircraftIds.length} aircraft on ground at ${airport.icao} on ${options.date}`);
        return;
      }
    }

    // Identify ground aircraft
    logger.info('Starting identification (this may take several minutes)', {
      airport: airport.icao,
      date: options.date,
    });

    const aircraftIds = await identifier.identifyGroundAircraft(options.date, airport);

    // Save results
    logger.info('Saving results', {
      airport: airport.icao,
      date: options.date,
      count: aircraftIds.length,
    });
    await dataStore.save(airport.icao, options.date, aircraftIds);

    console.log(`\n${'='.repeat(60)}`);
    console.log(`Results for ${airport.icao} (${airport.name}) on ${options.date}`);
    console.log('='.repeat(60));
    console.log(`Aircraft on ground: ${aircraftIds.length}`);
    console.log('='.repeat(60) + '\n');

    logger.info('Processing complete! 🎉');

  } catch (error) {
    logger.error('Processing failed', {
      error: error.message,
      stack: error.stack,
    });
    process.exit(1);
  }
}

main().catch(error => {
  logger.error('Fatal error', {
    error: error.message,
    stack: error.stack,
  });
  process.exit(1);
});

