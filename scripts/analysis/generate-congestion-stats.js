#!/usr/bin/env node

/**
 * Generate congestion statistics from flight summary data
 * 
 * Calculates the number of aircraft within 50nm radius that are landing
 * in the next 2 hours, displayed over 15-minute time slots throughout the day.
 * 
 * Usage:
 *   node scripts/analysis/generate-congestion-stats.js --airport KLGA --date 2025-11-08
 */

import dotenv from 'dotenv';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import CongestionAnalyzer from '../../src/analysis/congestion/CongestionAnalyzer.js';
import CongestionData from '../../src/analysis/congestion/CongestionData.js';
import FlightSummaryData from '../../src/analysis/FlightSummaryData.js';
import logger from '../../src/utils/logger.js';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function parseArgs() {
  const args = process.argv.slice(2);
  const options = {
    airport: null,
    date: null,
    startDate: null,
    endDate: null,
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
    } else if (arg === '--end-date' && i + 1 < args.length) {
      options.endDate = args[i + 1];
      i++;
    } else if (arg === '--force') {
      options.force = true;
    } else if (arg === '--help' || arg === '-h') {
      console.log(`
Generate congestion statistics from flight summary data

Usage:
  # Single date
  node scripts/analysis/generate-congestion-stats.js --airport ICAO --date YYYY-MM-DD [options]
  
  # Date range (batch processing)
  node scripts/analysis/generate-congestion-stats.js --airport ICAO --start-date YYYY-MM-DD --end-date YYYY-MM-DD [options]

Options:
  --airport ICAO        Airport ICAO code (e.g., KLGA, KLAX)
  --date YYYY-MM-DD     Single date to process
  --start-date DATE     Start date for batch processing
  --end-date DATE       End date for batch processing
  --force               Reprocess even if data exists
  --help, -h            Show this help message

Examples:
  # Process single date
  node scripts/analysis/generate-congestion-stats.js --airport KLGA --date 2025-11-08
  
  # Process date range (January 2025)
  node scripts/analysis/generate-congestion-stats.js --airport KORD --start-date 2025-01-01 --end-date 2025-01-31 --force
      `);
      process.exit(0);
    }
  }

  if (!options.airport) {
    console.error('Error: --airport is required');
    console.error('Run with --help for usage information');
    process.exit(1);
  }

  if (!options.date && (!options.startDate || !options.endDate)) {
    console.error('Error: Either --date or both --start-date and --end-date are required');
    console.error('Run with --help for usage information');
    process.exit(1);
  }

  return options;
}

function generateDateRange(startDate, endDate) {
  const dates = [];
  const start = new Date(startDate);
  const end = new Date(endDate);

  for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
    dates.push(d.toISOString().split('T')[0]);
  }

  return dates;
}

function getNextDate(date) {
  try {
    const d = new Date(date + 'T00:00:00Z');
    d.setUTCDate(d.getUTCDate() + 1);
    return d.toISOString().split('T')[0];
  } catch (error) {
    return null;
  }
}

async function loadAirportConfig(airport) {
  const configPath = path.join(__dirname, '../../config/airports.json');
  const configData = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
  const airportConfig = configData.airports.find(a => a.icao === airport);
  
  if (!airportConfig) {
    throw new Error(`Airport ${airport} not found in configuration`);
  }
  
  return airportConfig;
}

async function processDate(airport, date, force) {
  const summaryData = new FlightSummaryData();
  const congestionData = new CongestionData();
  const analyzer = new CongestionAnalyzer();

  // Check if already processed
  if (!force) {
    const exists = await congestionData.exists(airport, date);
    if (exists) {
      logger.info('Congestion stats already exist, skipping', {
        airport,
        date,
      });
      return { success: true, skipped: true, date };
    }
  }

  // Load airport configuration
  const airportConfig = await loadAirportConfig(airport);

  // Load current day summary data
  logger.debug('Loading flight summary data', {
    airport,
    date,
  });

  const currentDaySummary = await summaryData.load(airport, date);
  if (!currentDaySummary || !currentDaySummary.flights) {
    logger.warn('Flight summary data not found', {
      airport,
      date,
    });
    return { success: false, skipped: false, date, error: 'Flight summary data not found' };
  }

  const nextDate = getNextDate(date);
  let nextDaySummary = null;
  if (nextDate) {
    const nextDayExists = await summaryData.exists(airport, nextDate);
    if (nextDayExists) {
      try {
        nextDaySummary = await summaryData.load(airport, nextDate);
        if (nextDaySummary && nextDaySummary.flights) {
          logger.debug('Loaded next day summary data for lookahead', {
            airport,
            date,
            nextDate,
            flights: nextDaySummary.flights.length,
          });
        }
      } catch (error) {
        logger.warn('Could not load next day summary', {
          airport,
          date,
          nextDate,
          error: error.message,
        });
      }
    } else {
      logger.debug('Next day summary does not exist, skipping lookahead', {
        airport,
        date,
        nextDate,
      });
    }
  }

  logger.debug('Flight summary data loaded', {
    airport,
    date,
    currentDayFlights: currentDaySummary.flights.length,
    nextDayFlights: nextDaySummary?.flights?.length || 0,
  });

  // Generate congestion stats
  logger.info('Generating congestion statistics', {
    airport,
    date,
  });

  const stats = analyzer.analyze(
    currentDaySummary.flights,
    nextDaySummary?.flights || [],
    airportConfig,
    date
  );

  // Save results
  logger.info('Saving congestion stats', {
    airport,
    date,
    timeSlots: Object.keys(stats.byTimeSlot || {}).length,
  });
  await congestionData.save(airport, date, stats);

  return { success: true, skipped: false, date, stats };
}

