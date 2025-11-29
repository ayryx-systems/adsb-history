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

**SSH Access**: Use `./scripts/ingestion/ssh-to-instance.sh INSTANCE_ID` to connect. View logs with `tail -f /var/log/user-data.log`.

## Phase 2: Identification

Identify aircraft that were on the ground at airports.

**Input**: Raw ADSB data from Phase 1 (`s3://ayryx-adsb-history/raw/YYYY/MM/DD/*.tar`)  
**Output**: `s3://ayryx-adsb-history/ground-aircraft/AIRPORT/YYYY/MM/DD.json` (list of ICAO codes that were on ground)

### Local

```bash
# Single airport
node scripts/identification/identify-ground-aircraft.js --airport KLGA --date 2025-11-08

# Multiple airports
node scripts/identification/identify-ground-aircraft.js --all --date 2025-11-08
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

## Phase 2.5: Extraction

Extract traces for identified aircraft into per-airport tar files. This creates much smaller files (~50-200MB) that contain only the traces for aircraft that were on the ground at a specific airport, making downstream processing much more efficient.

**Input**:

- Ground aircraft list from Phase 2 (`s3://ayryx-adsb-history/ground-aircraft/AIRPORT/YYYY/MM/DD.json`)
- Raw ADSB data from Phase 1 (`s3://ayryx-adsb-history/raw/YYYY/MM/DD/*.tar`)

**Output**: `s3://ayryx-adsb-history/extracted/AIRPORT/YYYY/MM/AIRPORT-YYYY-MM-DD.tar` (tar file containing only traces for identified aircraft)

**Important**: This phase **must be completed** before Phase 3a. Downstream scripts will fail if extracted traces don't exist. Run extraction once for all dates and airports, then never download raw tar files again.

### Blanket Extraction (Recommended)

Extract traces for all enabled airports for a date range:

```bash
# Extract all enabled airports for January 2025
node scripts/extraction/extract-all-airports.js --start-date 2025-01-01 --end-date 2025-01-31

# Extract specific airports for a date range
node scripts/extraction/extract-all-airports.js --start-date 2025-01-01 --end-date 2025-01-15 --airports KORD,KLGA
```

**Requirements**: ~50GB disk space for extraction (processes one day at a time)

### Single Airport Extraction

For processing a single airport:

```bash
# Single date
node scripts/extraction/extract-airport-traces.js --airport KORD --date 2025-01-15

# Date range
node scripts/extraction/extract-airport-traces.js --airport KORD --start-date 2025-01-15 --days 7
```

## Phase 3: Analysis

### 3a. Flight Analysis

Analyze flights to create detailed summaries with distance milestones.

**Input**: Extracted traces from Phase 2.5 (`s3://ayryx-adsb-history/extracted/AIRPORT/YYYY/MM/AIRPORT-YYYY-MM-DD.tar`)

**Output**:

- `s3://ayryx-adsb-history/flight-summaries/AIRPORT/YYYY/MM/DD.json` (detailed flight data with milestones, classifications, touchdown/takeoff points)
- **Local cache**: `./cache/traces/AIRPORT/YYYY/MM/DD/ICAO.json` (simplified traces for visualization)

**Important**: Extracted traces **must exist** before running this phase. Run `extract-all-airports.js` first. The script will fail if extracted traces are not found.

**Simplified Traces**: As a side-effect of flight analysis, simplified trace files are automatically created for all arrivals and departures. These contain minimal position data optimized for map visualization. Traces are saved to `./cache/traces/AIRPORT/YYYY/MM/DD/ICAO.json` and can be loaded on-demand by the viewer when users click on scatter plot dots.

**Simplified Trace Format:**

```json
{
  "icao": "a1b2c3",
  "date": "2025-01-09",
  "airport": "KORD",
  "classifications": ["arrival"],
  "points": [
    [41.9786, -87.9048, 35000, 1704758400, 90],
    ...
  ],
  "metadata": {
    "registration": "N123AB",
    "aircraftType": "B738",
    "description": "Boeing 737-800",
    "minAlt": 0,
    "maxAlt": 35000,
    "startTime": 1704758400,
    "endTime": 1704762000,
    "pointCount": 1500
  }
}
```

