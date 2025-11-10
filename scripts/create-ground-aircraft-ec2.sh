#!/bin/bash

# Launch EC2 instance to identify ground aircraft for airports on a specific date
# 
# This script:
# 1. Packages the code and uploads to S3
# 2. Launches an EC2 instance with the code
# 3. The instance runs identify-ground-aircraft-multi.js which:
#    - Downloads raw ADSB data tar from S3
#    - Extracts and processes traces
#    - Identifies aircraft on ground at specified airports
#    - Saves ground-aircraft JSON files to S3 (one per airport)
# 4. Instance auto-terminates when complete
#
# Output: Creates ground-aircraft files in S3:
#   s3://ayryx-adsb-history/ground-aircraft/AIRPORT/YYYY/MM/DD.json

set -e

# Default values
AIRPORTS=""  # Empty means process all enabled airports
DATE=$(date -u -d "yesterday" +%Y-%m-%d 2>/dev/null || date -u -v-1d +%Y-%m-%d)
INSTANCE_TYPE="t3.xlarge"  # 4 vCPU, 16GB RAM for faster processing
REGION="us-west-1"
VOLUME_SIZE=50  # 50GB for tar download + extraction + processing

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

# Parse arguments
while [[ $# -gt 0 ]]; do
  case $1 in
    --airport)
      AIRPORTS="$2"
      shift 2
      ;;
    --airports)
      AIRPORTS="$2"
      shift 2
      ;;
    --date)
      DATE="$2"
      shift 2
      ;;
    --instance-type)
      INSTANCE_TYPE="$2"
      shift 2
      ;;
    --help)
      echo "Usage: $0 [options]"
      echo ""
      echo "Options:"
      echo "  --airport ICAO        Single airport to process (deprecated, use --airports)"
      echo "  --airports ICAO,...   Comma-separated airports (default: all enabled)"
      echo "  --date YYYY-MM-DD     Date to process (default: yesterday)"
      echo "  --instance-type TYPE  Instance type (default: t3.xlarge)"
      echo "  --help                Show this help"
      echo ""
      echo "Examples:"
      echo "  $0 --date 2025-11-08                    # Process all enabled airports"
      echo "  $0 --airports KLGA,KJFK --date 2025-11-08"
      echo "  $0 --airport KLGA --date 2025-11-08     # Single airport (backward compat)"
      exit 0
      ;;
    *)
      echo "Unknown option: $1"
      exit 1
      ;;
  esac
done

echo -e "${GREEN}╔════════════════════════════════════════════════════════════╗${NC}"
echo -e "${GREEN}║       ADSB Historical Data - EC2 Processor Setup          ║${NC}"
echo -e "${GREEN}╚════════════════════════════════════════════════════════════╝${NC}"
echo ""
if [ -z "$AIRPORTS" ]; then
  AIRPORTS_ARG="--all"
  AIRPORTS_DISPLAY="all enabled airports"
else
  AIRPORTS_ARG="--airports $AIRPORTS"
  AIRPORTS_DISPLAY="$AIRPORTS"
fi

echo "Configuration:"
echo "  Airports:      $AIRPORTS_DISPLAY"
echo "  Date:          $DATE"
echo "  Instance Type: $INSTANCE_TYPE"
echo "  Region:        $REGION"
echo "  Volume Size:   ${VOLUME_SIZE}GB"
echo ""

# Check AWS CLI
if ! command -v aws &> /dev/null; then
    echo -e "${RED}Error: AWS CLI not found${NC}"
    exit 1
fi

# Skip check for multi-airport processing (script handles it)

# Get latest Amazon Linux 2023 AMI
echo -e "${YELLOW}Finding latest Amazon Linux 2023 AMI...${NC}"
AMI_ID=$(aws ec2 describe-images \
    --region $REGION \
    --owners amazon \
    --filters "Name=name,Values=al2023-ami-*-x86_64" "Name=state,Values=available" \
    --query 'sort_by(Images, &CreationDate)[-1].ImageId' \
    --output text)

if [ -z "$AMI_ID" ]; then
    echo -e "${RED}Error: Could not find Amazon Linux 2023 AMI${NC}"
    exit 1
fi
echo -e "${GREEN}✓ Found AMI: $AMI_ID${NC}"

# Create or get IAM role
ROLE_NAME="adsb-history-processor-role"
echo -e "${YELLOW}Setting up IAM role...${NC}"

