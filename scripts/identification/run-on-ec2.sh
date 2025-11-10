#!/bin/bash
# Simple script to run ground aircraft identification on EC2
# Usage: ./scripts/processing/run-on-ec2.sh --date 2025-11-08 [--airports KLGA,KSFO]

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

# Parse arguments
DATE=""
AIRPORTS_ARG="--all"
AWS_PROFILE="${AWS_PROFILE:-}"

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
    --aws-profile)
      AWS_PROFILE="$2"
      export AWS_PROFILE
      shift 2
      ;;
    *)
      echo "Unknown option: $1"
      exit 1
      ;;
  esac
done

# Verify AWS account
if [ -n "$AWS_PROFILE" ]; then
    export AWS_PROFILE
fi

CURRENT_ACCOUNT=$(aws sts get-caller-identity --query 'Account' --output text 2>/dev/null)
if [ -z "$CURRENT_ACCOUNT" ]; then
    echo "ERROR: Cannot determine AWS account. Check your AWS credentials."
    exit 1
fi

echo "Using AWS account: $CURRENT_ACCOUNT"
if [ "$CURRENT_ACCOUNT" != "632391382381" ]; then
    echo "⚠️  WARNING: Expected account 632391382381 (Ayryx), but using $CURRENT_ACCOUNT"
    echo "   Set AWS_PROFILE to use the correct account, or use --aws-profile option"
    echo ""
    read -p "Continue anyway? (y/N) " -n 1 -r
    echo
    if [[ ! $REPLY =~ ^[Yy]$ ]]; then
        exit 1
    fi
fi
echo ""

if [ -z "$DATE" ]; then
  echo "Error: --date is required"
  exit 1
fi

# Configuration
REGION="us-west-1"
IAM_ROLE_NAME="adsb-history-processor-role"
IAM_INSTANCE_PROFILE="adsb-history-processor-role"  # Same name as role
SECURITY_GROUP_NAME="adsb-history-processor-sg"
S3_BUCKET="ayryx-adsb-history"

# Step 1: Create IAM role if it doesn't exist
echo "Step 1: Setting up IAM role..."
if aws iam get-role --role-name "$IAM_ROLE_NAME" --region "$REGION" > /dev/null 2>&1; then
  echo "✓ IAM role already exists: $IAM_ROLE_NAME"
else
  echo "Creating IAM role: $IAM_ROLE_NAME"
  
  # Create trust policy
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
    --role-name "$IAM_ROLE_NAME" \
    --assume-role-policy-document file:///tmp/trust-policy.json \
    --region "$REGION"
  
  # Create and attach S3 policy
  cat > /tmp/s3-policy.json <<EOF
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "s3:PutObject",
        "s3:GetObject",
        "s3:ListBucket",
        "s3:HeadObject",
        "s3:GetBucketLocation"
      ],
      "Resource": [
        "arn:aws:s3:::${S3_BUCKET}",
        "arn:aws:s3:::${S3_BUCKET}/*"
      ]
    }
  ]
}
EOF

  aws iam put-role-policy \
    --role-name "$IAM_ROLE_NAME" \
    --policy-name "S3Access" \
    --policy-document file:///tmp/s3-policy.json \
    --region "$REGION"
  
  echo "✓ IAM role created with S3 access"
fi

# Create instance profile if it doesn't exist
if aws iam get-instance-profile --instance-profile-name "$IAM_INSTANCE_PROFILE" --region "$REGION" > /dev/null 2>&1; then
  echo "✓ Instance profile already exists: $IAM_INSTANCE_PROFILE"
else
  echo "Creating instance profile: $IAM_INSTANCE_PROFILE"
  aws iam create-instance-profile \
    --instance-profile-name "$IAM_INSTANCE_PROFILE" \
    --region "$REGION"
  
  aws iam add-role-to-instance-profile \
    --instance-profile-name "$IAM_INSTANCE_PROFILE" \
    --role-name "$IAM_ROLE_NAME" \
    --region "$REGION"
  
  echo "✓ Instance profile created"
  echo "⏳ Waiting 10 seconds for IAM propagation..."
  sleep 10
fi
echo ""

# Step 2: Create security group if it doesn't exist
echo "Step 2: Setting up security group..."
VPC_ID=$(aws ec2 describe-vpcs --region "$REGION" --filters "Name=isDefault,Values=true" --query "Vpcs[0].VpcId" --output text)

if [ -z "$VPC_ID" ] || [ "$VPC_ID" == "None" ]; then
  echo "ERROR: No default VPC found in region $REGION"
  exit 1
fi

SG_ID=$(aws ec2 describe-security-groups \
  --region "$REGION" \
  --filters "Name=group-name,Values=$SECURITY_GROUP_NAME" "Name=vpc-id,Values=$VPC_ID" \
  --query "SecurityGroups[0].GroupId" \
  --output text 2>/dev/null || echo "")

