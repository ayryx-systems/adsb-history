import fs from 'fs';
import path from 'path';
import { S3Client, PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import logger from '../../utils/logger.js';

/**
 * Stores and retrieves L2 statistics data (time-of-day volumes)
 * 
 * S3 Structure:
 *   s3://bucket/l2-stats/AIRPORT/YYYY/MM/DD.json
 * 
 * Local Cache Structure:
 *   cache/AIRPORT/YYYY/MM/l2-stats-DD.json
 */
class L2StatsData {
  constructor(config = {}) {
    this.bucketName = config.bucketName || process.env.S3_BUCKET_NAME || 'ayryx-adsb-history';
    this.region = config.region || process.env.AWS_REGION || 'us-west-1';
    this.cacheDir = config.cacheDir || './cache';
    this.useCache = config.useCache !== false;
    this.localOnly = config.localOnly || false;

    // Initialize S3 client only if not local-only
    if (!this.localOnly) {
      const clientConfig = { region: this.region };
      
      if (process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY) {
        clientConfig.credentials = {
          accessKeyId: process.env.AWS_ACCESS_KEY_ID,
          secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
        };
      }
      
      this.s3Client = new S3Client(clientConfig);
    }
  }

  /**
   * Get S3 key for L2 stats data
   */
  getS3Key(airport, date) {
    const [year, month, day] = date.split('-');
    return `l2-stats/${airport}/${year}/${month}/${day}.json`;
  }

  /**
   * Get local cache path
   */
  getCachePath(airport, date) {
    const [year, month, day] = date.split('-');
    return path.join(this.cacheDir, airport, year, month, `l2-stats-${day}.json`);
  }

  /**
   * Save L2 stats data
   */
  async save(airport, date, l2Data) {
    const s3Key = this.getS3Key(airport, date);
    const cachePath = this.getCachePath(airport, date);

    logger.info('Saving L2 stats data', {
      airport,
      date,
      s3Key,
      volumes: l2Data.volumes,
    });

    const data = {
      ...l2Data,
    };

    const jsonData = JSON.stringify(data, null, 2);

    try {
      // Save to S3
      const command = new PutObjectCommand({
        Bucket: this.bucketName,
        Key: s3Key,
        Body: jsonData,
        ContentType: 'application/json',
      });

      await this.s3Client.send(command);
      logger.debug('Saved to S3', { s3Key });

      // Save to cache
      if (this.useCache) {
        const cacheDir = path.dirname(cachePath);
        if (!fs.existsSync(cacheDir)) {
          fs.mkdirSync(cacheDir, { recursive: true, mode: 0o755 });
        }
        fs.writeFileSync(cachePath, jsonData);
        logger.debug('Saved to cache', { cachePath });
      }
    } catch (error) {
      logger.error('Failed to save L2 stats data', {
        airport,
        date,
        s3Key,
        error: error.message,
      });
      throw error;
    }
  }

  /**
   * Load L2 stats data from cache or S3
   */
  async load(airport, date) {
    const s3Key = this.getS3Key(airport, date);
    const cachePath = this.getCachePath(airport, date);

    // Try cache first
    if (this.useCache && fs.existsSync(cachePath)) {
      try {
        const jsonData = fs.readFileSync(cachePath, 'utf-8');
        const data = JSON.parse(jsonData);
        logger.debug('Loaded from cache', { airport, date });
        return data;
      } catch (error) {
        if (this.localOnly) {
          logger.debug('Failed to load from cache (local-only mode)', {
            airport,
            date,
            error: error.message,
          });
          return null;
        }
        logger.warn('Failed to load from cache, trying S3', {
          airport,
          date,
          error: error.message,
        });
      }
    }

    // If local-only mode, don't try S3
    if (this.localOnly) {
      logger.debug('L2 stats data not found locally (local-only mode)', { airport, date });
      return null;
    }

    // Load from S3
    try {
      logger.info('Loading from S3', { airport, date, s3Key });
      
      const command = new GetObjectCommand({
        Bucket: this.bucketName,
        Key: s3Key,
      });

      const response = await this.s3Client.send(command);
      const jsonData = await response.Body.transformToString();
      const data = JSON.parse(jsonData);

      // Save to cache for future use
      if (this.useCache) {
        const cacheDir = path.dirname(cachePath);
        if (!fs.existsSync(cacheDir)) {
          fs.mkdirSync(cacheDir, { recursive: true, mode: 0o755 });
        }
        fs.writeFileSync(cachePath, jsonData);
        logger.info('Cached data from S3', { cachePath });
      }

      logger.info('Loaded from S3', { airport, date });
      return data;

    } catch (error) {
      if (error.name === 'NoSuchKey') {
        logger.info('L2 stats data not found', { airport, date, s3Key });
        return null;
      }
      
      logger.error('Failed to load L2 stats data', {
        airport,
        date,
        s3Key,
        error: error.message,
      });
      throw error;
    }
  }

  /**
   * Check if L2 stats data exists
   */
  async exists(airport, date) {
    const data = await this.load(airport, date);
    return data !== null;
  }
}

export default L2StatsData;