if ! aws iam get-role --role-name $ROLE_NAME &>/dev/null; then
    echo "Creating IAM role..."
    
    # Trust policy
    cat > /tmp/trust-policy.json <<EOF
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": {
        "Service": "ec2.amazonaws.com"
      },
      "Action": "sts:AssumeRole"
    }
  ]
}
EOF

    aws iam create-role \
        --role-name $ROLE_NAME \
        --assume-role-policy-document file:///tmp/trust-policy.json \
        --description "Role for ADSB history processing on EC2"

    # Attach S3 access policy
    cat > /tmp/s3-policy.json <<EOF
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "s3:GetObject",
        "s3:PutObject",
        "s3:ListBucket"
      ],
      "Resource": [
        "arn:aws:s3:::ayryx-adsb-history",
        "arn:aws:s3:::ayryx-adsb-history/*"
      ]
    }
  ]
}
EOF

    aws iam put-role-policy \
        --role-name $ROLE_NAME \
        --policy-name adsb-s3-access \
        --policy-document file:///tmp/s3-policy.json

    # Create instance profile
    aws iam create-instance-profile --instance-profile-name $ROLE_NAME
    aws iam add-role-to-instance-profile \
        --instance-profile-name $ROLE_NAME \
        --role-name $ROLE_NAME

    echo "Waiting for IAM role to propagate..."
    sleep 10
fi

echo -e "${GREEN}✓ IAM role ready${NC}"

# Create or get security group
SG_NAME="adsb-history-processor-sg"
echo -e "${YELLOW}Setting up security group...${NC}"

SG_ID=$(aws ec2 describe-security-groups \
    --region $REGION \
    --filters "Name=group-name,Values=$SG_NAME" \
    --query 'SecurityGroups[0].GroupId' \
    --output text 2>/dev/null || echo "None")

if [ "$SG_ID" == "None" ]; then
    echo "Creating security group..."
    VPC_ID=$(aws ec2 describe-vpcs \
        --region $REGION \
        --filters "Name=isDefault,Values=true" \
        --query 'Vpcs[0].VpcId' \
        --output text)
    
    SG_ID=$(aws ec2 create-security-group \
        --region $REGION \
        --group-name $SG_NAME \
        --description "Security group for ADSB history processor" \
        --vpc-id $VPC_ID \
        --query 'GroupId' \
        --output text)
    
    # Egress only (no inbound access needed)
    echo "Security group $SG_ID created (egress only)"
fi

echo -e "${GREEN}✓ Security group ready: $SG_ID${NC}"

# Package code
echo -e "${YELLOW}Packaging code...${NC}"
PACKAGE_DIR="/tmp/adsb-history-processor-$$"
mkdir -p $PACKAGE_DIR

# Copy necessary files
cp -r src $PACKAGE_DIR/
cp -r config $PACKAGE_DIR/
cp -r scripts $PACKAGE_DIR/
cp package.json $PACKAGE_DIR/
cp .env.example $PACKAGE_DIR/.env

# Create processing script
cat > $PACKAGE_DIR/run-processing.sh <<'EOFSCRIPT'
#!/bin/bash
set -e

DATE="$1"
shift
AIRPORTS_ARGS="$@"

echo "=================================================="
echo "ADSB Historical Data Processing"
echo "Date: $DATE"
echo "Airports: $AIRPORTS_ARGS"
echo "=================================================="
echo ""

# Install Node.js 18
echo "Installing Node.js 18..."
curl -fsSL https://rpm.nodesource.com/setup_18.x | bash -
dnf install -y nodejs

# Install dependencies
echo "Installing dependencies..."
cd /home/ec2-user/adsb-history
npm install --production

# Set AWS region (credentials come from IAM role)
export AWS_REGION=us-west-1
export S3_BUCKET_NAME=ayryx-adsb-history

# Set temp directory to an absolute path that we know is writable
export TEMP_DIR=/tmp/adsb-processing
mkdir -p $TEMP_DIR
chmod 755 $TEMP_DIR

# Run processing
echo ""
echo "Starting processing (this will take 10-15 minutes)..."
echo ""
node scripts/identify-ground-aircraft-multi.js \
  --date $DATE \
  $AIRPORTS_ARG

EXIT_CODE=$?

