#!/usr/bin/env node

/**
 * Run complete analysis pipeline for date range
 * 
 * Runs the analysis pipeline (Phase 3a, 3b, 3c, 3d, and 3e) for each day in the specified date range:
 * 1. Phase 3a: Analyze flights (analyze-airport-day.js) - creates flight summaries
 * 2. Phase 3b: Generate L1 statistics (generate-l1-stats.js)
 * 3. Phase 3c: Generate congestion statistics (generate-congestion-stats.js)
 * 4. Phase 3d: Generate L2 statistics (generate-l2-stats.js) - time-of-day volumes
 * 5. Phase 3e: Generate yearly baseline (generate-yearly-baseline.js) - aggregates all days for the year
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
Run analysis pipeline (Phase 3a, 3b, 3c, 3d, and 3e) for date range

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

async function checkExtractedTraces(airport, dates) {
  const extractedTraceData = new ExtractedTraceData();
  const missing = [];

  for (const date of dates) {
    const exists = await extractedTraceData.exists(airport, date);
    if (!exists) {
      missing.push(date);
    }
  }

  if (missing.length > 0) {
    const errorMsg = `Extracted traces not found for ${airport} on ${missing.length} dates. ` +
      `Please run extraction first: node scripts/extraction/extract-all-airports.js --start-date ${missing[0]} --end-date ${missing[missing.length - 1]} --airports ${airport}`;
    logger.error('Extracted traces not found', { airport, missing });
    throw new Error(errorMsg);
  }
}

async function batchProcessPhase(airport, dates, phaseName, scriptName, force) {
  logger.info(`Starting batch ${phaseName}`, { airport, dates: dates.length });
  const script = path.join(__dirname, scriptName);
  const results = { successful: 0, failed: 0, errors: [] };

  for (let i = 0; i < dates.length; i++) {
    const date = dates[i];
    const dayNum = i + 1;

    try {
      const args = ['--airport', airport, '--date', date];
      if (force) {
        args.push('--force');
      }

      await runCommand('node', [script, ...args]);
      results.successful++;
      logger.info(`${phaseName} complete for ${date}`, { dayNum, total: dates.length });
    } catch (error) {
      results.failed++;
      results.errors.push({ date, error: error.message });
      logger.error(`${phaseName} failed for ${date}`, { error: error.message });
    }

    if (i < dates.length - 1) {
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }

  return results;
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

  console.log(`\n${'='.repeat(60)}`);
  console.log(`Processing ${dates.length} days for ${options.airport}`);
  console.log(`Date range: ${options.startDate} to ${options.endDate}`);
  console.log('='.repeat(60) + '\n');

  // Check extracted traces exist for all dates
  await checkExtractedTraces(options.airport, dates);

  // Phase 3a: Analyze flights (batch process all days)
  console.log(`\n${'='.repeat(60)}`);
  console.log('Phase 3a: Analyzing flights (batch)');
  console.log('='.repeat(60));
  const phase3aResults = await batchProcessPhase(
    options.airport,
    dates,
    'Phase 3a: Analyze flights',
    'analyze-airport-day.js',
    options.force
  );

  if (phase3aResults.failed > 0) {
    console.log(`\nPhase 3a completed with ${phase3aResults.failed} failures`);
    console.log('Errors:');
    for (const { date, error } of phase3aResults.errors) {
      console.log(`  ${date}: ${error}`);
    }
  }

  // Phase 3b: Generate L1 statistics (batch process all days)
  console.log(`\n${'='.repeat(60)}`);
  console.log('Phase 3b: Generating L1 statistics (batch)');
  console.log('='.repeat(60));
  const phase3bResults = await batchProcessPhase(
    options.airport,
    dates,
    'Phase 3b: Generate L1 stats',
    'generate-l1-stats.js',
    options.force
  );

  if (phase3bResults.failed > 0) {
    console.log(`\nPhase 3b completed with ${phase3bResults.failed} failures`);
  }

  // Phase 3c: Generate congestion statistics (batch process all days)
  console.log(`\n${'='.repeat(60)}`);
  console.log('Phase 3c: Generating congestion statistics (batch)');
  console.log('='.repeat(60));
  const phase3cResults = await batchProcessPhase(
    options.airport,
    dates,
    'Phase 3c: Generate congestion stats',
    'generate-congestion-stats.js',
    options.force
  );

  if (phase3cResults.failed > 0) {
    console.log(`\nPhase 3c completed with ${phase3cResults.failed} failures`);
  }

  // Phase 3d: Generate L2 statistics (batch process all days - uses local dates)
  console.log(`\n${'='.repeat(60)}`);
  console.log('Phase 3d: Generating L2 statistics (batch, local time)');
  console.log('='.repeat(60));
  const phase3dResults = await batchProcessPhase(
    options.airport,
    dates,
    'Phase 3d: Generate L2 stats',
    'generate-l2-stats.js',
    options.force
  );

  if (phase3dResults.failed > 0) {
    console.log(`\nPhase 3d completed with ${phase3dResults.failed} failures`);
  }

  const results = {
    total: dates.length,
    successful: phase3aResults.successful + phase3bResults.successful + phase3cResults.successful + phase3dResults.successful,
    failed: phase3aResults.failed + phase3bResults.failed + phase3cResults.failed + phase3dResults.failed,
    skipped: 0,
    errors: [...phase3aResults.errors, ...phase3bResults.errors, ...phase3cResults.errors, ...phase3dResults.errors],
  };

  // Step 5: Generate yearly baseline (Phase 3e) - run once after all days are processed
  if (results.successful > 0) {
    const [year] = options.startDate.split('-');
    logger.info('Step 5: Generating yearly baseline', {
      airport: options.airport,
      year,
    });
    
    try {
      const baselineScript = path.join(__dirname, 'generate-yearly-baseline.js');
      const baselineArgs = ['--airport', options.airport, '--year', year];
      if (options.force) {
        baselineArgs.push('--force');
      }

      await runCommand('node', [baselineScript, ...baselineArgs]);
      logger.info('Yearly baseline generation complete', {
        airport: options.airport,
        year,
      });
    } catch (error) {
      logger.warn('Yearly baseline generation failed (non-fatal)', {
        airport: options.airport,
        year,
        error: error.message,
      });
      // Don't fail the entire pipeline if baseline generation fails
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

