#!/bin/bash
# Simple script to run ground aircraft identification on EC2
# Usage: ./scripts/processing/run-on-ec2.sh --date 2025-11-08 [--airports KLGA,KSFO]

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

# Parse arguments
DATE=""
AIRPORTS_ARG="--all"

while [[ $# -gt 0 ]]; do
  case $1 in
    --date)
      DATE="$2"
      shift 2
      ;;
    --airports)
      AIRPORTS_ARG="--airports $2"
      shift 2
      ;;
    *)
      echo "Unknown option: $1"
      exit 1
      ;;
  esac
done

if [ -z "$DATE" ]; then
  echo "Error: --date is required"
  exit 1
fi

echo "Packaging code..."
cd "$PROJECT_ROOT"
PACKAGE_DIR="/tmp/adsb-processor-$$"
mkdir -p "$PACKAGE_DIR"

# Copy necessary files
cp -r src "$PACKAGE_DIR/"
cp -r config "$PACKAGE_DIR/"
cp -r scripts "$PACKAGE_DIR/"
cp package.json "$PACKAGE_DIR/"
cp .env.example "$PACKAGE_DIR/.env" 2>/dev/null || true

# Create tarball
cd "$PACKAGE_DIR"
tar -czf /tmp/adsb-code.tar.gz .
cd - > /dev/null

# Upload to S3
PACKAGE_KEY="ec2-processor/code-$(date +%s).tar.gz"
echo "Uploading to S3..."
aws s3 cp /tmp/adsb-code.tar.gz "s3://ayryx-adsb-history/$PACKAGE_KEY"
rm -rf "$PACKAGE_DIR" /tmp/adsb-code.tar.gz

# Create simple user-data script
cat > /tmp/user-data.sh <<EOF
#!/bin/bash
exec > >(tee -a /var/log/user-data.log)
exec 2>&1

echo "Starting at \$(date)"

# Install Node.js
curl -fsSL https://rpm.nodesource.com/setup_18.x | bash -
dnf install -y nodejs

# Download and extract code
cd /home/ec2-user
aws s3 cp s3://ayryx-adsb-history/$PACKAGE_KEY code.tar.gz
tar -xzf code.tar.gz

# Install dependencies
cd adsb-history
npm install --production

# Set environment
export AWS_REGION=us-west-1
export S3_BUCKET_NAME=ayryx-adsb-history
export TEMP_DIR=/tmp/adsb-processing
mkdir -p \$TEMP_DIR

# Run processing
echo "Running: node scripts/processing/identify-ground-aircraft-multi.js --date $DATE $AIRPORTS_ARG"
cd /home/ec2-user/adsb-history
node scripts/processing/identify-ground-aircraft-multi.js --date "$DATE" $AIRPORTS_ARG

# Shutdown
echo "Completed at \$(date)"
shutdown -h +2
EOF

# Launch instance
echo "Launching EC2 instance..."
INSTANCE_ID=$(aws ec2 run-instances \
    --region us-west-1 \
    --image-id $(aws ec2 describe-images --region us-west-1 --owners amazon --filters "Name=name,Values=al2023-ami-*-x86_64" "Name=state,Values=available" --query 'sort_by(Images, &CreationDate)[-1].ImageId' --output text) \
    --instance-type t3.xlarge \
    --iam-instance-profile Name=adsb-history-processor-role \
    --security-group-ids $(aws ec2 describe-security-groups --region us-west-1 --filters "Name=group-name,Values=adsb-history-processor-sg" --query 'SecurityGroups[0].GroupId' --output text) \
    --user-data file:///tmp/user-data.sh \
    --block-device-mappings '[{"DeviceName":"/dev/xvda","Ebs":{"VolumeSize":50,"VolumeType":"gp3","DeleteOnTermination":true}}]' \
    --tag-specifications "ResourceType=instance,Tags=[{Key=Name,Value=adsb-processor-$DATE}]" \
    --query 'Instances[0].InstanceId' \
    --output text)

rm -f /tmp/user-data.sh

echo ""
echo "Instance launched: $INSTANCE_ID"
echo ""
echo "View logs in AWS Console:"
echo "  https://console.aws.amazon.com/ec2/v2/home?region=us-west-1#Instances:instanceId=$INSTANCE_ID"
echo "  → Actions → Monitor and troubleshoot → Get system log"
echo ""
echo "Check results:"
echo "  aws s3 ls s3://ayryx-adsb-history/ground-aircraft/ --recursive | grep $DATE"

