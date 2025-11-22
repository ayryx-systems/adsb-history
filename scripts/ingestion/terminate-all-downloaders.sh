#!/bin/bash

# Script to terminate all adsb-history-downloader EC2 instances

set -e

# Parse arguments
REGION=""
FORCE=""

while [[ $# -gt 0 ]]; do
  case $1 in
    --region)
      REGION="$2"
      shift 2
      ;;
    --force)
      FORCE="--force"
      shift
      ;;
    --help)
      echo "Usage: $0 [--region REGION] [--force]"
      echo ""
      echo "Terminates all adsb-history-downloader EC2 instances."
      echo ""
      echo "Options:"
      echo "  --region REGION   AWS region (default: us-west-1)"
      echo "  --force          Skip confirmation prompt"
      echo "  --help           Show this help message"
      echo ""
      echo "Examples:"
      echo "  $0                                    # Terminate in us-west-1"
      echo "  $0 --region us-west-2                 # Terminate in us-west-2"
      echo "  $0 --region us-west-1 --force        # Skip confirmation"
      echo ""
      exit 0
      ;;
    *)
      if [ -z "$REGION" ]; then
        REGION="$1"
      else
        echo "Unknown option: $1"
        echo "Use --help for usage information"
        exit 1
      fi
      shift
      ;;
  esac
done

# Default region
REGION="${REGION:-us-west-1}"

echo "=========================================="
echo "Terminate ADSB History Downloader Instances"
echo "=========================================="
echo "Region: $REGION"
echo ""

# Find all instances with the adsb-history-downloader tags
echo "Finding instances..."
INSTANCES=$(aws ec2 describe-instances \
  --region "$REGION" \
  --filters \
    "Name=tag:Name,Values=adsb-history-downloader" \
    "Name=tag:Purpose,Values=data-ingestion" \
    "Name=instance-state-name,Values=pending,running,stopping,stopped" \
  --query 'Reservations[*].Instances[*].[InstanceId,State.Name,PublicIpAddress,Tags[?Key==`Name`].Value|[0]]' \
  --output text 2>/dev/null || echo "")

if [ -z "$INSTANCES" ]; then
  echo "✓ No running instances found"
  exit 0
fi

# Count instances
INSTANCE_COUNT=$(echo "$INSTANCES" | wc -l | tr -d ' ')
echo "Found $INSTANCE_COUNT instance(s):"
echo ""
printf "%-20s %-12s %-15s\n" "Instance ID" "State" "Public IP"
echo "------------------------------------------------------------"
echo "$INSTANCES" | while read -r INSTANCE_ID STATE IP NAME; do
  printf "%-20s %-12s %-15s\n" "$INSTANCE_ID" "$STATE" "${IP:-N/A}"
done
echo ""

# Confirm termination
if [ "$FORCE" != "--force" ]; then
  echo "⚠️  WARNING: This will terminate all $INSTANCE_COUNT instance(s) listed above."
  echo ""
  read -p "Are you sure you want to terminate these instances? (yes/no) " -r
  echo
  if [[ ! $REPLY =~ ^[Yy][Ee][Ss]$ ]]; then
    echo "Cancelled."
    exit 0
  fi
fi

# Extract instance IDs
INSTANCE_IDS=$(echo "$INSTANCES" | awk '{print $1}')

echo "Terminating instances..."
TERMINATE_OUTPUT=$(aws ec2 terminate-instances \
  --instance-ids $INSTANCE_IDS \
  --region "$REGION" \
  --query 'TerminatingInstances[*].[InstanceId,CurrentState.Name]' \
  --output text 2>&1)

if [ $? -eq 0 ]; then
  echo "✓ Termination initiated for:"
  echo "$TERMINATE_OUTPUT" | while read -r INSTANCE_ID STATE; do
    echo "  - $INSTANCE_ID (current state: $STATE)"
  done
  echo ""
  echo "Instances will be terminated shortly."
  echo "Note: EBS volumes are configured to delete on termination."
else
  echo "❌ Error terminating instances:"
  echo "$TERMINATE_OUTPUT"
  exit 1
fi

echo ""
echo "To check status:"
echo "  aws ec2 describe-instances --instance-ids $INSTANCE_IDS --region $REGION --query 'Reservations[*].Instances[*].[InstanceId,State.Name]' --output table"
echo "=========================================="

