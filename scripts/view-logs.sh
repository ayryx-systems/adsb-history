#!/bin/bash
# View logs from the EC2 downloader instance

INSTANCE_ID=${1:-"i-02231da1d6d8c47a5"}
REGION=${2:-"us-west-1"}

echo "=========================================="
echo "EC2 Instance Log Viewer"
echo "Instance: $INSTANCE_ID"
echo "Region: $REGION"
echo "=========================================="
echo ""

# Check instance state
STATE=$(aws ec2 describe-instances \
  --instance-ids "$INSTANCE_ID" \
  --region "$REGION" \
  --query 'Reservations[0].Instances[0].State.Name' \
  --output text 2>/dev/null)

if [ -z "$STATE" ] || [ "$STATE" == "None" ]; then
  echo "❌ Instance not found or error querying"
  exit 1
fi

echo "Instance State: $STATE"
echo ""

if [ "$STATE" == "terminated" ]; then
  echo "⚠️  Instance is terminated. Logs are no longer available."
  echo "Check S3 for uploaded data instead:"
  echo "  aws s3 ls s3://ayryx-adsb-history-654654263702/raw/2025/11/ --recursive --human-readable"
  exit 0
fi

# Try Method 1: AWS Systems Manager Session Manager
echo "Attempting to connect via AWS Systems Manager..."
if aws ssm describe-instance-information \
  --region "$REGION" \
  --filters "Key=InstanceIds,Values=$INSTANCE_ID" \
  --query 'InstanceInformationList[0].PingStatus' \
  --output text 2>/dev/null | grep -q "Online"; then
  
  echo "✓ Instance is online in Systems Manager"
  echo ""
  echo "Opening log viewer session..."
  echo "Press Ctrl+C to exit when done"
  echo ""
  
  # Start interactive session and tail logs
  aws ssm start-session \
    --target "$INSTANCE_ID" \
    --region "$REGION" \
    --document-name AWS-StartInteractiveCommand \
    --parameters command="tail -f /var/log/user-data.log"
  
  exit 0
fi

# Method 2: EC2 Instance Connect (for temporary SSH)
echo "⚠️  SSM not available yet. Trying EC2 Instance Connect..."

PUBLIC_IP=$(aws ec2 describe-instances \
  --instance-ids "$INSTANCE_ID" \
  --region "$REGION" \
  --query 'Reservations[0].Instances[0].PublicIpAddress' \
  --output text)

if [ -z "$PUBLIC_IP" ] || [ "$PUBLIC_IP" == "None" ]; then
  echo "❌ No public IP available"
  echo ""
  echo "The instance is still starting up. Options:"
  echo ""
  echo "1. Wait a few minutes and try again:"
  echo "   ./scripts/view-logs.sh"
  echo ""
  echo "2. Check instance console output:"
  echo "   aws ec2 get-console-output --instance-id $INSTANCE_ID --region $REGION --output text"
  echo ""
  echo "3. Monitor S3 uploads (shows progress indirectly):"
  echo "   watch -n 30 'aws s3 ls s3://ayryx-adsb-history-654654263702/raw/2025/11/ --recursive --human-readable'"
  exit 1
fi

echo "Instance IP: $PUBLIC_IP"
echo ""
echo "⚠️  EC2 Instance Connect requires temporary SSH key upload."
echo "This feature requires the 'ec2-instance-connect' CLI tool."
echo ""
echo "Alternative: View console output (last 64KB of serial console):"
echo ""

aws ec2 get-console-output \
  --instance-id "$INSTANCE_ID" \
  --region "$REGION" \
  --output text | tail -50

echo ""
echo "=========================================="
echo "Options to view full logs:"
echo "=========================================="
echo ""
echo "1. Wait 2-3 minutes for SSM to register, then run again:"
echo "   ./scripts/view-logs.sh"
echo ""
echo "2. View console output (shows setup progress):"
echo "   aws ec2 get-console-output --instance-id $INSTANCE_ID --region $REGION --output text | less"
echo ""
echo "3. Monitor S3 uploads (shows download progress):"
echo "   watch -n 30 'aws s3 ls s3://ayryx-adsb-history-654654263702/raw/2025/11/ --recursive --human-readable'"
echo ""

