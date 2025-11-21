#!/usr/bin/env node

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import axios from 'axios';
import { S3Manager } from '../../src/utils/s3.js';
import logger from '../../src/utils/logger.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const MESONET_API_BASE = 'https://mesonet.agron.iastate.edu/cgi-bin/request/asos.py';
const RATE_LIMIT_DELAY_MS = 2000;
const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 5000;

const WEATHER_STATIONS = [
  { icao: 'KBOS', name: 'Boston Logan International', mesonet_network: 'MA_ASOS', mesonet_station: 'BOS' },
  { icao: 'KORD', name: 'Chicago O\'Hare International', mesonet_network: 'IL_ASOS', mesonet_station: 'ORD' },
  { icao: 'KEWR', name: 'Newark Liberty International', mesonet_network: 'NY_ASOS', mesonet_station: 'EWR' },
  { icao: 'KLGA', name: 'LaGuardia Airport', mesonet_network: 'NY_ASOS', mesonet_station: 'LGA' },
  { icao: 'KJFK', name: 'John F. Kennedy International', mesonet_network: 'NY_ASOS', mesonet_station: 'JFK' }
];

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function getYearDateRange(year) {
  const now = new Date();
  const currentYear = now.getUTCFullYear();
  const currentMonth = now.getUTCMonth() + 1;
  const currentDay = now.getUTCDate();
  
  const startDate = new Date(Date.UTC(year, 0, 1, 0, 0, 0));
  
  let endDate;
  if (year === currentYear) {
    endDate = new Date(Date.UTC(year, currentMonth - 1, currentDay, 23, 59, 59));
  } else {
    endDate = new Date(Date.UTC(year, 11, 31, 23, 59, 59));
  }
  
  return { startDate, endDate };
}

async function downloadMetarData(station, year, outputDir) {
  const { startDate, endDate } = getYearDateRange(year);
  
  const start = {
    year: startDate.getUTCFullYear(),
    month: startDate.getUTCMonth() + 1,
    day: startDate.getUTCDate()
  };
  
  const end = {
    year: endDate.getUTCFullYear(),
    month: endDate.getUTCMonth() + 1,
    day: endDate.getUTCDate()
  };
  
  const params = new URLSearchParams({
    network: station.mesonet_network,
    station: station.mesonet_station,
    data: 'all',
    year1: start.year.toString(),
    month1: start.month.toString(),
    day1: start.day.toString(),
    year2: end.year.toString(),
    month2: end.month.toString(),
    day2: end.day.toString(),
    tz: 'Etc/UTC',
    format: 'onlycomma',
    latlon: 'no',
    elev: 'no',
    missing: 'M',
    trace: 'T',
    direct: 'no'
  });
  params.append('report_type', '3');
  params.append('report_type', '4');
  
  const url = `${MESONET_API_BASE}?${params.toString()}`;
  const filename = `${station.icao}_${year}.csv`;
  const outputPath = path.join(outputDir, filename);
  
  logger.info('Downloading METAR data', {
    station: station.icao,
    year,
    network: station.mesonet_network,
    mesonet_station: station.mesonet_station,
    startDate: `${start.year}-${String(start.month).padStart(2, '0')}-${String(start.day).padStart(2, '0')}`,
    endDate: `${end.year}-${String(end.month).padStart(2, '0')}-${String(end.day).padStart(2, '0')}`,
    outputFile: filename
  });
  
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const response = await axios.get(url, {
        responseType: 'stream',
        timeout: 120000,
        headers: {
          'User-Agent': 'AYRYX-ADSB-History/1.0 (https://github.com/ayryx)'
        }
      });
      
      const writer = fs.createWriteStream(outputPath);
      response.data.pipe(writer);
      
      await new Promise((resolve, reject) => {
        writer.on('finish', resolve);
        writer.on('error', reject);
        response.data.on('error', reject);
      });
      
      const stats = fs.statSync(outputPath);
      logger.info('Downloaded METAR data', {
        station: station.icao,
        year,
        filename,
        sizeBytes: stats.size,
        sizeMB: (stats.size / 1024 / 1024).toFixed(2)
      });
      
      return { success: true, path: outputPath, size: stats.size, filename };
    } catch (error) {
      logger.warn(`Download attempt ${attempt} failed`, {
        station: station.icao,
        year,
        error: error.message,
        status: error.response?.status
      });
      
      if (attempt < MAX_RETRIES) {
        await sleep(RETRY_DELAY_MS * attempt);
      } else {
        logger.error('Failed to download METAR data after retries', {
          station: station.icao,
          year,
          error: error.message
        });
        throw error;
      }
    }
  }
}

