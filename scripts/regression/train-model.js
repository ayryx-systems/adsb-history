#!/usr/bin/env node

/**
 * Train arrival time prediction model
 * 
 * Usage:
 *   node scripts/regression/train-model.js --airport KORD --start-date 2024-01-01 --end-date 2024-12-31
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import FlightWeatherJoiner from '../../src/regression/data_joining/FlightWeatherJoiner.js';
import WeatherFeatureExtractor from '../../src/regression/feature_engineering/WeatherFeatureExtractor.js';
import TemporalFeatureExtractor from '../../src/regression/feature_engineering/TemporalFeatureExtractor.js';
import LinearRegression from '../../src/regression/models/LinearRegression.js';
import logger from '../../src/utils/logger.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function parseArgs() {
  const args = process.argv.slice(2);
  const config = {};

  for (let i = 0; i < args.length; i += 2) {
    const key = args[i]?.replace('--', '');
    const value = args[i + 1];
    if (key && value) {
      config[key] = value;
    }
  }

  return config;
}

function generateDateRange(startDate, endDate) {
  const dates = [];
  const start = new Date(startDate);
  const end = new Date(endDate);

  for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
    dates.push(d.toISOString().split('T')[0]);
  }

  return dates;
}

function prepareFeatures(joinedData, runwayHeading = null) {
  const weatherExtractor = new WeatherFeatureExtractor({ defaultRunwayHeading: runwayHeading });
  const temporalExtractor = new TemporalFeatureExtractor();

  const features = [];
  const targets = [];
  const featureNames = [];
  const metadata = [];

  for (const record of joinedData) {
    const flight = record.flight;
    const weather = record.weather;

    if (!flight.milestones || flight.milestones.timeFrom100nm === undefined) {
      continue;
    }

    const weatherFeatures = weatherExtractor.extract(weather, runwayHeading);
    const temporalFeatures = temporalExtractor.extract(flight.touchdown.timestamp);

    if (!weatherFeatures || !temporalFeatures) {
      continue;
    }

    const featureVector = [];
    const names = [];

    if (featureNames.length === 0) {
      featureNames.push('visibility_sm');
      featureNames.push('ceiling_ft');
      featureNames.push('wind_speed_kt');
      featureNames.push('crosswind_kt');
      featureNames.push('headwind_kt');
      featureNames.push('has_precipitation');
      featureNames.push('hour');
      featureNames.push('is_weekend');
      featureNames.push('is_holiday');
    }

    featureVector.push(weatherFeatures.visibility_sm || 10);
    featureVector.push(weatherFeatures.ceiling_ft || 10000);
    featureVector.push(weatherFeatures.wind_speed_kt || 0);
    featureVector.push(weatherFeatures.crosswind_kt || 0);
    featureVector.push(weatherFeatures.headwind_kt || 0);
    featureVector.push(weatherFeatures.has_precipitation ? 1 : 0);
    featureVector.push(temporalFeatures.hour);
    featureVector.push(temporalFeatures.is_weekend ? 1 : 0);
    featureVector.push(temporalFeatures.is_holiday ? 1 : 0);

    features.push(featureVector);
    targets.push(flight.milestones.timeFrom100nm);

    metadata.push({
      icao: flight.icao,
      date: record.date,
      aircraftType: flight.type,
      timeDiffSeconds: record.timeDiffSeconds,
    });
  }

  return { features, targets, featureNames, metadata };
}

function splitTrainTest(features, targets, metadata, testRatio = 0.2) {
  const n = features.length;
  const testSize = Math.floor(n * testRatio);
  const indices = Array.from({ length: n }, (_, i) => i);

  for (let i = n - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [indices[i], indices[j]] = [indices[j], indices[i]];
  }

  const testIndices = indices.slice(0, testSize);
  const trainIndices = indices.slice(testSize);

  const trainFeatures = trainIndices.map((i) => features[i]);
  const trainTargets = trainIndices.map((i) => targets[i]);
  const testFeatures = testIndices.map((i) => features[i]);
  const testTargets = testIndices.map((i) => targets[i]);
  const testMetadata = testIndices.map((i) => metadata[i]);

  return {
    train: { features: trainFeatures, targets: trainTargets },
    test: { features: testFeatures, targets: testTargets, metadata: testMetadata },
  };
}

async function main() {
  const config = parseArgs();

  const airport = config.airport || config['airport'];
  const startDate = config['start-date'] || config.startDate;
  const endDate = config['end-date'] || config.endDate;
  const runwayHeading = config['runway-heading'] ? parseFloat(config['runway-heading']) : null;
  const outputDir = config['output-dir'] || config.outputDir || './cache/models';

  if (!airport || !startDate || !endDate) {
    console.error('Usage: node train-model.js --airport KORD --start-date 2024-01-01 --end-date 2024-12-31 [--runway-heading 270]');
    process.exit(1);
  }

  logger.info('Starting model training', { airport, startDate, endDate, runwayHeading });

  const dates = generateDateRange(startDate, endDate);
  logger.info('Date range generated', { nDates: dates.length });

  const joiner = new FlightWeatherJoiner();
  const joinedData = joiner.joinMultiple(airport, dates);

  if (joinedData.length === 0) {
    logger.error('No joined data available', { airport, startDate, endDate });
    process.exit(1);
  }

  logger.info('Data joined', { nRecords: joinedData.length });

  const { features, targets, featureNames, metadata } = prepareFeatures(joinedData, runwayHeading);

  if (features.length === 0) {
    logger.error('No features extracted', { airport });
    process.exit(1);
  }

  logger.info('Features prepared', {
    nSamples: features.length,
    nFeatures: featureNames.length,
    featureNames,
  });

  const { train, test } = splitTrainTest(features, targets, metadata, 0.2);

  logger.info('Data split', {
    trainSize: train.features.length,
    testSize: test.features.length,
  });

  const model = new LinearRegression();
  model.fit(train.features, train.targets, featureNames);

  const trainPredictions = model.predict(train.features);
  const testPredictions = model.predict(test.features);

  const trainRMSE = model.calculateRMSE(train.targets, trainPredictions);
  const testRMSE = model.calculateRMSE(test.targets, testPredictions);
  const trainR2 = model.calculateRSquared(train.targets, trainPredictions);
  const testR2 = model.calculateRSquared(test.targets, testPredictions);

  const summary = model.getSummary();
  summary.airport = airport;
  summary.trainingPeriod = { start: startDate, end: endDate };
  summary.runwayHeading = runwayHeading;
  summary.metrics = {
    train: { rmse: trainRMSE, rSquared: trainR2 },
    test: { rmse: testRMSE, rSquared: testR2 },
  };

  logger.info('Model trained', {
    trainRMSE: trainRMSE.toFixed(2),
    testRMSE: testRMSE.toFixed(2),
    trainR2: trainR2.toFixed(4),
    testR2: testR2.toFixed(4),
  });

  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  const modelPath = path.join(outputDir, `${airport}_model.json`);
  fs.writeFileSync(modelPath, JSON.stringify(summary, null, 2));

  logger.info('Model saved', { path: modelPath });

  console.log('\n=== Model Summary ===');
  console.log(`Airport: ${airport}`);
  console.log(`Training Period: ${startDate} to ${endDate}`);
  console.log(`Samples: ${features.length}`);
  console.log(`\nTrain RMSE: ${trainRMSE.toFixed(2)} seconds (${(trainRMSE / 60).toFixed(1)} minutes)`);
  console.log(`Test RMSE: ${testRMSE.toFixed(2)} seconds (${(testRMSE / 60).toFixed(1)} minutes)`);
  console.log(`Train R²: ${trainR2.toFixed(4)}`);
  console.log(`Test R²: ${testR2.toFixed(4)}`);
  console.log(`\nCoefficients:`);
  console.log(`  Intercept: ${summary.intercept.toFixed(2)} seconds`);
  for (const [name, coeff] of Object.entries(summary.coefficients)) {
    console.log(`  ${name}: ${coeff.toFixed(2)} seconds/unit`);
  }
  console.log(`\nFeature Importance:`);
  for (const [name, importance] of Object.entries(summary.featureImportance)) {
    console.log(`  ${name}: ${(importance * 100).toFixed(1)}%`);
  }
}

main().catch((error) => {
  logger.error('Training failed', { error: error.message, stack: error.stack });
  process.exit(1);
});


