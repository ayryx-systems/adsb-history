#!/usr/bin/env node

/**
 * Generate weather pattern index from historical METAR data
 * 
 * Analyzes METAR data to create searchable weather patterns:
 * - Visibility patterns by time slot (clear >3mi, reduced 1-3mi, low <1mi)
 * - Weather events (fog, storms) with timing and impact
 * 
 * Usage (single year):
 *   node scripts/analysis/generate-weather-patterns.js --airport KORD --year 2024 [--force]
 * 
 * Usage (multiple years):
 *   node scripts/analysis/generate-weather-patterns.js --airport KORD --years 2024,2025 [--force]
 *   node scripts/analysis/generate-weather-patterns.js --airport KORD --years 2024 2025 [--force]
 * 
 * Options:
 *   --year YYYY     Single year to process (mutually exclusive with --years)
 *   --years YYYY... Multiple years to process (comma-separated or space-separated)
 *   --force         Regenerate patterns even if they already exist
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
  const season = getSeason(dateStr, airport, dateStr.split('-')[0]);
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
    year: null,
    years: null,
    force: false,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    
    if (arg === '--airport' && i + 1 < args.length) {
      options.airport = args[i + 1].toUpperCase();
      i++;
    } else if (arg === '--year' && i + 1 < args.length) {
      options.year = args[i + 1];
      i++;
    } else if (arg === '--years') {
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
    console.error('Usage: node scripts/analysis/generate-weather-patterns.js --airport AIRPORT (--year YYYY | --years YYYY...) [--force]');
    process.exit(1);
  }

  if (!options.year && !options.years) {
    console.error('Usage: node scripts/analysis/generate-weather-patterns.js --airport AIRPORT (--year YYYY | --years YYYY...) [--force]');
    process.exit(1);
  }

  if (options.year && options.years) {
    console.error('Error: Cannot specify both --year and --years');
    process.exit(1);
  }

  return options;
}

function utcToLocalTimeSlot(utcTimestamp, airport, dateStr) {
  const offsetHours = getUTCOffsetHours(airport, dateStr);
  const offsetSeconds = offsetHours * 3600;
  const localTimestamp = utcTimestamp + offsetSeconds;
  const localDate = new Date(localTimestamp * 1000);
  
  const hour = localDate.getUTCHours();
  const minute = localDate.getUTCMinutes();
  const slotMinute = Math.floor(minute / 15) * 15;
  
  const hourStr = hour.toString().padStart(2, '0');
  const minStr = slotMinute.toString().padStart(2, '0');
  return `${hourStr}:${minStr}`;
}

function parseMetarTimestamp(valid) {
  if (!valid) return null;
  try {
    const date = typeof valid === 'string' ? new Date(valid) : valid;
    if (isNaN(date.getTime())) {
      return null;
    }
    return Math.floor(date.getTime() / 1000);
  } catch (error) {
    return null;
  }
}

function getPatternsPath(airport, year, years) {
  if (years && years.length > 1) {
    const yearRange = `${years[0]}-${years[years.length - 1]}`;
    return path.join(process.cwd(), 'cache', airport, yearRange, 'weather-patterns.json');
  }
  return path.join(process.cwd(), 'cache', airport, year, 'weather-patterns.json');
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

function categorizeVisibility(visibilitySm) {
  if (visibilitySm === null || visibilitySm === undefined || isNaN(visibilitySm)) {
    return 'unknown';
  }
  if (visibilitySm < 1) {
    return 'low';
  }
  if (visibilitySm < 3) {
    return 'reduced';
  }
  return 'clear';
}

function getDateStr(timestampMs) {
  const date = new Date(timestampMs);
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const day = String(date.getUTCDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

async function generateWeatherPatterns(airport, year, years, force) {
  const actualYears = years || [year];
  const patternsPath = getPatternsPath(airport, year, years);
  
  if (!force && fs.existsSync(patternsPath)) {
    logger.info('Weather patterns already exist, skipping', {
      airport,
      year: years ? actualYears.join(',') : year,
      path: patternsPath,
    });
    return;
  }

  const yearRange = years ? `${actualYears[0]}-${actualYears[actualYears.length - 1]}` : year;
  
  logger.info('Generating weather patterns from METAR data', {
    airport,
    year: years ? actualYears.join(',') : year,
    yearRange,
  });

  const allMetarRecords = [];
  for (const y of actualYears) {
    const records = loadMetarData(airport, y);
    logger.info('Loaded METAR records', { year: y, count: records.length });
    allMetarRecords.push(...records);
  }

  if (allMetarRecords.length === 0) {
    logger.error('No METAR data found', { airport, years: actualYears });
    return;
  }

  const visibilityPatterns = {
    clear: { days: new Set(), byTimeSlot: {} },
    reduced: { days: new Set(), byTimeSlot: {} },
    low: { days: new Set(), byTimeSlot: {} },
  };

  const events = [];
  const dailyVisibility = {};

  for (const record of allMetarRecords) {
    const timestamp = parseMetarTimestamp(record.valid);
    if (!timestamp) continue;

    const dateStr = getDateStr(timestamp * 1000);
    const visibilitySm = record.visibility_sm_v;
    const category = categorizeVisibility(visibilitySm);

    if (category === 'unknown') continue;

    if (!dailyVisibility[dateStr]) {
      dailyVisibility[dateStr] = [];
    }
    dailyVisibility[dateStr].push({
      timestamp,
      visibility: visibilitySm,
      category,
    });

    visibilityPatterns[category].days.add(dateStr);

    const timeSlot = utcToLocalTimeSlot(timestamp, airport, dateStr);
    if (!visibilityPatterns[category].byTimeSlot[timeSlot]) {
      visibilityPatterns[category].byTimeSlot[timeSlot] = { days: new Set() };
    }
    visibilityPatterns[category].byTimeSlot[timeSlot].days.add(dateStr);
  }

  for (const [dateStr, observations] of Object.entries(dailyVisibility)) {
    if (observations.length === 0) continue;

    observations.sort((a, b) => a.timestamp - b.timestamp);

    const reducedOrLow = observations.filter(o => o.category === 'reduced' || o.category === 'low');
    
    if (reducedOrLow.length === 0) continue;

    const firstReduced = reducedOrLow[0];
    const lastReduced = reducedOrLow[reducedOrLow.length - 1];
    
    const offsetHours = getUTCOffsetHours(airport, dateStr);
    const offsetSeconds = offsetHours * 3600;
    
    const startLocalTimestamp = firstReduced.timestamp + offsetSeconds;
    const endLocalTimestamp = lastReduced.timestamp + offsetSeconds;
    
    const startTime = new Date(startLocalTimestamp * 1000);
    const endTime = new Date(endLocalTimestamp * 1000);
    
    const startHour = startTime.getUTCHours();
    const startMin = startTime.getUTCMinutes();
    const endHour = endTime.getUTCHours();
    const endMin = endTime.getUTCMinutes();
    
    const startTimeStr = `${String(startHour).padStart(2, '0')}:${String(startMin).padStart(2, '0')}`;
    const endTimeStr = `${String(endHour).padStart(2, '0')}:${String(endMin).padStart(2, '0')}`;
    
    const durationHours = (lastReduced.timestamp - firstReduced.timestamp) / 3600;
    const visibilities = reducedOrLow.map(o => o.visibility).filter(v => v !== null);
    const minVis = Math.min(...visibilities);
    const avgVis = visibilities.reduce((a, b) => a + b, 0) / visibilities.length;

    const [year, month, day] = dateStr.split('-');
    
    let eventType = 'reduced_visibility';
    let severity = 'moderate';
    
    if (minVis < 0.5) {
      severity = 'severe';
      eventType = 'fog';
    } else if (minVis < 1) {
      severity = 'moderate';
      eventType = 'fog';
    } else if (durationHours < 6) {
      eventType = 'storm';
    }

    events.push({
      date: dateStr,
      year: parseInt(year),
      type: eventType,
      startTime: startTimeStr,
      endTime: endTimeStr,
      durationHours: Math.round(durationHours * 10) / 10,
      severity,
      visibility: {
        min: Math.round(minVis * 10) / 10,
        avg: Math.round(avgVis * 10) / 10,
      },
    });
  }

  events.sort((a, b) => {
    if (a.date !== b.date) return a.date.localeCompare(b.date);
    return a.startTime.localeCompare(b.startTime);
  });

  const patterns = {
    airport,
    yearRange,
    years: actualYears,
    generatedAt: new Date().toISOString(),
    totalDays: new Set(Object.keys(dailyVisibility)).size,
    patterns: {
      visibility: {
        clear: {
          days: Array.from(visibilityPatterns.clear.days).sort(),
          byTimeSlot: Object.fromEntries(
            Object.entries(visibilityPatterns.clear.byTimeSlot).map(([slot, data]) => [
              slot,
              {
                days: Array.from(data.days).sort(),
                sampleSize: data.days.size,
              },
            ])
          ),
        },
        reduced: {
          days: Array.from(visibilityPatterns.reduced.days).sort(),
          byTimeSlot: Object.fromEntries(
            Object.entries(visibilityPatterns.reduced.byTimeSlot).map(([slot, data]) => [
              slot,
              {
                days: Array.from(data.days).sort(),
                sampleSize: data.days.size,
              },
            ])
          ),
        },
        low: {
          days: Array.from(visibilityPatterns.low.days).sort(),
          byTimeSlot: Object.fromEntries(
            Object.entries(visibilityPatterns.low.byTimeSlot).map(([slot, data]) => [
              slot,
              {
                days: Array.from(data.days).sort(),
                sampleSize: data.days.size,
              },
            ])
          ),
        },
      },
      events,
    },
  };

  const patternsDir = path.dirname(patternsPath);
  if (!fs.existsSync(patternsDir)) {
    fs.mkdirSync(patternsDir, { recursive: true, mode: 0o755 });
  }

  fs.writeFileSync(patternsPath, JSON.stringify(patterns, null, 2));
  
  logger.info('Weather patterns generated', {
    airport,
    year: years ? actualYears.join(',') : year,
    path: patternsPath,
    totalDays: patterns.totalDays,
    events: events.length,
    clearDays: patterns.patterns.visibility.clear.days.length,
    reducedDays: patterns.patterns.visibility.reduced.days.length,
    lowDays: patterns.patterns.visibility.low.days.length,
  });

  const yearLabel = years ? `${actualYears.join(', ')}` : year;
  console.log(`\n${'='.repeat(60)}`);
  console.log(`Weather Patterns for ${airport} in ${yearLabel}`);
  console.log('='.repeat(60));
  console.log(`Total Days: ${patterns.totalDays}`);
  console.log(`Clear Days (>3mi): ${patterns.patterns.visibility.clear.days.length}`);
  console.log(`Reduced Visibility (1-3mi): ${patterns.patterns.visibility.reduced.days.length}`);
  console.log(`Low Visibility (<1mi): ${patterns.patterns.visibility.low.days.length}`);
  console.log(`Weather Events: ${events.length}`);
  console.log(`Saved to: ${patternsPath}`);
  console.log('='.repeat(60) + '\n');
}

async function main() {
  const options = parseArgs();

  logger.info('Starting weather pattern generation', options);

  try {
    await generateWeatherPatterns(
      options.airport,
      options.year,
      options.years,
      options.force
    );
  } catch (error) {
    logger.error('Failed to generate weather patterns', {
      error: error.message,
      stack: error.stack,
    });
    console.error('Error:', error.message);
    process.exit(1);
  }
}

main();

