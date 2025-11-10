# Demo: Get Arrivals at KLGA

This demonstrates the abstraction layer for extracting useful information from ADSB historical data.

## What We Built

An **abstraction layer** that:
1. Processes raw ADSB trace data **once**
2. Classifies flights (arrivals, departures, overflights)
3. Stores structured data in S3 + local cache
4. Provides fast queries without reprocessing

## Architecture

```
┌─────────────────────────────────────────────┐
│ Raw Data (S3)                               │
│ s3://bucket/raw/2025/11/08/*.tar (~3GB)     │
└────────────────┬────────────────────────────┘
                 │
                 ▼
┌─────────────────────────────────────────────┐
│ Processing Pipeline (run once)              │
│ • TraceReader: Extract traces from tar      │
│ • FlightClassifier: Classify flights        │
│ • AirportDailyProcessor: Process all        │
└────────────────┬────────────────────────────┘
                 │
                 ▼
┌─────────────────────────────────────────────┐
│ Abstraction Layer (DailyFlightData)         │
│ s3://bucket/processed/KLGA/2025/11/08.json  │
│ + local cache                               │
└────────────────┬────────────────────────────┘
                 │
                 ▼
┌─────────────────────────────────────────────┐
│ Application Queries (instant!)              │
│ • getArrivals()                             │
│ • getDepartures()                           │
│ • getStatistics()                           │
└─────────────────────────────────────────────┘
```

## Usage Examples

### 1. Process Airport Data (First Time)

This processes ~3GB of raw data and saves structured results:

```bash
# Process KLGA for November 8, 2025 (takes ~5-15 minutes)
npm run process-airport -- --airport KLGA --date 2025-11-08 --show-arrivals

# Output:
# - Downloads tar from S3
# - Extracts ~500,000 traces
# - Classifies ~500 flights for KLGA
# - Saves to s3://bucket/processed/KLGA/2025/11/08.json
# - Displays arrival list
```

### 2. Query Arrivals (Subsequent Times)

After processing, queries are instant (uses cache/S3):

```bash
# Fast retrieval (< 1 second)
npm run get-arrivals -- --airport KLGA --date 2025-11-08
```

Output:
```
Arrivals at LaGuardia Airport (KLGA) on 2025-11-08:
Total: 225

ICAO       Time (UTC)   Closest Approach
------------------------------------------------------------
a12345     08:15:23     1.2 nm, 1500 ft
a67890     08:22:45     0.8 nm, 1200 ft
...
```

### 3. Programmatic API

```javascript
import DailyFlightData from './src/processing/DailyFlightData.js';

// Initialize abstraction layer
const dataStore = new DailyFlightData();

// Get arrivals (from cache/S3, instant)
const arrivals = await dataStore.getArrivals('KLGA', '2025-11-08');

// If data doesn't exist, process it first:
if (!arrivals) {
  const processor = new AirportDailyProcessor();
  const results = await processor.processAirportDay('2025-11-08', airport);
  await dataStore.save('KLGA', '2025-11-08', results);
}

// Now query is fast
console.log(`Found ${arrivals.length} arrivals`);
arrivals.forEach(flight => {
  console.log(`${flight.icao}: ${new Date(flight.timestamp * 1000).toISOString()}`);
});
```

## Data Format

### Input (Raw)
- **Location**: `s3://bucket/raw/2025/11/08/*.tar`
- **Format**: Readsb trace JSON (position reports)
- **Size**: ~3GB (global)

### Output (Processed)
- **Location**: `s3://bucket/processed/KLGA/2025/11/08.json`
- **Format**: Structured JSON with classified flights
- **Size**: ~5MB per airport

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
        "closestApproach": {
          "distance": 1.2,
          "altitude": 1500,
          "lat": 40.7769,
          "lon": -73.8740
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
    "departures": 220
  }
}
```

## Key Benefits

1. **Process Once**: Raw data processed once, results stored
2. **Fast Queries**: Subsequent queries are instant (cache/S3 lookup)
3. **Structured Data**: Clean JSON format, easy to consume
4. **Scalable**: Process multiple dates/airports in parallel
5. **Cost-Effective**: S3 storage ~$0.023/GB/month

## Performance

Processing a single day for one airport:
- **Input**: ~3GB tar (global data)
- **Output**: ~5MB JSON (airport-specific)
- **Time**: ~5-15 minutes (first time)
- **Traces**: ~500,000 processed
- **Flights**: ~500 classified

After processing:
- **Query time**: < 1 second (from cache)
- **Query time**: ~2 seconds (from S3)

## Next Steps

1. Run processing for KLGA: `npm run process-airport -- --airport KLGA --date 2025-11-08 --show-arrivals`
2. Test fast queries: `npm run get-arrivals -- --airport KLGA --date 2025-11-08`
3. Add more airports to `config/airports.json`
4. Process multiple days for trend analysis
5. Build pre-computed statistics (see [ARCHITECTURE.md](./ARCHITECTURE.md))

## Files Created

- `src/processing/TraceReader.js` - Extract traces from S3 tars
- `src/processing/FlightClassifier.js` - Classify flights
- `src/processing/AirportDailyProcessor.js` - Process all flights for airport
- `src/processing/DailyFlightData.js` - Abstraction layer (storage)
- `scripts/process-airport-day.js` - CLI tool to process data
- `scripts/get-arrivals.js` - CLI tool to query arrivals
- `config/airports.json` - Updated with KLGA

## Compatibility with Existing System

The data format is similar to the live ADSB aggregator:
- Uses same coordinate calculations
- Similar flight classification logic
- Compatible data structures

This allows seamless integration between live and historical data.

