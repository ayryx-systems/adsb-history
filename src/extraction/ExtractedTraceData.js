import fs from 'fs';
import path from 'path';
import { S3Client, PutObjectCommand, GetObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3';
import logger from '../utils/logger.js';
import { describeAwsError } from '../utils/awsErrorUtils.js';

class ExtractedTraceData {
  constructor(config = {}) {
    this.bucketName = config.bucketName || process.env.S3_BUCKET_NAME || 'ayryx-adsb-history';
    this.region = config.region || process.env.AWS_REGION || 'us-west-1';

    const clientConfig = { region: this.region };
    
    if (process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY) {
      clientConfig.credentials = {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
      };
    }
    
    this.s3Client = new S3Client(clientConfig);
  }

  getS3Key(airport, date) {
    const [year, month, day] = date.split('-');
    return `extracted/${airport}/${year}/${month}/${airport}-${year}-${month}-${day}.tar`;
  }

  async save(airport, date, tarPath) {
    const s3Key = this.getS3Key(airport, date);

    if (!fs.existsSync(tarPath)) {
      throw new Error(`Tar file not found: ${tarPath}`);
    }

    const stats = fs.statSync(tarPath);
    const sizeMB = (stats.size / 1024 / 1024).toFixed(2);

    logger.info('Uploading extracted traces to S3', {
      airport,
      date,
      s3Key,
      sizeMB,
    });

    try {
      const fileStream = fs.createReadStream(tarPath);
      const command = new PutObjectCommand({
        Bucket: this.bucketName,
        Key: s3Key,
        Body: fileStream,
        ContentType: 'application/x-tar',
      });

      await this.s3Client.send(command);

      logger.info('Successfully uploaded extracted traces', {
        airport,
        date,
        s3Key,
        sizeMB,
      });
    } catch (error) {
      const details = describeAwsError(error);
      logger.error('Failed to upload extracted traces', {
        airport,
        date,
        s3Key,
        error: details,
      });
      console.error(`[ExtractedTraceData] Failed to upload ${s3Key}: ${details}`);
      error.message = details;
      throw error;
    }
  }

  async download(airport, date, localPath) {
    const s3Key = this.getS3Key(airport, date);

    const dirPath = path.dirname(localPath);
    if (!fs.existsSync(dirPath)) {
      fs.mkdirSync(dirPath, { recursive: true, mode: 0o755 });
    }

    if (fs.existsSync(localPath)) {
      logger.info('Extracted tar already downloaded', { airport, date, path: localPath });
      return localPath;
    }

    logger.info('Downloading extracted traces from S3', { airport, date, s3Key });

    try {
      const command = new GetObjectCommand({
        Bucket: this.bucketName,
        Key: s3Key,
      });

      const response = await this.s3Client.send(command);
      const writeStream = fs.createWriteStream(localPath);

      await new Promise((resolve, reject) => {
        response.Body.pipe(writeStream);
        writeStream.on('finish', resolve);
        writeStream.on('error', reject);
      });

      const stats = fs.statSync(localPath);
      logger.info('Downloaded extracted traces', {
        airport,
        date,
        sizeMB: `${(stats.size / 1024 / 1024).toFixed(2)} MB`,
        path: localPath,
      });

      return localPath;
    } catch (error) {
      if (error.name === 'NoSuchKey') {
        logger.info('Extracted traces not found', { airport, date, s3Key });
        return null;
      }
      
      const details = describeAwsError(error);
      logger.error('Failed to download extracted traces', {
        airport,
        date,
        s3Key,
        error: details,
      });
      console.error(`[ExtractedTraceData] Failed to download ${s3Key}: ${details}`);
      error.message = details;
      throw error;
    }
  }

  async exists(airport, date) {
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
      const details = describeAwsError(error);
      logger.error('Failed to check extracted traces', {
        airport,
        date,
        s3Key,
        error: details,
      });
      console.error(`[ExtractedTraceData] Failed to head ${s3Key}: ${details}`);
      error.message = details;
      throw error;
    }
  }
}

export default ExtractedTraceData;

