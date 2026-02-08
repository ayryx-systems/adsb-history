#!/bin/bash
# Provision EC2 instance to run trace extraction (identification and extraction)
# Usage: ./scripts/extraction/provision-ec2-extraction.sh --start-date 2025-01-01 --end-date 2025-01-31 [--airports KORD,KLGA] [--force]

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

# Parse arguments
START_DATE=""
END_DATE=""
AIRPORTS_ARG=""
FORCE_ARG=""
AWS_PROFILE="${AWS_PROFILE:-}"
KEY_NAME=""

while [[ $# -gt 0 ]]; do
  case $1 in
    --start-date)
      START_DATE="$2"
      shift 2
      ;;
    --end-date)
      END_DATE="$2"
      shift 2
      ;;
    --airports)
      AIRPORTS_ARG="--airports $2"
      shift 2
      ;;
    --force)
      FORCE_ARG="--force"
      shift
      ;;
    --aws-profile)
      AWS_PROFILE="$2"
      export AWS_PROFILE
      shift 2
      ;;
    --key-name)
      KEY_NAME="$2"
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

if [ -z "$START_DATE" ] || [ -z "$END_DATE" ]; then
  echo "Error: --start-date and --end-date are required"
  exit 1
fi

# Configuration
REGION="us-west-1"
IAM_ROLE_NAME="adsb-history-processor-role"
IAM_INSTANCE_PROFILE="adsb-history-processor-role"
SECURITY_GROUP_NAME="adsb-history-processor-sg"
S3_BUCKET="ayryx-adsb-history"
DEFAULT_KEY_NAME="adsb-history-processor-key"

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

