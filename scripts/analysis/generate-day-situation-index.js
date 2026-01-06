#!/usr/bin/env node

/**
 * Generate Day-Based Situation Index for Arrival Duration Forecasting
 * 
 * This creates an index that matches ENTIRE DAYS based on weather conditions
 * at specific time slots. This preserves traffic patterns (8am rush stays 8am)
 * and makes predictions more intuitive.
 * 
 * Structure:
 * - daysByConditionAtTime: { "14:00": { "VFR": ["2024-01-10", ...], "IFR": [...] } }
 * - dailyArrivals: { "2024-01-15": { arrivals: [...], conditions: {...} } }
 * 
 * Usage:
 *   node scripts/analysis/generate-day-situation-index.js --airport KORD --years 2024,2025
 * 
 * Output:
 *   cache/AIRPORT/overall/day-situation-index.json
 */

import dotenv from 'dotenv';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import logger from '../../src/utils/logger.js';
import { getSeason, getUTCOffset } from '../../src/utils/dst.js';
import {
  categorizeVisibility,
  categorizeCeiling,
  computeFlightCategory,
  extractCeiling,
  percentile,
} from './lib/weather-categories.js';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const CACHE_DIR = path.join(__dirname, '../../cache');

const TIME_SLOTS = [];
for (let h = 0; h < 24; h++) {
  for (let m = 0; m < 60; m += 15) {
    TIME_SLOTS.push(`${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`);
  }
}

function parseArgs() {
  const args = process.argv.slice(2);
  const options = { airport: null, years: [], force: false };

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--airport' && args[i + 1]) {
      options.airport = args[i + 1].toUpperCase();
      i++;
    } else if (args[i] === '--years' && args[i + 1]) {
      const yearsStr = args[i + 1];
      if (yearsStr.includes(',')) {
        options.years = yearsStr.split(',').map(y => y.trim());
      } else {
        options.years.push(yearsStr);
      }
      i++;
    } else if (args[i] === '--force') {
      options.force = true;
    }
  }

  return options;
}

function loadMetarData(airport, year) {
  const metarPath = path.join(CACHE_DIR, 'metar', airport, `${airport}_${year}.json`);
  
  if (!fs.existsSync(metarPath)) {
    logger.warn('METAR file not found', { path: metarPath });
    return [];
  }

  try {
    const data = JSON.parse(fs.readFileSync(metarPath, 'utf-8'));
    return data.records || [];
  } catch (error) {
    logger.error('Failed to load METAR data', { path: metarPath, error: error.message });
    return [];
  }
}

function loadL2Stats(airport, year, month, day) {
  const l2Path = path.join(
    CACHE_DIR, 
    airport, 
    year, 
    String(month).padStart(2, '0'), 
    `l2-stats-${String(day).padStart(2, '0')}.json`
  );

  if (!fs.existsSync(l2Path)) {
    return null;
  }

  try {
    return JSON.parse(fs.readFileSync(l2Path, 'utf-8'));
  } catch (error) {
    return null;
  }
}

function buildMetarIndex(metarRecords) {
  const index = new Map();
  
  for (const record of metarRecords) {
    if (!record.valid) continue;
    
    // METAR times are UTC - ensure proper parsing by adding 'Z' or using 'T'
    let validStr = record.valid;
    if (!validStr.includes('T') && !validStr.endsWith('Z')) {
      validStr = validStr.replace(' ', 'T') + 'Z';
    }
    
    const timestamp = new Date(validStr).getTime();
    if (isNaN(timestamp)) continue;
    
    index.set(timestamp, record);
  }
  
  return index;
}

function findClosestMetar(metarIndex, targetTimestamp, maxDiffMs = 45 * 60 * 1000) {
  let closest = null;
  let closestDiff = Infinity;
  
  for (const [ts, metar] of metarIndex) {
    const diff = Math.abs(ts - targetTimestamp);
    if (diff < closestDiff && diff <= maxDiffMs) {
      closest = metar;
      closestDiff = diff;
    }
  }
  
  return closest;
}

