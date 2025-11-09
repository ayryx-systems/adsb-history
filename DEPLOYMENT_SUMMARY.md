# ADSB History - Current Deployment

**Last Updated:** November 9, 2025  
**Status:** ✅ Active

## Current Setup

**S3 Bucket:** `ayryx-adsb-history` (us-west-1)  
**IAM Role:** `adsb-history-downloader-role`  
**Security Group:** `sg-0567e2bad774aaa63` (us-west-1)

## Active EC2 Instance

**Instance ID:** `i-02231da1d6d8c47a5`  
**Region:** us-west-1  
**Type:** t3.medium  
**Task:** Downloading 7 days (2025-11-02 to 2025-11-08)  
**Started:** 2025-11-10 00:32 UTC  
**Status:** ✅ Working! (2/7 days complete)  
**Expected completion:** ~30-60 minutes  
**Will auto-terminate:** Yes (on success)

## Monitor Progress

```bash
# Check S3 uploads
aws s3 ls s3://ayryx-adsb-history/raw/2025/11/ --recursive --human-readable

# Check instance status
aws ec2 describe-instances --instance-ids i-02231da1d6d8c47a5 \
  --region us-west-1 --query 'Reservations[0].Instances[0].State.Name'

# Auto-monitor
cd /Users/allredj/git/ayryx/adsb-history
./scripts/monitor-ec2.sh
```

## Expected Result

7 tar files in S3 (~21GB total):

```
s3://ayryx-adsb-history/raw/2025/11/
├── 02/v2025.11.02-planes-readsb-prod-0.tar (~3GB)
├── 03/v2025.11.03-planes-readsb-prod-0.tar (~3GB)
├── 04/v2025.11.04-planes-readsb-prod-0.tar (~3GB)
├── 05/v2025.11.05-planes-readsb-prod-0.tar (~3GB)
├── 06/v2025.11.06-planes-readsb-prod-0.tar (~3GB)
├── 07/v2025.11.07-planes-readsb-prod-0.tar (~3GB)
└── 08/v2025.11.08-planes-readsb-prod-0.tar (~3GB)
```

## Download More Data

```bash
# Download additional days
./scripts/provision-ec2-downloader.sh --start-date 2025-11-01 --days 1

# Daily automation (cron)
0 6 * * * cd /path/to/adsb-history && ./scripts/provision-ec2-downloader.sh --days 1
```

## Cost Estimate

- **This run:** ~$0.05 (instance) = < $0.10 total
- **S3 storage:** ~$0.48/month for 21GB

## Important Notes

1. **Bucket Policy Required:** The S3 bucket has a policy that explicitly grants access to:

   - Your IAM user: `joel-allred-sagaswipe-admin`
   - EC2 role: `adsb-history-downloader-role`

2. **Region:** Everything is in **us-west-1** (same as bucket)

3. **Auto-termination:** Instance terminates itself on success. If it stays running >2 hours, check for errors and terminate manually.

## Next Steps

See [ARCHITECTURE.md](./ARCHITECTURE.md) for processing pipeline design.
