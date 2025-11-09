#!/usr/bin/env node

/**
 * Download one week of recent ADSB data from adsblol GitHub releases
 * 
 * Usage:
 *   node scripts/download-week.js [--start-date YYYY-MM-DD] [--days 7]
 *   node scripts/download-week.js --start-date 2025-11-02 --days 7
 *   node scripts/download-week.js  # defaults to 7 days ending on latest available (2025-11-08)
 */

import dotenv from 'dotenv';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import GitHubReleaseDownloader from '../src/ingestion/GitHubReleaseDownloader.js';
import DataExtractor from '../src/ingestion/DataExtractor.js';
import S3Uploader from '../src/ingestion/S3Uploader.js';
import logger from '../src/utils/logger.js';

// Load environment variables
dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Parse command line arguments
function parseArgs() {
  const args = process.argv.slice(2);
  const options = {
    startDate: null,
    days: 7,
    skipExtraction: false,
    skipS3Upload: false,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    
    if (arg === '--start-date' && i + 1 < args.length) {
      options.startDate = args[i + 1];
      i++;
    } else if (arg === '--days' && i + 1 < args.length) {
      options.days = parseInt(args[i + 1]);
      i++;
    } else if (arg === '--skip-extraction') {
      options.skipExtraction = true;
    } else if (arg === '--skip-s3-upload') {
      options.skipS3Upload = true;
    } else if (arg === '--help' || arg === '-h') {
      console.log(`
Download recent ADSB historical data

Usage:
  node scripts/download-week.js [options]

Options:
  --start-date YYYY-MM-DD   Start date for download (default: 7 days before latest)
  --days N                  Number of days to download (default: 7)
  --skip-extraction         Skip tar extraction (only download)
  --skip-s3-upload         Skip S3 upload (only download and extract)
  --help, -h               Show this help message

Examples:
  # Download most recent 7 days
  node scripts/download-week.js

  # Download specific week
  node scripts/download-week.js --start-date 2025-11-02 --days 7

  # Download and extract only (no S3 upload)
  node scripts/download-week.js --skip-s3-upload
      `);
      process.exit(0);
    }
  }

  return options;
}

async function main() {
  const options = parseArgs();

  logger.info('Starting ADSB data download', options);

  // Initialize components
  const downloader = new GitHubReleaseDownloader();
  const extractor = new DataExtractor();
  const uploader = new S3Uploader();

  // Determine date range
  let endDate = '2025-11-08'; // Latest available based on user info
  let startDate = options.startDate;

  if (!startDate) {
    const end = new Date(endDate);
    const start = new Date(end);
    start.setDate(start.getDate() - (options.days - 1));
    startDate = start.toISOString().split('T')[0];
  }

  const dates = GitHubReleaseDownloader.getDateRange(startDate, 
    new Date(new Date(startDate).getTime() + (options.days - 1) * 24 * 60 * 60 * 1000).toISOString().split('T')[0]
  );

  logger.info('Date range determined', {
    startDate,
    endDate: dates[dates.length - 1],
    totalDays: dates.length,
    dates,
  });

  // Validate AWS credentials if S3 upload is enabled
  if (!options.skipS3Upload) {
    if (!process.env.AWS_ACCESS_KEY_ID || !process.env.AWS_SECRET_ACCESS_KEY) {
      logger.error('AWS credentials not configured. Please set AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY in .env file');
      process.exit(1);
    }
  }

  // Process each date
  const results = {
    successful: [],
    failed: [],
  };

  for (const date of dates) {
    logger.info('='.repeat(60));
    logger.info(`Processing date: ${date}`);
    logger.info('='.repeat(60));

    try {
      // Step 1: Download
      logger.info('Step 1: Downloading tar files', { date });
      const tarPath = await downloader.downloadDate(date);
      
      if (!tarPath) {
        throw new Error('Download failed');
      }

      // Step 2: Upload tar to S3 (raw storage)
      if (!options.skipS3Upload) {
        logger.info('Step 2: Uploading tar file to S3', { date });
        await uploader.uploadTarFile(tarPath, date);
      }

      // Step 3: Extract tar
      let extractedInfo = null;
      if (!options.skipExtraction) {
        logger.info('Step 3: Extracting tar file', { date });
        const extractDir = await extractor.extractTar(tarPath);
        extractedInfo = await extractor.analyzeExtractedData(extractDir);
        
        logger.info('Extraction complete', {
          chunkDirs: extractedInfo.chunkDirs.length,
          aircraftFile: !!extractedInfo.aircraftFile,
        });

        // Optional: Upload extracted data to S3 (currently disabled to save space)
        // if (!options.skipS3Upload) {
        //   logger.info('Step 4: Uploading extracted data to S3', { date });
        //   await uploader.uploadExtractedData(extractDir, date, { uploadChunks: false });
        // }

        // Clean up extracted directory (we'll re-extract from S3 tar files during processing)
        extractor.cleanup(extractDir);
      }

      // Clean up downloaded tar file
      if (fs.existsSync(tarPath)) {
        fs.unlinkSync(tarPath);
        logger.info('Cleaned up local tar file', { path: tarPath });
      }

      results.successful.push(date);
      logger.info('Successfully processed date', { date });

    } catch (error) {
      logger.error('Failed to process date', {
        date,
        error: error.message,
        stack: error.stack,
      });
      results.failed.push({ date, error: error.message });
    }
  }

  // Summary
  logger.info('='.repeat(60));
  logger.info('DOWNLOAD SUMMARY');
  logger.info('='.repeat(60));
  logger.info('Results', {
    totalDates: dates.length,
    successful: results.successful.length,
    failed: results.failed.length,
    successfulDates: results.successful,
    failedDates: results.failed.map(f => f.date),
  });

  if (results.failed.length > 0) {
    logger.error('Some downloads failed', {
      failures: results.failed,
    });
    process.exit(1);
  }

  logger.info('All downloads completed successfully! 🎉');
}

// Run
main().catch(error => {
  logger.error('Fatal error', {
    error: error.message,
    stack: error.stack,
  });
  process.exit(1);
});

