import { S3Client, PutObjectCommand, GetObjectCommand, ListObjectsV2Command } from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import fs from 'fs';
import path from 'path';
import logger from './logger.js';

/**
 * S3 utility functions for uploading and managing ADSB historical data
 */
class S3Manager {
  constructor(config = {}) {
    this.bucketName = config.bucketName || process.env.S3_BUCKET_NAME || 'ayryx-adsb-history';
    this.region = config.region || process.env.AWS_REGION || 'us-west-1';
    
    //Note: On EC2 with IAM role, credentials are automatically provided by AWS SDK
    // On local machine, credentials come from env vars or ~/.aws/credentials
    const clientConfig = {
      region: this.region,
    };
    
    // Only set explicit credentials if they're provided (local development)
    if (process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY) {
      clientConfig.credentials = {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
      };
    }
    
    this.client = new S3Client(clientConfig);
    
    logger.info('S3Manager initialized', { bucket: this.bucketName, region: this.region });
  }

  /**
   * Upload a file to S3
   * @param {string} localFilePath - Path to local file
   * @param {string} s3Key - S3 key (path within bucket)
   * @param {object} options - Additional options
   */
  async uploadFile(localFilePath, s3Key, options = {}) {
    try {
      const fileStream = fs.createReadStream(localFilePath);
      const fileStats = fs.statSync(localFilePath);
      
      logger.info('Starting S3 upload', {
        file: path.basename(localFilePath),
        size: fileStats.size,
        destination: s3Key,
      });

      const upload = new Upload({
        client: this.client,
        params: {
          Bucket: this.bucketName,
          Key: s3Key,
          Body: fileStream,
          ContentType: options.contentType || 'application/octet-stream',
          ...options.additionalParams,
        },
        queueSize: 4,
        partSize: 1024 * 1024 * 5, // 5MB parts
        leavePartsOnError: false,
      });

      upload.on('httpUploadProgress', (progress) => {
        const percent = Math.round((progress.loaded / progress.total) * 100);
        if (percent % 10 === 0) {
          logger.debug('Upload progress', {
            file: path.basename(localFilePath),
            progress: `${percent}%`,
          });
        }
      });

      await upload.done();
      
      logger.info('S3 upload completed', {
        file: path.basename(localFilePath),
        destination: s3Key,
      });
      
      return { success: true, key: s3Key };
    } catch (error) {
      logger.error('S3 upload failed', {
        file: localFilePath,
        destination: s3Key,
        error: error.message,
      });
      throw error;
    }
  }

  /**
   * Check if an object exists in S3
   * @param {string} s3Key - S3 key to check
   */
  async objectExists(s3Key) {
    try {
      await this.client.send(
        new GetObjectCommand({
          Bucket: this.bucketName,
          Key: s3Key,
        })
      );
      return true;
    } catch (error) {
      if (error.name === 'NoSuchKey') {
        return false;
      }
      throw error;
    }
  }

  /**
   * List objects with a given prefix
   * @param {string} prefix - S3 key prefix
   */
  async listObjects(prefix) {
    try {
      const response = await this.client.send(
        new ListObjectsV2Command({
          Bucket: this.bucketName,
          Prefix: prefix,
        })
      );
      return response.Contents || [];
    } catch (error) {
      logger.error('Failed to list S3 objects', {
        prefix,
        error: error.message,
      });
      throw error;
    }
  }

  /**
   * Generate S3 key for raw data
   * @param {string} date - ISO date string (YYYY-MM-DD or YYYY.MM.DD)
   * @param {string} filename - Original filename
   */
  getRawDataKey(date, filename) {
    // Normalize date format to YYYY-MM-DD
    const normalizedDate = date.replace(/\./g, '-');
    const [year, month, day] = normalizedDate.split('-');
    return `raw/${year}/${month}/${day}/${filename}`;
  }
}

// Export singleton instance for convenience
const s3Manager = new S3Manager();

export default s3Manager;
export { S3Manager };

