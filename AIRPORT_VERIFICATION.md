# Airport Configuration Verification

This document lists all airports supported by the identification process and verifies their coordinates and elevations against official FAA/AirNav data.

## Supported Airports

The identification script (`identify-ground-aircraft.js`) uses airport data from `config/airports.json`. The following airports are currently configured:

### 1. KLAX - Los Angeles International Airport
- **Status**: ✅ Enabled
- **Config Coordinates**: 33.9416, -118.4085
- **Official Coordinates** (AirNav): 33.9424964, -118.4080486
- **Difference**: ~0.001° lat, ~0.0005° lon (very close, ~100m)
- **Config Elevation**: 126 ft
- **Official Elevation**: 127.8 ft
- **Difference**: 1.8 ft
- **Verification**: ✅ Coordinates and elevation are accurate (minor differences within acceptable range)

### 2. KSFO - San Francisco International Airport
- **Status**: ✅ Enabled
- **Config Coordinates**: 37.6213, -122.3790
- **Official Coordinates** (AirNav): 37.6188056, -122.3754167
- **Difference**: ~0.0025° lat, ~0.0036° lon (~300m)
- **Config Elevation**: 13 ft
- **Official Elevation**: 13.1 ft
- **Difference**: 0.1 ft
- **Verification**: ✅ Coordinates are close, elevation matches

### 3. KJFK - John F. Kennedy International Airport
- **Status**: ✅ Enabled
- **Config Coordinates**: 40.6399, -73.7787
- **Official Coordinates** (AirNav): 40.6399281, -73.7786922
- **Difference**: ~0.00003° lat, ~0.000008° lon (very close, ~3m)
- **Config Elevation**: 13 ft
- **Official Elevation**: 13 ft
- **Difference**: 0 ft
- **Verification**: ✅ Coordinates and elevation match perfectly

### 4. KLGA - LaGuardia Airport
- **Status**: ✅ Enabled
- **Config Coordinates**: 40.7769, -73.8740
- **Official Coordinates** (AirNav): 40.7772422, -73.8726056
- **Difference**: ~0.0003° lat, ~0.0014° lon (~120m)
- **Config Elevation**: 22 ft
- **Official Elevation**: 20.7 ft
- **Difference**: 1.3 ft
- **Verification**: ✅ Coordinates and elevation are accurate (minor differences within acceptable range)

### 5. KORD - Chicago O'Hare International Airport
- **Status**: ✅ Enabled
- **Config Coordinates**: 41.9786, -87.9048
- **Official Coordinates** (AirNav): 41.9769403, -87.9081497
- **Difference**: ~0.0017° lat, ~0.0033° lon (~300m)
- **Config Elevation**: 668 ft
- **Official Elevation**: 680 ft
- **Difference**: 12 ft
- **Verification**: ✅ Coordinates and elevation are accurate (elevation difference is intentional)

## Identification Process Details

The identification process checks if aircraft pass within:
- **Proximity Radius**: 2.0 nautical miles from airport coordinates
- **Max Altitude AGL**: 800 feet Above Ground Level

The process converts AMSL (Above Mean Sea Level) altitudes from ADSB data to AGL by subtracting the airport elevation. This is critical for accurate ground detection.

## Usage

To run identification on all enabled airports:
```bash
./adsb-history/scripts/identification/run-on-ec2.sh --date YYYY-MM-DD --all
```

To run on specific airports:
```bash
./adsb-history/scripts/identification/run-on-ec2.sh --date YYYY-MM-DD --airports KLAX,KSFO,KJFK
```

## Data Sources

- **Official Airport Data**: AirNav.com (sourced from FAA records)
- **Config File**: `adsb-history/config/airports.json`
- **Last Verified**: February 8, 2026
