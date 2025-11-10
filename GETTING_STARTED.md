# Getting Started: ADSB Historical Data Processing

Quick guide to extract useful information from ADSB historical data.

## Goal

Get a list of all aircraft that arrived at an airport (e.g., KLGA) on a specific day from historical ADSB data.

## Quick Start

### 1. Prerequisites

Already done ✅:

- Node.js 18+ installed
- AWS credentials configured
- ~1 week of ADSB data in S3 (Nov 2-8, 2025)

### 2. Get Arrival List for KLGA

```bash
cd adsb-history

# Process KLGA for November 8, 2025 (first time: ~10 minutes)
npm run process-airport -- --airport KLGA --date 2025-11-08 --show-arrivals

# Or use the simpler command
npm run get-arrivals -- --airport KLGA --date 2025-11-08
```

**First run**: Downloads ~3GB tar from S3, processes ~500k traces, saves results
**Subsequent runs**: Instant (< 1 second) from cache

### 3. Output

```
Arrivals at LaGuardia Airport (KLGA) on 2025-11-08:
Total: 225

ICAO       Time (UTC)   Closest Approach
------------------------------------------------------------
a12345     08:15:23     1.2 nm, 1500 ft
a67890     08:22:45     0.8 nm, 1200 ft
...
```

## How It Works

1. **Raw Data** (Input)

   - Location: `s3://ayryx-adsb-history/raw/2025/11/08/*.tar`
   - Size: ~3GB (global ADSB data)

2. **Processing** (Run once)

   - Downloads tar from S3
   - Extracts ~500k aircraft traces
   - Classifies each flight (arrival/departure/overflight)
   - Takes ~10 minutes

3. **Abstraction Layer** (Stored results)

   - Location: `s3://ayryx-adsb-history/processed/KLGA/2025/11/08.json`
   - Size: ~5MB (structured, airport-specific)

4. **Query** (Instant)
   - Reads from cache or S3
   - Returns arrival list in < 1 second

## Key Principle

**Process raw data once, query many times** - The abstraction layer stores structured results so you never need to reprocess raw data.

## Usage

### Get arrivals

```bash
npm run get-arrivals -- --airport KLGA --date 2025-11-08
```

### Get full processing results

```bash
npm run process-airport -- --airport KLGA --date 2025-11-08 --show-arrivals --show-departures
```

### Programmatic API

```javascript
import DailyFlightData from "./src/processing/DailyFlightData.js";

const dataStore = new DailyFlightData();
const arrivals = await dataStore.getArrivals("KLGA", "2025-11-08");

console.log(`${arrivals.length} arrivals found`);
```

## Add More Airports

Edit `config/airports.json`:

```json
{
  "icao": "KJFK",
  "name": "John F. Kennedy International",
  "enabled": true,
  "coordinates": { "lat": 40.6398, "lon": -73.7789 },
  "elevation_ft": 13,
  "analysis_radius_nm": 150,
  "timezone": "America/New_York",
  "runways": [...]
}
```

Then process:

```bash
npm run process-airport -- --airport KJFK --date 2025-11-08
```

## Architecture

```
Raw Data (~3GB) → Processing (~10 min) → Abstraction Layer (~5MB) → Query (instant)
```

See [IMPLEMENTATION_SUMMARY.md](./IMPLEMENTATION_SUMMARY.md) for detailed architecture.

## Components

- **TraceReader** - Extracts traces from S3 tars
- **FlightClassifier** - Identifies arrivals/departures/overflights
- **AirportDailyProcessor** - Processes all flights for airport
- **DailyFlightData** - Abstraction layer (storage + query API)

## Files Created

| File                                      | Purpose                |
| ----------------------------------------- | ---------------------- |
| `src/processing/TraceReader.js`           | Extract traces from S3 |
| `src/processing/FlightClassifier.js`      | Classify flights       |
| `src/processing/AirportDailyProcessor.js` | Process airport data   |
| `src/processing/DailyFlightData.js`       | Abstraction layer      |
| `scripts/process-airport-day.js`          | CLI tool to process    |
| `scripts/get-arrivals.js`                 | CLI tool to query      |

## Documentation

- **GETTING_STARTED.md** (this file) - Quick start guide
- **[README.md](./README.md)** - EC2 processing (recommended)
- **[PROCESSING_README.md](./PROCESSING_README.md)** - Local processing details
- **[EC2_INGESTION_README.md](./EC2_INGESTION_README.md)** - Data download
- **[ARCHITECTURE.md](./ARCHITECTURE.md)** - System design

## Example Workflow

1. **Download raw data** (already done):

```bash
aws s3 ls s3://ayryx-adsb-history/raw/2025/11/
# Shows: 7 days of data (Nov 2-8)
```

2. **Process KLGA**:

```bash
npm run process-airport -- --airport KLGA --date 2025-11-08
# Takes ~10 minutes, saves to S3 + cache
```

3. **Query arrivals** (instant):

```bash
npm run get-arrivals -- --airport KLGA --date 2025-11-08
# < 1 second
```

4. **Process more dates**:

```bash
for date in 2025-11-02 2025-11-03 2025-11-04; do
  npm run process-airport -- --airport KLGA --date $date
done
```

5. **Build trends** (future):

- Aggregate weekly/monthly statistics
- Compare conditions (VFR vs IFR)
- Analyze approach times
- Generate pre-computed JSON for frontend

## What's Next?

The abstraction layer is complete. Next steps:

1. ✅ Process data for airports you care about
2. ✅ Query arrival/departure lists
3. 🔜 Build aggregate statistics (weekly, monthly)
4. 🔜 Add weather correlation
5. 🔜 Deploy CloudFront CDN for frontend
6. 🔜 Integrate with planning-app

## Questions?

See detailed documentation:

- [README.md](./README.md) - EC2 processing guide
- [PROCESSING_README.md](./PROCESSING_README.md) - Full processing details
- [ARCHITECTURE.md](./ARCHITECTURE.md) - System design
- [README.md](./README.md) - Main overview
