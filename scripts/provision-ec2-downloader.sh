#!/bin/bash

# Provision EC2 instance to download and upload ADSB historical data to S3
# This script launches an instance that downloads data from GitHub and uploads to S3,
# then self-terminates when complete.

set -e

# Configuration
INSTANCE_TYPE="t3.medium"  # 2 vCPU, 4GB RAM - good for download/upload
ROOT_VOLUME_SIZE=30        # GB - enough for 7 days of data
AMI_ID="ami-0c94855ba95c574c8"  # Amazon Linux 2023 (us-west-2)
REGION="us-west-2"
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
        "arn:aws:s3:::ayryx-adsb-history",
        "arn:aws:s3:::ayryx-adsb-history/*"
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

# Step 3: Create user data script
echo "Step 3: Preparing user data script..."
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
dnf install -y nodejs git

# Verify installation
node --version
npm --version

# Create working directory
mkdir -p /opt/adsb-history
cd /opt/adsb-history

# Clone the repository (or download the code)
echo "Fetching code..."
cat > package.json <<'PKG_EOF'
{
  "name": "adsb-history",
  "version": "1.0.0",
  "type": "module",
  "dependencies": {
    "dotenv": "^16.0.3",
    "winston": "^3.11.0",
    "@aws-sdk/client-s3": "^3.450.0",
    "@aws-sdk/lib-storage": "^3.450.0",
    "tar": "^6.2.0",
    "axios": "^1.6.0",
    "p-limit": "^5.0.0"
  }
}
PKG_EOF

echo "Installing dependencies..."
npm install

# Create minimal implementation
mkdir -p src/ingestion src/utils config

# Download configuration
cat > config/airports.json <<'AIRPORTS_EOF'
[
  {
    "icao": "KLAX",
    "name": "Los Angeles International",
    "lat": 33.9425,
    "lon": -118.408
  }
]
AIRPORTS_EOF

cat > config/aws-config.json <<'AWS_CONFIG_EOF'
{
  "region": "us-west-2",
  "bucket": "ayryx-adsb-history"
}
AWS_CONFIG_EOF

# We'll inject the actual source files from the repository
USERDATA_EOF

# Inject the source files content into user data
echo 'echo "Creating source files..."' >> /tmp/user-data.sh

# Read and inject GitHubReleaseDownloader.js
echo "cat > src/ingestion/GitHubReleaseDownloader.js <<'GITHUB_EOF'" >> /tmp/user-data.sh
cat /Users/allredj/git/ayryx/adsb-history/src/ingestion/GitHubReleaseDownloader.js >> /tmp/user-data.sh
echo 'GITHUB_EOF' >> /tmp/user-data.sh

# Read and inject S3Uploader.js  
echo "cat > src/ingestion/S3Uploader.js <<'S3_EOF'" >> /tmp/user-data.sh
cat /Users/allredj/git/ayryx/adsb-history/src/ingestion/S3Uploader.js >> /tmp/user-data.sh
echo 'S3_EOF' >> /tmp/user-data.sh

# Read and inject DataExtractor.js
echo "cat > src/ingestion/DataExtractor.js <<'EXTRACTOR_EOF'" >> /tmp/user-data.sh
cat /Users/allredj/git/ayryx/adsb-history/src/ingestion/DataExtractor.js >> /tmp/user-data.sh
echo 'EXTRACTOR_EOF' >> /tmp/user-data.sh

# Read and inject logger.js
echo "cat > src/utils/logger.js <<'LOGGER_EOF'" >> /tmp/user-data.sh
cat /Users/allredj/git/ayryx/adsb-history/src/utils/logger.js >> /tmp/user-data.sh
echo 'LOGGER_EOF' >> /tmp/user-data.sh

# Read and inject s3.js
echo "cat > src/utils/s3.js <<'S3UTIL_EOF'" >> /tmp/user-data.sh
cat /Users/allredj/git/ayryx/adsb-history/src/utils/s3.js >> /tmp/user-data.sh
echo 'S3UTIL_EOF' >> /tmp/user-data.sh

# Read and inject download-week.js
echo "cat > scripts/download-week.js <<'DOWNLOAD_EOF'" >> /tmp/user-data.sh
cat /Users/allredj/git/ayryx/adsb-history/scripts/download-week.js >> /tmp/user-data.sh
echo 'DOWNLOAD_EOF' >> /tmp/user-data.sh
echo 'mkdir -p scripts' >> /tmp/user-data.sh

# Add the execution part
cat >> /tmp/user-data.sh <<'USERDATA_EOF2'

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
USERDATA_EOF2

# Replace placeholders
sed -i "s/AWS_REGION_PLACEHOLDER/$REGION/g" /tmp/user-data.sh
sed -i "s/START_DATE_PLACEHOLDER/$START_DATE/g" /tmp/user-data.sh
sed -i "s/DAYS_PLACEHOLDER/$DAYS/g" /tmp/user-data.sh

echo "✓ User data script prepared"
echo ""

# Step 4: Launch EC2 instance
echo "Step 4: Launching EC2 instance..."

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

