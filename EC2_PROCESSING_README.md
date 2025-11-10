# EC2 Processing for ADSB Historical Data

Identify aircraft that were on the ground at an airport on a specific date.

## Why EC2?

- **No local disk space needed** - Processing requires ~50GB (tar + extraction + temp files)
- **Fast processing** - t3.xlarge (4 vCPU, 16GB RAM) processes in ~10-15 minutes
- **Cost-effective** - Instance auto-terminates when done (~$0.04-0.05 per run)
- **Free S3 transfers** - EC2 to S3 in same region (us-west-1) are free

## Quick Start

### Process all enabled airports for a date

```bash
cd adsb-history
./scripts/provision-ec2-processor.sh --date 2025-11-08
```

### Process specific airports

```bash
./scripts/provision-ec2-processor.sh --airports KLGA,KJFK,KLAX --date 2025-11-08
```

**What it does:**

1. Launches EC2 instance (t3.xlarge, 50GB, us-west-1)
2. Downloads tar from S3 (~3 minutes)
3. Extracts and processes traces (~10 minutes per airport)
4. Identifies aircraft on ground for each airport (within 1nm, altitude < 500ft)
5. Saves list of ICAO codes to S3 for each airport
6. Auto-terminates when complete

**Cost:** ~$0.04-0.05 per run (processes all airports in one instance)

### Monitor Progress

```bash
# Monitor specific instance
./scripts/monitor-ec2-processor.sh i-1234567890abcdef

# Or auto-detect latest
./scripts/monitor-ec2-processor.sh auto
```

Shows:

- Instance state and uptime
- Processing progress
- When results are available in S3

## How It Works

```
┌─────────────────────────────────────────────────────────────┐
│ Local Machine                                               │
│ • Run provision script                                      │
│ • Packages code, uploads to S3                              │
│ • Launches EC2 instance                                     │
└────────────────┬────────────────────────────────────────────┘
                 │
                 ▼
┌─────────────────────────────────────────────────────────────┐
│ EC2 Instance (t3.xlarge, 50GB, us-west-1)                  │
│                                                              │
│ 1. Download tar from S3 (~3GB)                              │
│ 2. Extract traces (~20GB extracted)                         │
│ 3. Process ~68k traces                                      │
│ 4. Identify aircraft on ground                              │
│ 5. Save ICAO list to S3 (~50KB)                             │
│ 6. Self-terminate                                           │
│                                                              │
│ Duration: ~10-15 minutes                                     │
│ Cost: ~$0.04-0.05                                            │
└────────────────┬────────────────────────────────────────────┘
                 │
                 ▼
┌─────────────────────────────────────────────────────────────┐
│ S3: Ground Aircraft List                                    │
│ s3://bucket/ground-aircraft/KLGA/2025/11/08.json           │
│                                                              │
│ Format:                                                      │
│ {                                                           │
│   "airport": "KLGA",                                        │
│   "date": "2025-11-08",                                     │
│   "aircraftIds": ["a12345", "b67890", ...],                │
│   "count": 323                                              │
│ }                                                           │
└────────────────────────────────────────────────────────────┘
```

## Options

```bash
./scripts/provision-ec2-processor.sh [options]

Options:
  --airports ICAO,...   Comma-separated airports (default: all enabled)
  --airport ICAO        Single airport (backward compatibility)
  --date YYYY-MM-DD     Date to process (default: yesterday)
  --instance-type TYPE  Instance type (default: t3.xlarge)
  --help                Show help

Examples:
  # Process all enabled airports
  ./scripts/provision-ec2-processor.sh --date 2025-11-08

  # Process specific airports
  ./scripts/provision-ec2-processor.sh --airports KLGA,KJFK,KLAX --date 2025-11-08

  # Process single airport (backward compat)
  ./scripts/provision-ec2-processor.sh --airport KLGA --date 2025-11-08
```

## Cost Breakdown

**Per processing run:**

- **EC2**: t3.xlarge @ $0.1664/hour × 0.25 hours = **$0.04**
- **EBS**: 50GB gp3 @ $0.08/GB/month × 0.25 hours / 730 hours = **$0.001**
- **S3 transfer**: Free (same region)
- **S3 storage**: ~50KB @ $0.023/GB/month = **negligible**

**Total per run: ~$0.04-0.05**

**Monthly (30 airports, daily):**

- 30 airports × 30 days × $0.04 = **$36/month**

## Infrastructure

The script automatically creates:

1. **IAM Role**: `adsb-history-processor-role`

   - S3 read/write access to `ayryx-adsb-history` bucket

2. **Security Group**: `adsb-history-processor-sg`

   - Egress only (no inbound access)

3. **EC2 Instance**: Auto-configured
   - Amazon Linux 2023
   - Node.js 18
   - All dependencies installed
   - Auto-terminates on completion

## Monitoring

### Check Instance Status

```bash
# Monitor continuously
./scripts/monitor-ec2-processor.sh auto

# Check S3 for results
aws s3 ls s3://ayryx-adsb-history/ground-aircraft/KLGA/2025/11/

# List all processor instances
aws ec2 describe-instances \
  --region us-west-1 \
  --filters "Name=tag:Purpose,Values=adsb-processing" \
  --query 'Reservations[].Instances[].[InstanceId,State.Name,Tags[?Key==`Name`].Value|[0],LaunchTime]' \
  --output table
```

### Troubleshooting

**Instance doesn't terminate:**

- Processing likely failed - instance stays running for debugging
- Check logs: SSH to instance (would need key pair setup)
- Manually terminate: `aws ec2 terminate-instances --instance-ids i-xxx --region us-west-1`

**Processing takes too long (>30 minutes):**

- Check if stuck in extraction or download
- Consider larger instance type (t3.2xlarge)
- Check S3 to see if partial results uploaded

**Cost concerns:**

- Instances auto-terminate to prevent runaway costs
- Set up billing alerts in AWS Console
- Monitor with `./scripts/monitor-ec2-processor.sh`

## Process Multiple Dates

Process a week of data:

```bash
for date in 2025-11-02 2025-11-03 2025-11-04 2025-11-05 2025-11-06 2025-11-07 2025-11-08; do
  echo "Processing $date..."
  ./scripts/provision-ec2-processor.sh --airport KLGA --date $date
  sleep 5  # Brief delay between launches
done
```

**Note:** Multiple instances can run in parallel (each processes different dates).

## Local Processing

You can also process locally if you have ~50GB disk space:

```bash
# Process all enabled airports
node scripts/identify-ground-aircraft-multi.js --date 2025-11-08 --all

# Process specific airports
node scripts/identify-ground-aircraft-multi.js --date 2025-11-08 --airports KLGA,KJFK,KLAX

# Process single airport
node scripts/identify-ground-aircraft.js --airport KLGA --date 2025-11-08
```

The tar file is cached locally after first download, so subsequent runs are faster. When processing multiple airports, the same tar file is reused for all airports.

## Output Format

Results are saved as JSON:

```json
{
  "airport": "KLGA",
  "date": "2025-11-08",
  "aircraftIds": [
    "a12345",
    "b67890",
    ...
  ],
  "count": 323,
  "generatedAt": "2025-11-10T12:38:48.000Z"
}
```

## Criteria

An aircraft is identified as "on ground" if it meets **both** criteria:

- Within **1 nautical mile** of airport coordinates
- Altitude below **500 feet** or "ground"

## See Also

- [GETTING_STARTED.md](./GETTING_STARTED.md) - Quick start guide
- [EC2_INGESTION_README.md](./EC2_INGESTION_README.md) - EC2 data download
- [README.md](./README.md) - Main overview
