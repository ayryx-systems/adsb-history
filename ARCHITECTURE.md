# ADS-B Historical Data Collection & Analysis System

## 🎯 Purpose

Download, process, and serve historical ADS-B data from [adsb.lol/globe_history_2025](https://github.com/adsblol/globe_history_2025) to provide statistical analysis of flight operations for the `planning-app`.

Primary metrics:

- Approach times (100nm → touchdown) by conditions
- Go-around and diversion rates
- Flight pattern analysis

## 📊 High-Level Architecture

```
┌──────────────────────────────────────────────────────────┐
│  INGESTION (Daily Cron)                                  │
│  - Download global raw data from GitHub (~4GB/day)       │
│  - Extract tar + decompress gzipped JSON                 │
│  - Store in S3 raw/ (kept forever)                       │
└────────────────┬─────────────────────────────────────────┘
                 │
                 ▼
┌──────────────────────────────────────────────────────────┐
│  PROCESSING (Daily Batch)                                │
│  1. Spatial filter: Extract flights near KLAX, KSFO, ... │
│  2. Build flight tracks (group positions by ICAO)        │
│  3. Calculate approach times (100nm → touchdown)         │
│  4. Detect go-arounds & diversions                       │
│  5. Generate/update pre-computed JSON files              │
│  6. Upload to S3 api/ → CloudFront invalidation         │
└────────────────┬─────────────────────────────────────────┘
                 │
                 ▼
┌──────────────────────────────────────────────────────────┐
│  S3 + CloudFront (Static JSON API)                       │
│  - Pre-computed statistics by airport                    │
│  - No database, no queries, no backend server            │
│  - Instant global delivery via CDN                       │
└────────────────┬─────────────────────────────────────────┘
                 │
                 ▼
┌──────────────────────────────────────────────────────────┐
│  PLANNING-APP (Frontend Consumer)                        │
│  - fetch() pre-computed JSON from CDN                    │
│  - Instant display, no processing                        │
│  - Replace mock data with real historical stats          │
└──────────────────────────────────────────────────────────┘
```

## 🗂️ Folder Structure

```
ayryx-adsb-history/
├── ARCHITECTURE.md              # This file
├── README.md                    # Setup and usage instructions
├── package.json                 # Dependencies
├── .env.example                 # Environment variables template
├── .gitignore
│
├── config/
│   ├── airports.json           # Airport definitions (which airports to analyze)
│   ├── processing-config.json  # Processing parameters
│   └── aws-config.json         # S3 bucket names, CloudFront distribution
│
├── src/
│   ├── ingestion/
│   │   ├── GitHubReleaseDownloader.js   # Download tar files from GitHub releases
│   │   ├── DataExtractor.js             # Extract tar + decompress gzipped JSON
│   │   └── S3Uploader.js                # Upload raw data to S3
│   │
│   ├── processing/
│   │   ├── FlightTrackBuilder.js        # Group position reports by ICAO hex
│   │   ├── ApproachAnalyzer.js          # Calculate approach times (port from atc-backend)
│   │   ├── EventDetector.js             # Detect go-arounds, diversions, holdings
│   │   ├── MetricsCalculator.js         # Aggregate statistics
│   │   └── JSONGenerator.js             # Generate pre-computed JSON files
│   │
│   ├── utils/
│   │   ├── aviation.js                  # Aviation calculations (shared with atc-backend)
│   │   ├── geo.js                       # Geographic calculations (shared with atc-backend)
│   │   ├── logger.js                    # Logging utilities
│   │   └── s3.js                        # S3 helper functions
│   │
│   └── index.js                         # Main orchestrator
│
├── scripts/
│   ├── backfill-historical.js          # Download and process all historical data
│   ├── daily-update.js                 # Cron job for daily incremental updates
│   ├── reprocess-airport.js            # Reprocess data for specific airport
│   └── verify-data-integrity.js        # Verify raw and processed data
│
└── tests/
    ├── unit/
    │   ├── FlightTrackBuilder.test.js
    │   ├── ApproachAnalyzer.test.js
    │   └── EventDetector.test.js
    └── integration/
        └── end-to-end.test.js
```

## 🗄️ S3 Storage Structure

```
s3://ayryx-adsb-history/
│
├── raw/                                    # Keep forever, tar archives only
│   ├── 2025/
│   │   ├── 01/
│   │   │   ├── 15/
│   │   │   │   └── v2025.01.15-planes-readsb-prod-0.tar  # ~3GB (concatenated from .tar.aa + .tar.ab)
│   │   │   ├── 16/
│   │   │   └── ...
│   │   └── 02/
│   └── 2024/
│
│   # Note: Extract tar files on-demand during processing, not stored in S3
│   # Extracted structure (temporary):
│   #   ./traces/d0/, ./traces/d1/, ... ./traces/ff/  (256 subdirs by hex)
│   #     └── trace_full_<icao>.json  (one file per aircraft)
│   #   ./acas/acas.csv.gz, acas.json.gz  (collision avoidance data)
│
├── processed/                              # Intermediate processing artifacts
│   └── flights/                            # Optional: full flight tracks
│       ├── KLAX/
│       │   └── 2025/
│       │       └── 01/
│       │           ├── 15/
│       │           │   ├── AAL123.json    # Complete flight track
│       │           │   ├── UAL456.json
│       │           │   └── ...
│       │           └── ...
│       └── KSFO/
│           └── ...
│
└── api/                                    # Pre-computed JSON served to frontend
    ├── manifest.json                       # Processing status and metadata
    │
    ├── KLAX/
    │   ├── overview.json                   # Airport summary statistics
    │   │
    │   ├── approaches/
    │   │   ├── all-time.json              # Complete historical aggregate
    │   │   │
    │   │   ├── by-year/
    │   │   │   ├── 2024.json
    │   │   │   └── 2025.json
    │   │   │
    │   │   ├── by-month/
    │   │   │   ├── 2025-01.json           # All approach data for Jan 2025
    │   │   │   ├── 2025-02.json
    │   │   │   └── ...
    │   │   │
    │   │   ├── by-weather/
    │   │   │   ├── vfr.json               # Visual flight rules conditions
    │   │   │   ├── mvfr.json              # Marginal VFR
    │   │   │   └── ifr.json               # Instrument flight rules
    │   │   │
    │   │   └── by-time-of-day/
    │   │       ├── morning.json           # 06:00-12:00 local
    │   │       ├── afternoon.json         # 12:00-18:00 local
    │   │       ├── evening.json           # 18:00-00:00 local
    │   │       └── night.json             # 00:00-06:00 local
    │   │
    │   ├── go-arounds/
    │   │   ├── summary.json               # All-time go-around statistics
    │   │   └── by-month/
    │   │       ├── 2025-01.json
    │   │       └── ...
    │   │
    │   ├── diversions/
    │   │   ├── summary.json
    │   │   └── by-month/
    │   │       └── ...
    │   │
    │   └── daily/                         # Optional: day-by-day data
    │       ├── 2025-01-15.json
    │       └── ...
    │
    └── KSFO/
        └── [same structure as KLAX]
```

## 💾 Data Organization

### Input Configuration

- **Airports**: List of airports to analyze with coordinates, runways, and analysis radius
- **Processing parameters**: Thresholds and settings (determined during implementation)

### Output Data Structure

Pre-computed JSON files organized by:

- **Airport** (KLAX, KSFO, etc.)
- **Time period** (all-time, by-year, by-month, daily)
- **Conditions** (weather, time-of-day)
- **Event types** (approaches, go-arounds, diversions)

Content includes:

- Statistical aggregates (percentiles, means, counts)
- Event rates and patterns
- Sample flights for reference
- Processing metadata and status

## 🔧 Core Components

### 1. Ingestion Layer

Downloads and stores raw ADS-B data from GitHub.

**Components**:

- **GitHub Downloader**: Fetch daily releases (2 tar files per day, ~4GB total)
- **Data Extractor**: Extract tar archives and decompress gzipped JSON files
- **S3 Uploader**: Organize and upload raw data to S3

**Data Source**: https://github.com/adsblol/globe_history_2025/releases

### 2. Processing Layer

Transforms raw position data into flight metrics and statistics.

**Components**:

- **Flight Track Builder**: Group position reports by aircraft, identify flight type (arrival/departure/overflight)
- **Approach Analyzer**: Calculate approach times and metrics (reuse logic from `atc-backend`)
- **Event Detector**: Identify go-arounds, diversions, and holding patterns (reuse logic from `atc-backend`)
- **Metrics Calculator**: Aggregate statistics (percentiles, means, rates)
- **JSON Generator**: Create pre-computed output files

**Key Operations**:

- Spatial filtering (extract flights near configured airports)
- Flight phase detection
- Statistical aggregation by conditions
- Output optimization and compression

### 3. Shared Utilities (from `atc-backend`)

Reuse existing aviation logic for consistency:

- **aviation.js**: Approach detection, event detection, flight phases
- **geo.js**: Distance calculations, bearings, spatial filtering

## 🔄 Processing Workflows

### Daily Incremental Update

Run daily (scheduled cron) to process new data:

1. Check for new GitHub releases
2. Download and extract new day's data
3. Process for each configured airport
4. Update aggregated statistics
5. Upload to S3 and invalidate CloudFront CDN

### Historical Backfill

One-time bulk processing of historical data:

- Identify missing date ranges
- Download and process in parallel
- Generate complete aggregate statistics

### Reprocess Airport

On-demand reprocessing when needed:

- New airport added to configuration
- Improved processing logic requiring recalculation
- Bug fixes or data corrections

## 🚀 Deployment

### AWS Infrastructure

**Storage**:

- **S3**: Raw data, processed data, and API files
- **CloudFront**: CDN for serving pre-computed JSON to frontend

**Processing** (choose based on scale):

- **Lambda**: Serverless, event-triggered (suitable for daily updates)
- **EC2 Spot**: More cost-effective for large backfills
- **EventBridge**: Scheduled cron triggers

**CI/CD**: Deploy code updates, run tests, invalidate CDN caches

## 💰 Estimated Costs

**Monthly (steady state)**: ~$15-20

- S3 storage: ~$10/month (1TB/year for tar files only)
- CloudFront: ~$5/month (frontend API delivery)
- Lambda/compute: ~$5-10/month (daily processing)

**One-time backfill**: ~$10-60 (depending on Lambda vs EC2 Spot)

## 🔐 Configuration

Environment variables and config files to define:

- AWS credentials and resource names
- GitHub API tokens (optional, for rate limits)
- Processing parameters (parallelism, temp directories, log levels)
- Airport definitions

## 📝 Key Design Decisions

### 1. No Database for Frontend Data

- **Decision**: Pre-compute all statistics, serve as static JSON via CDN
- **Rationale**:
  - Frontend requires instant loading, no query delays
  - Historical data changes infrequently (only new days added)
  - Static files are cheaper and more scalable than database queries
- **Trade-off**: Less flexible querying, but frontend doesn't need it

### 2. Keep Raw Tar Files Forever, Extract On-Demand

- **Decision**: Store tar archives in S3, extract temporarily during processing
- **Rationale**:
  - Can reprocess with improved logic later
  - Can add new airports without re-downloading
  - Storage is cheap (~$10/month for 1TB/year of compressed tars)
  - Extract on-demand saves 7x storage costs (3GB tar vs 20GB extracted)
- **Trade-off**: Slight processing overhead to extract, but major cost savings

### 3. Stateless Processing (No DynamoDB)

- **Decision**: Use S3 itself as "database" for processing state
- **Rationale**:
  - Simpler architecture, fewer moving parts
  - Idempotent processing (safe to re-run)
  - S3 checking is fast enough for daily batch jobs
- **Trade-off**: Slower status queries, but not needed for this use case

### 4. Spatial Filtering at Processing Time

- **Decision**: Store global raw data, filter to airports during processing
- **Rationale**:
  - Easy to add new airports (just reprocess)
  - Raw data reusable for other analyses
  - Only process what's needed (saves compute)
- **Trade-off**: Can't analyze arbitrary locations without reprocessing

### 5. Port Logic from atc-backend

- **Decision**: Reuse existing aviation logic for approach detection, event detection
- **Rationale**:
  - Proven logic already working in production
  - Consistent definitions between live and historical analysis
  - Don't reinvent the wheel
- **Trade-off**: Dependency on atc-backend code structure

## 🧪 Testing & Validation

- Unit tests for core processing logic
- Integration tests for end-to-end workflows
- Validate against `atc-backend` live data (where overlap exists)
- Manual spot checks of sample flights

## 📚 Potential Future Enhancements

- Weather correlation (METAR/TAF integration)
- Aircraft type analysis
- Runway-specific statistics
- Seasonal and time-of-day patterns
- Predictive modeling
- Real-time + historical data blending

## 🔗 Integration

### Reuses from `atc-backend`

- Aviation utilities (approach detection, event detection, geo calculations)
- Airport definitions and runway data
- Flight phase detection logic

### Serves to `planning-app`

- Pre-computed statistics via CloudFront CDN
- Replaces mock data with real historical analysis

### Other Potential Consumers

- `pilot-app`, `atc-dashboard`, analytics platforms

## 📖 Data Source

**adsb.lol globe_history**: https://github.com/adsblol/globe_history_2025/releases

- License: Open Database License (ODbL) + CC0
- Format: Daily tar archives of readsb JSON position reports

---

## 🚦 Implementation Approach

1. Review this architecture and understand data needs from `planning-app`
2. Examine existing aviation logic in `atc-backend`
3. Implement ingestion layer (download, extract, store)
4. Build processing pipeline (track building, metrics, event detection)
5. Generate pre-computed JSON files
6. Deploy to AWS with CloudFront CDN
7. Integrate with `planning-app` frontend

**Key Principle**: Build incrementally, test with small datasets first, ensure idempotent processing.