Each point in the `points` array is `[lat, lon, alt, timestamp, track]`:

- `lat`, `lon`: Latitude/longitude in degrees (float)
- `alt`: Altitude in feet (int)
- `timestamp`: Unix epoch seconds (int)
- `track`: Heading in degrees 0-360 (int, null if unavailable)

#### Local

```bash
node scripts/analysis/analyze-airport-day.js --airport KLGA --date 2025-11-08
```

**Requirements**: ~1-5GB disk space (uses extracted traces, much smaller than raw tar)

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

### 3c. Yearly Baseline Generation

Generate yearly baseline data for comparing daily statistics against yearly averages. This creates aggregated baseline data used by the viewer to show how each day compares to the yearly average.

**Input**: Daily L1 statistics from Phase 3b (all days for a year)  
**Output**:

- **Local cache**: `./cache/AIRPORT/YYYY/yearly-baseline.json` (yearly averages per time slot)
- Contains:
  - Average arrival counts per time slot across the year
  - Median time from 50nm per time slot (aggregated across all days)
  - Median time from 100nm per time slot (aggregated across all days)

**Note**: This script **must be run after Phase 3b** has generated L1 statistics for the year. It aggregates all daily L1 stats files to create baseline comparisons. The baseline data is used by the viewer to overlay yearly averages on daily charts.

#### Local

```bash
# Generate baseline for a year
node scripts/analysis/generate-yearly-baseline.js --airport KORD --year 2025

# Force regeneration even if baseline exists
node scripts/analysis/generate-yearly-baseline.js --airport KORD --year 2025 --force
```

#### EC2

```bash
# Same script, run on EC2 instance
node scripts/analysis/generate-yearly-baseline.js --airport KORD --year 2025
```

**When to run**: After processing a full year of data (or when you want to update the baseline with new data). The baseline is used by the viewer to show how each day compares to the yearly average.

### Running Complete Analysis Pipeline

Run analysis phases (2, 3a, and 3b) for a date range in one command. This script processes each day sequentially, running:

1. Phase 2: Identify ground aircraft
2. Phase 3a: Analyze flights (create flight summaries) - **requires extracted traces to exist**
3. Phase 3b: Generate L1 statistics

**Prerequisites**:

- Raw ADSB data from Phase 1 (must be ingested first)
- Extracted traces from Phase 2.5 (run `extract-all-airports.js` first)

**Output**: Complete analysis pipeline outputs (ground aircraft lists, flight summaries, and L1 statistics)

#### Local

```bash
# Process date range (defaults to January 2025)
node scripts/analysis/process-analysis-pipeline.js --airport KORD

# Process specific date range
node scripts/analysis/process-analysis-pipeline.js --airport KORD --start-date 2025-01-15 --end-date 2025-01-20

# Force reprocess even if data exists
node scripts/analysis/process-analysis-pipeline.js --airport KORD --start-date 2025-01-15 --end-date 2025-01-20 --force
```

**Requirements**: ~50GB disk space for extraction (processes one day at a time to manage disk usage)

#### EC2

```bash
# Same script, run on EC2 instance with sufficient disk space
node scripts/analysis/process-analysis-pipeline.js --airport KORD --start-date 2025-01-15 --end-date 2025-01-20
```

## Pipeline Flow

```
GitHub Releases
    ↓ (Phase 1: Ingestion)
Raw ADSB Data (S3) ~2GB/day
    ↓ (Phase 2: Identification)
Ground Aircraft List (S3) ~100KB/day
    ↓ (Phase 2.5: Extraction - REQUIRED)
Extracted Traces (S3) ~50-200MB/day per airport
    ↓ (Phase 3a: Flight Analysis)
Flight Summaries (S3) ~1-10MB/day per airport
    ↓ (Phase 3b: L1 Statistics)
L1 Statistics (S3) ~100KB/day per airport
    ↓ (Phase 3c: Yearly Baseline - Optional)
Yearly Baseline (Local Cache)
```

