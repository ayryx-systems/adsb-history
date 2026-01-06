#!/usr/bin/env node

/**
 * Generate Example Days Index (Lightweight)
 * 
 * Creates a small lookup table with 2 representative example days for each
 * time slot + weather category combination. Only stores:
 * - Date
 * - Weather category at the time slot
 * - Basic stats (arrival count, P50)
 * 
 * The full arrival data is fetched on-demand from the per-day l2-stats files.
 * 
 * Usage:
 *   node scripts/analysis/generate-example-days-index.js --airport KORD --years 2024,2025
 * 
 * Output:
 *   cache/AIRPORT/overall/example-days-index.json (~100KB)
 */

import dotenv from 'dotenv';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import logger from '../../src/utils/logger.js';
import {
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
const EXAMPLES_PER_SLOT = 2;

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

function loadDaySituationIndex(airport) {
  const indexPath = path.join(CACHE_DIR, airport, 'overall', 'day-situation-index.json');
  
  if (!fs.existsSync(indexPath)) {
    return null;
  }

  try {
    return JSON.parse(fs.readFileSync(indexPath, 'utf-8'));
  } catch (error) {
    return null;
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

function getDayStats(l2Stats) {
  const durations = [];
  
  const bySlot = l2Stats?.overall?.byTouchdownTimeSlotLocal;
  if (!bySlot) return { p50: null, count: 0 };
  
  for (const slotData of Object.values(bySlot)) {
    const aircraft = slotData.aircraft || [];
    for (const ac of aircraft) {
      if (!ac.milestones?.timeFrom50nm) continue;
      if (isSmallLightAircraft(ac.type)) continue;
      durations.push(ac.milestones.timeFrom50nm / 60);
    }
  }
  
  if (durations.length === 0) return { p50: null, count: 0 };
  
  durations.sort((a, b) => a - b);
  
  return {
    p50: Math.round(percentile(durations, 50) * 10) / 10,
    count: durations.length,
  };
}

function getWeatherTimelineForDay(daySituationIndex, dateStr) {
  const timeline = {};
  
  for (const [slot, categories] of Object.entries(daySituationIndex.daysByConditionAtTime || {})) {
    for (const [category, dates] of Object.entries(categories)) {
      if (dates.includes(dateStr)) {
        timeline[slot] = category;
      }
    }
  }
  
  // Reduce to hourly
  const hourlyTimeline = {};
  for (let h = 0; h < 24; h++) {
    const slot = `${String(h).padStart(2, '0')}:00`;
    if (timeline[slot]) {
      hourlyTimeline[h] = timeline[slot];
    }
  }
  
  return hourlyTimeline;
}

async function generateExampleDaysIndex(airport, years, force) {
  const outputPath = path.join(CACHE_DIR, airport, 'overall', 'example-days-index.json');
  
  if (!force && fs.existsSync(outputPath)) {
    logger.info('Example days index already exists, use --force to regenerate', { path: outputPath });
    return;
  }

  logger.info('Generating lightweight example days index', { airport, years });

  const daySituationIndex = loadDaySituationIndex(airport);
  if (!daySituationIndex) {
    logger.error('Day situation index not found. Run generate-day-situation-index.js first.', { airport });
    return;
  }

  const examples = {};
  let processedSlots = 0;

  for (const slot of TIME_SLOTS) {
    examples[slot] = {};
    
    for (const cat of CATEGORIES) {
      const matchingDays = daySituationIndex.daysByConditionAtTime?.[slot]?.[cat] || [];
      
      if (matchingDays.length === 0) {
        examples[slot][cat] = [];
        continue;
      }

      const candidates = [];
      
      for (const dateStr of matchingDays.slice(0, 15)) {
        const [year, month, day] = dateStr.split('-');
        const l2Stats = loadL2Stats(airport, year, parseInt(month), parseInt(day));
        
        if (!l2Stats) continue;
        
        const stats = getDayStats(l2Stats);
        if (stats.count < 50) continue;
        
        const weatherTimeline = getWeatherTimelineForDay(daySituationIndex, dateStr);
        
        candidates.push({
          date: dateStr,
          category: cat,
          p50: stats.p50,
          arrivalCount: stats.count,
          weather: weatherTimeline,
        });
        
        if (candidates.length >= EXAMPLES_PER_SLOT * 2) break;
      }
      
      candidates.sort((a, b) => b.arrivalCount - a.arrivalCount);
      
      examples[slot][cat] = candidates.slice(0, EXAMPLES_PER_SLOT);
    }
    
    processedSlots++;
    if (processedSlots % 12 === 0) {
      logger.info('Processing time slots', { processed: processedSlots, total: TIME_SLOTS.length });
    }
  }

  const index = {
    generated: new Date().toISOString(),
    airport,
    years,
    examplesPerSlot: EXAMPLES_PER_SLOT,
    examples,
  };

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, JSON.stringify(index, null, 2), 'utf-8');
  
  const fileSize = fs.statSync(outputPath).size;
  logger.info('Example days index generated', { 
    path: outputPath, 
    slots: processedSlots,
    sizeKB: Math.round(fileSize / 1024),
  });
}

const options = parseArgs();

if (!options.airport || options.years.length === 0) {
  console.log('Usage: node generate-example-days-index.js --airport <ICAO> --years <YYYY,YYYY,...> [--force]');
  process.exit(1);
}

generateExampleDaysIndex(options.airport, options.years, options.force).catch(error => {
  logger.error('Failed to generate example days index', { error: error.message });
  process.exit(1);
});

