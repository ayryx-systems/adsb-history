#!/usr/bin/env node

/**
 * Download ADSB historical data from GitHub releases and upload to S3
 * 
 * Usage:
 *   node scripts/download-week.js --start-date 2025-11-02 --days 7
 */

import GitHubReleaseDownloader from '../src/ingestion/GitHubReleaseDownloader.js';
import S3Uploader from '../src/ingestion/S3Uploader.js';
import logger from '../src/utils/logger.js';

// Parse command line arguments
const args = process.argv.slice(2);
let startDate = null;
let days = null;

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--start-date' && args[i + 1]) {
    startDate = args[i + 1];
    i++;
  } else if (args[i] === '--days' && args[i + 1]) {
    days = parseInt(args[i + 1], 10);
    i++;
  }
}

if (!startDate || !days || isNaN(days) || days < 1) {
  console.error('Usage: node scripts/download-week.js --start-date YYYY-MM-DD --days N');
  console.error('Example: node scripts/download-week.js --start-date 2025-11-02 --days 7');
  process.exit(1);
}

// Determine GitHub repository based on year of start date
const startYear = new Date(startDate).getFullYear();
const repo = `adsblol/globe_history_${startYear}`;

// Generate date range
const dates = GitHubReleaseDownloader.getDateRange(startDate, new Date(new Date(startDate).getTime() + (days - 1) * 24 * 60 * 60 * 1000));

logger.info('Starting download and upload', {
  startDate,
  days,
  dateCount: dates.length,
  dates,
  repo,
});

// Initialize components
// Use /opt for temp directory on EC2 (on EBS volume, not tmpfs)
const tempDir = process.env.TEMP_DIR || '/opt/adsb-downloads';
const downloader = new GitHubReleaseDownloader({ tempDir, repo });
const uploader = new S3Uploader();

let successCount = 0;
let failCount = 0;

// Process each date
for (const date of dates) {
  try {
    logger.info('Processing date', { date });
    
    // Check if already uploaded
    const alreadyUploaded = await uploader.isDateUploaded(date);
    if (alreadyUploaded) {
      logger.info('Date already uploaded, skipping', { date });
      successCount++;
      continue;
    }
    
    // Download from GitHub
    logger.info('Downloading from GitHub', { date });
    const tarPath = await downloader.downloadDate(date);
    
    // Upload to S3
    logger.info('Uploading to S3', { date, tarPath });
    const uploadResult = await uploader.uploadTarFile(tarPath, date);
    
    if (uploadResult.success) {
      logger.info('Successfully processed date', { date, skipped: uploadResult.skipped });
      successCount++;
      
      // Clean up local tar file to save disk space
      try {
        const fs = await import('fs');
        fs.unlinkSync(tarPath);
        logger.debug('Cleaned up local tar file', { tarPath });
      } catch (cleanupError) {
        logger.warn('Failed to clean up local tar file', { tarPath, error: cleanupError.message });
      }
    } else {
      throw new Error('Upload failed');
    }
  } catch (error) {
    logger.error('Failed to process date', {
      date,
      error: error.message,
      stack: error.stack,
    });
    failCount++;
  }
}

// Summary
logger.info('Download and upload complete', {
  total: dates.length,
  successful: successCount,
  failed: failCount,
});

if (failCount > 0) {
  logger.error('Some dates failed to process', { failCount });
  process.exit(1);
}

logger.info('All dates processed successfully');
process.exit(0);
