import axios from 'axios';
import fs from 'fs';
import path from 'path';
import { pipeline } from 'stream/promises';
import logger from '../utils/logger.js';

/**
 * Downloads ADS-B data from adsblol/globe_history_YYYY GitHub releases
 * 
 * Repository is determined by year (e.g., adsblol/globe_history_2024, adsblol/globe_history_2025)
 * Release naming: vYYYY.MM.DD-planes-readsb-prod-0
 * Assets: .tar.aa (2GB) and .tar.ab (1GB) - must be concatenated before extraction
 */
class GitHubReleaseDownloader {
  constructor(config = {}) {
    this.repo = config.repo || process.env.GITHUB_REPO || 'adsblol/globe_history_2025';
    this.tempDir = config.tempDir || process.env.TEMP_DIR || './temp';
    
    this.axiosConfig = {
      headers: {
        'Accept': 'application/vnd.github+json',
      },
      timeout: 60000, // 60 second timeout
    };
    
    // Ensure temp directory exists
    if (!fs.existsSync(this.tempDir)) {
      fs.mkdirSync(this.tempDir, { recursive: true });
      logger.info('Created temp directory', { path: this.tempDir });
    }
  }

  /**
   * Format date for release tag
   * @param {Date|string} date - Date object or ISO string
   * @param {boolean} withTmp - Whether to add "tmp" suffix
   * @returns {string} Formatted as v2025.11.08-planes-readsb-prod-0 or v2025.11.08-planes-readsb-prod-0tmp
   */
  formatReleaseTag(date, withTmp = false) {
    let dateStr;
    if (typeof date === 'string') {
      // If already a string in YYYY-MM-DD format, use it directly
      dateStr = date;
    } else {
      // Convert Date to ISO string and extract date part
      dateStr = date.toISOString().split('T')[0];
    }
    
    // Parse the date string to avoid timezone issues
    const [year, month, day] = dateStr.split('-');
    const suffix = withTmp ? 'tmp' : '';
    return `v${year}.${month}.${day}-planes-readsb-prod-0${suffix}`;
  }

  /**
   * Get release information by date
   * Tries standard format first, then falls back to "tmp" suffix variant
   * @param {Date|string} date - Date to fetch
   * @returns {object|null} Release data or null if not found
   */
  async getReleaseByDate(date) {
    const standardTag = this.formatReleaseTag(date, false);
    const tmpTag = this.formatReleaseTag(date, true);
    
    // Try standard format first
    const tags = [standardTag, tmpTag];
    
    for (const tag of tags) {
      const url = `https://api.github.com/repos/${this.repo}/releases/tags/${tag}`;
      
      logger.info('Fetching release info', { tag, repo: this.repo, url });
      
      try {
        const response = await axios.get(url, this.axiosConfig);
        logger.info('Release found', { tag, repo: this.repo });
        return { ...response.data, _tag: tag };
      } catch (error) {
        if (error.response?.status === 404) {
          logger.warn('Release not found', { tag, repo: this.repo, url });
          continue;
        }
        logger.error('Failed to fetch release', {
          tag,
          repo: this.repo,
          url,
          error: error.message,
        });
        throw error;
      }
    }
    
    logger.warn('No release found for any tag variant', { 
      standardTag, 
      tmpTag, 
      repo: this.repo 
    });
    return null;
  }

  /**
   * Download a single asset file
   * @param {object} asset - GitHub asset object
   * @param {string} outputPath - Where to save the file
   */
  async downloadAsset(asset, outputPath) {
    logger.info('Downloading asset', {
      name: asset.name,
      size: `${(asset.size / 1024 / 1024 / 1024).toFixed(2)} GB`,
    });

    try {
      const response = await axios({
        method: 'GET',
        url: asset.browser_download_url,
        responseType: 'stream',
        headers: {
          'Accept': 'application/octet-stream',
        },
        timeout: 0, // No timeout for large downloads
      });

      // Track progress
      let downloadedBytes = 0;
      const totalBytes = asset.size;
      let lastLoggedPercent = 0;

      response.data.on('data', (chunk) => {
        downloadedBytes += chunk.length;
        const percent = Math.floor((downloadedBytes / totalBytes) * 100);
        
        if (percent >= lastLoggedPercent + 10) {
          logger.info('Download progress', {
            file: asset.name,
            progress: `${percent}%`,
            downloaded: `${(downloadedBytes / 1024 / 1024 / 1024).toFixed(2)} GB`,
          });
          lastLoggedPercent = percent;
        }
      });

      await pipeline(response.data, fs.createWriteStream(outputPath));
      
      logger.info('Asset downloaded successfully', {
        name: asset.name,
        path: outputPath,
      });
      
      return outputPath;
    } catch (error) {
      logger.error('Failed to download asset', {
        name: asset.name,
        error: error.message,
      });
      throw error;
    }
  }

