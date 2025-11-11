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
Generate L1 statistics from flight summary data

Usage:
  node scripts/analysis/generate-l1-stats.js --airport ICAO --date YYYY-MM-DD [options]

Options:
  --airport ICAO        Airport ICAO code (e.g., KLGA, KLAX)
  --date YYYY-MM-DD     Date to process
  --force               Reprocess even if data exists
  --help, -h            Show this help message

Examples:
  node scripts/analysis/generate-l1-stats.js --airport KLGA --date 2025-11-08
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

async function main() {
  const options = parseArgs();

  logger.info('Starting L1 stats generation', options);

  try {
    const summaryData = new FlightSummaryData();
    const l1StatsData = new L1StatsData();
    const analyzer = new L1StatsAnalyzer();

    // Check if already processed
    if (!options.force) {
      const exists = await l1StatsData.exists(options.airport, options.date);
      if (exists) {
        logger.info('L1 stats already exist, loading from storage', {
          airport: options.airport,
          date: options.date,
        });
        
        const data = await l1StatsData.load(options.airport, options.date);
        console.log(`\n${'='.repeat(60)}`);
        console.log(`L1 Statistics for ${options.airport} on ${options.date}`);
        console.log('='.repeat(60));
        console.log(`Total Arrivals: ${data.totalArrivals}`);
        console.log(`Aircraft Types: ${Object.keys(data.byAircraftType).length}`);
        console.log('='.repeat(60) + '\n');
        
        // Show sample stats
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
    }

    // Load summary data
    logger.info('Loading flight summary data', {
      airport: options.airport,
      date: options.date,
    });

    const summary = await summaryData.load(options.airport, options.date);
    if (!summary || !summary.flights) {
      logger.error('Flight summary data not found', {
        airport: options.airport,
        date: options.date,
      });
      console.error(`Error: Flight summary data not found for ${options.airport} on ${options.date}`);
      console.error('Please run analyze-airport-day.js first to generate summary data');
      process.exit(1);
    }

    logger.info('Flight summary data loaded', {
      airport: options.airport,
      date: options.date,
      flights: summary.flights.length,
    });

    // Generate L1 stats
    logger.info('Generating L1 statistics', {
      airport: options.airport,
      date: options.date,
    });

    const stats = analyzer.analyze(summary.flights, options.airport, options.date);

    // Save results
    logger.info('Saving L1 stats', {
      airport: options.airport,
      date: options.date,
      totalArrivals: stats.totalArrivals,
    });
    await l1StatsData.save(options.airport, options.date, stats);

    // Display results
    console.log(`\n${'='.repeat(60)}`);
    console.log(`L1 Statistics for ${options.airport} on ${options.date}`);
    console.log('='.repeat(60));
    console.log(`Total Arrivals: ${stats.totalArrivals}`);
    console.log(`Aircraft Types: ${Object.keys(stats.byAircraftType).length}`);
    console.log('='.repeat(60) + '\n');

    // Show overall stats
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

    // Show stats by aircraft type (top 5 by count)
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

