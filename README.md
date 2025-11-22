# ADSB History Processing

Pipeline to process ADSB historical data through three phases: ingestion, identification, and analysis.

## Overview

Three-phase pipeline:

1. **Ingestion**: Download raw ADSB data from GitHub → S3
2. **Identification**: Identify aircraft that were on the ground at airports
3. **Analysis**:
   - **3a. Flight Analysis**: Create detailed summaries with distance milestones
   - **3b. L1 Statistics**: Generate statistics (arrival times, aircraft types, milestones)

Each phase depends on the previous one's output.

## Running Scripts

**Important**: Always run scripts from the project root directory (`adsb-history/`).

```bash
cd adsb-history
node scripts/analysis/analyze-airport-day.js --airport KLGA --date 2025-11-08
```

### Why?

Cache and temp directories are created relative to your current working directory:

- **Cache**: `./cache/` - Created relative to `process.cwd()` (where you run the script)
- **Temp**: `./temp/` - Created relative to `process.cwd()` (where you run the script)

If you run scripts from subdirectories, cache and temp files will be created in unexpected locations, making it hard to find and manage files.

### Directory Structure

When running from the project root, you'll get this structure:

```
adsb-history/
├── cache/              # Processed files (keep)
│   ├── KLGA/
│   │   └── 2025/
│   │       └── 11/
│   └── metar/
├── temp/               # Temporary files (can delete)
│   ├── weather/
│   └── 2025-11-08/
└── scripts/            # Scripts (run from root)
```

### Environment Variables

You can override the temp directory using the `TEMP_DIR` environment variable:

```bash
# Use custom temp directory
TEMP_DIR=/path/to/temp node scripts/analysis/analyze-airport-day.js --airport KLGA --date 2025-11-08
```

**Note**: The cache directory (`./cache/`) is not configurable via environment variables. It's always created relative to your current working directory. For simplicity, always run scripts from the project root to use the default `./cache/` and `./temp/` directories.

### Cleaning Up Old Cache/Temp Directories

If you've previously run scripts from subdirectories, you may have cache/temp directories in places like `scripts/analysis/cache/` or `scripts/identification/temp/`. These are safe to delete:

```bash
# Remove old cache/temp from script subdirectories
rm -rf scripts/analysis/cache scripts/analysis/temp
rm -rf scripts/identification/cache scripts/identification/temp
```

Going forward, all cache and temp files will be created in the project root (`./cache/` and `./temp/`) when you run scripts from the root directory.

## Phase 1: Ingestion

Download raw ADSB data and store in S3.

