# Development Notes

## Data Format

### Trace Files
- **Location**: `traces/XX/trace_full_<icao>.json` (XX = last 2 hex digits of ICAO)
- **Format**: Gzipped JSON despite `.json` extension
- **Decompression**: Must use `zlib.gunzip()` before parsing
- **Structure**: Array of position reports (see wiedehopf/readsb documentation)

### Position Report Format (readsb)
Array format: `[timestamp, lat, lon, alt_baro, gs, track, flags, ...]`

Key fields:
- `[0]`: timestamp (Unix epoch seconds)
- `[1]`: latitude (degrees, null if no position)
- `[2]`: longitude (degrees, null if no position)
- `[3]`: alt_baro (barometric altitude, feet)
- `[4]`: gs (ground speed, knots)
- `[5]`: track (degrees)
- `[15]`: baro_rate (vertical speed, feet/minute)

## S3 File Naming

### Raw Data
- **Pattern**: `raw/YYYY/MM/DD/vYYYY.MM.DD-planes-readsb-prod-0.tar`
- **Note**: Date uses dots (`.`) not dashes (`-`) in filename
- **Example**: `raw/2025/11/08/v2025.11.08-planes-readsb-prod-0.tar`

### Processed Data
- **Pattern**: `processed/AIRPORT/YYYY/MM/DD.json`
- **Example**: `processed/KLGA/2025/11/08.json`

## Flight Classification Logic

### Arrivals
- High altitude before airport (>5000 ft)
- Low altitude near airport (<5000 ft)
- Very close proximity (<5 nm)
- Descending altitude profile

### Departures
- Low altitude near airport (<5000 ft)
- High altitude after airport (>5000 ft)
- Very close proximity (<5 nm)
- Climbing altitude profile

### Touch-and-go
- Both arrival and departure patterns detected

### Overflights
- Passes near airport but doesn't match arrival/departure patterns

## EC2 Processing

### Instance Specs
- **Type**: t3.xlarge (4 vCPU, 16GB RAM)
- **Storage**: 50GB gp3 EBS
- **Duration**: ~15 minutes
- **Cost**: ~$0.04-0.05 per run

### Processing Steps
1. Download tar from S3 (~3 min, ~3GB)
2. Extract tar (~2 min, ~20GB uncompressed)
3. Stream and decompress trace files
4. Classify flights for airport (~10 min, ~500k traces)
5. Save results to S3 (~5MB)
6. Auto-terminate

## Performance

### Trace Processing
- **Input**: ~500,000 traces per day (global)
- **Relevant**: ~500 flights per airport
- **Rate**: ~1,000 traces/second
- **Memory**: ~2GB peak during processing

### Storage
- **Raw**: ~3GB/day (tar, kept forever)
- **Processed**: ~5MB/day/airport (structured JSON)
- **Cache**: Local copy for instant queries

## Known Issues / Gotchas

1. **Gzipped JSON**: Trace files are gzipped despite `.json` extension - must decompress first
2. **Date format**: S3 filenames use dots (`v2025.11.08`) not dashes
3. **No extraction in S3**: Only store tar files, extract on-demand to save costs
4. **IAM propagation**: Wait 10s after creating IAM role for EC2
5. **Security group output**: AWS returns ARN+ID, must extract just ID

## Testing

### Quick Test
```bash
# Download one day
./scripts/provision-ec2-downloader.sh --date 2025-11-08

# Process one airport
./scripts/provision-ec2-processor.sh --airport KLGA --date 2025-11-08

# Query results
npm run get-arrivals -- --airport KLGA --date 2025-11-08
```

### Local Testing (requires 50GB disk)
```bash
npm run process-airport -- --airport KLGA --date 2025-11-08 --show-arrivals
```

## Future Enhancements

- [ ] Batch processing (multiple dates in parallel)
- [ ] Lambda for daily processing automation
- [ ] CloudFront CDN for processed data
- [ ] Aggregate statistics (weekly, monthly)
- [ ] Weather correlation (METAR/TAF integration)
- [ ] Aircraft type analysis
- [ ] Runway-specific statistics

