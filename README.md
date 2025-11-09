# ADS-B Historical Data Collection & Analysis

A system for downloading, processing, and serving historical ADS-B flight data from [adsb.lol](https://github.com/adsblol/globe_history_2025) to power statistical analysis of flight operations.

## 📋 Project Status

**Status**: Architecture phase - implementation pending

This project is currently in the planning stage. The architecture has been designed and documented in `ARCHITECTURE.md`.

## 🎯 Purpose

This system will:
- Download daily global ADS-B position data from GitHub (~4GB/day compressed)
- Process and analyze flight tracks for specific airports (KLAX, KSFO, etc.)
- Calculate approach times (100nm → touchdown) under various conditions
- Detect go-arounds, diversions, and holding patterns
- Generate pre-computed statistics served via CDN for instant frontend loading
- Power the `planning-app` with real historical data (replacing mock data)

## 🗂️ Project Structure

See `ARCHITECTURE.md` for complete details.

```
ayryx-adsb-history/
├── ARCHITECTURE.md      # Complete system architecture (READ THIS FIRST)
├── README.md           # This file
├── config/             # Configuration files (airports, processing params)
├── src/
│   ├── ingestion/      # Download and extract data from GitHub
│   ├── processing/     # Build tracks, calculate metrics, detect events
│   └── utils/          # Shared utilities (aviation, geo, S3)
└── scripts/            # Operational scripts (daily-update, backfill)
```

## 🚀 Quick Start

> **Note**: Implementation not yet complete. These instructions are for future reference.

### Prerequisites

- Node.js 18+
- AWS account with S3 and CloudFront access
- AWS CLI configured

### Installation

```bash
npm install
cp .env.example .env
# Edit .env with your AWS credentials
```

### Configuration

Edit `config/airports.json` to specify which airports to analyze:

```json
{
  "airports": [
    {
      "icao": "KLAX",
      "enabled": true,
      "analysis_radius_nm": 150
    }
  ]
}
```

### Usage

**Process a single day**:
```bash
node scripts/daily-update.js --date 2025-01-15
```

**Backfill historical data**:
```bash
node scripts/backfill-historical.js --start-date 2024-01-01 --end-date 2025-01-31
```

**Reprocess an airport**:
```bash
node scripts/reprocess-airport.js --airport KLAX --start-date 2025-01-01
```

## 📊 Data Flow

```
GitHub (raw) → S3 (raw) → Processing → S3 (api/) → CloudFront → Frontend
```

1. **Ingestion**: Download global data from GitHub releases
2. **Processing**: Filter to specific airports, calculate metrics
3. **Generation**: Create pre-computed JSON statistics
4. **Serving**: Deliver via CloudFront CDN for instant loading

## 🔗 Integration

### Planning App

Replace mock data with real historical statistics:

```javascript
// Before: Mock data
const mockData = generateMockData();

// After: Real data
const response = await fetch('https://cdn.ayryx.com/api/KLAX/approaches/by-month/2025-01.json');
const realData = await response.json();
```

### Shared with atc-backend

This project reuses proven aviation logic from `atc-backend`:
- Approach path detection
- Go-around detection
- Geographic calculations

## 💰 Estimated Costs

- **S3 Storage**: ~$70/month (raw data accumulation)
- **CloudFront**: ~$5/month (API file delivery)
- **Processing (Lambda)**: ~$5/month (daily updates)
- **Total**: ~$80/month

## 📚 Documentation

- **[ARCHITECTURE.md](./ARCHITECTURE.md)** - Complete system design (start here!)
- **[atc-backend](../atc-backend/)** - Related project with shared aviation logic
- **[planning-app](../planning-app/)** - Primary consumer of this data

## 🛠️ Development Phases

### Phase 1: Data Ingestion ⏳
- [ ] GitHub release downloader
- [ ] Tar extraction and decompression
- [ ] S3 upload pipeline
- [ ] Test with 1 week of data

### Phase 2: Processing ⏳
- [ ] Flight track builder
- [ ] Approach analyzer (port from atc-backend)
- [ ] Event detector (go-arounds, diversions)
- [ ] Metrics aggregation

### Phase 3: API Generation ⏳
- [ ] JSON file generator
- [ ] CloudFront integration
- [ ] Caching and optimization

### Phase 4: Integration ⏳
- [ ] Update planning-app
- [ ] Testing and validation
- [ ] Production deployment

## 🔐 Environment Variables

See `.env.example` for required configuration:

```bash
AWS_REGION=us-west-2
S3_BUCKET_NAME=ayryx-adsb-history
CLOUDFRONT_DISTRIBUTION_ID=xxx
```

## 📝 License

Same license as parent Ayryx project.

Data from adsb.lol is provided under:
- Open Database License (ODbL)
- CC0 for contributed feeder data

## 🙋 Questions?

Refer to `ARCHITECTURE.md` for detailed technical information, design decisions, and implementation guidance.

---

**For AI Assistants**: Please read `ARCHITECTURE.md` completely before implementing any features. It contains critical design decisions, data formats, and integration requirements.