function localTimeSlotToUTC(localDate, timeSlot, airport) {
  const [hours, minutes] = timeSlot.split(':').map(Number);
  const [year, month, day] = localDate.split('-').map(Number);
  
  const localMs = Date.UTC(year, month - 1, day, hours, minutes, 0, 0);
  const offsetHours = getUTCOffset(airport, localDate);
  const utcMs = localMs - (offsetHours * 60 * 60 * 1000);
  
  return utcMs;
}

function getFlightCategoryFromMetar(metar) {
  if (!metar) return 'unknown';
  
  const visibility = metar.visibility_sm_v ?? 10;
  const ceiling = extractCeiling(metar);
  
  return computeFlightCategory(visibility, ceiling);
}

function getAllDaysInYear(year) {
  const days = [];
  const startDate = new Date(Date.UTC(Number(year), 0, 1));
  const endDate = new Date(Date.UTC(Number(year) + 1, 0, 1));
  
  const current = new Date(startDate);
  while (current < endDate) {
    const y = current.getUTCFullYear();
    const m = current.getUTCMonth() + 1;
    const d = current.getUTCDate();
    days.push({ year: String(y), month: m, day: d });
    current.setUTCDate(current.getUTCDate() + 1);
  }
  
  return days;
}

function extractArrivalsFromL2(l2Stats, localDate, airport) {
  const arrivals = [];
  
  const bySlot = l2Stats?.overall?.byTouchdownTimeSlotLocal;
  if (!bySlot) return arrivals;
  
  for (const [timeSlot, slotData] of Object.entries(bySlot)) {
    const aircraft = slotData.aircraft || [];
    
    for (const ac of aircraft) {
      if (!ac.milestones?.timeFrom50nm) continue;
      
      const durationMinutes = ac.milestones.timeFrom50nm / 60;
      const touchdown = ac.touchdown?.utc;
      
      if (!touchdown) continue;
      
      const landingDate = new Date(touchdown);
      const offsetHours = getUTCOffset(airport, localDate);
      const localLandingMs = landingDate.getTime() + (offsetHours * 60 * 60 * 1000);
      const localLanding = new Date(localLandingMs);
      
      const localTimeStr = `${String(localLanding.getUTCHours()).padStart(2, '0')}:${String(localLanding.getUTCMinutes()).padStart(2, '0')}`;
      
      arrivals.push({
        time: localTimeStr,
        duration: Math.round(durationMinutes * 100) / 100,
        callsign: ac.callsign || ac.icao || 'unknown',
        category: ac.type || 'unknown',
        goAround: false,
      });
    }
  }
  
  arrivals.sort((a, b) => a.time.localeCompare(b.time));
  
  return arrivals;
}

function computeDailyStats(arrivals) {
  if (arrivals.length === 0) {
    return { count: 0, p10: null, p25: null, p50: null, p75: null, p90: null, goArounds: 0 };
  }
  
  const durations = arrivals.map(a => a.duration);
  durations.sort((a, b) => a - b);
  
  return {
    count: arrivals.length,
    p10: Math.round(percentile(durations, 10) * 10) / 10,
    p25: Math.round(percentile(durations, 25) * 10) / 10,
    p50: Math.round(percentile(durations, 50) * 10) / 10,
    p75: Math.round(percentile(durations, 75) * 10) / 10,
    p90: Math.round(percentile(durations, 90) * 10) / 10,
    goArounds: arrivals.filter(a => a.goAround).length,
  };
}

