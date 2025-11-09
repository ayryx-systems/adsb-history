# EC2 Automated Data Ingestion

This directory contains scripts to automatically provision an EC2 instance that downloads ADSB historical data from GitHub and uploads it to S3.

## Why EC2?

- **Disk space**: Each day of data is ~3GB compressed. Downloading a week requires ~21GB of temporary storage.
- **Network**: EC2 to S3 transfers are fast and free within the same AWS region.
- **Cost-effective**: Instance auto-terminates when complete, you only pay for ~30-60 minutes of compute.
- **Automation-ready**: Can be triggered daily via cron/Lambda for ongoing ingestion.

## Prerequisites

1. **AWS CLI configured** with credentials that have permissions to:
   - Launch EC2 instances
   - Create IAM roles and policies
   - Create security groups
   - Upload to S3

2. **Check your AWS configuration**:
   ```bash
   aws sts get-caller-identity
   ```

## Quick Start

### Download a Week of Data

Download 7 days of data (2025-11-02 through 2025-11-08):

```bash
cd adsb-history
./scripts/provision-ec2-downloader.sh --start-date 2025-11-02 --days 7
```

**That's it!** The script will:
1. Create necessary IAM roles (if they don't exist)
2. Create security group (if it doesn't exist)
3. Launch an EC2 instance with 30GB storage
4. Automatically download and upload data
5. Self-terminate when complete

### Monitor Progress

Get instance state:

```bash
# Replace <instance-id> with the ID printed by the script
aws ec2 describe-instances --instance-ids <instance-id> --region us-west-2 --query 'Reservations[0].Instances[0].State.Name'
```

View CloudWatch logs (after ~5 minutes):

```bash
aws logs tail /aws/ec2/adsb-history-downloader --follow --region us-west-2
```

### Custom Options

```bash
# Download specific date range
./scripts/provision-ec2-downloader.sh --start-date 2025-10-01 --days 14

# Use different region
./scripts/provision-ec2-downloader.sh --region us-east-1

# Enable SSH access for debugging (requires existing key pair)
./scripts/provision-ec2-downloader.sh --key-name my-key-pair
```

## How It Works

### Infrastructure Created

**IAM Role** (`adsb-history-downloader-role`):
- Allows EC2 instance to assume role
- Grants S3 read/write access to `ayryx-adsb-history` bucket

**Security Group** (`adsb-history-downloader`):
- Outbound traffic only (no inbound ports open)
- Instance has no public access

**EC2 Instance**:
- Instance type: `t3.medium` (2 vCPU, 4GB RAM)
- Root volume: 30GB GP3 SSD
- AMI: Amazon Linux 2023 (latest)
- Region: us-west-2 (configurable)

### Execution Flow

1. **Launch**: EC2 instance boots with user-data script
2. **Setup**: Install Node.js, npm, dependencies
3. **Download**: Run `download-week.js` script
   - Download split tar files from GitHub releases
   - Concatenate `.tar.aa` + `.tar.ab` → `.tar`
   - Upload to S3 `raw/YYYY/MM/DD/`
   - Extract temporarily to verify structure
   - Clean up local files
4. **Terminate**: Instance self-terminates on success

### Cost Estimate

- **EC2**: ~$0.05/hour × 0.5-1 hour = **$0.025-0.05 per run**
- **Data transfer**: Free (EC2 to S3 in same region)
- **S3 storage**: ~$0.023/GB/month = **$0.70/day or $21/month**

Total for one-time 7-day backfill: **< $0.10**

## Daily Automation (Future)

To set up daily ingestion:

```bash
# Option 1: Cron job (run from local machine or bastion)
0 6 * * * /path/to/provision-ec2-downloader.sh --days 1

# Option 2: Lambda + EventBridge (recommended)
# Trigger Lambda daily that calls this script or replicates logic
```

## Troubleshooting

### Script fails with "AWS CLI is not configured"

Run:
```bash
aws configure
```

Enter your AWS access key, secret key, and default region.

### IAM permissions error

Your AWS user needs these permissions:
- `ec2:RunInstances`, `ec2:DescribeInstances`, `ec2:CreateSecurityGroup`
- `iam:CreateRole`, `iam:PutRolePolicy`, `iam:CreateInstanceProfile`
- `s3:PutObject`, `s3:ListBucket` on `ayryx-adsb-history` bucket

### Instance doesn't terminate

If the download fails, the instance will remain running for debugging. To view logs:

1. Get the instance's public IP:
   ```bash
   aws ec2 describe-instances --instance-ids <instance-id> --query 'Reservations[0].Instances[0].PublicIpAddress'
   ```

2. SSH into the instance (requires `--key-name` option):
   ```bash
   ssh ec2-user@<public-ip>
   tail -f /var/log/user-data.log
   ```

3. Manually terminate when done:
   ```bash
   aws ec2 terminate-instances --instance-ids <instance-id> --region us-west-2
   ```

### GitHub rate limit exceeded

GitHub allows 60 API requests/hour without authentication. Each date requires 1 request. If you hit the limit, wait an hour or configure a GitHub personal access token:

```bash
# Set in the script or export before running
export GITHUB_TOKEN=your_token_here
```

## Files

- `scripts/provision-ec2-downloader.sh` - Main provisioning script
- `scripts/download-week.js` - Download script that runs on EC2
- `src/ingestion/GitHubReleaseDownloader.js` - GitHub API client
- `src/ingestion/S3Uploader.js` - S3 upload client
- `src/ingestion/DataExtractor.js` - Tar extraction utilities

## Security Notes

- ✅ IAM roles used for credentials (no hardcoded keys)
- ✅ No inbound network access
- ✅ Minimal IAM permissions (S3 bucket-specific)
- ✅ Auto-terminate prevents runaway costs
- ✅ All resources tagged for tracking

## Next Steps

After data is in S3:
1. Implement processing pipeline (flight track building, metrics)
2. Generate pre-computed JSON files
3. Deploy to CloudFront CDN
4. Integrate with `planning-app`

See [ARCHITECTURE.md](./ARCHITECTURE.md) for complete system design.

