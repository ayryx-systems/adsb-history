#!/usr/bin/env node

/**
 * Generate yearly baseline data from daily L2 statistics (local time)
 * 
 * Aggregates daily L2 stats files (which are in local time) to create baseline comparisons:
 * - Average arrival counts per local time slot across the year
 * - Average time from 50nm per local time slot (median across all days)
 * - Average time from 100nm per local time slot (median across all days)
 * - Average time-of-day volumes (morning/afternoon/evening) based on 50nm threshold passing
 * 
 * Usage:
 *   node scripts/analysis/generate-yearly-baseline.js --airport KORD --year 2025 [--force] [--local-only]
 * 
 * Options:
 *   --local-only    Only use local L2 stats files, skip S3 downloads (faster when processing limited date ranges)
 */

import dotenv from 'dotenv';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import L2StatsData from '../../src/analysis/l2-stats/L2StatsData.js';
import CongestionData from '../../src/analysis/congestion/CongestionData.js';
import logger from '../../src/utils/logger.js';
import { getSeason, getDSTDates } from '../../src/utils/dst.js';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function parseArgs() {
  const args = process.argv.slice(2);
  const options = {
    airport: null,
    year: null,
    force: false,
    localOnly: false,
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
    } else if (arg === '--local-only') {
      options.localOnly = true;
    }
  }

  if (!options.airport || !options.year) {
    console.error('Usage: node scripts/analysis/generate-yearly-baseline.js --airport AIRPORT --year YYYY [--force] [--local-only]');
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

function getNthWeekday(year, month, weekday, n) {
  const firstDay = new Date(year, month - 1, 1);
  const firstWeekday = firstDay.getDay();
  const offset = (weekday - firstWeekday + 7) % 7;
  const day = 1 + offset + (n - 1) * 7;
  return day;
}

function getLastWeekday(year, month, weekday) {
  const lastDay = new Date(year, month, 0).getDate();
  const lastDate = new Date(year, month - 1, lastDay);
  const lastWeekday = lastDate.getDay();
  const offset = (lastWeekday - weekday + 7) % 7;
  return lastDay - offset;
}

function getUSHolidays(year) {
  const holidays = [];
  const yearNum = typeof year === 'string' ? parseInt(year, 10) : year;
  
  holidays.push({ name: "New Year's Day", month: 1, day: 1 });
  
  holidays.push({ name: "Independence Day", month: 7, day: 4 });
  
  const thanksgiving = getNthWeekday(yearNum, 11, 4, 4);
  holidays.push({ name: "Thanksgiving", month: 11, day: thanksgiving });
  
  holidays.push({ name: "Christmas", month: 12, day: 25 });
  
  return holidays;
}

function normalizeHolidayName(name) {
  return name
    .toLowerCase()
    .replace(/'/g, '')
    .replace(/\s+/g, '_')
    .replace(/\./g, '');
}

function getHolidayCategory(dateStr) {
  const [year, month, day] = dateStr.split('-').map(Number);
  const date = new Date(year, month - 1, day);
  const holidays = getUSHolidays(year);
  
  for (const holiday of holidays) {
    const holidayDate = new Date(year, holiday.month - 1, holiday.day);
    const diffMs = date - holidayDate;
    const diffDays = Math.round(diffMs / (1000 * 60 * 60 * 24));
    
    if (diffDays === -2) {
      return { category: normalizeHolidayName(holiday.name), offset: -2 };
    } else if (diffDays === -1) {
      return { category: normalizeHolidayName(holiday.name), offset: -1 };
    } else if (diffDays === 0) {
      return { category: normalizeHolidayName(holiday.name), offset: 0 };
    } else if (diffDays === 1) {
      return { category: normalizeHolidayName(holiday.name), offset: 1 };
    } else if (diffDays === 2) {
      return { category: normalizeHolidayName(holiday.name), offset: 2 };
    }
  }
  
  return null;
}

function getDayOfWeek(dateStr) {
  const [year, month, day] = dateStr.split('-').map(Number);
  const date = new Date(year, month - 1, day);
  const days = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
  return days[date.getDay()];
}

async function generateBaseline(airport, year, force, localOnly) {
  const baselinePath = getBaselinePath(airport, year);
  
  if (!force && fs.existsSync(baselinePath)) {
    logger.info('Yearly baseline already exists, skipping', {
      airport,
      year,
      path: baselinePath,
    });
    return;
  }

  const l2StatsData = new L2StatsData({ localOnly });
  const congestionData = new CongestionData({ localOnly });
  const dates = getDaysInYear(year);
  
  const dstDates = getDSTDates(airport, year);
  logger.info('Generating seasonal baseline from L2 stats and congestion data', {
    airport,
    year,
    totalDays: dates.length,
    dstStart: dstDates.start.toISOString().split('T')[0],
    dstEnd: dstDates.end.toISOString().split('T')[0],
    localOnly,
  });

  const summerTimeSlotData = {};
  const winterTimeSlotData = {};
  const summerL2Volumes = {
    morning: [],
    afternoon: [],
    evening: [],
  };
  const winterL2Volumes = {
    morning: [],
    afternoon: [],
    evening: [],
  };
  
  const summerHolidayVolumes = {};
  const winterHolidayVolumes = {};
  const summerDayOfWeekVolumes = {
    monday: { morning: [], afternoon: [], evening: [] },
    tuesday: { morning: [], afternoon: [], evening: [] },
    wednesday: { morning: [], afternoon: [], evening: [] },
    thursday: { morning: [], afternoon: [], evening: [] },
    friday: { morning: [], afternoon: [], evening: [] },
    saturday: { morning: [], afternoon: [], evening: [] },
    sunday: { morning: [], afternoon: [], evening: [] },
  };
  const winterDayOfWeekVolumes = {
    monday: { morning: [], afternoon: [], evening: [] },
    tuesday: { morning: [], afternoon: [], evening: [] },
    wednesday: { morning: [], afternoon: [], evening: [] },
    thursday: { morning: [], afternoon: [], evening: [] },
    friday: { morning: [], afternoon: [], evening: [] },
    saturday: { morning: [], afternoon: [], evening: [] },
    sunday: { morning: [], afternoon: [], evening: [] },
  };
  
  let processedDays = 0;
  let skippedDays = 0;
  let summerDays = 0;
  let winterDays = 0;

  for (const date of dates) {
    try {
      const season = getSeason(date, airport, year);
      const timeSlotData = season === 'summer' ? summerTimeSlotData : winterTimeSlotData;
      const volumesData = season === 'summer' ? summerL2Volumes : winterL2Volumes;
      
      const l2Data = await l2StatsData.load(airport, date);
      
      if (!l2Data || !l2Data.overall || !l2Data.overall.byTouchdownTimeSlotLocal) {
        skippedDays++;
        continue;
      }

      const bySlot = l2Data.overall.byTouchdownTimeSlotLocal;
      
      for (const [slot, slotData] of Object.entries(bySlot)) {
        if (!timeSlotData[slot]) {
          timeSlotData[slot] = {
            counts: [],
            times50nm: [],
            times100nm: [],
            congestion: [],
            entries: [],
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

      // Load congestion data for this date
      try {
        const congestionStats = await congestionData.load(airport, date);
        if (congestionStats && congestionStats.byTimeSlotLocal) {
          for (const [slot, slotData] of Object.entries(congestionStats.byTimeSlotLocal)) {
            if (!timeSlotData[slot]) {
              timeSlotData[slot] = {
                counts: [],
                times50nm: [],
                times100nm: [],
                congestion: [],
                entries: [],
              };
            }
            
            if (slotData.congestion !== undefined && slotData.congestion !== null) {
              timeSlotData[slot].congestion.push(slotData.congestion);
            }
            if (slotData.entries !== undefined && slotData.entries !== null) {
              timeSlotData[slot].entries.push(slotData.entries);
            }
          }
        }
      } catch (error) {
        logger.debug('Failed to load congestion data for date', {
          airport,
          date,
          error: error.message,
        });
      }

      if (l2Data.volumes) {
        if (l2Data.volumes.morning !== undefined) {
          volumesData.morning.push(l2Data.volumes.morning);
        }
        if (l2Data.volumes.afternoon !== undefined) {
          volumesData.afternoon.push(l2Data.volumes.afternoon);
        }
        if (l2Data.volumes.evening !== undefined) {
          volumesData.evening.push(l2Data.volumes.evening);
        }
      }
      
      const holidayCategory = getHolidayCategory(date);
      const dayOfWeek = getDayOfWeek(date);
      
      if (holidayCategory) {
        const holidayVolumes = season === 'summer' ? summerHolidayVolumes : winterHolidayVolumes;
        const categoryKey = `${holidayCategory.category}_${holidayCategory.offset}`;
        
        if (!holidayVolumes[categoryKey]) {
          holidayVolumes[categoryKey] = {
            morning: [],
            afternoon: [],
            evening: [],
          };
        }
        
        if (l2Data.volumes) {
          if (l2Data.volumes.morning !== undefined) {
            holidayVolumes[categoryKey].morning.push(l2Data.volumes.morning);
          }
          if (l2Data.volumes.afternoon !== undefined) {
            holidayVolumes[categoryKey].afternoon.push(l2Data.volumes.afternoon);
          }
          if (l2Data.volumes.evening !== undefined) {
            holidayVolumes[categoryKey].evening.push(l2Data.volumes.evening);
          }
        }
      } else {
        const dayOfWeekVolumes = season === 'summer' ? summerDayOfWeekVolumes : winterDayOfWeekVolumes;
        
        if (dayOfWeekVolumes[dayOfWeek] && l2Data.volumes) {
          if (l2Data.volumes.morning !== undefined) {
            dayOfWeekVolumes[dayOfWeek].morning.push(l2Data.volumes.morning);
          }
          if (l2Data.volumes.afternoon !== undefined) {
            dayOfWeekVolumes[dayOfWeek].afternoon.push(l2Data.volumes.afternoon);
          }
          if (l2Data.volumes.evening !== undefined) {
            dayOfWeekVolumes[dayOfWeek].evening.push(l2Data.volumes.evening);
          }
        }
      }

      processedDays++;
      if (season === 'summer') {
        summerDays++;
      } else {
        winterDays++;
      }
      
      if (processedDays % 30 === 0) {
        logger.info('Progress', {
          processed: processedDays,
          skipped: skippedDays,
          summerDays,
          winterDays,
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
    summerDays,
    winterDays,
  });

  const baseline = {
    airport,
    year,
    generatedAt: new Date().toISOString(),
    processedDays,
    skippedDays,
    summerDays,
    winterDays,
    dstStart: dstDates.start.toISOString().split('T')[0],
    dstEnd: dstDates.end.toISOString().split('T')[0],
    summer: {
      byTimeSlotLocal: {},
      l2Volumes: {},
    },
    winter: {
      byTimeSlotLocal: {},
      l2Volumes: {},
    },
  };

  function aggregateSeason(seasonData, seasonName) {
    const result = {};
    for (const [slot, data] of Object.entries(seasonData)) {
      const avgCount = data.counts.length > 0
        ? data.counts.reduce((a, b) => a + b, 0) / data.counts.length
        : 0;

      const median50nm = data.times50nm.length > 0
        ? calculateMedian(data.times50nm)
        : null;

      const median100nm = data.times100nm.length > 0
        ? calculateMedian(data.times100nm)
        : null;

      const avgCongestion = data.congestion.length > 0
        ? data.congestion.reduce((a, b) => a + b, 0) / data.congestion.length
        : null;

      const avgEntries = data.entries.length > 0
        ? data.entries.reduce((a, b) => a + b, 0) / data.entries.length
        : null;

      result[slot] = {
        averageCount: Math.round(avgCount * 100) / 100,
        medianTimeFrom50nm: median50nm ? Math.round(median50nm * 100) / 100 : null,
        medianTimeFrom100nm: median100nm ? Math.round(median100nm * 100) / 100 : null,
        averageCongestion: avgCongestion !== null ? Math.round(avgCongestion * 100) / 100 : null,
        averageEntries: avgEntries !== null ? Math.round(avgEntries * 100) / 100 : null,
        sampleSize: {
          days: data.counts.length,
          arrivals50nm: data.times50nm.length,
          arrivals100nm: data.times100nm.length,
          congestion: data.congestion.length,
          entries: data.entries.length,
        },
      };
    }
    return result;
  }

  baseline.summer.byTimeSlotLocal = aggregateSeason(summerTimeSlotData, 'summer');
  baseline.winter.byTimeSlotLocal = aggregateSeason(winterTimeSlotData, 'winter');

  function aggregateL2Volumes(volumesData) {
    return {
      morning: volumesData.morning.length > 0
        ? Math.round((volumesData.morning.reduce((a, b) => a + b, 0) / volumesData.morning.length) * 100) / 100
        : null,
      afternoon: volumesData.afternoon.length > 0
        ? Math.round((volumesData.afternoon.reduce((a, b) => a + b, 0) / volumesData.afternoon.length) * 100) / 100
        : null,
      evening: volumesData.evening.length > 0
        ? Math.round((volumesData.evening.reduce((a, b) => a + b, 0) / volumesData.evening.length) * 100) / 100
        : null,
      sampleSize: {
        days: Math.max(volumesData.morning.length, volumesData.afternoon.length, volumesData.evening.length),
      },
    };
  }

  baseline.summer.l2Volumes = aggregateL2Volumes(summerL2Volumes);
  baseline.winter.l2Volumes = aggregateL2Volumes(winterL2Volumes);
  
  function aggregateHolidayVolumes(holidayVolumes) {
    const result = {};
    for (const [categoryKey, volumesData] of Object.entries(holidayVolumes)) {
      result[categoryKey] = aggregateL2Volumes(volumesData);
    }
    return result;
  }
  
  baseline.summer.holidayVolumes = aggregateHolidayVolumes(summerHolidayVolumes);
  baseline.winter.holidayVolumes = aggregateHolidayVolumes(winterHolidayVolumes);
  
  function aggregateDayOfWeekVolumes(dayOfWeekVolumes) {
    const result = {};
    for (const [day, volumesData] of Object.entries(dayOfWeekVolumes)) {
      result[day] = aggregateL2Volumes(volumesData);
    }
    return result;
  }
  
  baseline.summer.dayOfWeekVolumes = aggregateDayOfWeekVolumes(summerDayOfWeekVolumes);
  baseline.winter.dayOfWeekVolumes = aggregateDayOfWeekVolumes(winterDayOfWeekVolumes);

  const baselineDir = path.dirname(baselinePath);
  if (!fs.existsSync(baselineDir)) {
    fs.mkdirSync(baselineDir, { recursive: true, mode: 0o755 });
  }

  fs.writeFileSync(baselinePath, JSON.stringify(baseline, null, 2));
  
  logger.info('Seasonal baseline generated', {
    airport,
    year,
    path: baselinePath,
    summerTimeSlots: Object.keys(baseline.summer.byTimeSlotLocal).length,
    winterTimeSlots: Object.keys(baseline.winter.byTimeSlotLocal).length,
  });

  console.log(`\n${'='.repeat(60)}`);
  console.log(`Seasonal Baseline for ${airport} in ${year}`);
  console.log('='.repeat(60));
  console.log(`Processed Days: ${processedDays} (Summer: ${summerDays}, Winter: ${winterDays})`);
  console.log(`Skipped Days: ${skippedDays}`);
  console.log(`DST Start: ${baseline.dstStart}`);
  console.log(`DST End: ${baseline.dstEnd}`);
  console.log(`Summer Time Slots: ${Object.keys(baseline.summer.byTimeSlotLocal).length}`);
  console.log(`Winter Time Slots: ${Object.keys(baseline.winter.byTimeSlotLocal).length}`);
  console.log(`Summer Holiday Categories: ${Object.keys(baseline.summer.holidayVolumes).length}`);
  console.log(`Winter Holiday Categories: ${Object.keys(baseline.winter.holidayVolumes).length}`);
  console.log(`Summer Day-of-Week Categories: ${Object.keys(baseline.summer.dayOfWeekVolumes).length}`);
  console.log(`Winter Day-of-Week Categories: ${Object.keys(baseline.winter.dayOfWeekVolumes).length}`);
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
    await generateBaseline(options.airport, options.year, options.force, options.localOnly);
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

