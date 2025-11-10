# ADSB Historical Data Processing

This document explains how to use the abstraction layer to extract useful information from raw ADSB historical data.

## Overview

The system processes raw ADSB trace data **once** and stores structured flight information in an abstraction layer (S3 + local cache). This avoids reprocessing on every query.

**Architecture:**
```
Raw Data (S3 tars)
    ↓
Processing Pipeline
    ├─ TraceReader: Extract traces from tar
    ├─ FlightClassifier: Identify arrivals/departures/overflights
    └─ AirportDailyProcessor: Process all flights for airport
    ↓
Abstraction Layer (DailyFlightData)
    ├─ S3: s3://bucket/processed/AIRPORT/YYYY/MM/DD.json
    └─ Local cache: ./cache/AIRPORT/YYYY/MM/DD.json
    ↓
Application Queries (fast!)
```

## Data Format

### Raw Data (Input)
- **Location**: `s3://ayryx-adsb-history/raw/YYYY/MM/DD/*.tar`
- **Format**: Readsb trace JSON (gzipped position reports)
- **Size**: ~3GB per day (global)

### Processed Data (Output)
- **Location**: `s3://ayryx-adsb-history/processed/AIRPORT/YYYY/MM/DD.json`
- **Format**: Structured JSON with classified flights
- **Size**: ~1-10MB per airport per day

Example processed data structure:
```json
{
  "date": "2025-11-08",
  "airport": "KLGA",
  "airportName": "LaGuardia Airport",
  "flights": {
    "arrivals": [
      {
        "icao": "a12345",
        "classification": "arrival",
        "timestamp": 1731052800,
        "dateTime": "2025-11-08T12:00:00.000Z",
        "closestApproach": {
          "distance": 1.2,
          "altitude": 1500,
          "timestamp": 1731052850,
          "lat": 40.7769,
          "lon": -73.8740
        },
        "altitudeProfile": {
          "minNearby": 1200,
          "avgBefore": 8500,
          "avgAfter": null
        },
        "duration": 1800,
        "positionCount": 120
      }
    ],
    "departures": [...],
    "touch_and_go": [...],
    "overflights": [...]
  },
  "statistics": {
    "total": 450,
    "arrivals": 225,
    "departures": 220,
    "touch_and_go": 5,
    "overflights": 0
  }
}
```

## Quick Start

### 1. Process an Airport for a Specific Date

```bash
# Process KLGA for November 8, 2025
npm run process-airport -- --airport KLGA --date 2025-11-08 --show-arrivals

# This will:
# 1. Check if already processed (in S3/cache)
# 2. If not, download tar from S3
# 3. Extract and analyze all traces
# 4. Classify flights as arrivals/departures/overflights
# 5. Save to abstraction layer (S3 + cache)
# 6. Display results
```

### 2. Get Just Arrivals

```bash
# Quick retrieval of arrivals (uses cached data if available)
npm run get-arrivals -- --airport KLGA --date 2025-11-08
```

### 3. Programmatic API

```javascript
import DailyFlightData from './src/processing/DailyFlightData.js';
import AirportDailyProcessor from './src/processing/AirportDailyProcessor.js';

// Initialize abstraction layer
const dataStore = new DailyFlightData();

// Check if data already processed
const arrivals = await dataStore.getArrivals('KLGA', '2025-11-08');

if (!arrivals) {
  // Not processed yet, process now
  const processor = new AirportDailyProcessor();
  const results = await processor.processAirportDay('2025-11-08', airport);
  await dataStore.save('KLGA', '2025-11-08', results);
}

// Now query the abstraction layer (fast!)
const arrivals = await dataStore.getArrivals('KLGA', '2025-11-08');
const departures = await dataStore.getDepartures('KLGA', '2025-11-08');
const stats = await dataStore.getStatistics('KLGA', '2025-11-08');
```

## Components

### TraceReader
Extracts and streams trace files from S3 tar archives.

