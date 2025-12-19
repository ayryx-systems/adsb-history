#!/usr/bin/env node

/**
 * Upload baseline.json file to S3
 * 
 * Usage:
 *   node scripts/upload-baseline-to-s3.js --airport KLGA
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

function parseArgs() {
  const args = process.argv.slice(2);
  const options = {
    airport: null,
    customPath: null,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    
    if (arg === '--airport' && i + 1 < args.length) {
      options.airport = args[i + 1].toUpperCase();
      i++;
    } else if (arg === '--path' && i + 1 < args.length) {
      options.customPath = args[i + 1];
      i++;
    }
  }

  return options;
}

async function uploadBaseline(airport, customPath = null) {
  const s3Manager = new S3Manager();
  
  let localPath;
  if (customPath) {
    localPath = path.isAbsolute(customPath) 
      ? customPath 
      : path.join(__dirname, '..', customPath);
  } else {
    localPath = path.join(__dirname, '..', 'cache', airport, 'overall', 'baseline.json');
  }

  if (!fs.existsSync(localPath)) {
    throw new Error(`Baseline file not found: ${localPath}`);
  }

  const s3Key = `baseline/${airport}/overall/baseline.json`;

  logger.info('Uploading baseline to S3', {
    airport,
    localPath,
    s3Key,
  });

  try {
    await s3Manager.uploadFile(localPath, s3Key, {
      contentType: 'application/json',
    });

    console.log(`\n${'='.repeat(60)}`);
    console.log(`Successfully uploaded baseline for ${airport}`);
    console.log(`Local: ${localPath}`);
    console.log(`S3: s3://${s3Manager.bucketName}/${s3Key}`);
    console.log('='.repeat(60) + '\n');

    logger.info('Baseline uploaded successfully', {
      airport,
      s3Key,
    });
  } catch (error) {
    logger.error('Failed to upload baseline', {
      airport,
      s3Key,
      error: error.message,
    });
    throw error;
  }
}

async function main() {
  const options = parseArgs();

  if (!options.airport) {
    console.error('Error: --airport is required');
    console.error('Usage: node scripts/upload-baseline-to-s3.js --airport KLGA [--path custom/path/to/baseline.json]');
    process.exit(1);
  }

  try {
    await uploadBaseline(options.airport, options.customPath);
  } catch (error) {
    console.error('Error:', error.message);
    process.exit(1);
  }
}

main();
