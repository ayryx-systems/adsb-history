import fs from 'fs';
import { execSync } from 'child_process';
import logger from './logger.js';

/**
 * Check available disk space for a given path
 * @param {string} path - Path to check disk space for
 * @returns {object} { availableGB, totalGB, usedGB, percentUsed }
 */
export function getDiskSpace(path) {
  try {
    const stats = fs.statSync(path);
    const dfOutput = execSync(`df -BG "${path}"`, { encoding: 'utf-8' });
    const lines = dfOutput.trim().split('\n');
    
    if (lines.length < 2) {
      throw new Error('Unexpected df output format');
    }
    
    const parts = lines[1].split(/\s+/);
    const totalGB = parseInt(parts[1].replace('G', ''), 10);
    const usedGB = parseInt(parts[2].replace('G', ''), 10);
    const availableGB = parseInt(parts[3].replace('G', ''), 10);
    const percentUsed = parseInt(parts[4].replace('%', ''), 10);
    
    return {
      availableGB,
      totalGB,
      usedGB,
      percentUsed,
    };
  } catch (error) {
    logger.warn('Failed to check disk space', {
      path,
      error: error.message,
    });
    return null;
  }
}

/**
 * Check if there's enough disk space available
 * @param {string} path - Path to check
 * @param {number} requiredGB - Required space in GB
 * @returns {object} { hasSpace: boolean, availableGB: number, requiredGB: number }
 */
export function checkDiskSpace(path, requiredGB) {
  const space = getDiskSpace(path);
  
  if (!space) {
    return {
      hasSpace: true,
      availableGB: null,
      requiredGB,
      warning: 'Could not check disk space',
    };
  }
  
  const hasSpace = space.availableGB >= requiredGB;
  
  if (!hasSpace) {
    logger.warn('Insufficient disk space', {
      path,
      availableGB: space.availableGB,
      requiredGB,
      totalGB: space.totalGB,
      usedGB: space.usedGB,
      percentUsed: space.percentUsed,
    });
  }
  
  return {
    hasSpace,
    availableGB: space.availableGB,
    requiredGB,
    totalGB: space.totalGB,
    usedGB: space.usedGB,
    percentUsed: space.percentUsed,
  };
}

/**
 * Log disk space information
 * @param {string} path - Path to check
 */
export function logDiskSpace(path) {
  const space = getDiskSpace(path);
  
  if (space) {
    logger.info('Disk space', {
      path,
      availableGB: space.availableGB,
      totalGB: space.totalGB,
      usedGB: space.usedGB,
      percentUsed: space.percentUsed,
    });
  }
}

