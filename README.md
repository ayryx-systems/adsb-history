# ADS-B Historical Data System

Complete system to download, process, and query historical ADS-B flight data from [adsb.lol/globe_history_2025](https://github.com/adsblol/globe_history_2025).

## What It Does

Get answers like: **"Which aircraft arrived at LaGuardia on November 8, 2025?"**

```bash
npm run get-arrivals -- --airport KLGA --date 2025-11-08
```

Results are instant after initial processing (~15 min on EC2).

## Quick Start

See [GETTING_STARTED.md](./GETTING_STARTED.md) for complete setup guide.

### 1. Download Raw Data (EC2, automated)

```bash
./scripts/provision-ec2-downloader.sh --start-date 2025-11-02 --days 7
```

Downloads ~3GB/day from GitHub → uploads to S3. Auto-terminates. Cost: < $0.10

### 2. Process for an Airport (EC2, automated)

```bash
./scripts/provision-ec2-processor.sh --airport KLGA --date 2025-11-08
```

Processes raw data → classifies flights → saves to S3. Takes ~15 min. Cost: ~$0.05

### 3. Query Results (local, instant)

```bash
npm run get-arrivals -- --airport KLGA --date 2025-11-08
```

Returns list of arriving aircraft with times and positions. < 1 second.

## Architecture

```
Raw Data (S3)      Processing (EC2)      Abstraction Layer      Query (Local)
  ~3GB/day    →    ~15 min once    →     ~5MB structured   →    < 1 sec
```

**Key principle:** Process raw data once, query many times from abstraction layer.

## Documentation

- **[GETTING_STARTED.md](./GETTING_STARTED.md)** - Setup and usage guide
- **[EC2_PROCESSING_README.md](./EC2_PROCESSING_README.md)** - EC2 processing details
- **[EC2_INGESTION_README.md](./EC2_INGESTION_README.md)** - EC2 data download
- **[PROCESSING_README.md](./PROCESSING_README.md)** - Processing pipeline details
- **[ARCHITECTURE.md](./ARCHITECTURE.md)** - System design

## Components

### Data Ingestion
- Downloads daily tar files from GitHub
- Stores in S3 (`s3://bucket/raw/YYYY/MM/DD/*.tar`)
- Automated via EC2 or local

### Data Processing
- Extracts and analyzes trace files (gzipped JSON)
- Classifies flights: arrivals, departures, overflights, touch-and-go
- Saves structured results to S3 (`s3://bucket/processed/AIRPORT/YYYY/MM/DD.json`)
- Runs on EC2 (no local disk space needed)

### Query Layer
- Fast lookups from processed data (< 1 sec)
- Local cache for instant repeated queries
- Simple API: `getArrivals()`, `getDepartures()`, `getStatistics()`

## Costs

- **Raw data storage**: ~$0.70/day = ~$250/year
- **Processed data**: ~$0.003/day/airport
- **EC2 ingestion**: < $0.10 per day
- **EC2 processing**: ~$0.05 per airport/day
- **Total for 3 airports**: ~$30/year + ~$5/month processing

## Data Format

### Input (Raw)
- Source: adsb.lol GitHub releases
- Format: Tar archives of gzipped trace JSON files
- Coverage: Global ADS-B position reports
- Size: ~3GB/day compressed

### Output (Processed)
- Format: Structured JSON with classified flights
- Storage: S3 + local cache
- Size: ~5MB per airport per day
- Schema: Arrivals, departures, statistics, metadata

## Requirements

- Node.js 18+
- AWS account (S3 access)
- For local processing: ~50GB disk space
- For EC2 processing: Just AWS credentials

## Setup

```bash
# Install dependencies
cd adsb-history
npm install

# Configure AWS
cp .env.example .env
# Edit .env with your AWS credentials

# Download data (EC2)
./scripts/provision-ec2-downloader.sh --date 2025-11-08

# Process data (EC2)
./scripts/provision-ec2-processor.sh --airport KLGA --date 2025-11-08

# Query results (local)
npm run get-arrivals -- --airport KLGA --date 2025-11-08
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
  "timezone": "America/New_York"
}
```

## License

Data from adsb.lol: Open Database License (ODbL) + CC0