async function generateDaySituationIndex(airport, years, force) {
  const outputPath = path.join(CACHE_DIR, airport, 'overall', 'day-situation-index.json');
  
  if (!force && fs.existsSync(outputPath)) {
    logger.info('Day situation index already exists, use --force to regenerate', { path: outputPath });
    return;
  }

  logger.info('Generating day-based situation index', { airport, years });

  const metarIndex = new Map();
  for (const year of years) {
    const records = loadMetarData(airport, year);
    logger.info('Loaded METAR records', { year, count: records.length });
    
    const yearIndex = buildMetarIndex(records);
    for (const [ts, metar] of yearIndex) {
      metarIndex.set(ts, metar);
    }
  }

  if (metarIndex.size === 0) {
    logger.error('No METAR data found', { airport, years });
    return;
  }

  const daysByConditionAtTime = {};
  for (const slot of TIME_SLOTS) {
    daysByConditionAtTime[slot] = {
      VFR: [],
      MVFR: [],
      IFR: [],
      LIFR: [],
    };
  }

  const dailyArrivals = {};
  let processedDays = 0;
  let skippedDays = 0;

  for (const year of years) {
    const allDays = getAllDaysInYear(year);
    
    for (const { year: y, month, day } of allDays) {
      const localDate = `${y}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
      
      const l2Stats = loadL2Stats(airport, y, month, day);
      if (!l2Stats) {
        skippedDays++;
        continue;
      }

      const arrivals = extractArrivalsFromL2(l2Stats, localDate, airport);
      
      if (arrivals.length === 0) {
        skippedDays++;
        continue;
      }

      const conditions = {};
      const season = getSeason(airport, localDate);
      
      for (const timeSlot of TIME_SLOTS) {
        const slotTimestamp = localTimeSlotToUTC(localDate, timeSlot, airport);
        const metar = findClosestMetar(metarIndex, slotTimestamp);
        const category = getFlightCategoryFromMetar(metar);
        
        conditions[timeSlot] = category;
        
        if (category !== 'unknown' && daysByConditionAtTime[timeSlot][category]) {
          daysByConditionAtTime[timeSlot][category].push(localDate);
        }
      }

      const stats = computeDailyStats(arrivals);

      dailyArrivals[localDate] = {
        arrivals,
        conditions,
        stats,
        season,
        dayOfWeek: new Date(Date.UTC(
          parseInt(y), 
          month - 1, 
          day
        )).getUTCDay(),
      };

      processedDays++;
      
      if (processedDays % 50 === 0) {
        logger.info('Processing days', { processed: processedDays, skipped: skippedDays });
      }
    }
  }

  logger.info('Processed all days', { processed: processedDays, skipped: skippedDays });

  const summary = {
    totalDays: processedDays,
    timeSlots: TIME_SLOTS.length,
    categories: ['VFR', 'MVFR', 'IFR', 'LIFR'],
  };

  for (const slot of ['08:00', '12:00', '16:00', '20:00']) {
    summary[`sample_${slot}`] = {
      VFR: daysByConditionAtTime[slot].VFR.length,
      MVFR: daysByConditionAtTime[slot].MVFR.length,
      IFR: daysByConditionAtTime[slot].IFR.length,
      LIFR: daysByConditionAtTime[slot].LIFR.length,
    };
  }

  const output = {
    generated: new Date().toISOString(),
    airport,
    years,
    summary,
    daysByConditionAtTime,
    dailyArrivals,
  };

  const outputDir = path.dirname(outputPath);
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  fs.writeFileSync(outputPath, JSON.stringify(output, null, 2));
  logger.info('Day situation index generated', { 
    path: outputPath, 
    days: processedDays,
    sizeBytes: fs.statSync(outputPath).size,
  });
}

const options = parseArgs();

if (!options.airport) {
  console.error('Usage: node generate-day-situation-index.js --airport ICAO --years 2024,2025 [--force]');
  process.exit(1);
}

if (options.years.length === 0) {
  options.years = ['2024', '2025'];
}

generateDaySituationIndex(options.airport, options.years, options.force)
  .then(() => {
    logger.info('Day situation index generation complete');
  })
  .catch(err => {
    logger.error('Failed to generate day situation index', { error: err.message });
    process.exit(1);
  });

