#!/usr/bin/env node

/**
 * Train distribution-based arrival time prediction model
 * 
 * This script trains:
 * 1. Quantile regression models (Q10, Q25, Q50, Q75, Q90, Q95, Q99)
 * 2. Extreme event classifiers (go-arounds, diversions, holding)
 * 3. Distribution shape analysis
 * 
 * Usage:
 *   node scripts/regression/train-distribution-model.js \
 *     --airport KORD \
 *     --start-date 2024-01-01 \
 *     --end-date 2024-12-31
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import FlightWeatherJoiner from '../../src/regression/data_joining/FlightWeatherJoiner.js';
import WeatherFeatureExtractor from '../../src/regression/feature_engineering/WeatherFeatureExtractor.js';
import TemporalFeatureExtractor from '../../src/regression/feature_engineering/TemporalFeatureExtractor.js';
import QuantileRegression from '../../src/regression/models/QuantileRegression.js';
import ExtremeEventClassifier from '../../src/regression/models/ExtremeEventClassifier.js';
import DistributionAnalyzer from '../../src/regression/analysis/DistributionAnalyzer.js';
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

function detectExtremeEvents(flight) {
  const events = {
    go_around: false,
    diversion: false,
    extended_holding: false,
    multiple_approaches: false,
  };

  if (flight.classification === 'missed_approach') {
    events.go_around = true;
  }

  const timeFrom100nm = flight.milestones?.timeFrom100nm;
  if (timeFrom100nm && timeFrom100nm > 3600) {
    events.extended_holding = true;
  }

  return events;
}

function prepareFeatures(joinedData, runwayHeading = null) {
  const weatherExtractor = new WeatherFeatureExtractor({ defaultRunwayHeading: runwayHeading });
  const temporalExtractor = new TemporalFeatureExtractor();

  const features = [];
  const targets = [];
  const extremeEventLabels = {
    go_around: [],
    diversion: [],
    extended_holding: [],
  };
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

    const events = detectExtremeEvents(flight);
    extremeEventLabels.go_around.push(events.go_around ? 1 : 0);
    extremeEventLabels.diversion.push(events.diversion ? 1 : 0);
    extremeEventLabels.extended_holding.push(events.extended_holding ? 1 : 0);

    metadata.push({
      icao: flight.icao,
      date: record.date,
      aircraftType: flight.type,
      timeFrom100nm: flight.milestones.timeFrom100nm,
      events,
    });
  }

  return { features, targets, extremeEventLabels, featureNames, metadata };
}

function splitTrainTest(features, targets, labels, metadata, testRatio = 0.2) {
  const n = features.length;
  const testSize = Math.floor(n * testRatio);
  const indices = Array.from({ length: n }, (_, i) => i);

  for (let i = n - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [indices[i], indices[j]] = [indices[j], indices[i]];
  }

  const testIndices = indices.slice(0, testSize);
  const trainIndices = indices.slice(testSize);

  const split = (arr) => ({
    train: trainIndices.map((i) => arr[i]),
    test: testIndices.map((i) => arr[i]),
  });

  return {
    train: {
      features: split(features).train,
      targets: split(targets).train,
      labels: {
        go_around: split(labels.go_around).train,
        diversion: split(labels.diversion).train,
        extended_holding: split(labels.extended_holding).train,
      },
    },
    test: {
      features: split(features).test,
      targets: split(targets).test,
      labels: {
        go_around: split(labels.go_around).test,
        diversion: split(labels.diversion).test,
        extended_holding: split(labels.extended_holding).test,
      },
      metadata: testIndices.map((i) => metadata[i]),
    },
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
    console.error('Usage: node train-distribution-model.js --airport KORD --start-date 2024-01-01 --end-date 2024-12-31 [--runway-heading 270]');
    process.exit(1);
  }

  logger.info('Starting distribution model training', { airport, startDate, endDate, runwayHeading });

  const dates = generateDateRange(startDate, endDate);
  logger.info('Date range generated', { nDates: dates.length });

  const joiner = new FlightWeatherJoiner();
  const joinedData = joiner.joinMultiple(airport, dates);

  if (joinedData.length === 0) {
    logger.error('No joined data available', { airport, startDate, endDate });
    process.exit(1);
  }

  logger.info('Data joined', { nRecords: joinedData.length });

  const { features, targets, extremeEventLabels, featureNames, metadata } = prepareFeatures(joinedData, runwayHeading);

  if (features.length === 0) {
    logger.error('No features extracted', { airport });
    process.exit(1);
  }

  logger.info('Features prepared', {
    nSamples: features.length,
    nFeatures: featureNames.length,
    featureNames,
  });

  const { train, test } = splitTrainTest(features, targets, extremeEventLabels, metadata, 0.2);

  logger.info('Data split', {
    trainSize: train.features.length,
    testSize: test.features.length,
  });

  const quantiles = [0.10, 0.25, 0.50, 0.75, 0.90, 0.95, 0.99];
  const quantileModels = {};

  logger.info('Training quantile regression models', { quantiles });

  for (const q of quantiles) {
    const model = new QuantileRegression(q);
    model.fit(train.features, train.targets, featureNames);
    quantileModels[`q${Math.round(q * 100)}`] = model.getSummary();
  }

  logger.info('Training extreme event classifiers');

  const extremeEventModels = {};
  for (const [eventType, labels] of Object.entries(train.labels)) {
    const classifier = new ExtremeEventClassifier(eventType);
    classifier.fit(train.features, labels, featureNames);
    extremeEventModels[eventType] = classifier.getSummary();

    const testProbs = classifier.predictProba(test.features);
    const testPreds = classifier.predict(test.features);
    const accuracy = test.labels[eventType].reduce((sum, label, i) => sum + (label === testPreds[i] ? 1 : 0), 0) / test.labels[eventType].length;
    logger.info(`Extreme event classifier trained`, { eventType, accuracy: accuracy.toFixed(3) });
  }

  logger.info('Analyzing distribution characteristics');

  const distributionAnalyzer = new DistributionAnalyzer();
  const distributionAnalysis = distributionAnalyzer.analyze(train.targets);

  const modelOutput = {
    airport,
    trainingPeriod: { start: startDate, end: endDate },
    runwayHeading,
    nSamples: features.length,
    nTrain: train.features.length,
    nTest: test.features.length,
    featureNames,
    quantileModels,
    extremeEventModels,
    distributionAnalysis,
    generatedAt: new Date().toISOString(),
  };

  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  const modelPath = path.join(outputDir, `${airport}_distribution_model.json`);
  fs.writeFileSync(modelPath, JSON.stringify(modelOutput, null, 2));

  logger.info('Model saved', { path: modelPath });

  console.log('\n=== Distribution Model Summary ===');
  console.log(`Airport: ${airport}`);
  console.log(`Training Period: ${startDate} to ${endDate}`);
  console.log(`Samples: ${features.length} (train: ${train.features.length}, test: ${test.features.length})`);
  console.log(`\nDistribution Characteristics:`);
  console.log(`  Mean: ${distributionAnalysis.mean.toFixed(2)} seconds (${(distributionAnalysis.mean / 60).toFixed(1)} min)`);
  console.log(`  Median: ${distributionAnalysis.median.toFixed(2)} seconds (${(distributionAnalysis.median / 60).toFixed(1)} min)`);
  console.log(`  Std Dev: ${distributionAnalysis.stdDev.toFixed(2)} seconds`);
  console.log(`  Skewness: ${distributionAnalysis.skewness.toFixed(2)} ${distributionAnalysis.isLongTailed ? '(LONG-TAILED)' : ''}`);
  console.log(`  Kurtosis: ${distributionAnalysis.kurtosis.toFixed(2)}`);
  console.log(`\nQuantile Predictions (example):`);
  for (const [qName, model] of Object.entries(quantileModels)) {
    console.log(`  ${qName}: intercept = ${model.intercept.toFixed(2)} seconds`);
  }
  console.log(`\nExtreme Event Probabilities (example):`);
  for (const [eventType, model] of Object.entries(extremeEventModels)) {
    console.log(`  ${eventType}: intercept = ${model.intercept.toFixed(4)}`);
  }
}

main().catch((error) => {
  logger.error('Training failed', { error: error.message, stack: error.stack });
  process.exit(1);
});


