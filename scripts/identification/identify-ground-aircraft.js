#!/usr/bin/env node

/**
 * Identify aircraft that were on the ground at airports on given date(s)
 * 
 * Supports:
 * - Single or multiple airports (--airport, --airports, or --all)
 * - Single date or date range (--date or --start-date with --end-date/--days)
 * 
 * Usage:
 *   Single airport, single date:
 *     node scripts/identification/identify-ground-aircraft.js --airport KLGA --date 2025-11-08
 *   Single airport, date range:
 *     node scripts/identification/identify-ground-aircraft.js --airport KLGA --start-date 2025-11-08 --end-date 2025-11-15
 *   Multiple airports, single date:
 *     node scripts/identification/identify-ground-aircraft.js --airports KLGA,KJFK --date 2025-11-08
 *   All airports, date range:
 *     node scripts/identification/identify-ground-aircraft.js --all --start-date 2025-11-08 --days 7
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
    airports: null,
    all: false,
    date: null,
    startDate: null,
    endDate: null,
    days: null,
    force: false,
    parallel: false,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    
    if (arg === '--airport' && i + 1 < args.length) {
      options.airport = args[i + 1].toUpperCase();
      i++;
    } else if (arg === '--airports' && i + 1 < args.length) {
      options.airports = args[i + 1].split(',').map(a => a.trim().toUpperCase());
      i++;
    } else if (arg === '--all') {
      options.all = true;
    } else if (arg === '--date' && i + 1 < args.length) {
      options.date = args[i + 1];
      i++;
    } else if (arg === '--start-date' && i + 1 < args.length) {
      options.startDate = args[i + 1];
      i++;
    } else if (arg === '--end-date' && i + 1 < args.length) {
      options.endDate = args[i + 1];
      i++;
    } else if (arg === '--days' && i + 1 < args.length) {
      options.days = parseInt(args[i + 1], 10);
      i++;
    } else if (arg === '--force') {
      options.force = true;
    } else if (arg === '--parallel') {
      options.parallel = true;
    } else if (arg === '--help' || arg === '-h') {
      console.log(`
Identify aircraft on ground at airports

Usage:
  Single airport, single date:
    node scripts/identification/identify-ground-aircraft.js --airport ICAO --date YYYY-MM-DD
  
  Single airport, date range:
    node scripts/identification/identify-ground-aircraft.js --airport ICAO --start-date YYYY-MM-DD --end-date YYYY-MM-DD
    node scripts/identification/identify-ground-aircraft.js --airport ICAO --start-date YYYY-MM-DD --days N
  
  Multiple airports, single date:
    node scripts/identification/identify-ground-aircraft.js --airports ICAO,ICAO,... --date YYYY-MM-DD
  
  All airports, date range:
    node scripts/identification/identify-ground-aircraft.js --all --start-date YYYY-MM-DD --days N

Options:
  Airport selection (one required):
    --airport ICAO        Single airport ICAO code (e.g., KLGA)
    --airports ICAO,...   Comma-separated list of airports (e.g., KLGA,KJFK,KLAX)
    --all                 Process all enabled airports from config
  
  Date selection (one required):
    --date YYYY-MM-DD           Single date to process
    --start-date YYYY-MM-DD    Start date for date range
    --end-date YYYY-MM-DD      End date for date range (use with --start-date)
    --days N                    Number of days from start date (use with --start-date)
  
  Other options:
    --force               Reprocess even if data exists
    --parallel            Process airports in parallel (faster but uses more resources)
    --help, -h            Show this help message

Examples:
  # Single airport, single date
  node scripts/identification/identify-ground-aircraft.js --airport KLGA --date 2025-11-08
  
  # Single airport, date range (7 days)
  node scripts/identification/identify-ground-aircraft.js --airport KLGA --start-date 2025-11-08 --days 7
  
  # Multiple airports, single date
  node scripts/identification/identify-ground-aircraft.js --airports KLGA,KJFK,KLAX --date 2025-11-08
  
  # All airports, date range
  node scripts/identification/identify-ground-aircraft.js --all --start-date 2025-11-08 --end-date 2025-11-15
  
  # Parallel processing (faster)
  node scripts/identification/identify-ground-aircraft.js --all --date 2025-11-08 --parallel
      `);
      process.exit(0);
    }
  }

  // Validate airport selection
  const airportOptions = [options.airport, options.airports, options.all].filter(Boolean);
  if (airportOptions.length === 0) {
    console.error('Error: One of --airport, --airports, or --all is required');
    console.error('Run with --help for usage information');
    process.exit(1);
  }
  if (airportOptions.length > 1) {
    console.error('Error: Only one of --airport, --airports, or --all can be specified');
    console.error('Run with --help for usage information');
    process.exit(1);
  }

  // Validate date selection
  if (!options.date && !options.startDate) {
    console.error('Error: Either --date or --start-date must be provided');
    console.error('Run with --help for usage information');
    process.exit(1);
  }

  if (options.date && (options.startDate || options.endDate || options.days)) {
    console.error('Error: --date cannot be used with --start-date/--end-date/--days');
    console.error('Run with --help for usage information');
    process.exit(1);
  }

  if (options.startDate) {
    if (options.endDate && options.days) {
      console.error('Error: --end-date and --days cannot both be specified');
      console.error('Run with --help for usage information');
      process.exit(1);
    }
    if (!options.endDate && !options.days) {
      console.error('Error: --end-date or --days is required when using --start-date');
      console.error('Run with --help for usage information');
      process.exit(1);
    }
    if (options.days && options.days < 1) {
      console.error('Error: --days must be at least 1');
      process.exit(1);
    }
  }

  return options;
}

function loadAirportConfig() {
  const configPath = path.join(__dirname, '..', '..', 'config', 'airports.json');
  const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
  return config.airports;
}

function loadAirportConfigSingle(icao) {
  const allAirports = loadAirportConfig();
  const airport = allAirports.find(a => a.icao === icao);
  
  if (!airport) {
    logger.error(`Airport ${icao} not found in configuration`, {
      availableAirports: allAirports.map(a => a.icao).join(', '),
    });
    throw new Error(`Airport ${icao} not found`);
  }

  return airport;
}

function generateDateRange(startDate, endDateOrDays) {
  const dates = [];
  const start = new Date(startDate + 'T00:00:00Z');
  
  let end;
  if (typeof endDateOrDays === 'number') {
    end = new Date(start);
    end.setUTCDate(start.getUTCDate() + endDateOrDays - 1);
  } else {
    end = new Date(endDateOrDays + 'T00:00:00Z');
  }
  
  const current = new Date(start);
  while (current <= end) {
    dates.push(current.toISOString().split('T')[0]);
    current.setUTCDate(current.getUTCDate() + 1);
  }
  
  return dates;
}

async function processAirportDate(airport, date, identifier, dataStore, force) {
  if (!force) {
    const exists = await dataStore.exists(airport.icao, date);
    if (exists) {
      logger.info('Data already exists, loading from storage', {
        airport: airport.icao,
        date,
      });
      
      const aircraftIds = await dataStore.load(airport.icao, date);
      return { airport: airport.icao, date, count: aircraftIds.length, skipped: true };
    }
  }

  logger.info('Starting identification', {
    airport: airport.icao,
    date,
  });

  const aircraftIds = await identifier.identifyGroundAircraft(date, airport);

  logger.info('Saving results', {
    airport: airport.icao,
    date,
    count: aircraftIds.length,
  });
  await dataStore.save(airport.icao, date, aircraftIds);

  // Explicitly clean up trace reader for this date to free memory
  if (identifier.traceReader && typeof identifier.traceReader.cleanup === 'function') {
    identifier.traceReader.cleanup(date);
  }

  // Clear the aircraftIds array reference to help GC
  const count = aircraftIds.length;
  aircraftIds.length = 0;

  return { airport: airport.icao, date, count, skipped: false };
}

async function main() {
  const options = parseArgs();

  logger.info('Identifying ground aircraft', options);

  try {
    const allAirports = loadAirportConfig();
    
    // Determine which airports to process
    let airportsToProcess = [];
    if (options.all) {
      airportsToProcess = allAirports.filter(a => a.enabled);
      console.log(`Processing all enabled airports: ${airportsToProcess.map(a => a.icao).join(', ')}`);
    } else if (options.airports) {
      airportsToProcess = allAirports.filter(a => 
        options.airports.includes(a.icao) && a.enabled
      );
      
      const validIcaos = airportsToProcess.map(a => a.icao);
      const invalid = options.airports.filter(icao => !validIcaos.includes(icao));
      if (invalid.length > 0) {
        console.warn(`WARNING: Invalid or disabled airports: ${invalid.join(', ')}`);
        logger.warn('Invalid or disabled airports', { invalid });
      }
      console.log(`Processing specified airports: ${airportsToProcess.map(a => a.icao).join(', ')}`);
    } else if (options.airport) {
      const airport = loadAirportConfigSingle(options.airport);
      airportsToProcess = [airport];
      console.log(`Processing airport: ${airport.icao} (${airport.name})`);
    }

    if (airportsToProcess.length === 0) {
      console.error('ERROR: No airports to process');
      logger.error('No airports to process');
      process.exit(1);
    }

    // Determine dates to process
    let dates;
    if (options.date) {
      dates = [options.date];
    } else {
      dates = generateDateRange(options.startDate, options.endDate || options.days);
    }

    console.log(`\n${'='.repeat(60)}`);
    console.log(`Processing ${airportsToProcess.length} airport(s) for ${dates.length} date(s)`);
    console.log(`Airports: ${airportsToProcess.map(a => a.icao).join(', ')}`);
    if (dates.length === 1) {
      console.log(`Date: ${dates[0]}`);
    } else {
      console.log(`Date range: ${dates[0]} to ${dates[dates.length - 1]} (${dates.length} days)`);
    }
    console.log('='.repeat(60) + '\n');

    logger.info('Starting processing', {
      airportCount: airportsToProcess.length,
      airports: airportsToProcess.map(a => a.icao),
      dateCount: dates.length,
      dates: dates.length === 1 ? dates[0] : `${dates[0]} to ${dates[dates.length - 1]}`,
    });

    const identifier = new AirportGroundIdentifier();
    const dataStore = new GroundAircraftData();

    const startTime = Date.now();
    const results = [];

    // Process all combinations of airports and dates
    for (let dateIdx = 0; dateIdx < dates.length; dateIdx++) {
      const date = dates[dateIdx];
      console.log(`\n[Date ${dateIdx + 1}/${dates.length}] Processing ${date}...`);
      console.log('─'.repeat(60));

      if (options.parallel && airportsToProcess.length > 1) {
        logger.info('Processing airports in parallel', { date });
        const promises = airportsToProcess.map(airport => 
          processAirportDate(airport, date, identifier, dataStore, options.force)
        );
        const dateResults = await Promise.all(promises);
        results.push(...dateResults);
        
        dateResults.forEach(r => {
          if (r.error) {
            console.log(`  ✗ ${r.airport}: ${r.error}`);
          } else if (r.skipped) {
            console.log(`  ⊘ ${r.airport}: ${r.count} aircraft (already processed)`);
          } else {
            console.log(`  ✓ ${r.airport}: ${r.count} aircraft`);
          }
        });
      } else {
        logger.info('Processing airports sequentially', { date });
        for (const airport of airportsToProcess) {
          try {
            const result = await processAirportDate(airport, date, identifier, dataStore, options.force);
            results.push(result);
            
            if (result.error) {
              console.log(`  ✗ ${result.airport}: ${result.error}`);
            } else if (result.skipped) {
              console.log(`  ⊘ ${result.airport}: ${result.count} aircraft (already processed)`);
            } else {
              console.log(`  ✓ ${result.airport}: ${result.count} aircraft`);
            }
          } catch (error) {
            logger.error('Failed to process airport/date', {
              airport: airport.icao,
              date,
              error: error.message,
              stack: error.stack,
            });
            console.log(`  ✗ ${airport.icao}: Error - ${error.message}`);
            results.push({ airport: airport.icao, date, error: error.message });
          }
        }
      }

      // Cleanup after each date to free memory
      if (dateIdx < dates.length - 1) {
        logger.info('Cleaning up after date', { date });
        console.log(`\n[Date ${dateIdx + 1}/${dates.length}] Cleanup: Freeing memory...`);
        
        // Force garbage collection if available (requires --expose-gc flag)
        if (global.gc) {
          global.gc();
          logger.info('Garbage collection triggered', { date });
        }
        
        // Small delay to allow GC to complete
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }

    const duration = Date.now() - startTime;

    // Summary
    console.log(`\n${'='.repeat(60)}`);
    console.log('SUMMARY');
    console.log('='.repeat(60));
    
    const successful = results.filter(r => !r.error && !r.skipped);
    const skipped = results.filter(r => r.skipped);
    const failed = results.filter(r => r.error);
    const totalAircraft = results.reduce((sum, r) => sum + (r.count || 0), 0);
    const totalCombinations = airportsToProcess.length * dates.length;

    console.log(`Total airport-date combinations: ${totalCombinations}`);
    console.log(`  ✓ Successfully processed: ${successful.length}`);
    console.log(`  ⊘ Skipped (already exists): ${skipped.length}`);
    console.log(`  ✗ Failed: ${failed.length}`);
    console.log(`Total aircraft found: ${totalAircraft.toLocaleString()}`);
    console.log(`Duration: ${(duration / 1000).toFixed(1)}s`);
    console.log('='.repeat(60) + '\n');

    if (successful.length > 0) {
      console.log('Successfully processed:');
      const byAirport = {};
      successful.forEach(r => {
        if (!byAirport[r.airport]) byAirport[r.airport] = [];
        byAirport[r.airport].push(r);
      });
      Object.entries(byAirport).forEach(([icao, results]) => {
        const total = results.reduce((sum, r) => sum + r.count, 0);
        console.log(`  ${icao}: ${results.length} date(s), ${total.toLocaleString()} total aircraft`);
      });
      console.log('');
    }

    if (skipped.length > 0) {
      console.log('Skipped (already processed):');
      const byAirport = {};
      skipped.forEach(r => {
        if (!byAirport[r.airport]) byAirport[r.airport] = [];
        byAirport[r.airport].push(r);
      });
      Object.entries(byAirport).forEach(([icao, results]) => {
        const total = results.reduce((sum, r) => sum + r.count, 0);
        console.log(`  ${icao}: ${results.length} date(s), ${total.toLocaleString()} total aircraft`);
      });
      console.log('');
    }

    if (failed.length > 0) {
      console.log('Failed:');
      failed.forEach(r => {
        console.log(`  ${r.airport} (${r.date}): ${r.error}`);
      });
      console.log('');
      process.exit(1);
    }

    logger.info('All processing complete! 🎉');

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
