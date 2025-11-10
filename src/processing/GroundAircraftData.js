import fs from 'fs';
import path from 'path';
import { S3Client, PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { fromInstanceMetadata } from '@aws-sdk/credential-providers';
import logger from '../utils/logger.js';

/**
 * Stores and retrieves lists of aircraft that were on the ground at an airport
 */
class GroundAircraftData {
  constructor(config = {}) {
    this.bucketName = config.bucketName || process.env.S3_BUCKET_NAME || 'ayryx-adsb-history';
    this.region = config.region || process.env.AWS_REGION || 'us-west-1';
    this.cacheDir = config.cacheDir || './cache';
    this.useCache = config.useCache !== false;

    // Initialize S3 client
    const clientConfig = { region: this.region };
    const hasExplicitCredentials = process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY;
    
    if (hasExplicitCredentials) {
      // Explicit credentials provided - use them (for local development)
      clientConfig.credentials = {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
      };
    } else {
      // No explicit credentials - use instance metadata provider on EC2
      // This ensures we use the instance profile and don't pick up invalid credentials
      clientConfig.credentials = fromInstanceMetadata({
        maxRetries: 5,
        timeout: 10000,
      });
    }
    this.s3Client = new S3Client(clientConfig);
  }

  /**
   * Get S3 key for ground aircraft list
   */
  getS3Key(airport, date) {
    const [year, month, day] = date.split('-');
    return `ground-aircraft/${airport}/${year}/${month}/${day}.json`;
  }

  /**
   * Get local cache path
   */
  getCachePath(airport, date) {
    const [year, month, day] = date.split('-');
    return path.join(this.cacheDir, airport, year, month, `${day}.json`);
  }

  /**
   * Save ground aircraft list
   */
  async save(airport, date, aircraftIds) {
    const s3Key = this.getS3Key(airport, date);
    const cachePath = this.getCachePath(airport, date);

    console.log(`[${new Date().toISOString()}] Saving ground aircraft data for ${airport} on ${date}`);
    console.log(`  S3 Key: ${s3Key}`);
    console.log(`  Aircraft count: ${aircraftIds.length}`);

    const data = {
      airport,
      date,
      aircraftIds,
      count: aircraftIds.length,
      generatedAt: new Date().toISOString(),
    };

    const jsonData = JSON.stringify(data, null, 2);

    try {
      // Save to S3
      console.log(`[${new Date().toISOString()}] Uploading to S3: ${s3Key}`);
      const command = new PutObjectCommand({
        Bucket: this.bucketName,
        Key: s3Key,
        Body: jsonData,
        ContentType: 'application/json',
      });

      await this.s3Client.send(command);
      console.log(`[${new Date().toISOString()}] ✓ Successfully uploaded to S3: ${s3Key}`);
      logger.info('Saved to S3', { s3Key, count: aircraftIds.length });

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
      logger.error('Failed to save ground aircraft data', {
        airport,
        date,
        s3Key,
        error: error.message,
      });
      throw error;
    }
  }

  /**
   * Load ground aircraft list from cache or S3
   */
  async load(airport, date) {
    const s3Key = this.getS3Key(airport, date);
    const cachePath = this.getCachePath(airport, date);

    // Try cache first
    if (this.useCache && fs.existsSync(cachePath)) {
      try {
        const jsonData = fs.readFileSync(cachePath, 'utf-8');
        const data = JSON.parse(jsonData);
        if (data && Array.isArray(data.aircraftIds)) {
          logger.info('Loaded from cache', { airport, date, count: data.aircraftIds.length });
          return data.aircraftIds;
        }
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

      logger.info('Loaded from S3', { airport, date, count: data.aircraftIds.length });
      return data.aircraftIds;

    } catch (error) {
      if (error.name === 'NoSuchKey') {
        logger.info('Ground aircraft data not found', { airport, date, s3Key });
        return null;
      }
      
      logger.error('Failed to load ground aircraft data', {
        airport,
        date,
        s3Key,
        error: error.message,
      });
      throw error;
    }
  }

  /**
   * Check if ground aircraft data exists
   */
  async exists(airport, date) {
    const data = await this.load(airport, date);
    return data !== null;
  }
}

export default GroundAircraftData;

