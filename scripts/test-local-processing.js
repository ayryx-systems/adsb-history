#!/usr/bin/env node

/**
 * Test processing locally by downloading a tar file and processing it
 * This helps debug permission errors before fixing on EC2
 * 
 * Usage:
 *   node scripts/test-local-processing.js --airport KLGA --date 2025-11-08
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
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    
    if (arg === '--airport' && i + 1 < args.length) {
      options.airport = args[i + 1].toUpperCase();
      i++;
    } else if (arg === '--date' && i + 1 < args.length) {
      options.date = args[i + 1];
      i++;
    } else if (arg === '--help' || arg === '-h') {
      console.log(`
Test local processing to debug permission errors

Usage:
  node scripts/test-local-processing.js --airport ICAO --date YYYY-MM-DD

Options:
  --airport ICAO        Airport ICAO code (e.g., KLGA, KLAX)
  --date YYYY-MM-DD     Date to process
  --help, -h            Show this help message

Examples:
  node scripts/test-local-processing.js --airport KLGA --date 2025-11-08
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

  return airport;
}

async function main() {
  const options = parseArgs();

  logger.info('Testing local processing', options);

  try {
    // Load airport configuration
    const airport = loadAirportConfig(options.airport);
    logger.info('Airport configuration loaded', {
      icao: airport.icao,
      name: airport.name,
    });

    // Set temp directory to a local test directory
    const testTempDir = path.join(__dirname, '..', 'temp-test');
    process.env.TEMP_DIR = testTempDir;
    
    // Ensure temp directory exists and is writable
    if (!fs.existsSync(testTempDir)) {
      fs.mkdirSync(testTempDir, { recursive: true });
      logger.info('Created test temp directory', { path: testTempDir });
    }

    // Check permissions
    try {
      const testFile = path.join(testTempDir, '.test-write');
      fs.writeFileSync(testFile, 'test');
      fs.unlinkSync(testFile);
      logger.info('Temp directory is writable', { path: testTempDir });
    } catch (error) {
      logger.error('Temp directory is not writable', {
        path: testTempDir,
        error: error.message,
      });
      throw new Error(`Cannot write to temp directory: ${testTempDir}`);
    }

    // Initialize components with explicit temp directory
    const processor = new AirportDailyProcessor({
      tempDir: testTempDir,
    });
    const dataStore = new DailyFlightData();

    // Process the data
    logger.info('Starting processing (this may take several minutes)', {
      airport: airport.icao,
      date: options.date,
      tempDir: testTempDir,
    });

    const results = await processor.processAirportDay(options.date, airport);

    // Save to abstraction layer (S3 + cache)
    logger.info('Saving processed data', {
      airport: airport.icao,
      date: options.date,
    });
    await dataStore.save(airport.icao, options.date, results);

    logger.info('Processing complete! 🎉');
    logger.info('Results', {
      total: results.statistics.total,
      arrivals: results.statistics.arrivals,
      departures: results.statistics.departures,
    });

  } catch (error) {
    logger.error('Processing failed', {
      error: error.message,
      stack: error.stack,
    });
    process.exit(1);
  }
}

// Run
main().catch(error => {
  logger.error('Fatal error', {
    error: error.message,
    stack: error.stack,
  });
  process.exit(1);
});