```javascript
const reader = new TraceReader();

// Download and extract tar
const tarPath = await reader.downloadTarFromS3('2025-11-08');
const extractDir = await reader.extractTar(tarPath);

// Stream all traces
for await (const { icao, trace } of reader.streamAllTraces(extractDir)) {
  // Process each trace
}

// Clean up
reader.cleanup('2025-11-08');
```

### FlightClassifier
Analyzes traces to determine if they're arrivals, departures, or overflights.

```javascript
const classifier = new FlightClassifier({
  arrivalAltitudeThreshold: 5000,  // feet
  departureAltitudeThreshold: 5000, // feet
  airportProximityRadius: 10,       // nautical miles
});

const classification = classifier.classifyFlight(trace, airport);
// Returns: { classification: 'arrival', closestApproach: {...}, ... }
```

### AirportDailyProcessor
Processes all flights for an airport on a specific day.

```javascript
const processor = new AirportDailyProcessor();
const results = await processor.processAirportDay('2025-11-08', airport);

// Or get just arrivals
const arrivals = await processor.getArrivals('2025-11-08', airport);
```

### DailyFlightData (Abstraction Layer)
Stores and retrieves processed flight data.

```javascript
const dataStore = new DailyFlightData();

// Save processed data
await dataStore.save('KLGA', '2025-11-08', results);

// Load processed data
const data = await dataStore.load('KLGA', '2025-11-08');

// Query specific data
const arrivals = await dataStore.getArrivals('KLGA', '2025-11-08');
const stats = await dataStore.getStatistics('KLGA', '2025-11-08');
```

## Configuration

### Add New Airport

Edit `config/airports.json`:

```json
{
  "icao": "KLGA",
  "name": "LaGuardia Airport",
  "enabled": true,
  "coordinates": {
    "lat": 40.7769,
    "lon": -73.8740
  },
  "elevation_ft": 22,
  "analysis_radius_nm": 150,
  "timezone": "America/New_York",
  "runways": [...]
}
```

### Adjust Classification Thresholds

```javascript
const classifier = new FlightClassifier({
  arrivalAltitudeThreshold: 5000,     // Lower = more arrivals detected
  departureAltitudeThreshold: 5000,   // Lower = more departures detected
  airportProximityRadius: 10,         // Larger = include flights further away
  minPositionReports: 5,              // Minimum data points to classify
});
```

## Performance

Processing a single day for one airport:
- **Input**: ~3GB tar (global data)
- **Output**: ~5MB JSON (airport-specific)
- **Time**: ~5-15 minutes (depending on airport size and CPU)
- **Traces processed**: ~200,000-500,000
- **Flights classified**: ~200-1000 per airport

After initial processing, queries are instant (cache/S3 lookup).

## Storage Costs

- **Raw data**: ~$0.023/GB/month = ~$0.70/day = ~$250/year
- **Processed data**: ~$0.023/GB/month = ~$0.01/day/airport = ~$3.65/year/airport
- **Total for 3 airports + 1 year raw**: ~$260/year

## Best Practices

1. **Process once, query many**: Don't reprocess data unless needed
2. **Use cache**: Local cache speeds up repeated queries
3. **Batch processing**: Process multiple days at once for efficiency
4. **Monitor S3 costs**: Set up billing alerts
5. **Clean up temp files**: Extracted data is large (~20GB per day)

## Troubleshooting

### Out of Memory
Large airports process many traces. Increase Node memory:
```bash
NODE_OPTIONS="--max-old-space-size=8192" npm run process-airport -- --airport KLAX --date 2025-11-08
```

### Slow Processing
- Ensure running on a machine with good CPU
- Consider using EC2 for faster processing
- Process multiple days in parallel on different machines

### Missing Data
Check that raw tar exists in S3:
```bash
aws s3 ls s3://ayryx-adsb-history/raw/2025/11/08/
```

## Next Steps

See [ARCHITECTURE.md](./ARCHITECTURE.md) for:
- Pre-computed statistics aggregation
- CloudFront CDN deployment
- Integration with planning-app frontend
- Historical analysis and trending

