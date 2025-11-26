#!/usr/bin/env node

/**
 * Generate yearly baseline data from daily L1 statistics
 * 
 * Aggregates daily L1 stats files to create baseline comparisons:
 * - Average arrival counts per time slot across the year
 * - Average time from 50nm per time slot (median across all days)
 * - Average time from 100nm per time slot (median across all days)
 * 
 * Usage:
 *   node scripts/analysis/generate-yearly-baseline.js --airport KORD --year 2025
 */

import dotenv from 'dotenv';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import L1StatsData from '../../src/analysis/l1-stats/L1StatsData.js';
import logger from '../../src/utils/logger.js';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function parseArgs() {
  const args = process.argv.slice(2);
  const options = {
    airport: null,
    year: null,
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
    } else if (arg === '--force') {
      options.force = true;
    }
  }

  if (!options.airport || !options.year) {
    console.error('Usage: node scripts/analysis/generate-yearly-baseline.js --airport AIRPORT --year YYYY [--force]');
    process.exit(1);
  }

  return options;
}

function getDaysInYear(year) {
  const dates = [];
  const start = new Date(year, 0, 1);
  const end = new Date(year, 11, 31);
  
  for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
    const dateStr = d.toISOString().split('T')[0];
    dates.push(dateStr);
  }
  
  return dates;
}

function getBaselinePath(airport, year) {
  return path.join(process.cwd(), 'cache', airport, year, 'yearly-baseline.json');
}

async function generateBaseline(airport, year, force) {
  const baselinePath = getBaselinePath(airport, year);
  
  if (!force && fs.existsSync(baselinePath)) {
    logger.info('Yearly baseline already exists, skipping', {
      airport,
      year,
      path: baselinePath,
    });
    return;
  }

  const l1StatsData = new L1StatsData();
  const dates = getDaysInYear(year);
  
  logger.info('Generating yearly baseline', {
    airport,
    year,
    totalDays: dates.length,
  });

  const timeSlotData = {};
  let processedDays = 0;
  let skippedDays = 0;

  for (const date of dates) {
    try {
      const data = await l1StatsData.load(airport, date);
      
      if (!data || !data.overall || !data.overall.byTouchdownTimeSlot) {
        skippedDays++;
        continue;
      }

      const bySlot = data.overall.byTouchdownTimeSlot;
      
      for (const [slot, slotData] of Object.entries(bySlot)) {
        if (!timeSlotData[slot]) {
          timeSlotData[slot] = {
            counts: [],
            times50nm: [],
            times100nm: [],
          };
        }

        timeSlotData[slot].counts.push(slotData.count || 0);

        if (slotData.aircraft && Array.isArray(slotData.aircraft)) {
          const times50nm = slotData.aircraft
            .map(ac => ac.milestones?.timeFrom50nm)
            .filter(t => t !== undefined && t !== null);
          
          const times100nm = slotData.aircraft
            .map(ac => ac.milestones?.timeFrom100nm)
            .filter(t => t !== undefined && t !== null);

          if (times50nm.length > 0) {
            timeSlotData[slot].times50nm.push(...times50nm);
          }
          
          if (times100nm.length > 0) {
            timeSlotData[slot].times100nm.push(...times100nm);
          }
        }
      }

      processedDays++;
      
      if (processedDays % 30 === 0) {
        logger.info('Progress', {
          processed: processedDays,
          skipped: skippedDays,
          total: dates.length,
        });
      }
    } catch (error) {
      logger.warn('Failed to load data for date', {
        airport,
        date,
        error: error.message,
      });
      skippedDays++;
    }
  }

  logger.info('Aggregating baseline data', {
    processedDays,
    skippedDays,
  });

  const baseline = {
    airport,
    year,
    generatedAt: new Date().toISOString(),
    processedDays,
    skippedDays,
    byTimeSlot: {},
  };

  for (const [slot, data] of Object.entries(timeSlotData)) {
    const avgCount = data.counts.length > 0
      ? data.counts.reduce((a, b) => a + b, 0) / data.counts.length
      : 0;

    const median50nm = data.times50nm.length > 0
      ? calculateMedian(data.times50nm)
      : null;

    const median100nm = data.times100nm.length > 0
      ? calculateMedian(data.times100nm)
      : null;

    baseline.byTimeSlot[slot] = {
      averageCount: Math.round(avgCount * 100) / 100,
      medianTimeFrom50nm: median50nm ? Math.round(median50nm * 100) / 100 : null,
      medianTimeFrom100nm: median100nm ? Math.round(median100nm * 100) / 100 : null,
      sampleSize: {
        days: data.counts.length,
        arrivals50nm: data.times50nm.length,
        arrivals100nm: data.times100nm.length,
      },
    };
  }

  const baselineDir = path.dirname(baselinePath);
  if (!fs.existsSync(baselineDir)) {
    fs.mkdirSync(baselineDir, { recursive: true, mode: 0o755 });
  }

  fs.writeFileSync(baselinePath, JSON.stringify(baseline, null, 2));
  
  logger.info('Yearly baseline generated', {
    airport,
    year,
    path: baselinePath,
    timeSlots: Object.keys(baseline.byTimeSlot).length,
  });

  console.log(`\n${'='.repeat(60)}`);
  console.log(`Yearly Baseline for ${airport} in ${year}`);
  console.log('='.repeat(60));
  console.log(`Processed Days: ${processedDays}`);
  console.log(`Skipped Days: ${skippedDays}`);
  console.log(`Time Slots: ${Object.keys(baseline.byTimeSlot).length}`);
  console.log(`Saved to: ${baselinePath}`);
  console.log('='.repeat(60) + '\n');
}

function calculateMedian(values) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}

async function main() {
  const options = parseArgs();

  logger.info('Starting yearly baseline generation', options);

  try {
    await generateBaseline(options.airport, options.year, options.force);
  } catch (error) {
    logger.error('Failed to generate yearly baseline', {
      error: error.message,
      stack: error.stack,
    });
    console.error('Error:', error.message);
    process.exit(1);
  }
}

main();

