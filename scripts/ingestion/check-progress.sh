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

# Get instance state and account
INSTANCE_INFO=$(aws ec2 describe-instances \
    --instance-ids "$INSTANCE_ID" \
    --region "$REGION" \
    --query 'Reservations[0].[Instances[0].State.Name,OwnerId]' \
    --output text)

STATE=$(echo "$INSTANCE_INFO" | awk '{print $1}')
ACCOUNT_ID=$(echo "$INSTANCE_INFO" | awk '{print $2}')
CURRENT_ACCOUNT=$(aws sts get-caller-identity --query 'Account' --output text 2>/dev/null)

echo "State: $STATE"
echo "Instance Account: $ACCOUNT_ID"
echo "Your AWS CLI Account: $CURRENT_ACCOUNT"
if [ "$ACCOUNT_ID" != "$CURRENT_ACCOUNT" ]; then
    echo ""
    echo "⚠️  WARNING: Instance is in account $ACCOUNT_ID, but your AWS CLI is using $CURRENT_ACCOUNT"
    echo "   You need to switch to account $ACCOUNT_ID in the AWS Console to see this instance"
fi
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
# Check if instance still exists
if [ "$STATE" == "terminated" ] || [ "$STATE" == "stopped" ]; then
    echo "Instance is $STATE"
    echo ""
    echo "To view in AWS Console (including terminated instances):"
    echo "  1. Go to: https://console.aws.amazon.com/ec2/v2/home?region=$REGION"
    echo "  2. Click 'Instances' in left menu"
    echo "  3. Use search/filter to find instance ID: $INSTANCE_ID"
    echo "  4. Or change filter to show 'Terminated' instances"
else
    echo "View in AWS Console:"
    echo "  https://console.aws.amazon.com/ec2/v2/home?region=$REGION#Instances:instanceId=$INSTANCE_ID"
    echo ""
    echo "If instance doesn't appear:"
    echo "  1. Go to: https://console.aws.amazon.com/ec2/v2/home?region=$REGION"
    echo "  2. Click 'Instances' in the left menu"
    echo "  3. In the search box, type: $INSTANCE_ID"
    echo "  4. Or filter by 'Running instances'"
    echo ""
    echo "Note: The instance is in AWS account: $(aws ec2 describe-instances --instance-ids $INSTANCE_ID --region $REGION --query 'Reservations[0].OwnerId' --output text 2>/dev/null || echo 'unknown')"
fi

