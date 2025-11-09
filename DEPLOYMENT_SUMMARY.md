# ADSB History Data Ingestion - Deployment Summary

**Date:** November 9, 2025  
**Status:** ✅ Running

## What Was Deployed

### AWS Resources Created

1. **S3 Bucket:** `ayryx-adsb-history-654654263702`
   - Region: us-west-2
   - Versioning: Enabled
   - Purpose: Store raw ADSB data tar files

2. **IAM Role:** `adsb-history-downloader-role`
   - Instance profile attached
   - S3 read/write permissions to bucket above

3. **Security Group:** `sg-01d8d56555aaee267`
   - Egress only (no inbound ports)
   - Name: `adsb-history-downloader`

4. **EC2 Instance:** `i-082027a078ce349c6`
   - Type: t3.medium (2 vCPU, 4GB RAM)
   - Storage: 30GB GP3 SSD
   - AMI: ami-00e15f0027b9bf02b (Amazon Linux 2023)
   - Status: **Running**
   - Will self-terminate when complete

## Current Task

Downloading 7 days of ADSB data:
- **Date Range:** 2025-11-02 through 2025-11-08
- **Source:** adsblol/globe_history_2025 GitHub releases
- **Destination:** `s3://ayryx-adsb-history-654654263702/raw/2025/11/`
- **Est. Completion:** 30-60 minutes from launch

## Monitoring

### Check Instance Status

```bash
aws ec2 describe-instances \
  --instance-ids i-082027a078ce349c6 \
  --region us-west-2 \
  --query 'Reservations[0].Instances[0].State.Name' \
  --output text
```

**States:**
- `pending` → Starting up
- `running` → Downloading and uploading data
- `terminating` → Job complete, shutting down
- `terminated` → Finished successfully

### Monitor with Script

```bash
cd /Users/allredj/git/ayryx/adsb-history
./scripts/monitor-ec2.sh i-082027a078ce349c6 us-west-2
```

This will check status every 30 seconds and notify when complete.

### Verify Data in S3

After completion:

```bash
aws s3 ls s3://ayryx-adsb-history-654654263702/raw/2025/11/ \
  --recursive --human-readable --region us-west-2
```

Expected files (7 days × ~3GB each = ~21GB):
```
2025-11-02/v2025.11.02-planes-readsb-prod-0.tar
2025-11-03/v2025.11.03-planes-readsb-prod-0.tar
2025-11-04/v2025.11.04-planes-readsb-prod-0.tar
2025-11-05/v2025.11.05-planes-readsb-prod-0.tar
2025-11-06/v2025.11.06-planes-readsb-prod-0.tar
2025-11-07/v2025.11.07-planes-readsb-prod-0.tar
2025-11-08/v2025.11.08-planes-readsb-prod-0.tar
```

## Cost Estimate

- **EC2:** ~$0.05/hour × 1 hour = $0.05
- **Data Transfer:** Free (EC2 → S3 same region)
- **S3 Storage:** ~$0.023/GB/month × 21GB = $0.48/month
- **Total one-time:** < $0.10

## What's Next

1. ✅ Wait for EC2 to complete (~30-60 min)
2. ✅ Verify all 7 tar files in S3
3. 🔜 Build processing pipeline (flight track analysis)
4. 🔜 Generate pre-computed metrics
5. 🔜 Deploy CloudFront CDN
6. 🔜 Integrate with planning-app

## Troubleshooting

### If Instance Doesn't Terminate

The instance only stays running if the download **fails**. To check logs:

1. Get public IP:
   ```bash
   aws ec2 describe-instances --instance-ids i-082027a078ce349c6 \
     --region us-west-2 \
     --query 'Reservations[0].Instances[0].PublicIpAddress' \
     --output text
   ```

2. SSH (requires key pair):
   ```bash
   ssh ec2-user@<public-ip>
   tail -f /var/log/user-data.log
   ```

3. Manual termination:
   ```bash
   aws ec2 terminate-instances \
     --instance-ids i-082027a078ce349c6 \
     --region us-west-2
   ```

### If Downloads Fail

Common issues:
- GitHub rate limit (60 requests/hour)
- Network issues (rare)
- Insufficient disk space (30GB should be plenty)

Solution: Wait 1 hour, run provisioning script again

## Daily Automation (Future)

To keep data up-to-date, run this daily:

```bash
./scripts/provision-ec2-downloader.sh --days 1
```

Or schedule via cron/Lambda.

## Files Modified

- ✅ Created: `scripts/provision-ec2-downloader.sh`
- ✅ Created: `scripts/package-code.sh`
- ✅ Created: `scripts/monitor-ec2.sh`
- ✅ Updated: `config/aws-config.json` (bucket name)
- ✅ Updated: `README.md` (bucket name)
- ✅ Updated: `.gitignore` (.temp-package/)
- ✅ Created: `EC2_INGESTION_README.md`
- ✅ Created: `scripts/QUICK_START.md`

## Architecture

```
Local Machine
    ↓
    ├─ Package code → Upload to S3 (bootstrap/)
    └─ Launch EC2 (t3.medium, 30GB)
         ↓
         ├─ Download code from S3
         ├─ Install Node.js + dependencies
         ├─ Download ADSB data from GitHub (7 days)
         ├─ Upload to S3 (raw/YYYY/MM/DD/)
         └─ Self-terminate ✓
```

---

**Status Check:** Run `./scripts/monitor-ec2.sh` to track progress!