if [ -z "$SG_ID" ] || [ "$SG_ID" == "None" ]; then
  echo "Creating security group: $SECURITY_GROUP_NAME"
  SG_ID=$(aws ec2 create-security-group \
    --group-name "$SECURITY_GROUP_NAME" \
    --description "Security group for ADSB history processor (egress only)" \
    --vpc-id "$VPC_ID" \
    --region "$REGION" \
    --query "GroupId" \
    --output text)
  
  echo "✓ Security group created: $SG_ID"
else
  echo "✓ Security group already exists: $SG_ID"
fi
echo ""

# Step 3: Auto-detect AMI
echo "Step 3: Detecting AMI..."
AMI_ID=$(aws ec2 describe-images \
  --region "$REGION" \
  --owners amazon \
  --filters "Name=name,Values=al2023-ami-2023.*-x86_64" \
            "Name=state,Values=available" \
  --query 'Images | sort_by(@, &CreationDate) | [-1].ImageId' \
  --output text)

if [ -z "$AMI_ID" ] || [ "$AMI_ID" == "None" ]; then
  echo "ERROR: Could not find Amazon Linux 2023 AMI in region $REGION"
  exit 1
fi
echo "✓ Using AMI: $AMI_ID"
echo ""

# Step 4: Package code
echo "Step 4: Packaging code..."
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
aws s3 cp /tmp/adsb-code.tar.gz "s3://$S3_BUCKET/$PACKAGE_KEY" --region "$REGION"
rm -rf "$PACKAGE_DIR" /tmp/adsb-code.tar.gz
echo "✓ Code uploaded to s3://$S3_BUCKET/$PACKAGE_KEY"
echo ""

# Step 5: Create user-data script
echo "Step 5: Preparing user-data script..."
cat > /tmp/user-data.sh <<EOF
#!/bin/bash
set -e
exec > >(tee /var/log/user-data.log)
exec 2>&1

echo "=========================================="
echo "ADSB History Processing Starting"
echo "Start time: \$(date)"
echo "=========================================="

# Install Node.js 20.x
echo "Installing Node.js..."
curl -fsSL https://rpm.nodesource.com/setup_20.x | bash -
dnf install -y nodejs

# Verify installation
node --version
npm --version

# Download code from S3
echo "Downloading code package from S3..."
cd /opt
aws s3 cp s3://$S3_BUCKET/$PACKAGE_KEY . --region $REGION

echo "Extracting code..."
tar xzf $(basename $PACKAGE_KEY)

echo "Installing dependencies..."
npm install

# Create temp directory for processing (on EBS volume, not tmpfs)
echo "Creating temp directory for processing..."
mkdir -p /opt/adsb-processing
chmod 755 /opt/adsb-processing

# Set AWS region (credentials come from IAM role)
export AWS_REGION=$REGION
export AWS_DEFAULT_REGION=$REGION
export S3_BUCKET_NAME=$S3_BUCKET
export TEMP_DIR=/opt/adsb-processing

# Unset any explicit credentials to ensure we use instance profile
unset AWS_ACCESS_KEY_ID
unset AWS_SECRET_ACCESS_KEY
unset AWS_SESSION_TOKEN

# Remove any AWS credentials file that might interfere
rm -f ~/.aws/credentials
rm -f ~/.aws/config

