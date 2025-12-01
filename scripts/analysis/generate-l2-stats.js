#!/usr/bin/env node

/**
 * Generate L2 statistics from L1 statistics data
 * 
 * Calculates time-of-day volumes in local time:
 * - Morning volume (06:00-12:00 local)
 * - Afternoon volume (12:00-18:00 local)
 * - Evening volume (18:00-24:00 local)
 * 
 * Usage:
 *   node scripts/analysis/generate-l2-stats.js --airport KLGA --date 2025-11-08
 */

import dotenv from 'dotenv';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import L2StatsAnalyzer from '../../src/analysis/l2-stats/L2StatsAnalyzer.js';
import L2StatsData from '../../src/analysis/l2-stats/L2StatsData.js';
import L1StatsData from '../../src/analysis/l1-stats/L1StatsData.js';
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
Generate L2 statistics from L1 statistics data

Usage:
  # Single date
  node scripts/analysis/generate-l2-stats.js --airport ICAO --date YYYY-MM-DD [options]
  
  # Date range (batch processing)
  node scripts/analysis/generate-l2-stats.js --airport ICAO --start-date YYYY-MM-DD --end-date YYYY-MM-DD [options]

Options:
  --airport ICAO        Airport ICAO code (e.g., KLGA, KLAX)
  --date YYYY-MM-DD     Single date to process (local date)
  --start-date DATE     Start date for batch processing (local date)
  --end-date DATE       End date for batch processing (local date)
  --force               Reprocess even if data exists
  --help, -h            Show this help message

Examples:
  # Process single date
  node scripts/analysis/generate-l2-stats.js --airport KLGA --date 2025-11-08
  
  # Process date range (January 2025)
  node scripts/analysis/generate-l2-stats.js --airport KORD --start-date 2025-01-01 --end-date 2025-01-31 --force
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

async function loadAirportConfig(airport) {
  const configPath = path.join(__dirname, '../../config/airports.json');
  const configData = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
  const airportConfig = configData.airports.find(a => a.icao === airport);
  
  if (!airportConfig) {
    throw new Error(`Airport ${airport} not found in configuration`);
  }
  
  return airportConfig;
}

async function processDate(airport, localDate, force) {
  const l1StatsData = new L1StatsData();
  const l2StatsData = new L2StatsData();
  const analyzer = new L2StatsAnalyzer();

  // Check if already processed
  if (!force) {
    const exists = await l2StatsData.exists(airport, localDate);
    if (exists) {
      logger.info('L2 stats already exist, skipping', {
        airport,
        localDate,
      });
      return { success: true, skipped: true, date: localDate };
    }
  }

  // Load airport configuration
  const airportConfig = await loadAirportConfig(airport);

  // Get relevant UTC dates for this local date
  const relevantUTCDates = analyzer.getRelevantUTCDates(localDate, airportConfig);
  logger.info('Loading L1 stats for UTC dates', {
    airport,
    localDate,
    utcDates: relevantUTCDates,
  });

  // Load L1 stats for all relevant UTC dates
  const l1StatsArray = [];
  for (const utcDate of relevantUTCDates) {
    try {
      const l1Stats = await l1StatsData.load(airport, utcDate);
      if (l1Stats) {
        l1StatsArray.push(l1Stats);
      } else {
        logger.warn('L1 stats not found for UTC date', {
          airport,
          utcDate,
          localDate,
        });
      }
    } catch (error) {
      logger.warn('Failed to load L1 stats for UTC date', {
        airport,
        utcDate,
        localDate,
        error: error.message,
      });
    }
  }

  if (l1StatsArray.length === 0) {
    logger.warn('No L1 stats found for relevant UTC dates', {
      airport,
      localDate,
      utcDates: relevantUTCDates,
    });
    return { success: false, skipped: false, date: localDate, error: 'L1 stats data not found' };
  }

  logger.info('L1 stats loaded', {
    airport,
    localDate,
    l1StatsCount: l1StatsArray.length,
  });

  // Generate L2 stats
  logger.info('Generating L2 statistics', {
    airport,
    localDate,
  });

  const stats = analyzer.analyze(l1StatsArray, airportConfig, localDate);

  // Save results
  logger.info('Saving L2 stats', {
    airport,
    localDate,
    volumes: stats.volumes,
  });
  await l2StatsData.save(airport, localDate, stats);

  return { success: true, skipped: false, date: localDate, stats };
}

async function main() {
  const options = parseArgs();

  logger.info('Starting L2 stats generation', options);

  try {
    // Determine if batch processing or single date
    const dates = options.date 
      ? [options.date]
      : generateDateRange(options.startDate, options.endDate);

    if (dates.length === 1) {
      // Single date processing
      const result = await processDate(options.airport, dates[0], options.force);
      
      if (!result.success) {
        if (result.error === 'L1 stats data not found') {
          console.error(`Error: L1 stats data not found for ${options.airport} on ${dates[0]}`);
          console.error('Please run generate-l1-stats.js first to generate L1 statistics');
          process.exit(1);
        }
        throw new Error(result.error);
      }

      if (result.skipped) {
        const l2StatsData = new L2StatsData();
        const data = await l2StatsData.load(options.airport, dates[0]);
        console.log(`\n${'='.repeat(60)}`);
        console.log(`L2 Statistics for ${options.airport} on ${dates[0]} (local)`);
        console.log('='.repeat(60));
        console.log(`Morning (06:00-12:00): ${data.volumes.morning}`);
        console.log(`Afternoon (12:00-18:00): ${data.volumes.afternoon}`);
        console.log(`Evening (18:00-24:00): ${data.volumes.evening}`);
        console.log(`Total: ${data.volumes.total}`);
        console.log('='.repeat(60) + '\n');
        return;
      }

      // Display results for single date
      const stats = result.stats;
      console.log(`\n${'='.repeat(60)}`);
      console.log(`L2 Statistics for ${options.airport} on ${dates[0]} (local)`);
      console.log('='.repeat(60));
      console.log(`Morning (06:00-12:00): ${stats.volumes.morning}`);
      console.log(`Afternoon (12:00-18:00): ${stats.volumes.afternoon}`);
      console.log(`Evening (18:00-24:00): ${stats.volumes.evening}`);
      console.log(`Total: ${stats.volumes.total}`);
      console.log('='.repeat(60) + '\n');

      logger.info('L2 stats generation complete! 🎉');
    } else {
      // Batch processing
      console.log(`\n${'='.repeat(60)}`);
      console.log(`Processing ${dates.length} days for ${options.airport}`);
      console.log(`Date range: ${options.startDate} to ${options.endDate} (local)`);
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
            const volumes = result.stats.volumes;
            console.log(`  ✓ ${date} completed (M:${volumes.morning} A:${volumes.afternoon} E:${volumes.evening})`);
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
    logger.error('L2 stats generation failed', {
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

