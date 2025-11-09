# ADS-B Historical Data Collection

Download, process, and analyze historical ADS-B data from [adsb.lol/globe_history_2025](https://github.com/adsblol/globe_history_2025).

## 📋 Prerequisites

- Node.js 18+
- AWS Account with S3 access
- ~20GB disk space for temporary downloads (per week of data)

## 🚀 Quick Start

### 1. Install Dependencies

```bash
cd adsb-history
npm install
```

### 2. Configure AWS Credentials

Create `.env` file from the example:

```bash
cp .env.example .env
```

Edit `.env` and add your AWS credentials:

```env
AWS_REGION=us-west-2
AWS_ACCESS_KEY_ID=your_access_key_here
AWS_SECRET_ACCESS_KEY=your_secret_key_here
S3_BUCKET_NAME=ayryx-adsb-history
```

### 3. Download Recent Week of Data

**Option A: Automated EC2 (Recommended)**

Launch an EC2 instance that automatically downloads and uploads to S3:

```bash
./scripts/provision-ec2-downloader.sh --start-date 2025-11-02 --days 7
```

The EC2 instance will self-terminate when complete. See [EC2_INGESTION_README.md](./EC2_INGESTION_README.md) for details.

**Benefits:**
- No local disk space required
- Fast network transfer (EC2 → S3)
- Auto-terminates when complete
- Cost: < $0.10 per run

**Option B: Local Machine**

If you have 30GB+ free disk space:

```bash
npm run download-week
```

This will:
1. Download split tar files (`.tar.aa` + `.tar.ab`) from GitHub releases (~3GB)
2. Concatenate into single tar file
3. Upload to S3 at `raw/YYYY/MM/DD/` (tar only, not extracted)
4. Extract temporarily to verify structure
5. Clean up all temporary files

**Note:** We only store the compressed tar files in S3 (~3GB per day). Extracted data (~20GB per day) is generated on-demand during processing to save storage costs.

### 4. Custom Date Ranges

Download specific dates:

```bash
# Using EC2 (recommended)
./scripts/provision-ec2-downloader.sh --start-date 2025-11-02 --days 7

# Using local machine (requires 30GB+ disk space)
node scripts/download-week.js --start-date 2025-11-02 --days 7

# Download just 3 days
./scripts/provision-ec2-downloader.sh --start-date 2025-11-06 --days 3
```

## 📂 Directory Structure

```
adsb-history/
├── config/
│   ├── airports.json          # Airports to analyze
│   ├── aws-config.json         # S3/CloudFront configuration
│   └── processing-config.json  # Processing parameters
├── src/
│   ├── ingestion/
│   │   ├── GitHubReleaseDownloader.js
│   │   ├── DataExtractor.js
│   │   └── S3Uploader.js
│   └── utils/
│       ├── logger.js
│       └── s3.js
├── scripts/
│   └── download-week.js        # Download recent week
├── temp/                       # Temporary downloads (auto-cleaned)
└── logs/                       # Application logs
```

## ☁️ S3 Storage Structure

Data is organized in S3 as:

```
s3://ayryx-adsb-history/
├── raw/                          # Tar archives only (~3GB/day, ~1TB/year)
│   └── 2025/
│       └── 11/
│           └── 08/
│               └── v2025.11.08-planes-readsb-prod-0.tar
│
└── api/                          # Pre-computed stats (coming soon)
    └── KLAX/
        └── approaches/
            └── all-time.json
```

**Tar contents** (extracted on-demand during processing):
- `./traces/d0/`, `./traces/d1/`, ... `./traces/ff/` - Flight traces by ICAO hex
- `./acas/` - Collision avoidance data

## 🔧 Available Scripts

- `npm run download-week` - Download recent 7 days
- `npm run daily-update` - (Coming soon) Daily incremental update
- `npm run backfill` - (Coming soon) Bulk historical download

## 📊 Data Source

**adsb.lol globe_history_2025**: https://github.com/adsblol/globe_history_2025/releases

- Daily releases with format: `v2025.11.08-planes-readsb-prod-0`
- Split tar archives: `.tar.aa` (~2GB) + `.tar.ab` (~1GB)
- Contains global ADS-B position reports in readsb JSON format

## 🐛 Troubleshooting

### AWS Credentials Not Found

Make sure you've created `.env` file with valid AWS credentials:

```bash
cp .env.example .env
# Edit .env with your credentials
```

### Out of Disk Space

The download script cleans up temporary files automatically. If you run out of space:

```bash
rm -rf temp/
```

### GitHub Rate Limits

GitHub allows 60 API requests per hour for unauthenticated requests. This should be sufficient for downloading a few days of data at a time. If you need to download more frequently, space out your downloads.

## 📖 Next Steps

After downloading raw data:

1. **Processing**: Implement flight track building and metrics calculation
2. **Analysis**: Extract airport-specific statistics
3. **API Generation**: Create pre-computed JSON files for frontend
4. **CloudFront**: Deploy CDN for fast global access

See [ARCHITECTURE.md](./ARCHITECTURE.md) for complete system design.

## 📝 License

Data from adsb.lol is provided under Open Database License (ODbL) + CC0.
