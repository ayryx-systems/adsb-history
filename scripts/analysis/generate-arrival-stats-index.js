#!/usr/bin/env node

/**
 * Generate Pre-Aggregated Arrival Stats Index
 * 
 * Creates a simple lookup table with pre-computed percentiles for each
 * time slot + weather category combination. No on-the-fly computation needed.
 * 
 * Structure:
 * {
 *   "generated": "2026-01-04T...",
 *   "airport": "ORD",
 *   "stats": {
 *     "08:00": {
 *       "VFR": { "matchCount": 45, "totalArrivals": 5000, "p10": 14.5, "p50": 18.2, "p90": 24.1 },
 *       "MVFR": { ... },
 *       "IFR": { ... },
 *       "LIFR": { ... }
 *     },
 *     "08:15": { ... },
 *     ...
 *   }
 * }
 * 
 * Usage:
 *   node scripts/analysis/generate-arrival-stats-index.js --airport KORD --years 2024,2025
 * 
 * Output:
 *   cache/AIRPORT/overall/arrival-stats-index.json (~50KB vs 20MB for full index)
 */

import dotenv from 'dotenv';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import logger from '../../src/utils/logger.js';
import { getSeason, getUTCOffset } from '../../src/utils/dst.js';
import {
  computeFlightCategory,
  extractCeiling,
  percentile,
} from './lib/weather-categories.js';
import { isSmallLightAircraft } from '../../src/utils/aircraft-categories.js';

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

const CATEGORIES = ['VFR', 'MVFR', 'IFR', 'LIFR'];

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
    return [];
  }

  try {
    const data = JSON.parse(fs.readFileSync(metarPath, 'utf-8'));
    return data.records || [];
  } catch (error) {
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

function extractArrivalsForTimeSlot(l2Stats, timeSlot, airport, localDate) {
  const arrivals = [];
  
  const bySlot = l2Stats?.overall?.byTouchdownTimeSlotLocal;
  if (!bySlot || !bySlot[timeSlot]) return arrivals;
  
  const slotData = bySlot[timeSlot];
  const aircraft = slotData.aircraft || [];
  
  for (const ac of aircraft) {
    if (!ac.milestones?.timeFrom50nm) continue;
    if (isSmallLightAircraft(ac.type)) continue;
    
    const durationMinutes = ac.milestones.timeFrom50nm / 60;
    arrivals.push(durationMinutes);
  }
  
  return arrivals;
}

async function generateArrivalStatsIndex(airport, years, force) {
  const outputPath = path.join(CACHE_DIR, airport, 'overall', 'arrival-stats-index.json');
  
  if (!force && fs.existsSync(outputPath)) {
    logger.info('Arrival stats index already exists, use --force to regenerate', { path: outputPath });
    return;
  }

  logger.info('Generating pre-aggregated arrival stats index', { airport, years });

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

  const stats = {};
  for (const slot of TIME_SLOTS) {
    stats[slot] = {};
    for (const cat of CATEGORIES) {
      stats[slot][cat] = {
        matchCount: 0,
        totalArrivals: 0,
        durations: [],
      };
    }
  }

  let processedDays = 0;
  let skippedDays = 0;

  for (const year of years) {
    const allDays = getAllDaysInYear(year);
    
    for (const { year: y, month: m, day: d } of allDays) {
      const localDate = `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
      const l2Stats = loadL2Stats(airport, y, m, d);
      
      if (!l2Stats) {
        skippedDays++;
        continue;
      }

      for (const timeSlot of TIME_SLOTS) {
        const slotTimestamp = localTimeSlotToUTC(localDate, timeSlot, airport);
        const metar = findClosestMetar(metarIndex, slotTimestamp);
        const category = getFlightCategoryFromMetar(metar);
        
        if (category === 'unknown' || !CATEGORIES.includes(category)) continue;
        
        const arrivals = extractArrivalsForTimeSlot(l2Stats, timeSlot, airport, localDate);
        
        if (arrivals.length > 0) {
          stats[timeSlot][category].matchCount++;
          stats[timeSlot][category].totalArrivals += arrivals.length;
          stats[timeSlot][category].durations.push(...arrivals);
        }
      }

      processedDays++;
      if (processedDays % 100 === 0) {
        logger.info('Processing days', { processed: processedDays, skipped: skippedDays });
      }
    }
  }

  logger.info('Computing percentiles for all time slots');

  const finalStats = {};
  for (const slot of TIME_SLOTS) {
    finalStats[slot] = {};
    
    for (const cat of CATEGORIES) {
      const data = stats[slot][cat];
      
      if (data.durations.length === 0) {
        finalStats[slot][cat] = {
          matchCount: 0,
          totalArrivals: 0,
          p10: null,
          p25: null,
          p50: null,
          p75: null,
          p90: null,
        };
        continue;
      }
      
      data.durations.sort((a, b) => a - b);
      
      finalStats[slot][cat] = {
        matchCount: data.matchCount,
        totalArrivals: data.totalArrivals,
        p10: Math.round(percentile(data.durations, 10) * 10) / 10,
        p25: Math.round(percentile(data.durations, 25) * 10) / 10,
        p50: Math.round(percentile(data.durations, 50) * 10) / 10,
        p75: Math.round(percentile(data.durations, 75) * 10) / 10,
        p90: Math.round(percentile(data.durations, 90) * 10) / 10,
      };
    }
  }

  const index = {
    generated: new Date().toISOString(),
    airport,
    years,
    processedDays,
    stats: finalStats,
  };

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, JSON.stringify(index, null, 2), 'utf-8');
  
  const fileSize = fs.statSync(outputPath).size;
  logger.info('Arrival stats index generated', { 
    path: outputPath, 
    days: processedDays,
    sizeKB: Math.round(fileSize / 1024),
  });
}

const options = parseArgs();

if (!options.airport || options.years.length === 0) {
  console.log('Usage: node generate-arrival-stats-index.js --airport <ICAO> --years <YYYY,YYYY,...> [--force]');
  process.exit(1);
}

generateArrivalStatsIndex(options.airport, options.years, options.force).catch(error => {
  logger.error('Failed to generate arrival stats index', { error: error.message });
  process.exit(1);
});


