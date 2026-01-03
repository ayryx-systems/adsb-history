#!/usr/bin/env node

/**
 * Generate daily weather summary from METAR data
 * 
 * Analyzes METAR data to create a daily summary table showing:
 * - Visibility dropped below 2 SM
 * - Visibility dropped below 1 SM
 * - Cloud ceiling dropped below 500ft
 * - Fog present (FG, BR codes)
 * - Snow present (SN, SG, FZSN codes)
 * - Rain present (RA, DZ, FZRA, FZDZ codes)
 * - Thunderstorms present (TS codes)
 * - Strong winds (wind speed above 30 knots)
 * 
 * Only checks conditions between 06:00 and 24:00 local time.
 * 
 * Usage:
 *   node scripts/analysis/generate-daily-weather-summary.js --airport KORD [--years 2024,2025] [--force]
 */

import dotenv from 'dotenv';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import logger from '../../src/utils/logger.js';
import { getSeason } from '../../src/utils/dst.js';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function getUTCOffsetHours(airport, dateStr) {
  const year = dateStr.split('-')[0];
  const season = getSeason(dateStr, airport, year);
  const offsets = {
    KORD: { winter: -6, summer: -5 },
    KLGA: { winter: -5, summer: -4 },
    KJFK: { winter: -5, summer: -4 },
    KLAX: { winter: -8, summer: -7 },
    KSFO: { winter: -8, summer: -7 },
  };
  const offset = offsets[airport] || { winter: -6, summer: -5 };
  return season === 'summer' ? offset.summer : offset.winter;
}

function parseArgs() {
  const args = process.argv.slice(2);
  const options = {
    airport: null,
    years: null,
    force: false,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    
    if (arg === '--airport' && i + 1 < args.length) {
      options.airport = args[i + 1].toUpperCase();
      i++;
    } else if (arg === '--years' && i + 1 < args.length) {
      const yearsList = [];
      i++;
      while (i < args.length && !args[i].startsWith('--')) {
        if (args[i].includes(',')) {
          yearsList.push(...args[i].split(',').map(y => y.trim()));
        } else {
          yearsList.push(args[i]);
        }
        i++;
      }
      i--;
      if (yearsList.length > 0) {
        options.years = yearsList;
      }
    } else if (arg === '--force') {
      options.force = true;
    }
  }

  if (!options.airport) {
    console.error('Usage: node scripts/analysis/generate-daily-weather-summary.js --airport AIRPORT [--years YYYY...] [--force]');
    process.exit(1);
  }

  if (!options.years) {
    options.years = ['2024', '2025'];
  }

  return options;
}

function parseMetarTimestamp(valid) {
  if (!valid) return null;
  try {
    let dateStr;
    if (typeof valid === 'string') {
      dateStr = valid;
      if (!dateStr.includes('T')) {
        dateStr = dateStr.replace(/^(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2}:\d{2})$/, '$1T$2');
      }
      if (!dateStr.endsWith('Z') && !dateStr.includes('+') && !dateStr.includes('-', 10)) {
        dateStr += 'Z';
      }
      const date = new Date(dateStr);
      if (isNaN(date.getTime())) {
        return null;
      }
      return Math.floor(date.getTime() / 1000);
    } else {
      const date = new Date(valid);
      if (isNaN(date.getTime())) {
        return null;
      }
      return Math.floor(date.getTime() / 1000);
    }
  } catch (error) {
    return null;
  }
}