  /**
   * Download split tar files for a given date and concatenate them
   * @param {Date|string} date - Date to download
   * @returns {string} Path to concatenated tar file
   */
  async downloadDate(date) {
    const release = await this.getReleaseByDate(date);
    
    if (!release) {
      throw new Error(`No release found for date: ${date}`);
    }

    const tag = release._tag || this.formatReleaseTag(date, false);
    const baseName = tag;
    
    // Log available assets for debugging
    logger.info('Release assets', { 
      tag, 
      assets: release.assets.map(a => a.name),
      assetCount: release.assets.length 
    });
    
    // Check for split files (2025 format) or single tar file (2024 format)
    const aaAsset = release.assets.find(a => a.name === `${baseName}.tar.aa`);
    const abAsset = release.assets.find(a => a.name === `${baseName}.tar.ab`);
    const singleTarAsset = release.assets.find(a => a.name === `${baseName}.tar`);

    const dateStr = typeof date === 'string' ? date : date.toISOString().split('T')[0];
    const downloadDir = path.join(this.tempDir, dateStr);
    
    if (!fs.existsSync(downloadDir)) {
      fs.mkdirSync(downloadDir, { recursive: true });
    }

    const tarPath = path.join(downloadDir, `${baseName}.tar`);

    // Handle split files (2025 format)
    if (aaAsset && abAsset) {
      logger.info('Downloading split tar files', { date: dateStr, tag });
      
      const aaPath = path.join(downloadDir, `${baseName}.tar.aa`);
      const abPath = path.join(downloadDir, `${baseName}.tar.ab`);

      await this.downloadAsset(aaAsset, aaPath);
      await this.downloadAsset(abAsset, abPath);

      // Concatenate the files
      logger.info('Concatenating tar files', { output: tarPath });
      
      const writeStream = fs.createWriteStream(tarPath);
      await pipeline(fs.createReadStream(aaPath), writeStream, { end: false });
      await pipeline(fs.createReadStream(abPath), writeStream);

      logger.info('Tar files concatenated successfully', { path: tarPath });

      // Clean up split files
      fs.unlinkSync(aaPath);
      fs.unlinkSync(abPath);
      logger.debug('Cleaned up split tar files');
    }
    // Handle single tar file (2024 format)
    else if (singleTarAsset) {
      logger.info('Downloading single tar file', { date: dateStr, tag });
      await this.downloadAsset(singleTarAsset, tarPath);
      logger.info('Tar file downloaded successfully', { path: tarPath });
    }
    else {
      throw new Error(`Missing tar files for ${tag}. Found: ${release.assets.map(a => a.name).join(', ')}`);
    }

    return tarPath;
  }

  /**
   * Download multiple dates
   * @param {Array<Date|string>} dates - Array of dates to download
   * @returns {Array<string>} Paths to downloaded tar files
   */
  async downloadMultipleDates(dates) {
    const results = [];
    
    for (const date of dates) {
      try {
        const tarPath = await this.downloadDate(date);
        results.push({ date, tarPath, success: true });
      } catch (error) {
        logger.error('Failed to download date', {
          date,
          error: error.message,
        });
        results.push({ date, error: error.message, success: false });
      }
    }
    
    return results;
  }

  /**
   * Generate array of dates for a date range
   * @param {Date|string} startDate - Start date (inclusive)
   * @param {Date|string} endDate - End date (inclusive)
   * @returns {Array<string>} Array of ISO date strings
   */
  static getDateRange(startDate, endDate) {
    const dates = [];
    const start = new Date(startDate);
    const end = new Date(endDate);
    
    for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
      dates.push(d.toISOString().split('T')[0]);
    }
    
    return dates;
  }
}

export default GitHubReleaseDownloader;

