#!/bin/bash
# Package the code for EC2 deployment

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

echo "Packaging code for EC2 deployment..." >&2

# Create temporary directory in project
TEMP_DIR="$PROJECT_DIR/.temp-package"
rm -rf "$TEMP_DIR"
CODE_DIR="$TEMP_DIR/adsb-history"
mkdir -p "$CODE_DIR"

# Copy necessary files
mkdir -p "$CODE_DIR/src/ingestion" "$CODE_DIR/src/utils" "$CODE_DIR/scripts" "$CODE_DIR/config"

cp "$PROJECT_DIR/package.json" "$CODE_DIR/"
cp "$PROJECT_DIR/src/ingestion/"*.js "$CODE_DIR/src/ingestion/"
cp "$PROJECT_DIR/src/utils/"*.js "$CODE_DIR/src/utils/"
cp "$PROJECT_DIR/scripts/download-week.js" "$CODE_DIR/scripts/"
cp "$PROJECT_DIR/config/"*.json "$CODE_DIR/config/" 2>/dev/null || true

# Create tarball
OUTPUT_FILE="$TEMP_DIR/adsb-history-code.tar.gz"
cd "$TEMP_DIR"
tar czf adsb-history-code.tar.gz adsb-history/

echo "✓ Code packaged: $OUTPUT_FILE" >&2
echo "$OUTPUT_FILE"

