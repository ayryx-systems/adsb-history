#!/usr/bin/env node

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { GetObjectCommand } from '@aws-sdk/client-s3';
import { S3Manager } from '../../src/utils/s3.js';
import logger from '../../src/utils/logger.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const WEATHER_STATIONS = [
  { icao: 'KBOS', name: 'Boston Logan International' },
  { icao: 'KORD', name: 'Chicago O\'Hare International' },
  { icao: 'KEWR', name: 'Newark Liberty International' },
  { icao: 'KLGA', name: 'LaGuardia Airport' },
  { icao: 'KJFK', name: 'John F. Kennedy International' }
];

async function downloadMetarFromS3(s3Manager, icao, year, outputDir) {
  const s3Key = `weather/metar/${icao}/${icao}_${year}.csv`;
  const outputPath = path.join(outputDir, icao, `${icao}_${year}.csv`);
  
  try {
    logger.info('Downloading METAR file from S3', {
      icao,
      year,
      s3Key,
      outputPath
    });
    
    const command = new GetObjectCommand({
      Bucket: s3Manager.bucketName,
      Key: s3Key,
    });
    
    const response = await s3Manager.client.send(command);
    
    const outputDirPath = path.dirname(outputPath);
    if (!fs.existsSync(outputDirPath)) {
      fs.mkdirSync(outputDirPath, { recursive: true });
    }
    
    const writeStream = fs.createWriteStream(outputPath);
    
    await new Promise((resolve, reject) => {
      response.Body.pipe(writeStream);
      writeStream.on('finish', resolve);
      writeStream.on('error', reject);
    });
    
    const stats = fs.statSync(outputPath);
    logger.info('Downloaded METAR file from S3', {
      icao,
      year,
      filename: path.basename(outputPath),
      sizeBytes: stats.size,
      sizeMB: (stats.size / 1024 / 1024).toFixed(2)
    });
    
    return { success: true, path: outputPath, size: stats.size };
  } catch (error) {
    if (error.name === 'NoSuchKey') {
      logger.warn('METAR file not found in S3', {
        icao,
        year,
        s3Key
      });
      return { success: false, error: 'NotFound' };
    }
    
    logger.error('Failed to download METAR file from S3', {
      icao,
      year,
      s3Key,
      error: error.message
    });
    throw error;
  }
}

async function main() {
  const args = process.argv.slice(2);
  let years = null;
  let airports = null;
  let outputDir = null;
  
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--year' && args[i + 1]) {
      years = [parseInt(args[i + 1], 10)];
      i++;
    } else if (args[i] === '--years' && args[i + 1]) {
      years = args[i + 1].split(',').map(y => parseInt(y.trim(), 10));
      i++;
    } else if (args[i] === '--airport' && args[i + 1]) {
      airports = [args[i + 1].trim().toUpperCase()];
      i++;
    } else if (args[i] === '--airports' && args[i + 1]) {
      airports = args[i + 1].split(',').map(a => a.trim().toUpperCase());
      i++;
    } else if (args[i] === '--output-dir' && args[i + 1]) {
      outputDir = args[i + 1];
      i++;
    }
  }
  
  if (!years || years.length === 0 || years.some(y => isNaN(y) || y < 2000 || y > 2100)) {
    console.error('Usage: node scripts/weather/download-metar-from-s3.js --year YYYY [--years YYYY1,YYYY2] [--airport AIRPORT | --airports AIRPORT1,AIRPORT2] [--output-dir <path>]');
    console.error('');
    console.error('Options:');
    console.error('  --year YYYY                  Single year to download (e.g., 2024)');
    console.error('  --years YYYY1,YYYY2          Multiple years (e.g., 2024,2025)');
    console.error('  --airport AIRPORT            Single airport (e.g., KLGA)');
    console.error('  --airports AIRPORT1,AIRPORT2 Multiple airports (default: all)');
    console.error('  --output-dir <path>          Output directory (default: ./cache/metar)');
    console.error('');
    console.error('Example:');
    console.error('  node scripts/weather/download-metar-from-s3.js --year 2024');
    console.error('  node scripts/weather/download-metar-from-s3.js --years 2024,2025 --airport KLGA');
    console.error('  node scripts/weather/download-metar-from-s3.js --year 2024 --airports KBOS,KLGA');
    process.exit(1);
  }
  
  const downloadDir = outputDir || path.join(__dirname, '../../cache/metar');
  const stationsToProcess = airports 
    ? WEATHER_STATIONS.filter(s => airports.includes(s.icao))
    : WEATHER_STATIONS;
  
  if (stationsToProcess.length === 0) {
    console.error('Error: No matching stations found');
    process.exit(1);
  }
  
  logger.info('Starting METAR download from S3', {
    years,
    stations: stationsToProcess.map(s => s.icao),
    outputDir: downloadDir
  });
  
  if (!fs.existsSync(downloadDir)) {
    fs.mkdirSync(downloadDir, { recursive: true });
  }
  
  const s3Manager = new S3Manager();
  let successCount = 0;
  let failCount = 0;
  let notFoundCount = 0;
  
  for (const year of years) {
    for (const station of stationsToProcess) {
      try {
        const result = await downloadMetarFromS3(s3Manager, station.icao, year, downloadDir);
        
        if (result.success) {
          successCount++;
        } else if (result.error === 'NotFound') {
          notFoundCount++;
        } else {
          failCount++;
        }
      } catch (error) {
        logger.error('Failed to process station', {
          station: station.icao,
          year,
          error: error.message
        });
        failCount++;
      }
    }
  }
  
  logger.info('METAR download from S3 complete', {
    years,
    total: stationsToProcess.length * years.length,
    successful: successCount,
    notFound: notFoundCount,
    failed: failCount,
    outputDir: downloadDir
  });
  
  if (failCount > 0) {
    process.exit(1);
  }
}

main().catch(error => {
  logger.error('Fatal error', { error: error.message, stack: error.stack });
  process.exit(1);
});

