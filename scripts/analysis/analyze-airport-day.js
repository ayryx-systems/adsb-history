#!/usr/bin/env node

/**
 * Analyze flights for an airport on a specific day
 * 
 * Creates detailed flight summaries including:
 * - Time from 100nm, 50nm, 20nm to touchdown (for arrivals)
 * - Time to 20nm, 50nm, 100nm from takeoff (for departures)
 * - Summary statistics for the day
 * 
 * Usage:
 *   node scripts/analysis/analyze-airport-day.js --airport KLGA --date 2025-11-08
 */

import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import AirportDayAnalyzer from '../../src/analysis/AirportDayAnalyzer.js';
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
Analyze flights for an airport on a specific day

Usage:
  node scripts/analysis/analyze-airport-day.js --airport ICAO --date YYYY-MM-DD [options]

Options:
  --airport ICAO        Airport ICAO code (e.g., KLGA, KLAX)
  --date YYYY-MM-DD     Date to process
  --force               Reprocess even if data exists
  --help, -h            Show this help message

Examples:
  node scripts/analysis/analyze-airport-day.js --airport KLGA --date 2025-11-08
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

  logger.info('Starting airport day analysis', options);

  try {
    const airport = loadAirportConfig(options.airport);
    logger.info('Airport configuration loaded', {
      icao: airport.icao,
      name: airport.name,
    });

    const analyzer = new AirportDayAnalyzer({ skipCleanup: true });
    const dataStore = new FlightSummaryData();

    // Check if already processed
    if (!options.force) {
      const exists = await dataStore.exists(airport.icao, options.date);
      if (exists) {
        logger.info('Data already exists, loading from storage', {
          airport: airport.icao,
          date: options.date,
        });
        
        const data = await dataStore.load(airport.icao, options.date);
        console.log(`\n${'='.repeat(60)}`);
        console.log(`Flight Summary for ${airport.icao} (${airport.name}) on ${options.date}`);
        if (data.airportElevation_ft !== undefined) {
          console.log(`Airport Elevation: ${data.airportElevation_ft} ft`);
        }
        console.log('='.repeat(60));
        console.log(`Total movements: ${data.summary.totalMovements}`);
        console.log(`Arrivals: ${data.summary.arrivals}`);
        console.log(`Departures: ${data.summary.departures}`);
        console.log(`Missed Approaches: ${data.summary.missedApproaches || 0}`);
        console.log(`Other: ${data.summary.other}`);
        console.log('='.repeat(60) + '\n');
        return;
      }
    }

    // Analyze flights
    logger.info('Starting analysis (this may take several minutes)', {
      airport: airport.icao,
      date: options.date,
    });

    const results = await analyzer.analyzeDay(
      airport.icao,
      options.date,
      airport
    );

    // Save results
    logger.info('Saving results', {
      airport: airport.icao,
      date: options.date,
      flights: results.flights.length,
    });
    await dataStore.save(airport.icao, options.date, {
      flights: results.flights,
      summary: results.summary,
      airportElevation_ft: results.airportElevation_ft,
    });

    console.log(`\n${'='.repeat(60)}`);
    console.log(`Flight Summary for ${airport.icao} (${airport.name}) on ${options.date}`);
    console.log(`Airport Elevation: ${results.airportElevation_ft} ft`);
    console.log('='.repeat(60));
    console.log(`Total movements: ${results.summary.totalMovements}`);
    console.log(`Arrivals: ${results.summary.arrivals}`);
    console.log(`Departures: ${results.summary.departures}`);
    console.log(`Missed Approaches: ${results.summary.missedApproaches || 0}`);
    console.log(`Other: ${results.summary.other}`);
    if (results.tracesSaved !== undefined) {
      console.log(`Simplified traces saved: ${results.tracesSaved}`);
    }
    console.log('='.repeat(60) + '\n');

    // Show sample arrival with milestones
    const sampleArrival = results.flights.find(f => f.classification === 'arrival');
    if (sampleArrival) {
      console.log('Sample Arrival:');
      console.log(`  ICAO: ${sampleArrival.icao}`);
      console.log(`  Touchdown: ${new Date(sampleArrival.touchdown.timestamp * 1000).toISOString()}`);
      if (sampleArrival.milestones.timeFrom100nm) {
        console.log(`  Time from 100nm: ${(sampleArrival.milestones.timeFrom100nm / 60).toFixed(1)} minutes`);
      }
      if (sampleArrival.milestones.timeFrom50nm) {
        console.log(`  Time from 50nm: ${(sampleArrival.milestones.timeFrom50nm / 60).toFixed(1)} minutes`);
      }
      if (sampleArrival.milestones.timeFrom20nm) {
        console.log(`  Time from 20nm: ${(sampleArrival.milestones.timeFrom20nm / 60).toFixed(1)} minutes`);
      }
      console.log('');
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

main().catch(error => {
  logger.error('Fatal error', {
    error: error.message,
    stack: error.stack,
  });
  process.exit(1);
});

