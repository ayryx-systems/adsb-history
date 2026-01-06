#!/usr/bin/env node

/**
 * Generate Situation Index for Arrival Duration Forecasting
 * 
 * Creates a searchable index of historical time slots with:
 * - Weather conditions at each slot (current + 2-hour lookback)
 * - Arrival duration outcomes (percentiles of timeFrom50nm)
 * - Context (time of day, day type, season)
 * 
 * This index enables matching current/forecast conditions to similar
 * historical situations to predict arrival duration distributions.
 * 
 * Usage:
 *   node scripts/analysis/generate-situation-index.js --airport KORD --years 2024,2025
 * 
 * Output:
 *   cache/AIRPORT/overall/situation-index.json
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
  categorizeWind,
  categorizePrecipitation,
  calculateTrend,
  computeFlightCategory,
  extractCeiling,
  getTimeOfDay,
  getDayOfWeek,
  getDayType,
  getHolidayOffset,
  percentile,
} from './lib/weather-categories.js';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const CACHE_DIR = path.join(__dirname, '../../cache');

const LOOKBACK_HOURS = 2;
const LOOKBACK_MS = LOOKBACK_HOURS * 60 * 60 * 1000;

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
        while (args[i + 2] && !args[i + 2].startsWith('--')) {
          options.years.push(args[i + 2]);
          i++;
        }
      }
      i++;
    } else if (args[i] === '--year' && args[i + 1]) {
      options.years = [args[i + 1]];
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
    logger.warn('Failed to load L2 stats', { path: l2Path, error: error.message });
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

function getLookbackMetars(metarIndex, targetTimestamp, lookbackMs) {
  const metars = [];
  const startTime = targetTimestamp - lookbackMs;
  
  for (const [ts, metar] of metarIndex) {
    if (ts >= startTime && ts < targetTimestamp) {
      metars.push({ timestamp: ts, metar });
    }
  }
  
  metars.sort((a, b) => a.timestamp - b.timestamp);
  return metars.map(m => m.metar);
}

function localTimeSlotToUTC(localDate, timeSlot, airport) {
  const [hours, minutes] = timeSlot.split(':').map(Number);
  const [year, month, day] = localDate.split('-').map(Number);
  
  const localMs = Date.UTC(year, month - 1, day, hours, minutes, 0, 0);
  const offsetHours = getUTCOffset(airport, localDate);
  const utcMs = localMs - (offsetHours * 60 * 60 * 1000);
  
  return utcMs;
}

function buildOutcomes(slotData) {
  const durations = (slotData.aircraft || [])
    .filter(a => a.milestones?.timeFrom50nm)
    .map(a => a.milestones.timeFrom50nm / 60);
  
  if (durations.length === 0) {
    return {
      arrivalCount: 0,
      p10_50nm: null,
      p25_50nm: null,
      p50_50nm: null,
      p75_50nm: null,
      p90_50nm: null,
      p95_50nm: null,
      max_50nm: null,
      goArounds: slotData.goAroundCount || 0,
    };
  }
  
  durations.sort((a, b) => a - b);
  
  return {
    arrivalCount: durations.length,
    p10_50nm: Math.round(percentile(durations, 10) * 100) / 100,
    p25_50nm: Math.round(percentile(durations, 25) * 100) / 100,
    p50_50nm: Math.round(percentile(durations, 50) * 100) / 100,
    p75_50nm: Math.round(percentile(durations, 75) * 100) / 100,
    p90_50nm: Math.round(percentile(durations, 90) * 100) / 100,
    p95_50nm: Math.round(percentile(durations, 95) * 100) / 100,
    max_50nm: Math.round(durations[durations.length - 1] * 100) / 100,
    goArounds: slotData.goAroundCount || 0,
  };
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

async function generateSituationIndex(airport, years, force) {
  const outputPath = path.join(CACHE_DIR, airport, 'overall', 'situation-index.json');
  
  if (!force && fs.existsSync(outputPath)) {
    logger.info('Situation index already exists, use --force to regenerate', { path: outputPath });
    return;
  }

  logger.info('Generating situation index', { airport, years });

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

  logger.info('Built METAR index', { totalRecords: metarIndex.size });

  const slots = [];
  let processedDays = 0;
  let skippedSlots = 0;

  for (const year of years) {
    const allDays = getAllDaysInYear(year);
    
    for (const { year: y, month, day } of allDays) {
      const l2Stats = loadL2Stats(airport, y, month, day);
      if (!l2Stats) continue;
      
      processedDays++;
      const localDate = l2Stats.localDate;
      const byTimeSlot = l2Stats.overall?.byTouchdownTimeSlotLocal;
      
      if (!byTimeSlot) continue;

      for (const [timeSlot, slotData] of Object.entries(byTimeSlot)) {
        const slotTimestamp = localTimeSlotToUTC(localDate, timeSlot, airport);
        const currentMetar = findClosestMetar(metarIndex, slotTimestamp);
        
        if (!currentMetar) {
          skippedSlots++;
          continue;
        }

        const lookbackMetars = getLookbackMetars(metarIndex, slotTimestamp, LOOKBACK_MS);
        const ceiling = extractCeiling(currentMetar);
        
        const current = {
          visibility: categorizeVisibility(currentMetar.visibility_sm_v),
          visibilitySM: currentMetar.visibility_sm_v,
          ceiling: categorizeCeiling(ceiling),
          ceilingFt: ceiling,
          wind: categorizeWind(currentMetar.wind_spd_kt_v),
          windKt: currentMetar.wind_spd_kt_v,
          precipitation: categorizePrecipitation(currentMetar.wxcodes_tokens),
          flightCategory: computeFlightCategory(currentMetar.visibility_sm_v, ceiling),
        };

        const worstVisibility = lookbackMetars.length > 0
          ? Math.min(...lookbackMetars.map(m => m.visibility_sm_v).filter(v => v !== null))
          : currentMetar.visibility_sm_v;
        
        const worstCeiling = lookbackMetars.length > 0
          ? Math.min(...lookbackMetars.map(m => extractCeiling(m)).filter(c => c !== null))
          : ceiling;

        const lookback = {
          worstVisibility: categorizeVisibility(worstVisibility),
          worstVisibilitySM: worstVisibility,
          hadIFR: lookbackMetars.some(m => {
            const vis = m.visibility_sm_v;
            const ceil = extractCeiling(m);
            return (vis !== null && vis < 3) || (ceil !== null && ceil < 1000);
          }),
          hadLIFR: lookbackMetars.some(m => {
            const vis = m.visibility_sm_v;
            const ceil = extractCeiling(m);
            return (vis !== null && vis < 1) || (ceil !== null && ceil < 500);
          }),
          hadPrecip: [...new Set(
            lookbackMetars.map(m => categorizePrecipitation(m.wxcodes_tokens)).filter(p => p !== 'none')
          )],
          trend: calculateTrend(lookbackMetars, currentMetar.visibility_sm_v),
        };

        const holiday = getHolidayOffset(localDate);
        const context = {
          timeOfDay: getTimeOfDay(timeSlot),
          dayOfWeek: getDayOfWeek(localDate),
          dayType: holiday ? 'holiday' : getDayType(localDate),
          holiday,
        };

        const outcomes = buildOutcomes(slotData);
        const yearNum = parseInt(localDate.split('-')[0], 10);

        slots.push({
          date: localDate,
          timeSlot,
          season: getSeason(localDate, airport, yearNum),
          current,
          lookback,
          context,
          outcomes,
        });
      }
      
      if (processedDays % 50 === 0) {
        logger.info('Progress', { processedDays, slotsGenerated: slots.length });
      }
    }
  }

  logger.info('Slot generation complete', { 
    processedDays, 
    totalSlots: slots.length, 
    skippedSlots 
  });

  const aggregations = buildAggregations(slots);

  const situationIndex = {
    airport,
    generatedAt: new Date().toISOString(),
    years,
    totalSlots: slots.length,
    processedDays,
    categories: {
      visibility: ['VFR', 'MVFR', 'IFR', 'LIFR'],
      ceiling: ['VFR', 'MVFR', 'IFR', 'LIFR', 'unlimited'],
      wind: ['calm', 'light', 'moderate', 'strong'],
      precipitation: ['none', 'rain', 'snow', 'fog', 'mist', 'thunderstorm', 'freezing'],
      trend: ['improving', 'steady', 'deteriorating'],
      timeOfDay: ['earlyMorning', 'morning', 'midday', 'afternoon', 'evening', 'night'],
      dayType: ['weekday', 'weekend', 'holiday'],
    },
    slots,
    aggregations,
  };

  const outputDir = path.dirname(outputPath);
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  fs.writeFileSync(outputPath, JSON.stringify(situationIndex, null, 2));
  logger.info('Situation index written', { 
    path: outputPath, 
    totalSlots: slots.length,
    aggregations: Object.keys(aggregations).length,
  });
}

function buildAggregations(slots) {
  const aggregations = {};
  
  const validSlots = slots.filter(s => s.outcomes.arrivalCount > 0);
  
  const groupKeys = [
    { key: 'season_dayType_visibility', parts: ['season', 'context.dayType', 'current.visibility'] },
    { key: 'season_timeOfDay_visibility', parts: ['season', 'context.timeOfDay', 'current.visibility'] },
    { key: 'season_flightCategory', parts: ['season', 'current.flightCategory'] },
    { key: 'season_hadIFR_trend', parts: ['season', 'lookback.hadIFR', 'lookback.trend'] },
  ];
  
  for (const { key, parts } of groupKeys) {
    const groups = new Map();
    
    for (const slot of validSlots) {
      const groupKey = parts.map(p => {
        const pathParts = p.split('.');
        let val = slot;
        for (const pp of pathParts) {
          val = val?.[pp];
        }
        return val;
      }).join('_');
      
      if (!groups.has(groupKey)) {
        groups.set(groupKey, []);
      }
      groups.get(groupKey).push(slot);
    }
    
    for (const [groupKey, groupSlots] of groups) {
      const allDurations = [];
      let totalGoArounds = 0;
      let totalArrivals = 0;
      
      for (const s of groupSlots) {
        if (s.outcomes.p50_50nm !== null) {
          for (let i = 0; i < s.outcomes.arrivalCount; i++) {
            allDurations.push(s.outcomes.p50_50nm);
          }
          totalArrivals += s.outcomes.arrivalCount;
        }
        totalGoArounds += s.outcomes.goArounds;
      }
      
      allDurations.sort((a, b) => a - b);
      
      aggregations[`${key}_${groupKey}`] = {
        matchCount: groupSlots.length,
        totalArrivals,
        p50_50nm: percentile(allDurations, 50),
        p90_50nm: percentile(allDurations, 90),
        goAroundRate: totalArrivals > 0 ? Math.round((totalGoArounds / totalArrivals) * 10000) / 10000 : 0,
      };
    }
  }
  
  return aggregations;
}

const options = parseArgs();

if (!options.airport) {
  console.error('Usage: node generate-situation-index.js --airport KORD --years 2024,2025 [--force]');
  process.exit(1);
}

if (options.years.length === 0) {
  options.years = ['2024', '2025'];
}

generateSituationIndex(options.airport, options.years, options.force)
  .then(() => {
    logger.info('Situation index generation complete');
    process.exit(0);
  })
  .catch(error => {
    logger.error('Failed to generate situation index', { error: error.message, stack: error.stack });
    process.exit(1);
  });

