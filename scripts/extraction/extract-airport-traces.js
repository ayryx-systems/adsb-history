#!/usr/bin/env node

import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import TraceExtractor from '../../src/extraction/TraceExtractor.js';
import ExtractedTraceData from '../../src/extraction/ExtractedTraceData.js';
import logger from '../../src/utils/logger.js';
import { describeAwsError } from '../../src/utils/awsErrorUtils.js';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function parseArgs() {
  const args = process.argv.slice(2);
  const options = {
    airport: null,
    date: null,
    startDate: null,
    days: null,
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
    } else if (arg === '--start-date' && i + 1 < args.length) {
      options.startDate = args[i + 1];
      i++;
    } else if (arg === '--days' && i + 1 < args.length) {
      options.days = parseInt(args[i + 1], 10);
      i++;
    } else if (arg === '--force') {
      options.force = true;
    } else if (arg === '--help' || arg === '-h') {
      console.log(`
Extract traces for aircraft identified at an airport

Usage:
  Single date:
    node scripts/extraction/extract-airport-traces.js --airport ICAO --date YYYY-MM-DD [options]
  
  Date range:
    node scripts/extraction/extract-airport-traces.js --airport ICAO --start-date YYYY-MM-DD --days N [options]

Options:
  --airport ICAO        Airport ICAO code (e.g., KORD, KLGA)
  --date YYYY-MM-DD     Single date to process (mutually exclusive with --start-date)
  --start-date YYYY-MM-DD  Start date for date range
  --days N              Number of days to process (required with --start-date)
  --force               Reprocess even if data exists
  --help, -h            Show this help message

Examples:
  # Single date
  node scripts/extraction/extract-airport-traces.js --airport KORD --date 2025-01-15
  
  # Date range (7 days starting from 2025-01-15)
  node scripts/extraction/extract-airport-traces.js --airport KORD --start-date 2025-01-15 --days 7
      `);
      process.exit(0);
    }
  }

  if (!options.airport) {
    console.error('Error: --airport is required');
    console.error('Run with --help for usage information');
    process.exit(1);
  }

  if (!options.date && (!options.startDate || !options.days)) {
    console.error('Error: Either --date or (--start-date and --days) must be provided');
    console.error('Run with --help for usage information');
    process.exit(1);
  }

  if (options.date && (options.startDate || options.days)) {
    console.error('Error: --date cannot be used with --start-date/--days');
    console.error('Run with --help for usage information');
    process.exit(1);
  }

  if (options.startDate && !options.days) {
    console.error('Error: --days is required when using --start-date');
    console.error('Run with --help for usage information');
    process.exit(1);
  }

  if (options.days && !options.startDate) {
    console.error('Error: --start-date is required when using --days');
    console.error('Run with --help for usage information');
    process.exit(1);
  }

  if (options.days && options.days < 1) {
    console.error('Error: --days must be at least 1');
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

function generateDateRange(startDate, days) {
  const dates = [];
  const start = new Date(startDate + 'T00:00:00Z');
  
  for (let i = 0; i < days; i++) {
    const currentDate = new Date(start);
    currentDate.setUTCDate(start.getUTCDate() + i);
    const dateStr = currentDate.toISOString().split('T')[0];
    dates.push(dateStr);
  }
  
  return dates;
}

async function processDate(airport, date, extractor, dataStore, force) {
  if (!force) {
    const exists = await dataStore.exists(airport.icao, date);
    if (exists) {
      logger.info('Extracted traces already exist, skipping', {
        airport: airport.icao,
        date,
      });
      
      console.log(`  ✓ ${date}: Already extracted (use --force to reprocess)`);
      return { date, skipped: true };
    }
  }

  logger.info('Starting extraction', {
    airport: airport.icao,
    date,
  });

  try {
    const tarPath = await extractor.extractTracesForAirport(airport.icao, date);
    
    if (!tarPath) {
      console.log(`  ⊘ ${date}: No ground aircraft found`);
      return { date, skipped: true, reason: 'no_aircraft' };
    }

    await dataStore.save(airport.icao, date, tarPath);

    const stats = fs.statSync(tarPath);
    const sizeMB = (stats.size / 1024 / 1024).toFixed(2);

    console.log(`  ✓ ${date}: Extracted (${sizeMB} MB)`);
    return { date, sizeMB, skipped: false };
  } catch (error) {
    const errorDetails = describeAwsError(error);
    logger.error('Failed to extract traces', {
      airport: airport.icao,
      date,
      error: errorDetails,
      stack: error.stack,
    });
    console.log(`  ✗ ${date}: Error - ${errorDetails}`);
    return { date, error: errorDetails };
  }
}

async function main() {
  const options = parseArgs();

  logger.info('Starting trace extraction', options);

  try {
    const airport = loadAirportConfig(options.airport);
    logger.info('Airport configuration loaded', {
      icao: airport.icao,
      name: airport.name,
    });

    const extractor = new TraceExtractor();
    const dataStore = new ExtractedTraceData();

    let dates;
    if (options.date) {
      dates = [options.date];
    } else {
      dates = generateDateRange(options.startDate, options.days);
    }

    console.log(`\n${'='.repeat(60)}`);
    console.log(`Extracting traces for ${airport.icao} (${airport.name})`);
    if (dates.length === 1) {
      console.log(`Date: ${dates[0]}`);
    } else {
      console.log(`Date range: ${dates[0]} to ${dates[dates.length - 1]} (${dates.length} days)`);
    }
    console.log('='.repeat(60) + '\n');

    const results = [];
    const startTime = Date.now();

    for (let i = 0; i < dates.length; i++) {
      const date = dates[i];
      console.log(`[${i + 1}/${dates.length}] Processing ${date}...`);
      
      try {
        const result = await processDate(airport, date, extractor, dataStore, options.force);
        results.push(result);
      } catch (error) {
        logger.error('Failed to process date', {
          airport: airport.icao,
          date,
          error: error.message,
          stack: error.stack,
        });
        console.log(`  ✗ ${date}: Error - ${error.message}`);
        results.push({ date, error: error.message });
      }
    }

    const duration = Date.now() - startTime;
    const successful = results.filter(r => !r.error && !r.skipped).length;
    const skipped = results.filter(r => r.skipped).length;
    const failed = results.filter(r => r.error).length;
    const totalSizeMB = results
      .filter(r => r.sizeMB)
      .reduce((sum, r) => sum + parseFloat(r.sizeMB), 0);

    console.log(`\n${'='.repeat(60)}`);
    console.log(`Summary for ${airport.icao} (${airport.name})`);
    console.log('='.repeat(60));
    console.log(`Dates processed: ${dates.length}`);
    console.log(`  ✓ Successful: ${successful}`);
    console.log(`  ⊘ Skipped: ${skipped}`);
    console.log(`  ✗ Failed: ${failed}`);
    if (totalSizeMB > 0) {
      console.log(`Total size: ${totalSizeMB.toFixed(2)} MB`);
    }
    console.log(`Duration: ${(duration / 1000).toFixed(1)}s`);
    console.log('='.repeat(60) + '\n');

    if (failed > 0) {
      logger.warn('Some dates failed to process', { failed });
      process.exit(1);
    }

    logger.info('Extraction complete! 🎉');

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

