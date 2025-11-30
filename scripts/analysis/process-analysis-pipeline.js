#!/usr/bin/env node

/**
 * Run complete analysis pipeline for date range
 * 
 * Runs the analysis pipeline (Phase 3a, 3b, and 3c) for each day in the specified date range:
 * 1. Phase 3a: Analyze flights (analyze-airport-day.js) - creates flight summaries
 * 2. Phase 3b: Generate L1 statistics (generate-l1-stats.js)
 * 3. Phase 3c: Generate congestion statistics (generate-congestion-stats.js)
 * 
 * **Important**: Extracted traces must already exist (run extract-all-airports.js first).
 * This script will fail if extracted traces are not found - it does NOT download raw tar files.
 * 
 * Usage:
 *   node scripts/analysis/process-analysis-pipeline.js --airport KORD
 *   node scripts/analysis/process-analysis-pipeline.js --airport KORD --start-date 2025-01-15
 *   node scripts/analysis/process-analysis-pipeline.js --airport KORD --start-date 2025-01-15 --end-date 2025-01-20
 */

import { spawn } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';
import logger from '../../src/utils/logger.js';
import ExtractedTraceData from '../../src/extraction/ExtractedTraceData.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function parseArgs() {
  const args = process.argv.slice(2);
  const options = {
    airport: null,
    startDate: '2025-01-01',
    endDate: '2025-01-31',
    force: false,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    
    if (arg === '--airport' && i + 1 < args.length) {
      options.airport = args[i + 1].toUpperCase();
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
Run analysis pipeline (Phase 3a and 3b) for date range

**Prerequisites**: Extracted traces must exist (run extract-all-airports.js first).
This script will fail if extracted traces are not found - it does NOT download raw tar files.

Usage:
  node scripts/analysis/process-analysis-pipeline.js --airport ICAO [options]

Options:
  --airport ICAO        Airport ICAO code (e.g., KORD, KLGA, KJFK)
  --start-date DATE     Start date (default: 2025-01-01)
  --end-date DATE       End date (default: 2025-01-31)
  --force               Reprocess even if data exists
  --help, -h            Show this help message

Examples:
  # Process date range for KORD (defaults to January 2025)
  node scripts/analysis/process-analysis-pipeline.js --airport KORD

  # Process specific date range
  node scripts/analysis/process-analysis-pipeline.js --airport KORD --start-date 2025-01-15 --end-date 2025-01-20
      `);
      process.exit(0);
    }
  }

  if (!options.airport) {
    console.error('Error: --airport is required');
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

function runCommand(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: 'inherit',
      shell: false,
      ...options,
    });

    child.on('close', (code) => {
      if (code === 0) {
        resolve(code);
      } else {
        reject(new Error(`Command failed with exit code ${code}`));
      }
    });

    child.on('error', (error) => {
      reject(error);
    });
  });
}

async function processDay(airport, date, force) {
  logger.info('Processing day', { airport, date });

  const extractedTraceData = new ExtractedTraceData();
  const analyzeScript = path.join(__dirname, 'analyze-airport-day.js');
  const statsScript = path.join(__dirname, 'generate-l1-stats.js');

  try {
    // Check if extracted traces exist (required before analysis)
    logger.info('Checking for extracted traces', { airport, date });
    const extractedExists = await extractedTraceData.exists(airport, date);
    
    if (!extractedExists) {
      const errorMsg = `Extracted traces not found for ${airport} on ${date}. ` +
        `Please run extraction first: node scripts/extraction/extract-all-airports.js --start-date ${date} --end-date ${date} --airports ${airport}`;
      logger.error('Extracted traces not found', { airport, date });
      return { success: false, date, error: errorMsg };
    }

    logger.info('Extracted traces found, proceeding with analysis', { airport, date });

    // Step 1: Analyze flights (Phase 3a - creates flight summaries)
    // Uses extracted traces (no raw tar download needed)
    logger.info('Step 1: Analyzing flights', { airport, date });
    const analyzeArgs = ['--airport', airport, '--date', date];
    if (force) {
      analyzeArgs.push('--force');
    }

    await runCommand('node', [analyzeScript, ...analyzeArgs]);
    logger.info('Flight analysis complete', { airport, date });

    // Step 2: Generate L1 statistics (Phase 3b)
    logger.info('Step 2: Generating L1 statistics', { airport, date });
    const statsArgs = ['--airport', airport, '--date', date];
    if (force) {
      statsArgs.push('--force');
    }

    await runCommand('node', [statsScript, ...statsArgs]);
    logger.info('L1 stats generation complete', { airport, date });

    // Step 3: Generate congestion statistics (Phase 3c)
    logger.info('Step 3: Generating congestion statistics', { airport, date });
    const congestionScript = path.join(__dirname, 'generate-congestion-stats.js');
    const congestionArgs = ['--airport', airport, '--date', date];
    if (force) {
      congestionArgs.push('--force');
    }

    await runCommand('node', [congestionScript, ...congestionArgs]);
    logger.info('Congestion stats generation complete', { airport, date });

    return { success: true, date };
  } catch (error) {
    logger.error('Failed to process day', {
      airport,
      date,
      error: error.message,
    });
    return { success: false, date, error: error.message };
  }
}

async function main() {
  const options = parseArgs();

  logger.info('Starting analysis pipeline processing', {
    airport: options.airport,
    startDate: options.startDate,
    endDate: options.endDate,
    force: options.force,
  });

  logger.info('Note: This script requires extracted traces to exist. It will not download raw tar files.');

  const dates = generateDateRange(options.startDate, options.endDate);
  logger.info('Date range generated', { nDates: dates.length, dates });

  const results = {
    total: dates.length,
    successful: 0,
    failed: 0,
    skipped: 0,
    errors: [],
  };

  console.log(`\n${'='.repeat(60)}`);
  console.log(`Processing ${dates.length} days for ${options.airport}`);
  console.log(`Date range: ${options.startDate} to ${options.endDate}`);
  console.log('='.repeat(60) + '\n');

  for (let i = 0; i < dates.length; i++) {
    const date = dates[i];
    const dayNum = i + 1;

    console.log(`\n[${dayNum}/${dates.length}] Processing ${date}...`);
    console.log('─'.repeat(60));

    const result = await processDay(options.airport, date, options.force);

    if (result.success) {
      results.successful++;
      console.log(`✓ ${date} completed successfully`);
    } else {
      results.failed++;
      results.errors.push({ date, error: result.error });
      console.log(`✗ ${date} failed: ${result.error}`);
    }

    // Add a small delay between days to avoid overwhelming the system
    if (i < dates.length - 1) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }

  // Summary
  console.log(`\n${'='.repeat(60)}`);
  console.log('Processing Summary');
  console.log('='.repeat(60));
  console.log(`Total days: ${results.total}`);
  console.log(`Successful: ${results.successful}`);
  console.log(`Failed: ${results.failed}`);
  console.log(`Skipped: ${results.skipped}`);

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

main().catch((error) => {
  logger.error('Fatal error', {
    error: error.message,
    stack: error.stack,
  });
  process.exit(1);
});