async function main() {
  const options = parseArgs();

  logger.info('Starting congestion stats generation', options);

  try {
    // Determine if batch processing or single date
    const dates = options.date 
      ? [options.date]
      : generateDateRange(options.startDate, options.endDate);

    if (dates.length === 1) {
      // Single date processing
      const result = await processDate(options.airport, dates[0], options.force);
      
      if (!result.success) {
        if (result.error === 'Flight summary data not found') {
          console.error(`Error: Flight summary data not found for ${options.airport} on ${dates[0]}`);
          console.error('Please run analyze-airport-day.js first to generate summary data');
          process.exit(1);
        }
        throw new Error(result.error);
      }

      if (result.skipped) {
        const congestionData = new CongestionData();
        const data = await congestionData.load(options.airport, dates[0]);
        console.log(`\n${'='.repeat(60)}`);
        console.log(`Congestion Statistics for ${options.airport} on ${dates[0]}`);
        console.log('='.repeat(60));
        console.log(`Time Slots: ${Object.keys(data.byTimeSlot || {}).length}`);
        console.log('='.repeat(60) + '\n');
        return;
      }

      // Display results for single date
      const stats = result.stats;
      console.log(`\n${'='.repeat(60)}`);
      console.log(`Congestion Statistics for ${options.airport} on ${dates[0]}`);
      console.log('='.repeat(60));
      console.log(`Time Slots: ${Object.keys(stats.byTimeSlot || {}).length}`);
      
      // Show max congestion
      const maxCongestion = Math.max(
        ...Object.values(stats.byTimeSlot || {}).map(s => s.congestion || 0)
      );
      console.log(`Max Congestion: ${maxCongestion} aircraft`);
      console.log('='.repeat(60) + '\n');

      logger.info('Congestion stats generation complete! 🎉');
    } else {
      // Batch processing
      console.log(`\n${'='.repeat(60)}`);
      console.log(`Processing ${dates.length} days for ${options.airport}`);
      console.log(`Date range: ${options.startDate} to ${options.endDate}`);
      console.log('='.repeat(60) + '\n');

      const results = {
        total: dates.length,
        successful: 0,
        failed: 0,
        skipped: 0,
        errors: [],
      };

      for (let i = 0; i < dates.length; i++) {
        const date = dates[i];
        const dayNum = i + 1;

        console.log(`[${dayNum}/${dates.length}] Processing ${date}...`);
        const result = await processDate(options.airport, date, options.force);

        if (result.success) {
          if (result.skipped) {
            results.skipped++;
            console.log(`  ✓ ${date} skipped (already exists)`);
          } else {
            results.successful++;
            const timeSlots = Object.keys(result.stats.byTimeSlot || {}).length;
            console.log(`  ✓ ${date} completed (${timeSlots} time slots)`);
          }
        } else {
          results.failed++;
          results.errors.push({ date, error: result.error });
          console.log(`  ✗ ${date} failed: ${result.error}`);
        }
      }

      console.log(`\n${'='.repeat(60)}`);
      console.log('Processing Summary');
      console.log('='.repeat(60));
      console.log(`Total days: ${results.total}`);
      console.log(`Successful: ${results.successful}`);
      console.log(`Skipped: ${results.skipped}`);
      console.log(`Failed: ${results.failed}`);

      if (results.errors.length > 0) {
        console.log(`\nErrors:`);
        for (const { date, error } of results.errors) {
          console.log(`  ${date}: ${error}`);
        }
      }

      console.log('='.repeat(60) + '\n');

      if (results.failed > 0) {
        logger.warn('Some days failed to process', { failed: results.failed });
        process.exit(1);
      } else {
        logger.info('All days processed successfully! 🎉');
      }
    }

  } catch (error) {
    logger.error('Congestion stats generation failed', {
      error: error.message,
      stack: error.stack,
    });
    process.exit(1);
  }
}

main().catch(error => {
  logger.error('Fatal error', {
    error: error.message,
  });
  process.exit(1);
});
