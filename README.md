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

## Phase 1: Ingestion

Download raw ADSB data and store in S3.

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

**Output**: `s3://ayryx-adsb-history/raw/YYYY/MM/DD/*.tar`

## Phase 2: Identification

Identify aircraft that were on the ground at airports.

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

**Input**: Raw data from Phase 1  
**Output**: `s3://ayryx-adsb-history/ground-aircraft/AIRPORT/YYYY/MM/DD.json`

## Phase 3: Analysis

### 3a. Flight Analysis

Analyze flights to create detailed summaries with distance milestones.

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

**Input**: Ground aircraft list from Phase 2 + raw data from Phase 1  
**Output**: `s3://ayryx-adsb-history/flight-summaries/AIRPORT/YYYY/MM/DD.json`

### 3b. L1 Statistics Generation

Generate detailed statistics from flight summaries (arrival times, aircraft type breakdowns, milestone statistics).

#### Local

```bash
node scripts/analysis/generate-l1-stats.js --airport KLGA --date 2025-11-08
```

#### EC2

```bash
# Same script, run on EC2 instance
node scripts/analysis/generate-l1-stats.js --airport KLGA --date 2025-11-08
```

**Input**: Flight summaries from Phase 3a  
**Output**: `s3://ayryx-adsb-history/l1-stats/AIRPORT/YYYY/MM/DD.json`

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

## Configuration

Airports are configured in `config/airports.json`. Set `enabled: true` to process an airport.
