#!/usr/bin/env node

/**
 * Generate L1 statistics from flight summary data
 * 
 * Creates detailed statistics for arrival flights including:
 * - Statistics grouped by aircraft type
 * - Overall statistics for all arrivals
 * - Milestone statistics (timeFrom100nm, timeFrom50nm, timeFrom20nm)
 * 
 * Usage:
 *   node scripts/analysis/generate-l1-stats.js --airport KLGA --date 2025-11-08
 */

import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import L1StatsAnalyzer from '../../src/analysis/l1-stats/L1StatsAnalyzer.js';
import L1StatsData from '../../src/analysis/l1-stats/L1StatsData.js';
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
Generate L1 statistics from flight summary data

Usage:
  # Single date
  node scripts/analysis/generate-l1-stats.js --airport ICAO --date YYYY-MM-DD [options]
  
  # Date range (batch processing)
  node scripts/analysis/generate-l1-stats.js --airport ICAO --start-date YYYY-MM-DD --end-date YYYY-MM-DD [options]

Options:
  --airport ICAO        Airport ICAO code (e.g., KLGA, KLAX)
  --date YYYY-MM-DD     Single date to process
  --start-date DATE     Start date for batch processing
  --end-date DATE       End date for batch processing
  --force               Reprocess even if data exists
  --help, -h            Show this help message

Examples:
  # Process single date
  node scripts/analysis/generate-l1-stats.js --airport KLGA --date 2025-11-08
  
  # Process date range (January 2025)
  node scripts/analysis/generate-l1-stats.js --airport KORD --start-date 2025-01-01 --end-date 2025-01-31 --force
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

async function processDate(airport, date, force) {
  const summaryData = new FlightSummaryData();
  const l1StatsData = new L1StatsData();
  const analyzer = new L1StatsAnalyzer();

  // Check if already processed
  if (!force) {
    const exists = await l1StatsData.exists(airport, date);
    if (exists) {
      logger.info('L1 stats already exist, skipping', {
        airport,
        date,
      });
      return { success: true, skipped: true, date };
    }
  }

  // Load summary data
  logger.info('Loading flight summary data', {
    airport,
    date,
  });

  const summary = await summaryData.load(airport, date);
  if (!summary || !summary.flights) {
    logger.warn('Flight summary data not found', {
      airport,
      date,
    });
    return { success: false, skipped: false, date, error: 'Flight summary data not found' };
  }

  logger.info('Flight summary data loaded', {
    airport,
    date,
    flights: summary.flights.length,
  });

  // Generate L1 stats
  logger.info('Generating L1 statistics', {
    airport,
    date,
  });

  const stats = analyzer.analyze(summary.flights, airport, date);

  // Save results
  logger.info('Saving L1 stats', {
    airport,
    date,
    totalArrivals: stats.totalArrivals,
  });
  await l1StatsData.save(airport, date, stats);

  return { success: true, skipped: false, date, stats };
}

async function main() {
  const options = parseArgs();

  logger.info('Starting L1 stats generation', options);

  try {
    // Determine if batch processing or single date
    const dates = options.date 
      ? [options.date]
      : generateDateRange(options.startDate, options.endDate);

    if (dates.length === 1) {
      // Single date processing (original behavior with full output)
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
        const l1StatsData = new L1StatsData();
        const data = await l1StatsData.load(options.airport, dates[0]);
        console.log(`\n${'='.repeat(60)}`);
        console.log(`L1 Statistics for ${options.airport} on ${dates[0]}`);
        console.log('='.repeat(60));
        console.log(`Total Arrivals: ${data.totalArrivals}`);
        console.log(`Aircraft Types: ${Object.keys(data.byAircraftType).length}`);
        console.log('='.repeat(60) + '\n');
        
        if (data.overall && data.overall.milestones.timeFrom20nm) {
          const stats = data.overall.milestones.timeFrom20nm;
          console.log('Overall Time from 20nm (seconds):');
          console.log(`  Count: ${stats.count}`);
          console.log(`  Mean: ${stats.mean.toFixed(1)}s (${(stats.mean / 60).toFixed(1)} min)`);
          console.log(`  Median: ${stats.median.toFixed(1)}s (${(stats.median / 60).toFixed(1)} min)`);
          console.log(`  Min: ${stats.min.toFixed(1)}s`);
          console.log(`  Max: ${stats.max.toFixed(1)}s`);
          console.log('');
        }
        return;
      }

      // Display results for single date
      const stats = result.stats;
      console.log(`\n${'='.repeat(60)}`);
      console.log(`L1 Statistics for ${options.airport} on ${dates[0]}`);
      console.log('='.repeat(60));
      console.log(`Total Arrivals: ${stats.totalArrivals}`);
      console.log(`Aircraft Types: ${Object.keys(stats.byAircraftType).length}`);
      console.log('='.repeat(60) + '\n');

      if (stats.overall && stats.overall.milestones) {
        console.log('Overall Statistics (All Arrivals):');
        console.log('─'.repeat(60));
        
        const milestones = ['timeFrom100nm', 'timeFrom50nm', 'timeFrom20nm'];
        for (const milestone of milestones) {
          const stat = stats.overall.milestones[milestone];
          if (stat) {
            const distance = milestone.replace('timeFrom', '').replace('nm', '');
            console.log(`\nTime from ${distance}nm to touchdown:`);
            console.log(`  Count: ${stat.count}`);
            console.log(`  Mean: ${stat.mean.toFixed(1)}s (${(stat.mean / 60).toFixed(1)} min)`);
            console.log(`  Median: ${stat.median.toFixed(1)}s (${(stat.median / 60).toFixed(1)} min)`);
            console.log(`  Min: ${stat.min.toFixed(1)}s (${(stat.min / 60).toFixed(1)} min)`);
            console.log(`  Max: ${stat.max.toFixed(1)}s (${(stat.max / 60).toFixed(1)} min)`);
            console.log(`  Std Dev: ${stat.stdDev.toFixed(1)}s`);
            console.log(`  Percentiles: P10=${stat.percentiles.p10.toFixed(1)}s, P25=${stat.percentiles.p25.toFixed(1)}s, P75=${stat.percentiles.p75.toFixed(1)}s, P90=${stat.percentiles.p90.toFixed(1)}s`);
          }
        }
        console.log('');
      }

      const typeEntries = Object.entries(stats.byAircraftType)
        .sort((a, b) => b[1].count - a[1].count)
        .slice(0, 5);

      if (typeEntries.length > 0) {
        console.log('Statistics by Aircraft Type (Top 5):');
        console.log('─'.repeat(60));
        
        for (const [type, typeData] of typeEntries) {
          console.log(`\n${type} (${typeData.count} arrivals):`);
          if (typeData.milestones.timeFrom20nm) {
            const stat = typeData.milestones.timeFrom20nm;
            console.log(`  Time from 20nm:`);
            console.log(`    Mean: ${stat.mean.toFixed(1)}s (${(stat.mean / 60).toFixed(1)} min)`);
            console.log(`    Median: ${stat.median.toFixed(1)}s (${(stat.median / 60).toFixed(1)} min)`);
          }
        }
        console.log('');
      }

      logger.info('L1 stats generation complete! 🎉');
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
            console.log(`  ✓ ${date} completed (${result.stats.totalArrivals} arrivals)`);
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
    logger.error('L1 stats generation failed', {
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

