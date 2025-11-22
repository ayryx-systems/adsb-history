#!/bin/bash

# Helper script to add SSH access to an existing EC2 instance's security group

set -e

if [ $# -lt 1 ]; then
  echo "Usage: $0 INSTANCE_ID [REGION]"
  echo ""
  echo "Example:"
  echo "  $0 i-1234567890abcdef0 us-west-1"
  echo ""
  exit 1
fi

INSTANCE_ID="$1"
REGION="${2:-us-west-1}"

echo "Adding SSH access for instance: $INSTANCE_ID"
echo ""

# Get instance security group
SG_ID=$(aws ec2 describe-instances \
  --instance-ids "$INSTANCE_ID" \
  --region "$REGION" \
  --query 'Reservations[0].Instances[0].SecurityGroups[0].GroupId' \
  --output text 2>/dev/null || echo "")

if [ -z "$SG_ID" ] || [ "$SG_ID" == "None" ]; then
  echo "❌ Error: Could not find security group for instance $INSTANCE_ID"
  exit 1
fi

echo "✓ Found security group: $SG_ID"

# Get current public IP
echo "Detecting your public IP address..."
MY_IP=$(curl -s https://checkip.amazonaws.com 2>/dev/null || curl -s https://api.ipify.org 2>/dev/null || echo "")

if [ -z "$MY_IP" ]; then
  echo "❌ Error: Could not detect your public IP address"
  echo "   Please provide your IP manually:"
  echo "   aws ec2 authorize-security-group-ingress --group-id $SG_ID --region $REGION --protocol tcp --port 22 --cidr YOUR_IP/32"
  exit 1
fi

echo "✓ Your public IP: $MY_IP"
echo ""

# Add SSH rule
echo "Adding SSH access rule (port 22) from your IP..."
if aws ec2 authorize-security-group-ingress \
  --group-id "$SG_ID" \
  --region "$REGION" \
  --protocol tcp \
  --port 22 \
  --cidr "${MY_IP}/32" \
  2>&1; then
  echo ""
  echo "✓ SSH access rule added successfully!"
  echo ""
  echo "You can now SSH into the instance:"
  echo "  ./scripts/ingestion/ssh-to-instance.sh $INSTANCE_ID"
else
  EXIT_CODE=$?
  if [ $EXIT_CODE -eq 254 ]; then
    echo ""
    echo "⚠️  Rule may already exist (this is fine)"
    echo "   Try SSH now:"
    echo "     ./scripts/ingestion/ssh-to-instance.sh $INSTANCE_ID"
  else
    echo ""
    echo "❌ Error adding SSH rule"
    exit $EXIT_CODE
  fi
fi

