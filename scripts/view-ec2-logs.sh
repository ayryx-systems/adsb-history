#!/bin/bash

# View logs from EC2 processor instance

INSTANCE_ID=${1:-""}
REGION="us-west-1"

if [ -z "$INSTANCE_ID" ]; then
    echo "Usage: $0 <instance-id>"
    echo ""
    echo "Or to auto-detect latest instance:"
    echo "  $0 auto"
    exit 1
fi

if [ "$INSTANCE_ID" == "auto" ]; then
    echo "Finding latest processor instance..."
    INSTANCE_ID=$(aws ec2 describe-instances \
        --region $REGION \
        --filters "Name=tag:Purpose,Values=adsb-processing" "Name=instance-state-name,Values=running" \
        --query 'sort_by(Reservations[].Instances[], &LaunchTime)[-1].InstanceId' \
        --output text 2>/dev/null)
    
    if [ -z "$INSTANCE_ID" ] || [ "$INSTANCE_ID" == "None" ]; then
        echo "No running processor instances found"
        exit 1
    fi
    echo "Found instance: $INSTANCE_ID"
fi

echo ""
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
    echo "❌ Instance not found"
    exit 1
fi

echo "Instance State: $STATE"
echo ""

# Get console output (works for running instances)
echo "Retrieving console output..."
echo ""

# Try console output (may take a few minutes to be available)
CONSOLE_OUTPUT=$(aws ec2 get-console-output \
    --instance-id "$INSTANCE_ID" \
    --region "$REGION" \
    --query 'Output' \
    --output text 2>/dev/null)

if [ -n "$CONSOLE_OUTPUT" ] && [ "$CONSOLE_OUTPUT" != "None" ] && [ "$CONSOLE_OUTPUT" != "" ]; then
    echo "=========================================="
    echo "Console Output (last 200 lines):"
    echo "=========================================="
    echo ""
    echo "$CONSOLE_OUTPUT" | tail -200
    echo ""
    echo "=========================================="
    echo ""
    echo "Note: Console output shows what's written to stdout/stderr."
    echo "For full logs, check /var/log/user-data.log on the instance."
    echo ""
    
    if [ "$STATE" != "terminated" ] && [ "$STATE" != "stopped" ]; then
        echo "To get real-time logs, use AWS Console (most reliable):"
        echo "  https://console.aws.amazon.com/ec2/v2/home?region=$REGION#Instances:instanceId=$INSTANCE_ID"
        echo "  → Actions → Monitor and troubleshoot → Get system log"
    fi
else
    echo "⚠️  Console output not available yet"
    echo ""
    echo "Console output typically takes 2-5 minutes after instance launch to become available."
    echo ""
    echo "════════════════════════════════════════════════════════════"
    echo "RECOMMENDED: View logs via AWS Console (most reliable)"
    echo "════════════════════════════════════════════════════════════"
    echo ""
    echo "1. Open AWS Console:"
    echo "   https://console.aws.amazon.com/ec2/v2/home?region=$REGION#Instances:instanceId=$INSTANCE_ID"
    echo ""
    echo "2. Select the instance"
    echo ""
    echo "3. Click 'Actions' → 'Monitor and troubleshoot' → 'Get system log'"
    echo ""
    echo "This will show the full user-data.log output in real-time."
    echo ""
    echo "════════════════════════════════════════════════════════════"
    echo "Alternative methods:"
    echo "════════════════════════════════════════════════════════════"
    echo ""
    echo "Retry console output (wait 2-3 minutes after launch):"
    echo "  $0 $INSTANCE_ID"
    echo ""
    echo "Or use AWS CLI to get console output:"
    echo "  aws ec2 get-console-output --instance-id $INSTANCE_ID --region $REGION --query 'Output' --output text | tail -200"
    echo ""
fi

