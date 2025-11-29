import { S3Client, ListObjectsV2Command, CopyObjectCommand, DeleteObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3';
import pLimit from 'p-limit';
import logger from '../src/utils/logger.js';

const BUCKET_NAME = process.env.S3_BUCKET_NAME || 'ayryx-adsb-history';
const REGION = process.env.AWS_REGION || 'us-west-1';

const s3Client = new S3Client({
  region: REGION,
});

async function listAllObjects(prefix) {
  const objects = [];
  let continuationToken = undefined;

  do {
    const command = new ListObjectsV2Command({
      Bucket: BUCKET_NAME,
      Prefix: prefix,
      ContinuationToken: continuationToken,
    });

    const response = await s3Client.send(command);
    
    if (response.Contents) {
      objects.push(...response.Contents);
    }

    continuationToken = response.NextContinuationToken;
  } while (continuationToken);

  return objects;
}

async function objectExists(key) {
  try {
    await s3Client.send(new HeadObjectCommand({
      Bucket: BUCKET_NAME,
      Key: key,
    }));
    return true;
  } catch (error) {
    if (error.name === 'NotFound' || error.$metadata?.httpStatusCode === 404) {
      return false;
    }
    throw error;
  }
}

async function renameObject(oldKey, newKey) {
  try {
    const destinationExists = await objectExists(newKey);
    if (destinationExists) {
      logger.warn('Destination file already exists, skipping rename', {
        oldKey,
        newKey,
      });
      logger.info('Deleting source file with "tmp" suffix', { key: oldKey });
      
      await s3Client.send(new DeleteObjectCommand({
        Bucket: BUCKET_NAME,
        Key: oldKey,
      }));
      
      logger.info('Deleted source file (destination already existed)', { oldKey, newKey });
      return true;
    }
    
    logger.info('Copying object', { from: oldKey, to: newKey });
    
    await s3Client.send(new CopyObjectCommand({
      Bucket: BUCKET_NAME,
      CopySource: `${BUCKET_NAME}/${oldKey}`,
      Key: newKey,
    }));

    logger.info('Deleting old object', { key: oldKey });
    
    await s3Client.send(new DeleteObjectCommand({
      Bucket: BUCKET_NAME,
      Key: oldKey,
    }));

    logger.info('Successfully renamed', { oldKey, newKey });
    return true;
  } catch (error) {
    logger.error('Failed to rename object', {
      oldKey,
      newKey,
      error: error.message,
    });
    throw error;
  }
}

async function normalizeFilenames() {
  logger.info('Starting S3 filename normalization', {
    bucket: BUCKET_NAME,
    prefixes: ['raw/2024/', 'raw/2025/'],
  });

  const prefixes = ['raw/2024/', 'raw/2025/'];
  const filesToRename = [];

  for (const prefix of prefixes) {
    logger.info('Listing objects', { prefix });
    const objects = await listAllObjects(prefix);
    
    logger.info('Found objects', { prefix, count: objects.length });

    for (const obj of objects) {
      const key = obj.Key;
      const filename = key.split('/').pop();

      if (filename.includes('tmp')) {
        const newFilename = filename.replace(/tmp(?=\.tar$)/, '');
        const newKey = key.replace(filename, newFilename);
        
        filesToRename.push({
          oldKey: key,
          newKey: newKey,
          oldFilename: filename,
          newFilename: newFilename,
        });
      }
    }
  }

  logger.info('Found files to rename', { count: filesToRename.length });

  if (filesToRename.length === 0) {
    logger.info('No files with "tmp" found. Nothing to do.');
    return;
  }

  logger.info('Files to rename:', {
    files: filesToRename.map(f => ({
      from: f.oldFilename,
      to: f.newFilename,
    })),
  });

  const limit = pLimit(5);
  let successCount = 0;
  let errorCount = 0;

  const renamePromises = filesToRename.map(file =>
    limit(async () => {
      try {
        await renameObject(file.oldKey, file.newKey);
        successCount++;
      } catch (error) {
        errorCount++;
        logger.error('Failed to rename file', {
          oldKey: file.oldKey,
          error: error.message,
        });
      }
    })
  );

  await Promise.all(renamePromises);

  logger.info('Normalization complete', {
    total: filesToRename.length,
    success: successCount,
    errors: errorCount,
  });
}

normalizeFilenames()
  .then(() => {
    logger.info('Script completed successfully');
    process.exit(0);
  })
  .catch((error) => {
    logger.error('Script failed', { error: error.message, stack: error.stack });
    process.exit(1);
  });

