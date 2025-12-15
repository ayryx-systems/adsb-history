#!/usr/bin/env node

/**
 * Check for baseline files and regenerate them if missing or outdated
 * 
 * Usage:
 *   node scripts/check-and-regenerate-baselines.js [--force] [--local-only]
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const airports = ['KORD', 'KLGA', 'KLAX', 'KSFO'];
const years = ['2024', '2025'];

function checkL2StatsExists(airport) {
  const cacheDir = path.join(process.cwd(), 'cache', airport);
  if (!fs.existsSync(cacheDir)) {
    return false;
  }
  
  // Check for any L2 stats files
  const l2StatsPattern = path.join(cacheDir, '**', 'l2-stats-*.json');
  try {
    const result = execSync(`find ${cacheDir} -name "l2-stats-*.json" 2>/dev/null | head -1`, { encoding: 'utf8' });
    return result.trim().length > 0;
  } catch (error) {
    return false;
  }
}

function checkBaselineExists(airport) {
  const baselinePath = path.join(process.cwd(), 'cache', airport, 'overall', 'baseline.json');
  return fs.existsSync(baselinePath);
}

function getBaselineAge(airport) {
  const baselinePath = path.join(process.cwd(), 'cache', airport, 'overall', 'baseline.json');
  if (!fs.existsSync(baselinePath)) {
    return null;
  }
  
  const stats = fs.statSync(baselinePath);
  return stats.mtime;
}

function regenerateBaseline(airport, force, localOnly) {
  console.log(`\nRegenerating baseline for ${airport}...`);
  const args = [
    'scripts/analysis/generate-yearly-baseline.js',
    '--airport', airport,
    '--years', ...years
  ];
  
  if (force) {
    args.push('--force');
  }
  
  if (localOnly) {
    args.push('--local-only');
  }
  
  try {
    execSync(`node ${args.join(' ')}`, { 
      stdio: 'inherit',
      cwd: process.cwd()
    });
    console.log(`✓ Baseline regenerated for ${airport}`);
    return true;
  } catch (error) {
    console.error(`✗ Failed to regenerate baseline for ${airport}:`, error.message);
    return false;
  }
}

function main() {
  const args = process.argv.slice(2);
  const force = args.includes('--force');
  const localOnly = args.includes('--local-only');
  
  console.log('Checking baseline files for all airports...\n');
  
  for (const airport of airports) {
    const hasL2Stats = checkL2StatsExists(airport);
    const hasBaseline = checkBaselineExists(airport);
    const baselineAge = getBaselineAge(airport);
    
    console.log(`${airport}:`);
    console.log(`  L2 Stats available: ${hasL2Stats ? '✓' : '✗'}`);
    console.log(`  Baseline exists: ${hasBaseline ? '✓' : '✗'}`);
    
    if (baselineAge) {
      const ageDays = Math.floor((Date.now() - baselineAge.getTime()) / (1000 * 60 * 60 * 24));
      console.log(`  Baseline age: ${ageDays} days`);
    }
    
    if (!hasL2Stats) {
      console.log(`  ⚠ Skipping ${airport}: No L2 stats files found (need to generate L2 stats first)`);
      continue;
    }
    
    if (!hasBaseline || force) {
      if (force) {
        console.log(`  → Regenerating baseline (--force specified)...`);
      } else {
        console.log(`  → Baseline missing, generating...`);
      }
      regenerateBaseline(airport, force, localOnly);
    } else {
      console.log(`  ✓ Baseline up to date`);
    }
  }
  
  console.log('\n✓ Baseline check complete');
}

main();

