#!/usr/bin/env node

/**
 * Get raw ADSB trace data for a specific aircraft (ICAO code) on a specific day
 * 
 * Usage:
 *   node scripts/get-aircraft-trace.js --icao <ICAO_CODE> --date <YYYY-MM-DD>
 * 
 * Example:
 *   node scripts/get-aircraft-trace.js --icao a1b2c3 --date 2025-01-06
 * 
 * The script will:
 * 1. Download the tar file from S3 (if not already in temp/)
 * 2. Extract the tar file (if not already extracted)
 * 3. Find and read the trace file for the specified ICAO code
 * 4. Output the raw trace data as JSON
 * 
 * Files are cached in ./temp/YYYY-MM-DD/ to avoid re-downloading.
 */

import TraceReader from '../src/processing/TraceReader.js';
import logger from '../src/utils/logger.js';
import path from 'path';
import fs from 'fs';

// Parse command line arguments
const args = process.argv.slice(2);
let icao = null;
let date = null;
let outputFile = null;

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--icao' && args[i + 1]) {
    icao = args[i + 1].toLowerCase();
    i++;
  } else if (args[i] === '--date' && args[i + 1]) {
    date = args[i + 1];
    i++;
  } else if (args[i] === '--output' && args[i + 1]) {
    outputFile = args[i + 1];
    i++;
  }
}

if (!icao || !date) {
  console.error('Usage: node scripts/get-aircraft-trace.js --icao <ICAO_CODE> --date <YYYY-MM-DD> [--output <FILE>]');
  console.error('Example: node scripts/get-aircraft-trace.js --icao a1b2c3 --date 2025-01-06');
  console.error('         node scripts/get-aircraft-trace.js --icao a1b2c3 --date 2025-01-06 --output trace.json');
  process.exit(1);
}

// Validate date format
const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
if (!dateRegex.test(date)) {
  console.error('Error: Date must be in YYYY-MM-DD format');
  process.exit(1);
}

// Validate ICAO format (6 hex characters)
const icaoRegex = /^[0-9a-f]{6}$/i;
if (!icaoRegex.test(icao)) {
  console.error('Error: ICAO code must be 6 hexadecimal characters');
  process.exit(1);
}

async function getAircraftTrace() {
  try {
    logger.info('Getting aircraft trace', { icao, date });

    // Initialize TraceReader (handles temp directory, S3, etc.)
    const traceReader = new TraceReader();

    // Step 1: Download tar from S3 (cached if already exists)
    logger.info('Step 1: Downloading/checking tar file', { date });
    const tarPath = await traceReader.downloadTarFromS3(date);

    // Step 2: Extract tar (cached if already extracted)
    logger.info('Step 2: Extracting/checking extracted tar', { date });
    const extractDir = await traceReader.extractTar(tarPath);

    // Step 3: Find the trace file for this ICAO
    // Traces are organized by last 2 hex digits: traces/d0/trace_full_<icao>.json
    const hexSubdir = icao.slice(-2);
    const tracesDir = path.join(extractDir, 'traces');
    const subdirPath = path.join(tracesDir, hexSubdir);
    const traceFilePath = path.join(subdirPath, `trace_full_${icao}.json`);

    if (!fs.existsSync(traceFilePath)) {
      logger.error('Trace file not found', {
        icao,
        date,
        expectedPath: traceFilePath,
      });
      console.error(`Error: No trace data found for ICAO ${icao} on ${date}`);
      console.error(`Expected file: ${traceFilePath}`);
      process.exit(1);
    }

    // Step 4: Read the trace file
    logger.info('Step 4: Reading trace file', { icao, date, traceFilePath });
    const traceData = await traceReader.readTraceFile(traceFilePath);

    if (!traceData) {
      logger.error('Failed to read trace file', { icao, date, traceFilePath });
      console.error(`Error: Failed to read trace file for ICAO ${icao}`);
      process.exit(1);
    }

    // Step 5: Output the trace data
    const output = {
      icao: traceData.icao,
      date,
      registration: traceData.registration,
      aircraftType: traceData.aircraftType,
      description: traceData.description,
      trace: traceData.trace,
      traceCount: traceData.trace ? traceData.trace.length : 0,
    };

    if (outputFile) {
      // Write to file
      const outputPath = path.isAbsolute(outputFile) 
        ? outputFile 
        : path.resolve(process.cwd(), outputFile);
      
      const outputDir = path.dirname(outputPath);
      if (!fs.existsSync(outputDir)) {
        fs.mkdirSync(outputDir, { recursive: true });
      }

      fs.writeFileSync(outputPath, JSON.stringify(output, null, 2));
      logger.info('Trace data written to file', { 
        icao, 
        date, 
        outputPath,
        traceCount: output.traceCount,
      });
      console.log(`Trace data written to: ${outputPath}`);
      console.log(`Found ${output.traceCount} position reports for ICAO ${icao} on ${date}`);
    } else {
      // Write to stdout
      console.log(JSON.stringify(output, null, 2));
    }

    logger.info('Successfully retrieved aircraft trace', {
      icao,
      date,
      traceCount: output.traceCount,
    });

  } catch (error) {
    logger.error('Failed to get aircraft trace', {
      icao,
      date,
      error: error.message,
      stack: error.stack,
    });
    console.error(`Error: ${error.message}`);
    process.exit(1);
  }
}

// Run the script
getAircraftTrace();