if [ $EXIT_CODE -eq 0 ]; then
    echo ""
    echo "=================================================="
    echo "✓ Processing completed successfully!"
    echo "=================================================="
    echo ""
    echo "Data saved to:"
    echo "  s3://ayryx-adsb-history/ground-aircraft/*/${DATE:0:4}/${DATE:5:2}/${DATE:8:2}.json"
    echo ""
    
    # Shutdown instance
    echo "Shutting down instance..."
    shutdown -h now
else
    echo ""
    echo "=================================================="
    echo "✗ Processing failed with exit code $EXIT_CODE"
    echo "=================================================="
    echo "Instance will remain running for debugging"
    exit $EXIT_CODE
fi
EOFSCRIPT

chmod +x $PACKAGE_DIR/run-processing.sh

# Create tarball
cd $PACKAGE_DIR
tar -czf /tmp/adsb-processor-code.tar.gz .
cd - > /dev/null

# Upload to S3
PACKAGE_KEY="ec2-processor/code-$(date +%s).tar.gz"
echo "Uploading code to S3..."
aws s3 cp /tmp/adsb-processor-code.tar.gz "s3://ayryx-adsb-history/$PACKAGE_KEY"

echo -e "${GREEN}✓ Code packaged and uploaded${NC}"

# Create user data script
cat > /tmp/user-data.sh <<EOF
#!/bin/bash
set -e

# Log everything
exec > >(tee /var/log/user-data.log)
exec 2>&1

echo "Starting ADSB processor setup..."

# Download code
cd /home/ec2-user
aws s3 cp s3://ayryx-adsb-history/$PACKAGE_KEY code.tar.gz
mkdir -p adsb-history
cd adsb-history
tar -xzf ../code.tar.gz

# Run processing
bash run-processing.sh $DATE $AIRPORTS_ARG

# If we get here, processing succeeded and instance will shutdown
EOF

# Launch instance
echo -e "${YELLOW}Launching EC2 instance...${NC}"
echo "This will:"
echo "  1. Download tar from S3 (~3 minutes)"
echo "  2. Extract and process data (~10 minutes)"
echo "  3. Save results to S3"
echo "  4. Auto-terminate"
echo ""

INSTANCE_ID=$(aws ec2 run-instances \
    --region $REGION \
    --image-id $AMI_ID \
    --instance-type $INSTANCE_TYPE \
    --iam-instance-profile Name=$ROLE_NAME \
    --security-group-ids $SG_ID \
    --user-data file:///tmp/user-data.sh \
    --block-device-mappings "[{\"DeviceName\":\"/dev/xvda\",\"Ebs\":{\"VolumeSize\":$VOLUME_SIZE,\"VolumeType\":\"gp3\",\"DeleteOnTermination\":true}}]" \
    --tag-specifications "ResourceType=instance,Tags=[{Key=Name,Value=adsb-processor-multi-$DATE},{Key=Purpose,Value=adsb-processing}]" \
    --query 'Instances[0].InstanceId' \
    --output text)

echo -e "${GREEN}✓ Instance launched: $INSTANCE_ID${NC}"
echo ""
echo -e "${GREEN}╔════════════════════════════════════════════════════════════╗${NC}"
echo -e "${GREEN}║                   Processing Started!                      ║${NC}"
echo -e "${GREEN}╚════════════════════════════════════════════════════════════╝${NC}"
echo ""
echo "Instance ID: $INSTANCE_ID"
echo "Airport:     $AIRPORT"
echo "Date:        $DATE"
echo ""
echo "The instance will:"
echo "  • Download and process data (~15 minutes)"
echo "  • Save results to S3"
echo "  • Auto-terminate when complete"
echo ""
echo -e "${YELLOW}Monitor progress:${NC}"
echo "  scripts/monitor-ec2-processor.sh $INSTANCE_ID"
echo ""
echo -e "${YELLOW}Check results:${NC}"
echo "  aws s3 ls s3://ayryx-adsb-history/processed/$AIRPORT/"
echo ""
echo -e "${YELLOW}Query arrivals (after processing):${NC}"
echo "  npm run get-arrivals -- --airport $AIRPORT --date $DATE"
echo ""

# Cleanup
rm -rf $PACKAGE_DIR
rm -f /tmp/adsb-processor-code.tar.gz
rm -f /tmp/user-data.sh
rm -f /tmp/trust-policy.json
rm -f /tmp/s3-policy.json

echo "Setup complete!"

