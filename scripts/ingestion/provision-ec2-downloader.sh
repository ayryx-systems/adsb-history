#!/bin/bash

# Provision EC2 instance to download and upload ADSB historical data to S3
# This script launches an instance that downloads data from GitHub and uploads to S3,
# then self-terminates when complete.

set -e

# Configuration
INSTANCE_TYPE="t3.medium"  # 2 vCPU, 4GB RAM - good for download/upload
ROOT_VOLUME_SIZE=30        # GB - enough for 7 days of data
AMI_ID=""                  # Will be auto-detected for Amazon Linux 2023
REGION="us-west-1"
SECURITY_GROUP_NAME="adsb-history-downloader"
IAM_ROLE_NAME="adsb-history-downloader-role"
IAM_INSTANCE_PROFILE="adsb-history-downloader-profile"
KEY_NAME=""  # Optional - set if you want SSH access for debugging

# Parse arguments
START_DATE=""
DAYS=7

while [[ $# -gt 0 ]]; do
  case $1 in
    --start-date)
      START_DATE="$2"
      shift 2
      ;;
    --days)
      DAYS="$2"
      shift 2
      ;;
    --region)
      REGION="$2"
      shift 2
      ;;
    --key-name)
      KEY_NAME="$2"
      shift 2
      ;;
    --help)
      echo "Usage: $0 [options]"
      echo ""
      echo "Options:"
      echo "  --start-date YYYY-MM-DD   Start date for download (default: 2025-11-02)"
      echo "  --days N                  Number of days to download (default: 7)"
      echo "  --region REGION           AWS region (default: us-west-2)"
      echo "  --key-name KEY            SSH key name for debugging (optional)"
      echo "  --help                    Show this help message"
      echo ""
      echo "Example:"
      echo "  $0 --start-date 2025-11-02 --days 7"
      exit 0
      ;;
    *)
      echo "Unknown option: $1"
      exit 1
      ;;
  esac
done

# Default start date if not provided
if [ -z "$START_DATE" ]; then
  START_DATE="2025-11-02"
fi

echo "=========================================="
echo "ADSB History EC2 Downloader Provisioning"
echo "=========================================="
echo "Region: $REGION"
echo "Instance Type: $INSTANCE_TYPE"
echo "Root Volume: ${ROOT_VOLUME_SIZE}GB"
echo "Date Range: $START_DATE + $DAYS days"
echo "=========================================="
echo ""

# Check if AWS CLI is configured
if ! aws sts get-caller-identity --region "$REGION" > /dev/null 2>&1; then
  echo "ERROR: AWS CLI is not configured or credentials are invalid"
  echo "Please run 'aws configure' first"
  exit 1
fi

ACCOUNT_ID=$(aws sts get-caller-identity --region "$REGION" --query Account --output text)
echo "✓ AWS Account: $ACCOUNT_ID"

# Auto-detect latest Amazon Linux 2023 AMI if not specified
if [ -z "$AMI_ID" ]; then
  echo "Detecting latest Amazon Linux 2023 AMI for $REGION..."
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
fi
echo ""

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
  S3_BUCKET_FOR_POLICY="ayryx-adsb-history"
  cat > /tmp/s3-policy.json <<EOF
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "s3:PutObject",
        "s3:GetObject",
        "s3:ListBucket"
      ],
      "Resource": [
        "arn:aws:s3:::${S3_BUCKET_FOR_POLICY}",
        "arn:aws:s3:::${S3_BUCKET_FOR_POLICY}/*"
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
    --description "Security group for ADSB history downloader (egress only)" \
    --vpc-id "$VPC_ID" \
    --region "$REGION" \
    --query "GroupId" \
    --output text)
  
  # Allow all outbound traffic (default, but making it explicit)
  echo "✓ Security group created: $SG_ID"
else
  echo "✓ Security group already exists: $SG_ID"
fi
echo ""

# Step 3: Use existing S3 bucket
echo "Step 3: Using S3 bucket..."
S3_BUCKET="ayryx-adsb-history"
echo "✓ Using bucket: $S3_BUCKET (in $REGION)"
echo ""

# Step 4: Package and upload code to S3
echo "Step 4: Packaging code..."
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

PACKAGE_DIR="/tmp/adsb-ingestion-$$"
mkdir -p "$PACKAGE_DIR"

# Copy necessary files
cd "$PROJECT_ROOT"
cp -r src "$PACKAGE_DIR/"
cp -r config "$PACKAGE_DIR/"
cp -r scripts "$PACKAGE_DIR/"
cp package.json "$PACKAGE_DIR/"
cp .env.example "$PACKAGE_DIR/.env" 2>/dev/null || true

# Create tarball
cd "$PACKAGE_DIR"
tar -czf /tmp/adsb-code.tar.gz .
cd - > /dev/null
rm -rf "$PACKAGE_DIR"

echo "Uploading code package to S3..."
S3_CODE_KEY="bootstrap/adsb-history-code.tar.gz"
aws s3 cp /tmp/adsb-code.tar.gz "s3://$S3_BUCKET/$S3_CODE_KEY" --region "$REGION"
rm -f /tmp/adsb-code.tar.gz

