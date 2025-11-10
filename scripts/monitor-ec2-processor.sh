#!/bin/bash

# Monitor EC2 processing instance
# Usage: ./scripts/monitor-ec2-processor.sh [instance-id]

INSTANCE_ID="$1"
REGION="us-west-1"

if [ -z "$INSTANCE_ID" ]; then
    echo "Usage: $0 <instance-id>"
    echo ""
    echo "Or auto-detect latest processor instance:"
    echo "  $0 auto"
    exit 1
fi

if [ "$INSTANCE_ID" == "auto" ]; then
    echo "Finding latest processor instance..."
    INSTANCE_ID=$(aws ec2 describe-instances \
        --region $REGION \
        --filters "Name=tag:Purpose,Values=adsb-processing" "Name=instance-state-name,Values=pending,running,stopping,stopped" \
        --query 'sort_by(Reservations[].Instances[], &LaunchTime)[-1].InstanceId' \
        --output text)
    
    if [ -z "$INSTANCE_ID" ] || [ "$INSTANCE_ID" == "None" ]; then
        echo "No processor instances found"
        exit 1
    fi
    echo "Found: $INSTANCE_ID"
    echo ""
fi

echo "Monitoring EC2 Processing Instance"
echo "Instance ID: $INSTANCE_ID"
echo "Region: $REGION"
echo ""
echo "Press Ctrl+C to stop monitoring"
echo ""
echo "========================================================"

while true; do
    # Get instance info
    INFO=$(aws ec2 describe-instances \
        --region $REGION \
        --instance-ids $INSTANCE_ID \
        --query 'Reservations[0].Instances[0].[State.Name,LaunchTime,Tags[?Key==`Name`].Value|[0]]' \
        --output text 2>/dev/null)
    
    if [ $? -ne 0 ]; then
        echo "Error: Could not get instance info"
        exit 1
    fi
    
    STATE=$(echo "$INFO" | awk '{print $1}')
    LAUNCH_TIME=$(echo "$INFO" | awk '{print $2}')
    NAME=$(echo "$INFO" | awk '{print $3}')
    
    # Calculate uptime
    if [ "$STATE" == "running" ] || [ "$STATE" == "stopping" ] || [ "$STATE" == "stopped" ]; then
        LAUNCH_EPOCH=$(date -j -f "%Y-%m-%dT%H:%M:%S" "${LAUNCH_TIME%.*}" "+%s" 2>/dev/null || date -d "${LAUNCH_TIME%.*}" "+%s" 2>/dev/null || echo "0")
        NOW_EPOCH=$(date "+%s")
        UPTIME_SECONDS=$((NOW_EPOCH - LAUNCH_EPOCH))
        UPTIME_MIN=$((UPTIME_SECONDS / 60))
    else
        UPTIME_MIN=0
    fi
    
    clear
    echo "╔════════════════════════════════════════════════════════════╗"
    echo "║            ADSB Processor Instance Monitor                ║"
    echo "╚════════════════════════════════════════════════════════════╝"
    echo ""
    echo "Instance:   $INSTANCE_ID"
    echo "Name:       $NAME"
    echo "State:      $STATE"
    echo "Uptime:     ${UPTIME_MIN} minutes"
    echo "Launched:   $LAUNCH_TIME"
    echo ""
    
    # Check for ground-aircraft files (multi-airport format)
    if [[ $NAME =~ adsb-processor-multi-([0-9-]+) ]]; then
        DATE="${BASH_REMATCH[1]}"
        echo "Date:       $DATE"
        echo ""
        
        # Check for ground-aircraft files
        YEAR=$(echo $DATE | cut -d- -f1)
        MONTH=$(echo $DATE | cut -d- -f2)
        DAY=$(echo $DATE | cut -d- -f3)
        
        FILES=$(aws s3 ls "s3://ayryx-adsb-history/ground-aircraft/" --recursive 2>/dev/null | grep "$YEAR/$MONTH/$DAY.json" | wc -l)
        
        if [ "$FILES" -gt 0 ]; then
            echo "✓ Found $FILES ground-aircraft file(s) in S3:"
            aws s3 ls "s3://ayryx-adsb-history/ground-aircraft/" --recursive 2>/dev/null | grep "$YEAR/$MONTH/$DAY.json" | awk '{print "  " $4}'
            echo ""
        else
            echo "⏳ Processing in progress..."
            echo "  Target: s3://ayryx-adsb-history/ground-aircraft/*/$YEAR/$MONTH/$DAY.json"
            echo ""
        fi
    fi
    
    echo "────────────────────────────────────────────────────────────"
    
    if [ "$STATE" == "terminated" ]; then
        echo ""
        echo "✓ Instance terminated (processing complete)"
        echo ""
        if [ ! -z "$DATE" ]; then
            echo "View logs:"
            echo "  ./scripts/view-ec2-logs.sh $INSTANCE_ID"
            echo ""
            echo "Check S3 files:"
            echo "  aws s3 ls s3://ayryx-adsb-history/ground-aircraft/ --recursive | grep $DATE"
        fi
        exit 0
    elif [ "$STATE" == "stopped" ]; then
        echo ""
        echo "Instance stopped"
        exit 1
    elif [ "$STATE" == "running" ]; then
        echo ""
        if [ $UPTIME_MIN -lt 20 ]; then
            echo "Status: Processing (typical: 15 minutes)"
        else
            echo "⚠️  Running longer than expected (>20 minutes)"
            echo "    Check logs or terminate if stuck"
        fi
    fi
    
    echo ""
    echo "Updated: $(date '+%H:%M:%S')"
    echo ""
    echo "Press Ctrl+C to stop monitoring"
    
    sleep 10
done

