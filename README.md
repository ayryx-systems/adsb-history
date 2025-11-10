# ADSB History Processing

Simple pipeline to process ADSB historical data and identify aircraft that visited airports.

## Overview

1. **Ingestion**: Download raw ADSB data and store in S3
2. **Processing**: Identify aircraft that were on the ground at airports

## Quick Start

### Process ground aircraft locally

```bash
# Single airport
node scripts/processing/identify-ground-aircraft.js --airport KLGA --date 2025-11-08

# Multiple airports
node scripts/processing/identify-ground-aircraft-multi.js --date 2025-11-08 --all
```

### Process on EC2

```bash
# Process all enabled airports
./scripts/processing/run-on-ec2.sh --date 2025-11-08

# Process specific airports
./scripts/processing/run-on-ec2.sh --date 2025-11-08 --airports KLGA,KSFO

# Use specific AWS profile (if you have multiple AWS accounts)
# First, check your profiles: aws configure list-profiles
# Then use: AWS_PROFILE=your-profile-name ./scripts/processing/run-on-ec2.sh --date 2025-11-08
# Or: ./scripts/processing/run-on-ec2.sh --date 2025-11-08 --aws-profile your-profile-name
```

**Important**: The script will show which AWS account it's using. Make sure it matches your project account (not a different project).

The script will:

1. Package your code
2. Upload to S3
3. Launch an EC2 instance
4. Run the processing
5. Save results to S3
6. Auto-terminate

**View logs**: Go to AWS Console → EC2 → Select instance → Actions → Monitor and troubleshoot → Get system log

**Check results**: `aws s3 ls s3://ayryx-adsb-history/ground-aircraft/ --recursive | grep 2025-11-08`

## Output

Results are saved to S3:

- `s3://ayryx-adsb-history/ground-aircraft/AIRPORT/YYYY/MM/DD.json`

Each file contains:

```json
{
  "airport": "KLGA",
  "date": "2025-11-08",
  "aircraftIds": ["abc123", "def456", ...],
  "count": 123
}
```

## Configuration

Airports are configured in `config/airports.json`. Set `enabled: true` to process an airport.