**Important**: Phase 2.5 (Extraction) **must be completed** before Phase 3a. Once extraction is done for a date range, you never need to download raw tar files again. Downstream scripts will fail if extracted traces don't exist.

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

- **Simplified traces**: `cache/traces/AIRPORT/YYYY/MM/DD/ICAO.json`
  - Minimal trace data for map visualization
  - Created automatically during Phase 3a (flight analysis)
  - Contains position points: `[lat, lon, alt, timestamp, track]`
  - Only created for arrivals and departures (not overflights)
  - Used by viewer to display flight paths on scatter plot click

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

## Utility Scripts

### Get and Visualize Aircraft Trace

Retrieve raw ADSB trace data for a specific aircraft and generate an interactive HTML visualization. The script automatically downloads and caches the tar file from S3, extracts it if needed, finds the trace for the specified ICAO code, saves it to a standard filename, and generates an HTML visualization.

**Usage:**

```bash
node scripts/trace_utils/get-and-visualize-trace.js --icao <ICAO_CODE> --date <YYYY-MM-DD> [--thin N]
```

**Example:**

```bash
# Get trace and generate visualization for ICAO a1b2c3 on January 6, 2025
node scripts/trace_utils/get-and-visualize-trace.js --icao a1b2c3 --date 2025-01-06

# For better performance with large traces, thin the data
node scripts/trace_utils/get-and-visualize-trace.js --icao a1b2c3 --date 2025-01-06 --thin 5
```

**Options:**

- `--icao <ICAO_CODE>`: 6-character hexadecimal ICAO code (required)
- `--date <YYYY-MM-DD>`: Date in YYYY-MM-DD format (required)
- `--thin N`: Only show every Nth point in the visualization (e.g., `--thin 5` shows every 5th point). Useful for very large traces with thousands of points to improve performance.

**Output Files:**

The script automatically creates two files with standard names:

- **Trace file**: `trace_<icao>_<date>.txt` - JSON file containing the raw trace data
- **HTML visualization**: `trace_<icao>_<date>.html` - Interactive map visualization

Example: For ICAO `a1b2c3` on date `2025-01-06`, the script creates:

- `trace_a1b2c3_2025-01-06.txt`
- `trace_a1b2c3_2025-01-06.html`

**Features:**

- Automatically downloads tar file from S3 (cached in `./temp/YYYY-MM-DD/`)
- Extracts tar file if needed (cached extraction in `./temp/YYYY-MM-DD/extracted/`)
- Finds trace file using hex subdirectory organization
- Saves trace data to standardized filename (no need to specify output file)
- Generates interactive HTML visualization with standardized filename
- Interactive Leaflet map with OpenStreetMap tiles
- Directional arrows at each data point showing aircraft track (direction of travel)
- Color-coded arrows based on altitude (blue = low altitude, red = high altitude)
- **Viewport-based rendering** for performance - only renders markers visible in the current viewport, automatically updates as you pan/zoom
- Hover over arrows to see altitude, ground speed, track, and timestamp
- Start/end markers with altitude information
- Flight metadata display (ICAO, registration, aircraft type, date)
- Altitude range and duration statistics
- Optional data thinning (`--thin N`) for very large traces
- No dependencies - uses Leaflet via CDN

**Trace File Format:**

The trace file contains complete trace data in JSON format:

```json
{
  "icao": "a1b2c3",
  "date": "2025-01-06",
  "registration": "N123AB",
  "aircraftType": "B738",
  "description": "Boeing 737-800",
  "trace": [
    [timestamp, lat, lon, alt, gs, track],
    ...
  ],
  "traceCount": 1234
}
```

**HTML Visualization:**

The HTML file is a standalone file that can be opened directly in any web browser. The map automatically fits to show the entire flight path.

## Configuration

Airports are configured in `config/airports.json`. Set `enabled: true` to process an airport.