async function uploadFileToS3(s3Manager, localPath, icao, filename) {
  const s3Key = `weather/metar/${icao}/${filename}`;
  
  try {
    logger.info('Uploading METAR file to S3', {
      filename,
      s3Key
    });
    
    const result = await s3Manager.uploadFile(localPath, s3Key, {
      contentType: 'text/csv'
    });
    
    return { ...result, skipped: false };
  } catch (error) {
    logger.error('Failed to upload METAR file', {
      filename,
      s3Key,
      error: error.message
    });
    throw error;
  }
}

async function main() {
  const args = process.argv.slice(2);
  let year = null;
  let airports = null;
  let tempDir = null;
  
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--year' && args[i + 1]) {
      year = parseInt(args[i + 1], 10);
      i++;
    } else if (args[i] === '--airport' && args[i + 1]) {
      airports = [args[i + 1].trim().toUpperCase()];
      i++;
    } else if (args[i] === '--airports' && args[i + 1]) {
      airports = args[i + 1].split(',').map(a => a.trim().toUpperCase());
      i++;
    } else if (args[i] === '--temp-dir' && args[i + 1]) {
      tempDir = args[i + 1];
      i++;
    }
  }
  
  if (!year || isNaN(year) || year < 2000 || year > 2100) {
    console.error('Usage: node scripts/weather/populate-aws-metar.js --year YYYY [--airport AIRPORT | --airports AIRPORT1,AIRPORT2,...]');
    console.error('');
    console.error('Options:');
    console.error('  --year YYYY                  Year to download (e.g., 2024)');
    console.error('  --airport AIRPORT            Single airport (e.g., KLGA)');
    console.error('  --airports AIRPORT1,AIRPORT2 Multiple airports (default: all)');
    console.error('  --temp-dir <path>            Directory for downloaded files (default: ./temp/weather)');
    console.error('');
    console.error('Example:');
    console.error('  node scripts/weather/populate-aws-metar.js --year 2024');
    console.error('  node scripts/weather/populate-aws-metar.js --year 2024 --airport KLGA');
    console.error('  node scripts/weather/populate-aws-metar.js --year 2024 --airports KBOS,KLGA');
    process.exit(1);
  }
  
  const downloadDir = tempDir || path.join(__dirname, '../../temp/weather');
  const stationsToProcess = airports 
    ? WEATHER_STATIONS.filter(s => airports.includes(s.icao))
    : WEATHER_STATIONS;
  
  if (stationsToProcess.length === 0) {
    console.error('Error: No matching stations found');
    process.exit(1);
  }
  
  const { startDate, endDate } = getYearDateRange(year);
  
  logger.info('Starting AWS METAR population', {
    year,
    startDate: startDate.toISOString().split('T')[0],
    endDate: endDate.toISOString().split('T')[0],
    stations: stationsToProcess.map(s => s.icao),
    downloadDir
  });
  
  if (!fs.existsSync(downloadDir)) {
    fs.mkdirSync(downloadDir, { recursive: true });
  }
  
  const s3Manager = new S3Manager();
  let successCount = 0;
  let failCount = 0;
  
  for (const station of stationsToProcess) {
    try {
      const result = await downloadMetarData(station, year, downloadDir);
      
      await uploadFileToS3(s3Manager, result.path, station.icao, result.filename);
      
      successCount++;
      
      if (station !== stationsToProcess[stationsToProcess.length - 1]) {
        await sleep(RATE_LIMIT_DELAY_MS);
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
  
  logger.info('AWS METAR population complete', {
    year,
    total: stationsToProcess.length,
    successful: successCount,
    failed: failCount,
    downloadDir,
    note: 'Files are still in temp directory. Delete manually if desired.'
  });
  
  if (failCount > 0) {
    process.exit(1);
  }
}

main().catch(error => {
  logger.error('Fatal error', { error: error.message, stack: error.stack });
  process.exit(1);
});
