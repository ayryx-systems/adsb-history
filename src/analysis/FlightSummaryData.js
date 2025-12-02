import fs from 'fs';
import path from 'path';
import { S3Client, PutObjectCommand, GetObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3';
import logger from '../utils/logger.js';

/**
 * Stores and retrieves flight summary data (detailed analysis results)
 * 
 * S3 Structure:
 *   s3://bucket/flight-summaries/AIRPORT/YYYY/MM/DD.json
 */
class FlightSummaryData {
  constructor(config = {}) {
    this.bucketName = config.bucketName || process.env.S3_BUCKET_NAME || 'ayryx-adsb-history';
    this.region = config.region || process.env.AWS_REGION || 'us-west-1';
    this.cacheDir = config.cacheDir || './cache';
    this.useCache = config.useCache !== false;

    // Initialize S3 client
    const clientConfig = { region: this.region };
    
    if (process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY) {
      clientConfig.credentials = {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
      };
    }
    
    this.s3Client = new S3Client(clientConfig);
  }

  /**
   * Get S3 key for flight summary data
   */
  getS3Key(airport, date) {
    const [year, month, day] = date.split('-');
    return `flight-summaries/${airport}/${year}/${month}/${day}.json`;
  }

  /**
   * Get local cache path
   */
  getCachePath(airport, date) {
    const [year, month, day] = date.split('-');
    return path.join(this.cacheDir, airport, year, month, `summary-${day}.json`);
  }

  /**
   * Save flight summary data
   */
  async save(airport, date, summaryData) {
    const s3Key = this.getS3Key(airport, date);
    const cachePath = this.getCachePath(airport, date);

    logger.info('Saving flight summary data', {
      airport,
      date,
      s3Key,
      flights: summaryData.flights?.length || 0,
    });

    const data = {
      airport,
      date,
      generatedAt: new Date().toISOString(),
      ...summaryData,
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
      logger.info('Saved to S3', { s3Key });

      // Save to cache
      if (this.useCache) {
        const cacheDir = path.dirname(cachePath);
        if (!fs.existsSync(cacheDir)) {
          fs.mkdirSync(cacheDir, { recursive: true, mode: 0o755 });
        }
        fs.writeFileSync(cachePath, jsonData);
        logger.info('Saved to cache', { cachePath });
      }
    } catch (error) {
      logger.error('Failed to save flight summary data', {
        airport,
        date,
        s3Key,
        error: error.message,
      });
      throw error;
    }
  }

  /**
   * Load flight summary data from cache or S3
   */
  async load(airport, date) {
    const s3Key = this.getS3Key(airport, date);
    const cachePath = this.getCachePath(airport, date);

    // Try cache first
    if (this.useCache && fs.existsSync(cachePath)) {
      try {
        const jsonData = fs.readFileSync(cachePath, 'utf-8');
        const data = JSON.parse(jsonData);
        logger.info('Loaded from cache', { airport, date, cachePath });
        return data;
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

      logger.info('Loaded from S3', { airport, date });
      return data;

    } catch (error) {
      if (error.name === 'NoSuchKey') {
        logger.info('Flight summary data not found', { airport, date, s3Key });
        return null;
      }
      
      logger.error('Failed to load flight summary data', {
        airport,
        date,
        s3Key,
        error: error.message,
      });
      throw error;
    }
  }

  /**
   * Check if flight summary data exists
   */
  async exists(airport, date) {
    const cachePath = this.getCachePath(airport, date);
    
    if (this.useCache && fs.existsSync(cachePath)) {
      return true;
    }
    
    const s3Key = this.getS3Key(airport, date);
    try {
      const command = new HeadObjectCommand({
        Bucket: this.bucketName,
        Key: s3Key,
      });
      await this.s3Client.send(command);
      return true;
    } catch (error) {
      if (error.name === 'NotFound' || error.name === 'NoSuchKey') {
        return false;
      }
      logger.warn('Failed to check if flight summary exists, falling back to load', {
        airport,
        date,
        error: error.message,
      });
      const data = await this.load(airport, date);
      return data !== null;
    }
  }
}

export default FlightSummaryData;