# Wait for IAM credentials to be available
echo "Waiting for IAM credentials to be available..."
echo "Checking instance metadata for IAM role..."
MAX_RETRIES=30
RETRY_COUNT=0
IAM_ROLE_ARN=""
while [ \$RETRY_COUNT -lt \$MAX_RETRIES ]; do
  IAM_ROLE_ARN=\$(curl -s http://169.254.169.254/latest/meta-data/iam/security-credentials/ 2>/dev/null || echo "")
  if [ -n "\$IAM_ROLE_ARN" ]; then
    echo "✓ IAM role found: \$IAM_ROLE_ARN"
    # Wait a bit more for credentials to be available
    sleep 3
    if aws sts get-caller-identity --region $REGION > /dev/null 2>&1; then
      echo "✓ IAM credentials available"
      aws sts get-caller-identity --region $REGION
      break
    fi
  fi
  RETRY_COUNT=\$((RETRY_COUNT + 1))
  if [ \$RETRY_COUNT -eq \$MAX_RETRIES ]; then
    echo "⚠️  WARNING: IAM credentials not available after \$MAX_RETRIES attempts"
    echo "   Instance role: \$IAM_ROLE_ARN"
    echo "   Continuing anyway - credentials may become available during execution"
  else
    echo "   Waiting for IAM credentials... (attempt \$RETRY_COUNT/\$MAX_RETRIES)"
    sleep 2
  fi
done

# Verify S3 access and wait for credentials to be fully available
echo ""
echo "Verifying S3 access..."
CREDENTIALS_READY=false
for i in {1..10}; do
  if aws s3 ls "s3://$S3_BUCKET/" --region $REGION > /dev/null 2>&1; then
    echo "✓ S3 access verified via AWS CLI (attempt $i)"
    echo "   AWS CLI caller identity:"
    aws sts get-caller-identity --region $REGION 2>&1 || echo "   (Could not get caller identity)"
    CREDENTIALS_READY=true
    break
  else
    echo "   Waiting for credentials... (attempt $i/10)"
    sleep 2
  fi
done

if [ "$CREDENTIALS_READY" != "true" ]; then
  echo "⚠️  ERROR: Cannot access S3 bucket after 10 attempts!"
  echo "   Bucket: $S3_BUCKET"
  echo "   This will cause the processing to fail."
  echo "   Check IAM role permissions and instance profile attachment."
  exit 1
fi

# Give credentials a moment to fully propagate
echo "⏳ Waiting 5 seconds for credentials to fully propagate..."
sleep 5
echo ""

# Set environment variables to ensure Node.js SDK uses instance profile
# Unset any explicit credentials
unset AWS_ACCESS_KEY_ID
unset AWS_SECRET_ACCESS_KEY
unset AWS_SESSION_TOKEN
export AWS_SDK_LOAD_CONFIG=0
export AWS_PROFILE=""
export AWS_SHARED_CREDENTIALS_FILE=""
export AWS_CONFIG_FILE=""

# Debug: Show what credentials/env vars are set
echo "Environment check before running Node.js:"
echo "  AWS_ACCESS_KEY_ID: ${AWS_ACCESS_KEY_ID:-not set}"
echo "  AWS_SECRET_ACCESS_KEY: ${AWS_SECRET_ACCESS_KEY:-not set}"
echo "  AWS_SESSION_TOKEN: ${AWS_SESSION_TOKEN:-not set}"
echo "  AWS_PROFILE: ${AWS_PROFILE:-not set}"
echo "  AWS_SHARED_CREDENTIALS_FILE: ${AWS_SHARED_CREDENTIALS_FILE:-not set}"
echo "  AWS_CONFIG_FILE: ${AWS_CONFIG_FILE:-not set}"
echo "  AWS_SDK_LOAD_CONFIG: ${AWS_SDK_LOAD_CONFIG:-not set}"
echo "  Checking for credentials files:"
ls -la ~/.aws/ 2>/dev/null || echo "    ~/.aws/ does not exist"
echo ""

# Run processing
echo "=========================================="
echo "Starting processing: $DATE"
echo "=========================================="

node scripts/processing/identify-ground-aircraft-multi.js --date "$DATE" $AIRPORTS_ARG

EXIT_CODE=\$?

echo "=========================================="
echo "Processing Complete"
echo "Exit code: \$EXIT_CODE"
echo "End time: \$(date)"
echo "=========================================="

# Self-terminate the instance
if [ \$EXIT_CODE -eq 0 ]; then
  echo "✓ Success! Self-terminating instance..."
  INSTANCE_ID=\$(ec2-metadata --instance-id | cut -d " " -f 2)
  aws ec2 terminate-instances --instance-ids "\$INSTANCE_ID" --region "\$AWS_REGION"
else
  echo "✗ Processing failed. Instance will remain running for debugging."
  echo "Check logs at /var/log/user-data.log"
fi
EOF

# Step 6: Launch instance
echo "Step 6: Launching EC2 instance..."
INSTANCE_ID=$(aws ec2 run-instances \
    --region "$REGION" \
    --image-id "$AMI_ID" \
    --instance-type t3.xlarge \
    --iam-instance-profile "Name=$IAM_INSTANCE_PROFILE" \
    --security-group-ids "$SG_ID" \
    --user-data file:///tmp/user-data.sh \
    --block-device-mappings "[{\"DeviceName\":\"/dev/xvda\",\"Ebs\":{\"VolumeSize\":50,\"VolumeType\":\"gp3\",\"DeleteOnTermination\":true}}]" \
    --tag-specifications "ResourceType=instance,Tags=[{Key=Name,Value=adsb-processor-$DATE},{Key=Purpose,Value=data-processing},{Key=AutoTerminate,Value=true}]" \
    --query 'Instances[0].InstanceId' \
    --output text)

rm -f /tmp/user-data.sh /tmp/trust-policy.json /tmp/s3-policy.json

echo "=========================================="
echo "✓ Provisioning Complete!"
echo "=========================================="
echo ""
echo "Instance ID: $INSTANCE_ID"
echo "Region: $REGION"
echo ""
echo "The instance will:"
echo "  1. Process date: $DATE"
echo "  2. Upload results to S3 (s3://$S3_BUCKET/ground-aircraft/)"
echo "  3. Self-terminate when complete"
echo ""
echo "Monitor progress:"
echo "  aws ec2 describe-instances --instance-ids $INSTANCE_ID --region $REGION --query 'Reservations[0].Instances[0].State.Name'"
echo ""
echo "View logs in AWS Console:"
echo "  https://console.aws.amazon.com/ec2/v2/home?region=$REGION#Instances:instanceId=$INSTANCE_ID"
echo "  → Actions → Monitor and troubleshoot → Get system log"
echo ""
echo "Check results:"
echo "  aws s3 ls s3://$S3_BUCKET/ground-aircraft/ --recursive | grep $DATE"
echo ""
echo "Estimated completion: 30-90 minutes (depends on number of airports)"
echo "=========================================="

