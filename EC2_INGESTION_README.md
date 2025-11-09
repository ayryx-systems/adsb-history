# EC2 Automated Data Ingestion

Automatically provision an EC2 instance to download ADSB historical data from GitHub and upload to S3.

## Why EC2?

- **No local disk space needed** - Each day is ~3GB, a week requires ~21GB
- **Fast & free** - EC2 to S3 transfers in same region (us-west-1) are free
- **Cost-effective** - Instance auto-terminates when done (~30-60 min runtime)
- **Automation-ready** - Can run daily for ongoing ingestion

## Prerequisites

1. **AWS CLI configured** with admin or sufficient permissions
2. **S3 bucket** `ayryx-adsb-history` in us-west-1 with proper bucket policy

**Verify setup:**

```bash
aws sts get-caller-identity
aws s3 ls s3://ayryx-adsb-history/
```

## Quick Start

```bash
cd adsb-history
./scripts/provision-ec2-downloader.sh --start-date 2025-11-02 --days 7
```

**The script will:**

1. Create IAM role & security group (if needed)
2. Package and upload code to S3
3. Launch EC2 instance (us-west-1, t3.medium, 30GB)
4. Download 7 days from GitHub → Upload to S3
5. Self-terminate when complete

### Monitor Progress

**Check S3 uploads:**

```bash
aws s3 ls s3://ayryx-adsb-history/raw/2025/11/ --recursive --human-readable
```

**Check instance status:**

```bash
aws ec2 describe-instances --instance-ids <instance-id> \
  --region us-west-1 --query 'Reservations[0].Instances[0].State.Name'
```

**Auto-monitor:**

```bash
./scripts/monitor-ec2.sh
```

### Options

```bash
# Different date range
./scripts/provision-ec2-downloader.sh --start-date 2025-10-01 --days 14

# Download single day (for daily automation)
./scripts/provision-ec2-downloader.sh --days 1
```

## How It Works

**Infrastructure:**

- **IAM Role** - Grants EC2 access to S3 bucket
- **Security Group** - Egress only (no inbound access)
- **EC2 Instance** - t3.medium, 30GB storage, Amazon Linux 2023, us-west-1

**Execution:**

1. Boot → Install Node.js → Download code from S3
2. Download each day from GitHub (`.tar.aa` + `.tar.ab`)
3. Concatenate → Upload to S3 `raw/YYYY/MM/DD/`
4. Self-terminate on success (or stay running if failed for debugging)

**Cost:**

- **Per run**: ~$0.05 (EC2) + $0 (data transfer in same region) = **< $0.10**
- **S3 storage**: ~$0.023/GB/month → $0.70/day or $21/month for a week

## Daily Automation

Run daily to keep data current:

```bash
# Cron (local machine or bastion)
0 6 * * * cd /path/to/adsb-history && ./scripts/provision-ec2-downloader.sh --days 1
```

## Troubleshooting

**S3 Access Denied:**

- Ensure bucket policy grants access to your IAM user and EC2 role
- Check: `aws s3 ls s3://ayryx-adsb-history/`

**Instance doesn't terminate:**

- Download likely failed - instance stays running for debugging
- Check S3 to see what uploaded
- Manually terminate: `aws ec2 terminate-instances --instance-ids <id> --region us-west-1`

**GitHub rate limit (60/hour):**

- Wait 1 hour, or set `GITHUB_TOKEN` environment variable with PAT

## Next Steps

After data is in S3, see [ARCHITECTURE.md](./ARCHITECTURE.md) for:

- Processing pipeline (flight track building, metrics)
- Pre-computed JSON generation
- CloudFront CDN deployment
- Integration with planning-app
