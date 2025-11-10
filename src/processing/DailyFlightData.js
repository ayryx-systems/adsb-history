import fs from 'fs';
import path from 'path';
import { S3Client, PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import logger from '../utils/logger.js';

/**
 * Abstraction layer for processed flight data
 * 
 * Stores processed flight information (not raw traces) to avoid
 * reprocessing on every query. Data is stored in S3 as JSON.
 * 
 * Structure:
 *   s3://bucket/processed/AIRPORT/YYYY/MM/DD.json
 * 
 * This is the "database" layer that applications query.
 */
class DailyFlightData {
  constructor(config = {}) {
    this.bucketName = config.bucketName || process.env.S3_BUCKET_NAME || 'ayryx-adsb-history';
    this.region = config.region || process.env.AWS_REGION || 'us-west-1';
    this.cacheDir = config.cacheDir || './cache';
    this.useCache = config.useCache !== false;
    
    // Initialize S3 client
    // Don't set credentials - let SDK use default credential chain
    // This will automatically use instance profile on EC2
    const clientConfig = { region: this.region };
    
    // Only set explicit credentials if provided (for local development)
    // Otherwise, SDK will use default chain: env vars -> credentials file -> instance metadata
    if (process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY) {
      clientConfig.credentials = {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
      };
    }
    // If no explicit credentials, SDK will automatically use instance profile on EC2
    
    this.s3Client = new S3Client(clientConfig);
  }

  /**
   * Get S3 key for processed data
   */
  getS3Key(airport, date) {
    const [year, month, day] = date.split('-');
    return `processed/${airport}/${year}/${month}/${day}.json`;
  }

  /**
   * Get local cache path for processed data
   */
  getCachePath(airport, date) {
    const [year, month, day] = date.split('-');
    return path.join(this.cacheDir, airport, year, month, `${day}.json`);
  }

  /**
   * Save processed flight data to S3 and cache
   */
  async save(airport, date, data) {
    const s3Key = this.getS3Key(airport, date);

    logger.info('Saving processed flight data', {
      airport,
      date,
      s3Key,
      flights: data.statistics.total,
    });

    try {
      // Add metadata
      const dataWithMeta = {
        ...data,
        metadata: {
          processedAt: new Date().toISOString(),
          version: '1.0',
        },
      };

      const jsonData = JSON.stringify(dataWithMeta, null, 2);

      // Save to S3
      const command = new PutObjectCommand({
        Bucket: this.bucketName,
        Key: s3Key,
        Body: jsonData,
        ContentType: 'application/json',
        Metadata: {
          airport,
          date,
          flights: String(data.statistics.total),
          arrivals: String(data.statistics.arrivals),
          departures: String(data.statistics.departures),
        },
      });

      await this.s3Client.send(command);
      logger.info('Saved to S3', { s3Key });

      // Save to local cache
      if (this.useCache) {
        const cachePath = this.getCachePath(airport, date);
        const cacheDir = path.dirname(cachePath);
        
        if (!fs.existsSync(cacheDir)) {
          fs.mkdirSync(cacheDir, { recursive: true, mode: 0o755 });
        }
        
        fs.writeFileSync(cachePath, jsonData);
        logger.info('Saved to cache', { cachePath });
      }

      return dataWithMeta;

    } catch (error) {
      logger.error('Failed to save processed data', {
        airport,
        date,
        s3Key,
        error: error.message,
      });
      throw error;
    }
  }

  /**
   * Load processed flight data from cache or S3
   */
  async load(airport, date) {
    const s3Key = this.getS3Key(airport, date);
    const cachePath = this.getCachePath(airport, date);

    // Try cache first
    if (this.useCache && fs.existsSync(cachePath)) {
      try {
        const jsonData = fs.readFileSync(cachePath, 'utf-8');
        logger.info('Loaded from cache', { airport, date, cachePath });
        return JSON.parse(jsonData);
      } catch (error) {
        logger.warn('Failed to load from cache, trying S3', {
          airport,
          date,
          error: error.message,
        });
      }
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

      logger.info('Loaded from S3', { airport, date, flights: data.statistics.total });
      return data;

    } catch (error) {
      if (error.name === 'NoSuchKey') {
        logger.info('Processed data not found', { airport, date, s3Key });
        return null;
      }
      
      logger.error('Failed to load processed data', {
        airport,
        date,
        s3Key,
        error: error.message,
      });
      throw error;
    }
  }

  /**
   * Check if processed data exists
   */
  async exists(airport, date) {
    const data = await this.load(airport, date);
    return data !== null;
  }

  /**
   * Get arrivals for an airport on a date
   */
  async getArrivals(airport, date) {
    const data = await this.load(airport, date);
    return data ? data.flights.arrivals : null;
  }

  /**
   * Get departures for an airport on a date
   */
  async getDepartures(airport, date) {
    const data = await this.load(airport, date);
    return data ? data.flights.departures : null;
  }

  /**
   * Get statistics for an airport on a date
   */
  async getStatistics(airport, date) {
    const data = await this.load(airport, date);
    return data ? data.statistics : null;
  }
}

export default DailyFlightData;

