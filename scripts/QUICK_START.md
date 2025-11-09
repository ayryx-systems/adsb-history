# Quick Start: Download Week of ADSB Data

## 🚀 One Command Solution

```bash
cd /Users/allredj/git/ayryx/adsb-history
./scripts/provision-ec2-downloader.sh --start-date 2025-11-02 --days 7
```

**That's it!** This will:
- ✅ Create necessary AWS infrastructure (IAM roles, security groups)
- ✅ Launch EC2 instance with 30GB storage
- ✅ Download 7 days of data (2025-11-02 through 2025-11-08)
- ✅ Upload to S3: `s3://ayryx-adsb-history/raw/`
- ✅ Self-terminate when complete
- ✅ Cost: < $0.10 total

## Timeline

- **0-2 min**: IAM setup and instance launch
- **30-60 min**: Download and upload (runs automatically)
- **Done!**: Instance terminates itself

## Monitor Progress

Check instance status:

```bash
# Replace <instance-id> with ID from script output
aws ec2 describe-instances \
  --instance-ids <instance-id> \
  --region us-west-2 \
  --query 'Reservations[0].Instances[0].State.Name' \
  --output text
```

States: `pending` → `running` → `terminated` (when complete)

## Verify Data in S3

After completion, check S3:

```bash
aws s3 ls s3://ayryx-adsb-history/raw/2025/11/ --recursive --human-readable
```

Expected output:
```
2025-11-02/v2025.11.02-planes-readsb-prod-0.tar (~3GB)
2025-11-03/v2025.11.03-planes-readsb-prod-0.tar (~3GB)
2025-11-04/v2025.11.04-planes-readsb-prod-0.tar (~3GB)
2025-11-05/v2025.11.05-planes-readsb-prod-0.tar (~3GB)
2025-11-06/v2025.11.06-planes-readsb-prod-0.tar (~3GB)
2025-11-07/v2025.11.07-planes-readsb-prod-0.tar (~3GB)
2025-11-08/v2025.11.08-planes-readsb-prod-0.tar (~3GB)
```

## Troubleshooting

**"AWS CLI is not configured"**
```bash
aws configure
# Enter your AWS credentials
```

**Need help?**
- Full docs: [EC2_INGESTION_README.md](../EC2_INGESTION_README.md)
- Check logs: `/var/log/user-data.log` on EC2 instance

## What's Next?

After data is in S3:
1. ✅ Raw data stored: `s3://ayryx-adsb-history/raw/`
2. 🔜 Build processing pipeline (flight track analysis)
3. 🔜 Generate pre-computed metrics
4. 🔜 Deploy to CloudFront CDN
5. 🔜 Integrate with planning-app

See [ARCHITECTURE.md](../ARCHITECTURE.md) for the full system design.

