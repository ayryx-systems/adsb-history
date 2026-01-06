#!/usr/bin/env node

/**
 * Upload baseline and arrival prediction files to S3
 * 
 * Usage:
 *   # Upload baseline.json only
 *   node scripts/upload-baseline-to-s3.js --airport KLGA
 *   
 *   # Upload all arrival prediction files (baseline, arrival-stats-index, example-days-index, day-situation-index)
 *   node scripts/upload-baseline-to-s3.js --airport KLGA --all
 *   
 *   # Upload specific file
 *   node scripts/upload-baseline-to-s3.js --airport KLGA --file arrival-stats-index.json
 *   node scripts/upload-baseline-to-s3.js --airport KLGA --path cache/KLGA/overall/baseline.json
 */

import dotenv from 'dotenv';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { S3Manager } from '../src/utils/s3.js';
import logger from '../src/utils/logger.js';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const ARRIVAL_PREDICTION_FILES = [
  'baseline.json',
  'arrival-stats-index.json',
  'example-days-index.json',
  'day-situation-index.json',
];

function parseArgs() {
  const args = process.argv.slice(2);
  const options = {
    airport: null,
    customPath: null,
    file: null,
    all: false,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    
    if (arg === '--airport' && i + 1 < args.length) {
      options.airport = args[i + 1].toUpperCase();
      i++;
    } else if (arg === '--path' && i + 1 < args.length) {
      options.customPath = args[i + 1];
      i++;
    } else if (arg === '--file' && i + 1 < args.length) {
      options.file = args[i + 1];
      i++;
    } else if (arg === '--all') {
      options.all = true;
    }
  }

  return options;
}

function getAirportCodeForS3(airport) {
  return airport.replace(/^K/, '');
}

async function uploadFile(airport, filename, customPath = null) {
  const s3Manager = new S3Manager();
  const airportCode = getAirportCodeForS3(airport);
  
  let localPath;
  if (customPath) {
    localPath = path.isAbsolute(customPath) 
      ? customPath 
      : path.join(__dirname, '..', customPath);
  } else {
    localPath = path.join(__dirname, '..', 'cache', airport, 'overall', filename);
  }

  if (!fs.existsSync(localPath)) {
    throw new Error(`File not found: ${localPath}`);
  }

  const s3Key = `baseline/${airportCode}/overall/${filename}`;

  logger.info('Uploading file to S3', {
    airport,
    filename,
    localPath,
    s3Key,
  });

  try {
    await s3Manager.uploadFile(localPath, s3Key, {
      contentType: 'application/json',
    });

    console.log(`✅ Uploaded ${filename}`);
    console.log(`   Local: ${localPath}`);
    console.log(`   S3: s3://${s3Manager.bucketName}/${s3Key}\n`);

    logger.info('File uploaded successfully', {
      airport,
      filename,
      s3Key,
    });
  } catch (error) {
    logger.error('Failed to upload file', {
      airport,
      filename,
      s3Key,
      error: error.message,
    });
    throw error;
  }
}

async function uploadBaseline(airport, customPath = null) {
  await uploadFile(airport, 'baseline.json', customPath);
}

async function uploadAll(airport) {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`Uploading all arrival prediction files for ${airport}`);
  console.log('='.repeat(60) + '\n');

  const airportCode = getAirportCodeForS3(airport);
  const overallDir = path.join(__dirname, '..', 'cache', airport, 'overall');
  
  let uploaded = 0;
  let skipped = 0;

  for (const filename of ARRIVAL_PREDICTION_FILES) {
    const localPath = path.join(overallDir, filename);
    
    if (!fs.existsSync(localPath)) {
      console.log(`⚠️  Skipping ${filename} (file not found)`);
      skipped++;
      continue;
    }

    try {
      await uploadFile(airport, filename);
      uploaded++;
    } catch (error) {
      console.error(`❌ Failed to upload ${filename}: ${error.message}`);
      skipped++;
    }
  }

  console.log(`\n${'='.repeat(60)}`);
  console.log(`Upload complete: ${uploaded} uploaded, ${skipped} skipped`);
  console.log('='.repeat(60) + '\n');
}

async function main() {
  const options = parseArgs();

  if (!options.airport) {
    console.error('Error: --airport is required');
    console.error('\nUsage:');
    console.error('  # Upload baseline.json only');
    console.error('  node scripts/upload-baseline-to-s3.js --airport KLGA');
    console.error('\n  # Upload all arrival prediction files');
    console.error('  node scripts/upload-baseline-to-s3.js --airport KLGA --all');
    console.error('\n  # Upload specific file');
    console.error('  node scripts/upload-baseline-to-s3.js --airport KLGA --file arrival-stats-index.json');
    console.error('\n  # Upload with custom path');
    console.error('  node scripts/upload-baseline-to-s3.js --airport KLGA --path cache/KLGA/overall/baseline.json');
    process.exit(1);
  }

  try {
    if (options.all) {
      await uploadAll(options.airport);
    } else if (options.file) {
      await uploadFile(options.airport, options.file, options.customPath);
    } else {
      await uploadBaseline(options.airport, options.customPath);
    }
  } catch (error) {
    console.error('Error:', error.message);
    process.exit(1);
  }
}

main();
