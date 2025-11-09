#!/bin/bash
# Monitor the EC2 downloader instance

INSTANCE_ID=${1:-"i-0415a78563030a3bb"}
REGION=${2:-"us-west-1"}

echo "Monitoring EC2 instance: $INSTANCE_ID"
echo "=========================================="
echo ""

while true; do
  STATE=$(aws ec2 describe-instances \
    --instance-ids "$INSTANCE_ID" \
    --region "$REGION" \
    --query 'Reservations[0].Instances[0].State.Name' \
    --output text 2>/dev/null)
  
  if [ -z "$STATE" ] || [ "$STATE" == "None" ]; then
    echo "❌ Instance not found or error querying"
    exit 1
  fi
  
  TIMESTAMP=$(date '+%Y-%m-%d %H:%M:%S')
  
  case "$STATE" in
    "pending")
      echo "[$TIMESTAMP] ⏳ Instance is starting..."
      ;;
    "running")
      echo "[$TIMESTAMP] ▶️  Instance is running - downloading and uploading data..."
      ;;
    "stopping")
      echo "[$TIMESTAMP] 🛑 Instance is stopping..."
      ;;
    "stopped")
      echo "[$TIMESTAMP] ⏸️  Instance stopped"
      break
      ;;
    "terminated")
      echo "[$TIMESTAMP] ✅ Instance terminated - Job complete!"
      echo ""
      echo "Checking S3 for uploaded data..."
      aws s3 ls s3://ayryx-adsb-history/raw/2025/11/ --recursive --human-readable --region "$REGION"
      break
      ;;
    "terminating")
      echo "[$TIMESTAMP] 🏁 Instance is terminating..."
      ;;
    *)
      echo "[$TIMESTAMP] ❓ Unknown state: $STATE"
      ;;
  esac
  
  sleep 30
done

echo ""
echo "=========================================="
echo "Monitoring complete"

