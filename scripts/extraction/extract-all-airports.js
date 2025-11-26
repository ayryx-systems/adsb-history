#!/usr/bin/env node

import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { S3Client, ListObjectsV2Command } from '@aws-sdk/client-s3';
import TraceExtractor from '../../src/extraction/TraceExtractor.js';
import ExtractedTraceData from '../../src/extraction/ExtractedTraceData.js';
import GroundAircraftData from '../../src/processing/GroundAircraftData.js';
import logger from '../../src/utils/logger.js';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function parseArgs() {
  const args = process.argv.slice(2);
  const options = {
    startDate: null,
    endDate: null,
    force: false,
    airports: null,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    
    if (arg === '--start-date' && i + 1 < args.length) {
      options.startDate = args[i + 1];
      i++;
    } else if (arg === '--end-date' && i + 1 < args.length) {
      options.endDate = args[i + 1];
      i++;
    } else if (arg === '--airports' && i + 1 < args.length) {
      options.airports = args[i + 1].split(',').map(a => a.toUpperCase().trim());
      i++;
    } else if (arg === '--force') {
      options.force = true;
    } else if (arg === '--help' || arg === '-h') {
      console.log(`
Extract traces for all enabled airports for date range

This script processes all enabled airports and extracts traces for all dates
in the specified range. Once extraction is complete, downstream scripts will
use these extracted traces instead of downloading full raw tar files.

Usage:
  node scripts/extraction/extract-all-airports.js [options]

Options:
  --start-date YYYY-MM-DD  Start date (required)
  --end-date YYYY-MM-DD    End date (required)
  --airports ICAO1,ICAO2    Specific airports to process (default: all enabled)
  --force                   Reprocess even if data exists
  --help, -h               Show this help message

Examples:
  # Extract all enabled airports for January 2025
  node scripts/extraction/extract-all-airports.js --start-date 2025-01-01 --end-date 2025-01-31

  # Extract specific airports for a date range
  node scripts/extraction/extract-all-airports.js --start-date 2025-01-01 --end-date 2025-01-15 --airports KORD,KLGA
      `);
      process.exit(0);
    }
  }

  if (!options.startDate || !options.endDate) {
    console.error('Error: --start-date and --end-date are required');
    console.error('Run with --help for usage information');
    process.exit(1);
  }

  return options;
}

function loadAirportConfig() {
  const configPath = path.join(__dirname, '..', '..', 'config', 'airports.json');
  const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
  return config.airports.filter(a => a.enabled);
}

function generateDateRange(startDate, endDate) {
  const dates = [];
  const start = new Date(startDate + 'T00:00:00Z');
  const end = new Date(endDate + 'T00:00:00Z');
  
  for (let d = new Date(start); d <= end; d.setUTCDate(d.getUTCDate())) {
    dates.push(d.toISOString().split('T')[0]);
    d.setUTCDate(d.getUTCDate() + 1);
  }
  
  return dates;
}