**Input**: GitHub releases from [adsblol/globe_history_YYYY](https://github.com/adsblol/globe_history_2025) (repository determined by year, e.g., `globe_history_2024` for 2024 dates, `globe_history_2025` for 2025 dates)  
**Output**: `s3://ayryx-adsb-history/raw/YYYY/MM/DD/*.tar` (~3GB per day, compressed tar archives)

### Local

```bash
# Download 7 days of data
node scripts/download-week.js --start-date 2025-11-02 --days 7

# Download single day
node scripts/download-week.js --start-date 2025-11-08 --days 1
```

**Requirements**: ~50GB disk space for extraction

### EC2

```bash
# Download 7 days of data
./scripts/ingestion/provision-ec2-downloader.sh --start-date 2025-11-02 --days 7

# Download single day (for daily automation)
./scripts/ingestion/provision-ec2-downloader.sh --days 1
```

## Phase 2: Identification

Identify aircraft that were on the ground at airports.

**Input**: Raw ADSB data from Phase 1 (`s3://ayryx-adsb-history/raw/YYYY/MM/DD/*.tar`)  
**Output**: `s3://ayryx-adsb-history/ground-aircraft/AIRPORT/YYYY/MM/DD.json` (list of ICAO codes that were on ground)

### Local

```bash
# Single airport
node scripts/identification/identify-ground-aircraft.js --airport KLGA --date 2025-11-08

# Multiple airports
node scripts/identification/identify-ground-aircraft-multi.js --date 2025-11-08 --all
```

**Requirements**: ~50GB disk space for extraction

### EC2

```bash
# Process all enabled airports
./scripts/identification/run-on-ec2.sh --date 2025-11-08

# Process specific airports
./scripts/identification/run-on-ec2.sh --date 2025-11-08 --airports KLGA,KSFO

# Use specific AWS profile
AWS_PROFILE=your-profile-name ./scripts/identification/run-on-ec2.sh --date 2025-11-08
```

## Phase 3: Analysis

### 3a. Flight Analysis

Analyze flights to create detailed summaries with distance milestones.

**Input**:

- Ground aircraft list from Phase 2 (`s3://ayryx-adsb-history/ground-aircraft/AIRPORT/YYYY/MM/DD.json`)
- Raw ADSB data from Phase 1 (`s3://ayryx-adsb-history/raw/YYYY/MM/DD/*.tar`)

**Output**: `s3://ayryx-adsb-history/flight-summaries/AIRPORT/YYYY/MM/DD.json` (detailed flight data with milestones, classifications, touchdown/takeoff points)

#### Local

```bash
node scripts/analysis/analyze-airport-day.js --airport KLGA --date 2025-11-08
```

**Requirements**: ~50GB disk space for extraction

#### EC2

```bash
# Same script, run on EC2 instance with sufficient disk space
node scripts/analysis/analyze-airport-day.js --airport KLGA --date 2025-11-08
```

### 3b. L1 Statistics Generation

Generate aggregated statistics from flight summaries (arrival times, aircraft type breakdowns, milestone statistics).

**Input**: Flight summaries from Phase 3a (`s3://ayryx-adsb-history/flight-summaries/AIRPORT/YYYY/MM/DD.json`)  
**Output**:

- **S3**: `s3://ayryx-adsb-history/l1-stats/AIRPORT/YYYY/MM/DD.json` (statistical aggregates: means, medians, percentiles by aircraft type)
- **Local cache**: `./cache/AIRPORT/YYYY/MM/l1-stats-DD.json` (when running locally)

**Note**: This script **must be run after Phase 3a**. It reads the flight summaries and will error if they don't exist. The scripts are separate and do different things:

- **3a** (`analyze-airport-day.js`): Analyzes raw flight traces to create detailed per-flight summaries
- **3b** (`generate-l1-stats.js`): Aggregates those summaries into statistical reports

#### Local

```bash
node scripts/analysis/generate-l1-stats.js --airport KLGA --date 2025-11-08
```

#### EC2

```bash
# Same script, run on EC2 instance
node scripts/analysis/generate-l1-stats.js --airport KLGA --date 2025-11-08
```

## Pipeline Flow

```
GitHub Releases
    ↓ (Phase 1: Ingestion)
Raw ADSB Data (S3)
    ↓ (Phase 2: Identification)
Ground Aircraft List (S3)
    ↓ (Phase 3a: Flight Analysis)
Flight Summaries (S3)
    ↓ (Phase 3b: L1 Statistics)
L1 Statistics (S3)
```

## Weather Data

Download historical METAR data from Iowa State University Mesonet API and store in S3 for cross-referencing with arrival statistics.

**Input**: Mesonet API (https://mesonet.agron.iastate.edu)  
**Output**: `s3://ayryx-adsb-history/weather/metar/AIRPORT/AIRPORT_YYYY.csv` (one CSV file per airport per year)

### Usage

```bash
# Download and upload METAR data for all airports for a year
node scripts/weather/populate-aws-metar.js --year 2024

# Single airport
node scripts/weather/populate-aws-metar.js --year 2024 --airport KLGA

# Multiple airports
node scripts/weather/populate-aws-metar.js --year 2024 --airports KBOS,KLGA
```

The script downloads the full year (Jan 1 to Dec 31, or until current date if it's the current year) and overwrites any existing file for that airport and year on S3.

### Supported Airports

- **KBOS** - Boston Logan International
- **KORD** - Chicago O'Hare International
- **KEWR** - Newark Liberty International
- **KLGA** - LaGuardia Airport
- **KJFK** - John F. Kennedy International

The script includes rate limiting (2 second delay between requests) and automatic retries to be gentle with the mesonet API.

## Local Directory Structure

**Note**: These directories are created relative to where you run scripts. See [Running Scripts](#running-scripts) above for important guidance.

The project uses two main directories for local file storage:

### `./cache/` - Processed/Usable Files (Keep)

This directory contains processed, usable files that should be kept:

- **METAR JSON files**: `cache/metar/AIRPORT/AIRPORT_YYYY.json`

  - Converted from CSV using `scripts/metar_translation/metar_translator.py`
  - Used by analysis scripts (e.g., `FlightWeatherJoiner.js`)
  - Source: CSV files from S3 or `temp/weather/`

- **ADSB processed files**: `cache/AIRPORT/YYYY/MM/`
  - Flight summaries: `DD.json`
  - L1 statistics: `l1-stats-DD.json`
  - Ground aircraft lists: `DD.json`
  - Created by processing pipeline, also synced to S3

### `./temp/` - Temporary Working Files (Can Delete)

This directory contains temporary files used during processing:

- **METAR CSV downloads**: `temp/weather/AIRPORT_YYYY.csv`

  - Downloaded by `populate-aws-metar.js` from Mesonet API
  - Uploaded to S3, then can be deleted
  - Optional: Convert to JSON in `cache/metar/` using `metar_translator.py`

- **ADSB raw data**: `temp/YYYY-MM-DD/`
  - Tar files downloaded from S3: `YYYY-MM-DD.tar`
  - Extracted traces: `extracted/traces/...`
  - Used during processing, can be deleted after processing completes

**Recommendation**: Keep `cache/` for processed files, clean up `temp/` periodically to save disk space.

## Configuration

Airports are configured in `config/airports.json`. Set `enabled: true` to process an airport.