# Ensure SSH access rule exists when requested
echo "Detecting your public IP address for optional SSH access..."
MY_IP=$(curl -s https://checkip.amazonaws.com 2>/dev/null || curl -s https://api.ipify.org 2>/dev/null || echo "")
if [ -n "$MY_IP" ]; then
  if aws ec2 authorize-security-group-ingress \
    --group-id "$SG_ID" \
    --region "$REGION" \
    --protocol tcp \
    --port 22 \
    --cidr "${MY_IP}/32" \
    > /dev/null 2>&1; then
    echo "✓ SSH access opened for ${MY_IP}/32"
  else
    echo "✓ SSH rule already present for ${MY_IP}/32 (or rule exists)."
  fi
else
  echo "⚠️  Could not detect your public IP automatically. If you plan to SSH, add a rule to $SECURITY_GROUP_NAME manually."
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

# Copy necessary files, excluding cache, temp, logs, and other unnecessary files
rsync -av \
  --exclude='cache' \
  --exclude='temp' \
  --exclude='temp-test' \
  --exclude='logs' \
  --exclude='node_modules' \
  --exclude='.git' \
  --exclude='notebooks' \
  --exclude='viewer' \
  --exclude='trace_*.html' \
  --exclude='trace_*.txt' \
  --exclude='*.tar' \
  --exclude='*.tar.gz' \
  --exclude='.DS_Store' \
  --exclude='.env' \
  --exclude='.env.local' \
  --exclude='package-lock.json' \
  --exclude='*.log' \
  --exclude='.vscode' \
  --exclude='.idea' \
  --exclude='venv' \
  --exclude='__pycache__' \
  --exclude='*.pyc' \
  src config scripts package.json "$PACKAGE_DIR/" 2>/dev/null || true

# Copy .env.example as .env if it exists
if [ -f .env.example ]; then
  cp .env.example "$PACKAGE_DIR/.env"
fi

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
echo "ADSB History Trace Extraction Starting"
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

# Verify IAM credentials via STS (short retry loop)
echo "Checking IAM credentials..."
MAX_STS_ATTEMPTS=10
CREDENTIALS_READY=false
for attempt in \$(seq 1 \$MAX_STS_ATTEMPTS); do
  if aws sts get-caller-identity --region $REGION > /tmp/sts-info.json 2>/tmp/sts-error.log; then
    echo "✓ IAM credentials available (attempt \$attempt)"
    cat /tmp/sts-info.json
    CREDENTIALS_READY=true
    break
  fi
  echo "   Waiting for IAM credentials... (attempt \$attempt/\$MAX_STS_ATTEMPTS)"
  sleep 3
done

if [ "\$CREDENTIALS_READY" != "true" ]; then
  echo "⚠️  ERROR: Unable to obtain IAM credentials from instance profile"
  cat /tmp/sts-error.log
  exit 1
fi

echo ""
echo "Verifying S3 access..."
if ! aws s3 ls "s3://$S3_BUCKET/" --region $REGION > /dev/null 2>&1; then
  echo "⚠️  ERROR: Cannot access S3 bucket: $S3_BUCKET"
  echo "   Check IAM role permissions and bucket policy."
  exit 1
fi
echo "✓ S3 bucket reachable"
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
echo "  AWS_ACCESS_KEY_ID: \${AWS_ACCESS_KEY_ID:-not set}"
echo "  AWS_SECRET_ACCESS_KEY: \${AWS_SECRET_ACCESS_KEY:-not set}"
echo "  AWS_SESSION_TOKEN: \${AWS_SESSION_TOKEN:-not set}"
echo "  AWS_PROFILE: \${AWS_PROFILE:-not set}"
echo "  AWS_SHARED_CREDENTIALS_FILE: \${AWS_SHARED_CREDENTIALS_FILE:-not set}"
echo "  AWS_CONFIG_FILE: \${AWS_CONFIG_FILE:-not set}"
echo "  AWS_SDK_LOAD_CONFIG: \${AWS_SDK_LOAD_CONFIG:-not set}"
echo "  Checking for credentials files:"
ls -la ~/.aws/ 2>/dev/null || echo "    ~/.aws/ does not exist"
echo ""

# Check disk space before starting
echo "=========================================="
echo "Checking disk space before extraction"
echo "=========================================="
df -h /opt/adsb-processing || df -h /
echo ""

# Run processing
echo "=========================================="
echo "Starting extraction: $START_DATE to $END_DATE"
echo "=========================================="

if [ -z "$AIRPORTS_ARG" ]; then
  node --expose-gc --max-old-space-size=4096 scripts/extraction/identify-and-extract.js --all --start-date "$START_DATE" --end-date "$END_DATE" $FORCE_ARG
else
  node --expose-gc --max-old-space-size=4096 scripts/extraction/identify-and-extract.js $AIRPORTS_ARG --start-date "$START_DATE" --end-date "$END_DATE" $FORCE_ARG
fi

EXIT_CODE=\$?

echo "=========================================="
echo "Extraction Complete"
echo "Exit code: \$EXIT_CODE"
echo "End time: \$(date)"
echo "=========================================="

# Check disk space after extraction
echo ""
echo "Final disk space check:"
df -h /opt/adsb-processing || df -h /
echo ""

# Self-terminate the instance
if [ \$EXIT_CODE -eq 0 ]; then
  echo "✓ Success! Self-terminating instance..."
  INSTANCE_ID=\$(ec2-metadata --instance-id | cut -d " " -f 2)
  aws ec2 terminate-instances --instance-ids "\$INSTANCE_ID" --region "\$AWS_REGION"
else
  echo "✗ Extraction failed. Instance will remain running for debugging."
  echo "Check logs at /var/log/user-data.log"
  echo ""
  echo "To investigate:"
  echo "  1. SSH into the instance"
  echo "  2. Check disk space: df -h"
  echo "  3. Check for errors: tail -f /var/log/user-data.log"
  echo "  4. Check temp directory: du -sh /opt/adsb-processing/*"
fi
EOF

# Step 6: Set up SSH key (optional but recommended for debugging)
if [ -z "$KEY_NAME" ]; then
  KEY_NAME="$DEFAULT_KEY_NAME"
fi

echo "Step 6: Setting up SSH key ($KEY_NAME)..."
KEY_FILE="$HOME/.ssh/${KEY_NAME}.pem"
if aws ec2 describe-key-pairs --key-names "$KEY_NAME" --region "$REGION" > /dev/null 2>&1; then
  echo "✓ Key pair already exists in AWS: $KEY_NAME"
  if [ -f "$KEY_FILE" ]; then
    echo "✓ Private key present at $KEY_FILE"
  else
    echo "⚠️  Private key file not found at $KEY_FILE. If you intend to SSH, place the .pem file there or create a new key."
  fi
else
  echo "Creating new key pair: $KEY_NAME"
  mkdir -p "$HOME/.ssh"
  aws ec2 create-key-pair \
    --key-name "$KEY_NAME" \
    --region "$REGION" \
    --query 'KeyMaterial' \
    --output text > "$KEY_FILE"
  chmod 400 "$KEY_FILE"
  echo "✓ Key pair created and saved to $KEY_FILE"
fi
echo ""

# Step 7: Launch instance
echo "Step 7: Launching EC2 instance..."
KEY_NAME_PARAM=()
if [ -n "$KEY_NAME" ]; then
  KEY_NAME_PARAM=( --key-name "$KEY_NAME" )
fi

INSTANCE_ID=$(aws ec2 run-instances \
    --region "$REGION" \
    --image-id "$AMI_ID" \
    --instance-type t3.xlarge \
    --iam-instance-profile "Name=$IAM_INSTANCE_PROFILE" \
    --security-group-ids "$SG_ID" \
    "${KEY_NAME_PARAM[@]}" \
    --user-data file:///tmp/user-data.sh \
    --block-device-mappings "[{\"DeviceName\":\"/dev/xvda\",\"Ebs\":{\"VolumeSize\":100,\"VolumeType\":\"gp3\",\"DeleteOnTermination\":true}}]" \
    --tag-specifications "ResourceType=instance,Tags=[{Key=Name,Value=adsb-extractor-$START_DATE-to-$END_DATE},{Key=Purpose,Value=trace-extraction},{Key=AutoTerminate,Value=true}]" \
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
echo "  1. Extract traces for date range: $START_DATE to $END_DATE"
if [ -n "$AIRPORTS_ARG" ]; then
  echo "  2. Process airports: $(echo $AIRPORTS_ARG | sed 's/--airports //')"
else
  echo "  2. Process all enabled airports"
fi
echo "  3. Upload results to S3 (s3://$S3_BUCKET/extracted/)"
echo "  4. Self-terminate when complete"
echo ""
echo "Monitor progress:"
echo "  aws ec2 describe-instances --instance-ids $INSTANCE_ID --region $REGION --query 'Reservations[0].Instances[0].State.Name'"
echo ""
echo "View logs in AWS Console:"
echo "  https://console.aws.amazon.com/ec2/v2/home?region=$REGION#Instances:instanceId=$INSTANCE_ID"
echo "  → Actions → Monitor and troubleshoot → Get system log"
echo ""
if [ -n "$KEY_NAME" ]; then
  echo "SSH access (if needed):"
  echo "  aws ec2 describe-instances --instance-ids $INSTANCE_ID --region $REGION --query 'Reservations[0].Instances[0].PublicIpAddress' --output text"
  echo "  ssh -i $KEY_FILE ec2-user@<public-ip>"
  echo ""
fi
echo "Check results:"
echo "  aws s3 ls s3://$S3_BUCKET/extracted/ --recursive | grep -E '($START_DATE|$END_DATE)'"
echo ""
echo "Estimated completion: 1-4 hours (depends on date range and number of airports)"
echo "=========================================="