async function discoverAvailableDates(bucketName, region) {
  const clientConfig = { region };
  if (process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY) {
    clientConfig.credentials = {
      accessKeyId: process.env.AWS_ACCESS_KEY_ID,
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
    };
  }
  const s3Client = new S3Client(clientConfig);

  const dates = new Set();
  let continuationToken = null;

  do {
    const command = new ListObjectsV2Command({
      Bucket: bucketName,
      Prefix: 'raw/',
      Delimiter: '/',
    });

    if (continuationToken) {
      command.input.ContinuationToken = continuationToken;
    }

    const response = await s3Client.send(command);

    if (response.CommonPrefixes) {
      for (const prefix of response.CommonPrefixes) {
        const year = prefix.Prefix.replace('raw/', '').replace('/', '');
        if (/^\d{4}$/.test(year)) {
          const yearPrefix = `raw/${year}/`;
          let monthToken = null;
          
          do {
            const monthCommand = new ListObjectsV2Command({
              Bucket: bucketName,
              Prefix: yearPrefix,
              Delimiter: '/',
            });
            if (monthToken) {
              monthCommand.input.ContinuationToken = monthToken;
            }
            
            const monthResponse = await s3Client.send(monthCommand);
            
            if (monthResponse.CommonPrefixes) {
              for (const monthPrefix of monthResponse.CommonPrefixes) {
                const month = monthPrefix.Prefix.replace(yearPrefix, '').replace('/', '');
                if (/^\d{2}$/.test(month)) {
                  const dayPrefix = `${yearPrefix}${month}/`;
                  let dayToken = null;
                  
                  do {
                    const dayCommand = new ListObjectsV2Command({
                      Bucket: bucketName,
                      Prefix: dayPrefix,
                    });
                    if (dayToken) {
                      dayCommand.input.ContinuationToken = dayToken;
                    }
                    
                    const dayResponse = await s3Client.send(dayCommand);
                    
                    if (dayResponse.Contents) {
                      for (const obj of dayResponse.Contents) {
                        if (obj.Key.includes('.tar')) {
                          const dateMatch = obj.Key.match(/raw\/(\d{4})\/(\d{2})\/(\d{2})\//);
                          if (dateMatch) {
                            dates.add(`${dateMatch[1]}-${dateMatch[2]}-${dateMatch[3]}`);
                          }
                        }
                      }
                    }
                    
                    dayToken = dayResponse.NextContinuationToken;
                  } while (dayToken);
                }
              }
            }
            
            monthToken = monthResponse.NextContinuationToken;
          } while (monthToken);
        }
      }
    }

    continuationToken = response.NextContinuationToken;
  } while (continuationToken);

  return Array.from(dates).sort();
}

async function processDateForAirport(airport, date, extractor, dataStore, groundAircraftData, force) {
  if (!force) {
    const exists = await dataStore.exists(airport.icao, date);
    if (exists) {
      return { date, airport: airport.icao, skipped: true };
    }
  }

  const groundAircraftExists = await groundAircraftData.exists(airport.icao, date);
  if (!groundAircraftExists) {
    logger.warn('Ground aircraft list not found, skipping extraction', {
      airport: airport.icao,
      date,
    });
    return { date, airport: airport.icao, skipped: true, reason: 'no_ground_aircraft' };
  }

  try {
    const tarPath = await extractor.extractTracesForAirport(airport.icao, date);
    
    if (!tarPath) {
      return { date, airport: airport.icao, skipped: true, reason: 'no_traces' };
    }

    await dataStore.save(airport.icao, date, tarPath);

    const stats = fs.statSync(tarPath);
    const sizeMB = (stats.size / 1024 / 1024).toFixed(2);

    return { date, airport: airport.icao, sizeMB, skipped: false };
  } catch (error) {
    logger.error('Failed to extract traces', {
      airport: airport.icao,
      date,
      error: error.message,
      stack: error.stack,
    });
    return { date, airport: airport.icao, error: error.message };
  }
}

async function main() {
  const options = parseArgs();

  logger.info('Starting blanket extraction for all airports', options);

  try {
    const enabledAirports = loadAirportConfig();
    
    let airports = enabledAirports;
    if (options.airports) {
      airports = enabledAirports.filter(a => options.airports.includes(a.icao));
      const invalidAirports = options.airports.filter(a => !enabledAirports.find(ea => ea.icao === a));
      if (invalidAirports.length > 0) {
        console.error(`Error: Invalid or disabled airports: ${invalidAirports.join(', ')}`);
        process.exit(1);
      }
    }

    if (airports.length === 0) {
      console.error('Error: No enabled airports found');
      process.exit(1);
    }

    const dates = generateDateRange(options.startDate, options.endDate);

    console.log(`\n${'='.repeat(60)}`);
    console.log('Blanket Extraction for All Airports');
    console.log('='.repeat(60));
    console.log(`Airports: ${airports.map(a => a.icao).join(', ')} (${airports.length})`);
    console.log(`Date range: ${options.startDate} to ${options.endDate} (${dates.length} days)`);
    console.log(`Total tasks: ${airports.length * dates.length}`);
    console.log('='.repeat(60) + '\n');

    const extractor = new TraceExtractor();
    const dataStore = new ExtractedTraceData();
    const groundAircraftData = new GroundAircraftData();

    const results = [];
    const startTime = Date.now();
    let taskNum = 0;
    const totalTasks = airports.length * dates.length;

    for (const airport of airports) {
      console.log(`\nProcessing ${airport.icao} (${airport.name})...`);
      console.log('─'.repeat(60));

      for (const date of dates) {
        taskNum++;
        process.stdout.write(`[${taskNum}/${totalTasks}] ${airport.icao} ${date}... `);

        try {
          const result = await processDateForAirport(
            airport,
            date,
            extractor,
            dataStore,
            groundAircraftData,
            options.force
          );
          results.push(result);

          if (result.error) {
            console.log(`✗ Error: ${result.error}`);
          } else if (result.skipped) {
            if (result.reason === 'no_ground_aircraft') {
              console.log(`⊘ Skipped (no ground aircraft list)`);
            } else if (result.reason === 'no_traces') {
              console.log(`⊘ Skipped (no traces found)`);
            } else {
              console.log(`⊘ Skipped (already exists)`);
            }
          } else {
            console.log(`✓ Extracted (${result.sizeMB} MB)`);
          }
        } catch (error) {
          logger.error('Failed to process', {
            airport: airport.icao,
            date,
            error: error.message,
          });
          console.log(`✗ Error: ${error.message}`);
          results.push({ date, airport: airport.icao, error: error.message });
        }
      }
    }

    const duration = Date.now() - startTime;
    const successful = results.filter(r => !r.error && !r.skipped).length;
    const skipped = results.filter(r => r.skipped).length;
    const failed = results.filter(r => r.error).length;
    const totalSizeMB = results
      .filter(r => r.sizeMB)
      .reduce((sum, r) => sum + parseFloat(r.sizeMB), 0);

    console.log(`\n${'='.repeat(60)}`);
    console.log('Extraction Summary');
    console.log('='.repeat(60));
    console.log(`Total tasks: ${totalTasks}`);
    console.log(`  ✓ Successful: ${successful}`);
    console.log(`  ⊘ Skipped: ${skipped}`);
    console.log(`  ✗ Failed: ${failed}`);
    if (totalSizeMB > 0) {
      console.log(`Total size extracted: ${totalSizeMB.toFixed(2)} MB`);
    }
    console.log(`Duration: ${(duration / 1000 / 60).toFixed(1)} minutes`);
    console.log('='.repeat(60) + '\n');

    if (failed > 0) {
      logger.warn('Some extractions failed', { failed });
      const failedResults = results.filter(r => r.error);
      console.log('Failed extractions:');
      for (const result of failedResults) {
        console.log(`  ${result.airport} ${result.date}: ${result.error}`);
      }
      process.exit(1);
    }

    logger.info('Blanket extraction complete! 🎉');

  } catch (error) {
    logger.error('Processing failed', {
      error: error.message,
      stack: error.stack,
    });
    process.exit(1);
  }
}

main().catch(error => {
  logger.error('Fatal error', {
    error: error.message,
    stack: error.stack,
  });
  process.exit(1);
});