function getDateStr(timestampMs) {
  const date = new Date(timestampMs);
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const day = String(date.getUTCDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function getLocalDateStr(timestampSeconds, offsetHours, utcHour) {
  const utcDate = new Date(timestampSeconds * 1000);
  const utcYear = utcDate.getUTCFullYear();
  const utcMonth = utcDate.getUTCMonth();
  const utcDay = utcDate.getUTCDate();
  
  let localHour = utcHour + offsetHours;
  let dayAdjustment = 0;
  
  if (localHour < 0) {
    localHour += 24;
    dayAdjustment = -1;
  } else if (localHour >= 24) {
    localHour -= 24;
    dayAdjustment = 1;
  }
  
  const localDate = new Date(Date.UTC(utcYear, utcMonth, utcDay + dayAdjustment));
  return localDate.toISOString().split('T')[0];
}

function calculateCloudCeiling(cloudGroups) {
  if (!cloudGroups || cloudGroups.length === 0) return null;
  
  let lowestCeiling = null;
  for (const cloud of cloudGroups) {
    const type = cloud.type_raw;
    const heightStr = cloud.height_raw;
    
    if ((type === 'BKN' || type === 'OVC') && heightStr) {
      const height = parseFloat(heightStr);
      if (!isNaN(height) && (lowestCeiling === null || height < lowestCeiling)) {
        lowestCeiling = height;
      }
    }
  }
  
  return lowestCeiling;
}

function hasWeatherCode(record, codes) {
  const wxcodes = record.wxcodes_raw;
  if (!wxcodes || wxcodes === 'M') return false;
  
  const upperWx = wxcodes.toUpperCase();
  return codes.some(code => upperWx.includes(code));
}

function loadMetarData(airport, year) {
  const metarPath = path.join(
    process.cwd(),
    'cache',
    'metar',
    airport,
    `${airport}_${year}.json`
  );

  if (!fs.existsSync(metarPath)) {
    logger.warn('METAR file not found', { airport, year, path: metarPath });
    return [];
  }

  try {
    const data = JSON.parse(fs.readFileSync(metarPath, 'utf-8'));
    return data.records || [];
  } catch (error) {
    logger.error('Failed to load METAR data', {
      airport,
      year,
      error: error.message,
    });
    return [];
  }
}

async function generateDailyWeatherSummary(airport, years, force) {
  const summaryPath = path.join(
    process.cwd(),
    'cache',
    airport,
    'daily-weather-summary.json'
  );
  
  if (!force && fs.existsSync(summaryPath)) {
    logger.info('Daily weather summary already exists, skipping', {
      airport,
      path: summaryPath,
    });
    return;
  }

  logger.info('Generating daily weather summary from METAR data', {
    airport,
    years,
  });

  const allMetarRecords = [];
  for (const year of years) {
    const records = loadMetarData(airport, year);
    logger.info('Loaded METAR records', { year, count: records.length });
    allMetarRecords.push(...records);
  }

  if (allMetarRecords.length === 0) {
    logger.error('No METAR data found', { airport, years });
    return;
  }

  const dailySummaries = {};

  for (const record of allMetarRecords) {
    const timestamp = parseMetarTimestamp(record.valid);
    if (!timestamp) continue;

    const utcDateStr = getDateStr(timestamp * 1000);
    const offsetHours = getUTCOffsetHours(airport, utcDateStr);
    
    const utcDate = new Date(timestamp * 1000);
    const utcHour = utcDate.getUTCHours();
    const utcMinute = utcDate.getUTCMinutes();
    
    let localHour = utcHour + offsetHours;
    
    if (localHour < 0) {
      localHour += 24;
    } else if (localHour >= 24) {
      localHour -= 24;
    }

    if (localHour < 6 || localHour >= 24) {
      continue;
    }

    const localDateStr = getLocalDateStr(timestamp, offsetHours, utcHour);
    
    if (!dailySummaries[localDateStr]) {
      dailySummaries[localDateStr] = {
        date: localDateStr,
        visibilityBelow2: false,
        visibilityBelow1: false,
        ceilingBelow500: false,
        fog: false,
        snow: false,
        rain: false,
        thunderstorms: false,
        strongWinds: false,
      };
    }

    const summary = dailySummaries[localDateStr];

    const visibilitySm = record.visibility_sm_v;
    if (visibilitySm !== null && visibilitySm !== undefined) {
      if (visibilitySm < 1) {
        summary.visibilityBelow1 = true;
        summary.visibilityBelow2 = true;
      } else if (visibilitySm < 2) {
        summary.visibilityBelow2 = true;
      }
    }

    const cloudGroups = record.cloud_groups_raw;
    if (cloudGroups && cloudGroups.length > 0) {
      const ceiling = calculateCloudCeiling(cloudGroups);
      if (ceiling !== null && ceiling < 500) {
        summary.ceilingBelow500 = true;
      }
    }

    if (hasWeatherCode(record, ['FG', 'BR'])) {
      summary.fog = true;
    }

    if (hasWeatherCode(record, ['SN', 'SG', 'FZSN'])) {
      summary.snow = true;
    }

    if (hasWeatherCode(record, ['RA', 'DZ', 'FZRA', 'FZDZ'])) {
      summary.rain = true;
    }

    if (hasWeatherCode(record, ['TS'])) {
      summary.thunderstorms = true;
    }

    const windSpeed = record.wind_spd_kt_v;
    const windGust = record.gust_kt_v;
    
    if ((windSpeed !== null && windSpeed !== undefined && windSpeed > 30) ||
        (windGust !== null && windGust !== undefined && windGust > 30)) {
      summary.strongWinds = true;
    }
  }

  const summaryArray = Object.values(dailySummaries).sort((a, b) => 
    a.date.localeCompare(b.date)
  );

  const output = {
    airport,
    years,
    generatedAt: new Date().toISOString(),
    totalDays: summaryArray.length,
    days: summaryArray,
  };

  const summaryDir = path.dirname(summaryPath);
  if (!fs.existsSync(summaryDir)) {
    fs.mkdirSync(summaryDir, { recursive: true, mode: 0o755 });
  }

  fs.writeFileSync(summaryPath, JSON.stringify(output, null, 2));
  
  logger.info('Daily weather summary generated', {
    airport,
    path: summaryPath,
    totalDays: output.totalDays,
  });

  console.log(`\n${'='.repeat(60)}`);
  console.log(`Daily Weather Summary for ${airport}`);
  console.log('='.repeat(60));
  console.log(`Total Days: ${output.totalDays}`);
  console.log(`Saved to: ${summaryPath}`);
  console.log('='.repeat(60) + '\n');
}

async function main() {
  const options = parseArgs();

  logger.info('Starting daily weather summary generation', options);

  try {
    await generateDailyWeatherSummary(
      options.airport,
      options.years,
      options.force
    );
  } catch (error) {
    logger.error('Failed to generate daily weather summary', {
      error: error.message,
      stack: error.stack,
    });
    console.error('Error:', error.message);
    process.exit(1);
  }
}

main();

