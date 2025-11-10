#!/bin/bash
# Simple script to check ingestion progress
# Usage: ./scripts/ingestion/check-progress.sh [instance-id]

INSTANCE_ID="$1"
REGION="us-west-1"

if [ -z "$INSTANCE_ID" ]; then
    echo "Finding latest downloader instance..."
    INSTANCE_ID=$(aws ec2 describe-instances \
        --region $REGION \
        --filters "Name=tag:Purpose,Values=data-ingestion" "Name=instance-state-name,Values=running,pending" \
        --query 'sort_by(Reservations[].Instances[], &LaunchTime)[-1].InstanceId' \
        --output text 2>/dev/null)
    
    if [ -z "$INSTANCE_ID" ] || [ "$INSTANCE_ID" == "None" ]; then
        echo "No running downloader instances found"
        exit 1
    fi
fi

echo "Instance: $INSTANCE_ID"
echo ""

# Get instance state
STATE=$(aws ec2 describe-instances \
    --instance-ids "$INSTANCE_ID" \
    --region "$REGION" \
    --query 'Reservations[0].Instances[0].State.Name' \
    --output text)

echo "State: $STATE"
echo ""

# Check S3 for recent uploads (this is the real progress indicator)
echo "Recent S3 uploads (last 10 files):"
aws s3 ls s3://ayryx-adsb-history/raw/ --recursive --region "$REGION" 2>/dev/null | \
    sort -k1,2 | tail -10 | \
    awk '{printf "  %s %s  %s\n", $1, $2, $4}'

echo ""
echo "Total files in S3:"
aws s3 ls s3://ayryx-adsb-history/raw/ --recursive --region "$REGION" 2>/dev/null | wc -l | xargs

echo ""
echo "View in AWS Console:"
echo "  https://console.aws.amazon.com/ec2/v2/home?region=$REGION#Instances:instanceId=$INSTANCE_ID"

