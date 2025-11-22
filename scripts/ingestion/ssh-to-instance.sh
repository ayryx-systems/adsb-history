#!/bin/bash

# Helper script to get SSH command for an EC2 instance

set -e

if [ $# -lt 1 ]; then
  echo "Usage: $0 INSTANCE_ID [KEY_NAME] [REGION]"
  echo ""
  echo "Example:"
  echo "  $0 i-1234567890abcdef0 adsb-history-downloader-key us-west-1"
  echo ""
  exit 1
fi

INSTANCE_ID="$1"
DEFAULT_KEY_NAME="adsb-history-downloader-key"
KEY_NAME="${2:-$DEFAULT_KEY_NAME}"
REGION="${3:-us-west-1}"

echo "Getting instance information for: $INSTANCE_ID"
echo ""

# Get instance state
STATE=$(aws ec2 describe-instances \
  --instance-ids "$INSTANCE_ID" \
  --region "$REGION" \
  --query 'Reservations[0].Instances[0].State.Name' \
  --output text 2>/dev/null || echo "not-found")

if [ "$STATE" == "not-found" ] || [ -z "$STATE" ]; then
  echo "❌ Error: Could not find instance $INSTANCE_ID in region $REGION"
  exit 1
fi

if [ "$STATE" != "running" ]; then
  echo "⚠️  Instance is in state: $STATE"
  echo "   Instance must be 'running' to SSH into it."
  exit 1
fi

# Get public IP
PUBLIC_IP=$(aws ec2 describe-instances \
  --instance-ids "$INSTANCE_ID" \
  --region "$REGION" \
  --query 'Reservations[0].Instances[0].PublicIpAddress' \
  --output text)

if [ -z "$PUBLIC_IP" ] || [ "$PUBLIC_IP" == "None" ]; then
  echo "❌ Error: Instance does not have a public IP address"
  echo "   This may be because:"
  echo "   - Instance is in a private subnet"
  echo "   - No internet gateway configured"
  exit 1
fi

# Check if key file exists
KEY_FILE="$HOME/.ssh/${KEY_NAME}.pem"
if [ ! -f "$KEY_FILE" ]; then
  echo "⚠️  Warning: Key file not found: $KEY_FILE"
  echo "   You may need to:"
  echo "   1. Create the key: ./create-ec2-key.sh $KEY_NAME $REGION"
  echo "   2. Or use a different key name"
  echo ""
fi

echo "✓ Instance is running"
echo "✓ Public IP: $PUBLIC_IP"
echo ""
echo "SSH Command:"
echo "  ssh -i $KEY_FILE ec2-user@$PUBLIC_IP"
echo ""
echo "Or copy-paste this:"
echo "  ssh -i ~/.ssh/${KEY_NAME}.pem ec2-user@$PUBLIC_IP"
echo ""
echo "Once connected, view logs with:"
echo "  tail -f /var/log/user-data.log"
echo ""

