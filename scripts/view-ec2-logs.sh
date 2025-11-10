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

if [ "$STATE" == "terminated" ] || [ "$STATE" == "stopped" ]; then
    echo "⚠️  Instance is $STATE. Logs are no longer available."
    exit 0
fi

# Try to get logs via Systems Manager
echo "Attempting to retrieve logs via AWS Systems Manager..."
echo ""

# Try to get user-data log
if aws ssm send-command \
    --instance-ids "$INSTANCE_ID" \
    --region "$REGION" \
    --document-name "AWS-RunShellScript" \
    --parameters "commands=['cat /var/log/user-data.log']" \
    --output text \
    --query 'Command.CommandId' > /tmp/command-id.txt 2>/dev/null; then
    
    COMMAND_ID=$(cat /tmp/command-id.txt)
    echo "Command sent. Waiting for output..."
    sleep 3
    
    aws ssm get-command-invocation \
        --command-id "$COMMAND_ID" \
        --instance-id "$INSTANCE_ID" \
        --region "$REGION" \
        --query 'StandardOutputContent' \
        --output text 2>/dev/null
    
    echo ""
    echo "---"
    echo ""
    echo "Error output:"
    aws ssm get-command-invocation \
        --command-id "$COMMAND_ID" \
        --instance-id "$INSTANCE_ID" \
        --region "$REGION" \
        --query 'StandardErrorContent' \
        --output text 2>/dev/null
    
    rm -f /tmp/command-id.txt
else
    echo "⚠️  Could not retrieve logs via SSM"
    echo ""
    echo "To view logs manually, you can:"
    echo "  1. SSH into the instance (if you have a key pair)"
    echo "  2. Run: tail -f /var/log/user-data.log"
    echo ""
    echo "Or check CloudWatch Logs if configured"
fi

