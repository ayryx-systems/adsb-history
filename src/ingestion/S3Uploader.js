import fs from 'fs';
import path from 'path';
import { S3Manager } from '../utils/s3.js';
import logger from '../utils/logger.js';
import pLimit from 'p-limit';

/**
 * Handles uploading raw ADSB data to S3
 * Organized by date: raw/YYYY/MM/DD/
 */
class S3Uploader {
  constructor(config = {}) {
    this.s3Manager = new S3Manager(config);
    this.maxConcurrentUploads = config.maxConcurrentUploads || parseInt(process.env.MAX_CONCURRENT_UPLOADS) || 4;
    this.limit = pLimit(this.maxConcurrentUploads);
  }

  /**
   * Upload a tar file to S3 raw storage
   * @param {string} tarPath - Path to local tar file
   * @param {string} date - ISO date string (YYYY-MM-DD or YYYY.MM.DD)
   * @returns {object} Upload result
   */
  async uploadTarFile(tarPath, date) {
    const originalFilename = path.basename(tarPath);
    const filename = originalFilename.replace(/tmp(?=\.tar$)/, '');
    
    if (originalFilename !== filename) {
      logger.info('Normalizing filename by removing "tmp" suffix', {
        original: originalFilename,
        normalized: filename,
      });
    }
    
    const s3Key = this.s3Manager.getRawDataKey(date, filename);

    // Check if already uploaded
    const exists = await this.s3Manager.objectExists(s3Key);
    if (exists) {
      logger.info('File already exists in S3, skipping upload', {
        file: filename,
        s3Key,
      });
      return { success: true, key: s3Key, skipped: true };
    }

    // Upload the file
    logger.info('Uploading tar file to S3', {
      file: filename,
      date,
      s3Key,
    });

    try {
      const result = await this.s3Manager.uploadFile(tarPath, s3Key, {
        contentType: 'application/x-tar',
      });
      
      return { ...result, skipped: false };
    } catch (error) {
      logger.error('Failed to upload tar file', {
        file: filename,
        s3Key,
        error: error.message,
      });
      throw error;
    }
  }

  /**
   * Upload extracted data directory to S3
   * @param {string} extractDir - Directory containing extracted data
   * @param {string} date - ISO date string
   * @param {object} options - Upload options
   */
  async uploadExtractedData(extractDir, date, options = {}) {
    const { uploadChunks = false } = options;

    logger.info('Uploading extracted data to S3', {
      date,
      extractDir,
      uploadChunks,
    });

    const uploadTasks = [];

    // Upload aircraft.json if it exists
    const aircraftPath = path.join(extractDir, 'aircraft.json');
    if (fs.existsSync(aircraftPath)) {
      const s3Key = this.s3Manager.getRawDataKey(date, 'extracted/aircraft.json');
      uploadTasks.push(
        this.limit(() => this._uploadSingleFile(aircraftPath, s3Key))
      );
    }

    // Upload trace files if requested
    if (uploadChunks) {
      const chunksDir = path.join(extractDir, 'chunks');
      if (fs.existsSync(chunksDir)) {
        const uploadChunkTasks = await this._getChunkUploadTasks(chunksDir, date);
        uploadTasks.push(...uploadChunkTasks);
      }
    }

    // Execute uploads in parallel with concurrency limit
    const results = await Promise.all(uploadTasks);
    
    const summary = {
      total: results.length,
      successful: results.filter(r => r.success).length,
      failed: results.filter(r => !r.success).length,
      skipped: results.filter(r => r.skipped).length,
    };

    logger.info('Extracted data upload completed', summary);
    
    return summary;
  }

  /**
   * Get upload tasks for all chunk files
   * @private
   */
  async _getChunkUploadTasks(chunksDir, date) {
    const tasks = [];
    
    const chunkSubdirs = fs.readdirSync(chunksDir)
      .filter(name => {
        const fullPath = path.join(chunksDir, name);
        return fs.statSync(fullPath).isDirectory();
      });

    for (const subdir of chunkSubdirs) {
      const chunkPath = path.join(chunksDir, subdir);
      const files = fs.readdirSync(chunkPath)
        .filter(f => f.endsWith('.json'));

      for (const file of files) {
        const filePath = path.join(chunkPath, file);
        const s3Key = this.s3Manager.getRawDataKey(date, `extracted/chunks/${subdir}/${file}`);
        
        tasks.push(
          this.limit(() => this._uploadSingleFile(filePath, s3Key))
        );
      }
    }

    return tasks;
  }

  /**
   * Upload a single file
   * @private
   */
  async _uploadSingleFile(localPath, s3Key) {
    try {
      // Check if already exists
      const exists = await this.s3Manager.objectExists(s3Key);
      if (exists) {
        return { success: true, key: s3Key, skipped: true };
      }

      await this.s3Manager.uploadFile(localPath, s3Key, {
        contentType: 'application/json',
      });
      
      return { success: true, key: s3Key, skipped: false };
    } catch (error) {
      logger.error('File upload failed', {
        file: path.basename(localPath),
        s3Key,
        error: error.message,
      });
      return { success: false, key: s3Key, error: error.message };
    }
  }

  /**
   * Check if date has already been uploaded
   * @param {string} date - ISO date string
   * @returns {boolean}
   */
  async isDateUploaded(date) {
    const normalizedDate = date.replace(/\./g, '-');
    const [year, month, day] = normalizedDate.split('-');
    const prefix = `raw/${year}/${month}/${day}/`;
    
    const objects = await this.s3Manager.listObjects(prefix);
    return objects.length > 0;
  }
}

export default S3Uploader;