echo "✓ Code uploaded to s3://$S3_BUCKET/$S3_CODE_KEY"
echo ""

# Step 5: Create user data script
echo "Step 5: Preparing user data script..."
cat > /tmp/user-data.sh <<'USERDATA_EOF'
#!/bin/bash
set -e
exec > >(tee /var/log/user-data.log)
exec 2>&1

echo "=========================================="
echo "ADSB History Download Starting"
echo "Start time: $(date)"
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
aws s3 cp s3://S3_BUCKET_PLACEHOLDER/bootstrap/adsb-history-code.tar.gz . --region AWS_REGION_PLACEHOLDER

echo "Extracting code..."
tar xzf adsb-history-code.tar.gz
cd adsb-history

echo "Installing dependencies..."
npm install

# Set AWS region (credentials come from IAM role)
export AWS_REGION=AWS_REGION_PLACEHOLDER
export AWS_DEFAULT_REGION=AWS_REGION_PLACEHOLDER

# Run the download script
echo "=========================================="
echo "Starting download: START_DATE_PLACEHOLDER for DAYS_PLACEHOLDER days"
echo "=========================================="

node scripts/download-week.js --start-date START_DATE_PLACEHOLDER --days DAYS_PLACEHOLDER

EXIT_CODE=$?

echo "=========================================="
echo "Download Complete"
echo "Exit code: $EXIT_CODE"
echo "End time: $(date)"
echo "=========================================="

# Self-terminate the instance
if [ $EXIT_CODE -eq 0 ]; then
  echo "✓ Success! Self-terminating instance..."
  INSTANCE_ID=$(ec2-metadata --instance-id | cut -d " " -f 2)
  aws ec2 terminate-instances --instance-ids "$INSTANCE_ID" --region "$AWS_REGION"
else
  echo "✗ Download failed. Instance will remain running for debugging."
  echo "Check logs at /var/log/user-data.log"
fi
USERDATA_EOF

# Replace placeholders (macOS compatible)
sed -i '' "s/AWS_REGION_PLACEHOLDER/$REGION/g" /tmp/user-data.sh
sed -i '' "s/S3_BUCKET_PLACEHOLDER/$S3_BUCKET/g" /tmp/user-data.sh
sed -i '' "s/START_DATE_PLACEHOLDER/$START_DATE/g" /tmp/user-data.sh
sed -i '' "s/DAYS_PLACEHOLDER/$DAYS/g" /tmp/user-data.sh

echo "✓ User data script prepared"
echo ""

# Step 6: Launch EC2 instance
echo "Step 6: Launching EC2 instance..."

KEY_NAME_PARAM=""
if [ -n "$KEY_NAME" ]; then
  KEY_NAME_PARAM="--key-name $KEY_NAME"
fi

INSTANCE_ID=$(aws ec2 run-instances \
  --region "$REGION" \
  --image-id "$AMI_ID" \
  --instance-type "$INSTANCE_TYPE" \
  --iam-instance-profile "Name=$IAM_INSTANCE_PROFILE" \
  --security-group-ids "$SG_ID" \
  $KEY_NAME_PARAM \
  --block-device-mappings "[{\"DeviceName\":\"/dev/xvda\",\"Ebs\":{\"VolumeSize\":$ROOT_VOLUME_SIZE,\"VolumeType\":\"gp3\",\"DeleteOnTermination\":true}}]" \
  --user-data file:///tmp/user-data.sh \
  --tag-specifications "ResourceType=instance,Tags=[{Key=Name,Value=adsb-history-downloader},{Key=Purpose,Value=data-ingestion},{Key=AutoTerminate,Value=true}]" \
  --query "Instances[0].InstanceId" \
  --output text)

echo "✓ Instance launched: $INSTANCE_ID"
echo ""

# Clean up temp files
rm -f /tmp/trust-policy.json /tmp/s3-policy.json /tmp/user-data.sh

echo "=========================================="
echo "✓ Provisioning Complete!"
echo "=========================================="
echo ""
echo "Instance ID: $INSTANCE_ID"
echo "Region: $REGION"
echo ""
echo "The instance will:"
echo "  1. Download $DAYS days of data starting from $START_DATE"
echo "  2. Upload to S3 (s3://ayryx-adsb-history)"
echo "  3. Self-terminate when complete"
echo ""
echo "Monitor progress:"
echo "  aws ec2 describe-instances --instance-ids $INSTANCE_ID --region $REGION --query 'Reservations[0].Instances[0].State.Name'"
echo ""
echo "View logs (if you have SSH key configured):"
echo "  ssh ec2-user@\$(aws ec2 describe-instances --instance-ids $INSTANCE_ID --region $REGION --query 'Reservations[0].Instances[0].PublicIpAddress' --output text)"
echo "  tail -f /var/log/user-data.log"
echo ""
echo "Estimated completion: 30-60 minutes"
echo "=========================================="

