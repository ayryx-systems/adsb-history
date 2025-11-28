#!/bin/bash
# Simple script to run ground aircraft identification on EC2
# Usage: 
#   Single date: ./scripts/identification/run-on-ec2.sh --date 2025-11-08 [--airports KLGA,KSFO]
#   Date range:  ./scripts/identification/run-on-ec2.sh --start-date 2025-01-01 --end-date 2025-01-31 [--airports KLGA]

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

# Parse arguments
DATE=""
START_DATE=""
END_DATE=""
AIRPORTS_ARG="--all"
AWS_PROFILE="${AWS_PROFILE:-}"

while [[ $# -gt 0 ]]; do
  case $1 in
    --date)
      DATE="$2"
      shift 2
      ;;
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

# Validate date arguments
if [ -z "$DATE" ] && [ -z "$START_DATE" ]; then
  echo "Error: Either --date or --start-date (with --end-date) is required"
  echo ""
  echo "Usage:"
  echo "  Single date:  $0 --date YYYY-MM-DD [--airports ICAO,...]"
  echo "  Date range:   $0 --start-date YYYY-MM-DD --end-date YYYY-MM-DD [--airports ICAO,...]"
  exit 1
fi

if [ -n "$START_DATE" ] && [ -z "$END_DATE" ]; then
  echo "Error: --end-date is required when using --start-date"
  exit 1
fi

if [ -n "$END_DATE" ] && [ -z "$START_DATE" ]; then
  echo "Error: --start-date is required when using --end-date"
  exit 1
fi

# Build list of dates to process
DATES=()
if [ -n "$DATE" ]; then
  DATES=("$DATE")
else
  # Use Python for reliable date arithmetic across platforms
  while IFS= read -r d; do
    DATES+=("$d")
  done < <(python3 -c "
from datetime import datetime, timedelta
start = datetime.strptime('$START_DATE', '%Y-%m-%d')
end = datetime.strptime('$END_DATE', '%Y-%m-%d')
current = start
while current <= end:
    print(current.strftime('%Y-%m-%d'))
    current += timedelta(days=1)
")
fi

if [ ${#DATES[@]} -eq 0 ]; then
  echo "Error: No dates to process"
  exit 1
fi

echo "Will process ${#DATES[@]} date(s): ${DATES[*]}"
echo ""

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

# Step 5: Create user-data script that processes all dates
echo "Step 5: Preparing user-data script..."

# Build date command arguments
if [ ${#DATES[@]} -eq 1 ]; then
  DATE_CMD="--date ${DATES[0]}"
else
  LAST_DATE_IDX=$((${#DATES[@]} - 1))
  DATE_CMD="--start-date ${DATES[0]} --end-date ${DATES[$LAST_DATE_IDX]}"
fi

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

# Run processing
echo "=========================================="
echo "Starting processing"
if [ ${#DATES[@]} -eq 1 ]; then
  echo "Date: ${DATES[0]}"
  DATE_CMD="--date ${DATES[0]}"
else
  LAST_DATE_IDX=$((${#DATES[@]} - 1))
  echo "Date range: ${DATES[0]} to ${DATES[$LAST_DATE_IDX]} (${#DATES[@]} days)"
  DATE_CMD="--start-date ${DATES[0]} --end-date ${DATES[$LAST_DATE_IDX]}"
fi
echo "=========================================="

NODE_OPTIONS="--max-old-space-size=8192 --expose-gc" node scripts/identification/identify-ground-aircraft.js $DATE_CMD $AIRPORTS_ARG

EXIT_CODE=\$?

echo ""
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
  echo "✗ Some dates failed. Instance will remain running for debugging."
  echo "Check logs at /var/log/user-data.log"
fi
EOF


# Step 6: Launch instance
echo "Step 6: Launching EC2 instance..."
if [ ${#DATES[@]} -eq 1 ]; then
  INSTANCE_NAME="adsb-identification-${DATES[0]}"
else
  LAST_DATE_IDX=$((${#DATES[@]} - 1))
  INSTANCE_NAME="adsb-identification-${DATES[0]}-to-${DATES[$LAST_DATE_IDX]}"
fi

INSTANCE_ID=$(aws ec2 run-instances \
    --region "$REGION" \
    --image-id "$AMI_ID" \
    --instance-type t3.xlarge \
    --iam-instance-profile "Name=$IAM_INSTANCE_PROFILE" \
    --security-group-ids "$SG_ID" \
    --user-data file:///tmp/user-data.sh \
    --block-device-mappings "[{\"DeviceName\":\"/dev/xvda\",\"Ebs\":{\"VolumeSize\":50,\"VolumeType\":\"gp3\",\"DeleteOnTermination\":true}}]" \
    --tag-specifications "ResourceType=instance,Tags=[{Key=Name,Value=$INSTANCE_NAME},{Key=Purpose,Value=data-processing},{Key=AutoTerminate,Value=true}]" \
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
if [ ${#DATES[@]} -eq 1 ]; then
  echo "  1. Process date: ${DATES[0]}"
else
  LAST_DATE_IDX=$((${#DATES[@]} - 1))
  echo "  1. Process ${#DATES[@]} date(s): ${DATES[0]} to ${DATES[$LAST_DATE_IDX]}"
fi
if [ -n "$AIRPORTS_ARG" ] && [ "$AIRPORTS_ARG" != "--all" ]; then
  echo "  2. Process airports: $(echo $AIRPORTS_ARG | sed 's/--airports //')"
else
  echo "  2. Process all enabled airports"
fi
echo "  3. Upload results to S3 (s3://$S3_BUCKET/ground-aircraft/)"
echo "  4. Self-terminate when complete"
echo ""
echo "Monitor progress:"
echo "  aws ec2 describe-instances --instance-ids $INSTANCE_ID --region $REGION --query 'Reservations[0].Instances[0].State.Name'"
echo ""
echo "View logs in AWS Console:"
echo "  https://console.aws.amazon.com/ec2/v2/home?region=$REGION#Instances:instanceId=$INSTANCE_ID"
echo "  → Actions → Monitor and troubleshoot → Get system log"
echo ""
echo "Check results:"
if [ ${#DATES[@]} -eq 1 ]; then
  echo "  aws s3 ls s3://$S3_BUCKET/ground-aircraft/ --recursive | grep ${DATES[0]}"
else
  echo "  aws s3 ls s3://$S3_BUCKET/ground-aircraft/ --recursive | grep -E '($(IFS='|'; echo "${DATES[*]}"))'"
fi
echo ""
echo "Estimated completion: 30-90 minutes per date (depends on number of airports)"
echo "=========================================="

