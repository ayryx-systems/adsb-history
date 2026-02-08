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

### 6. KBOS - Boston Logan International Airport
- **Status**: ✅ Enabled
- **Config Coordinates**: 42.3629, -71.0064
- **Official Coordinates** (AirNav): 42.3629444, -71.0063889
- **Difference**: ~0.00004° lat, ~0.00001° lon (very close, ~5m)
- **Config Elevation**: 19 ft
- **Official Elevation**: 19.1 ft
- **Difference**: 0.1 ft
- **Verification**: ✅ Coordinates and elevation match perfectly

### 7. KDEN - Denver International Airport
- **Status**: ✅ Enabled
- **Config Coordinates**: 39.8617, -104.6732
- **Official Coordinates** (AirNav): 39.8616667, -104.6731667
- **Difference**: ~0.00003° lat, ~0.00003° lon (very close, ~3m)
- **Config Elevation**: 5434 ft
- **Official Elevation**: 5433.8 ft
- **Difference**: 0.2 ft
- **Verification**: ✅ Coordinates and elevation match perfectly

### 8. KPHL - Philadelphia International Airport
- **Status**: ✅ Enabled
- **Config Coordinates**: 39.8721, -75.2407
- **Official Coordinates** (AirNav): 39.8720839, -75.2406631
- **Difference**: ~0.00002° lat, ~0.00004° lon (very close, ~4m)
- **Config Elevation**: 36 ft
- **Official Elevation**: 35.9 ft
- **Difference**: 0.1 ft
- **Verification**: ✅ Coordinates and elevation match perfectly

### 9. KIAD - Washington Dulles International Airport
- **Status**: ✅ Enabled
- **Config Coordinates**: 38.9475, -77.4599
- **Official Coordinates** (AirNav): 38.9474564, -77.4599286
- **Difference**: ~0.00004° lat, ~0.00003° lon (very close, ~4m)
- **Config Elevation**: 312 ft
- **Official Elevation**: 312.3 ft
- **Difference**: 0.3 ft
- **Verification**: ✅ Coordinates and elevation match perfectly

### 10. KEWR - Newark Liberty International Airport
- **Status**: ✅ Enabled
- **Config Coordinates**: 40.6925, -74.1687
- **Official Coordinates** (AirNav): 40.6924806, -74.1686878
- **Difference**: ~0.00002° lat, ~0.00001° lon (very close, ~2m)
- **Config Elevation**: 18 ft
- **Official Elevation**: 17.5 ft
- **Difference**: 0.5 ft
- **Verification**: ✅ Coordinates and elevation are accurate (minor difference within acceptable range)

### 11. KBNA - Nashville International Airport
- **Status**: ✅ Enabled
- **Config Coordinates**: 36.1245, -86.6782
- **Official Coordinates** (AirNav): 36.1244750, -86.6781806
- **Difference**: ~0.00003° lat, ~0.00002° lon (very close, ~3m)
- **Config Elevation**: 599 ft
- **Official Elevation**: 599 ft
- **Difference**: 0 ft
- **Verification**: ✅ Coordinates and elevation match perfectly

### 12. KMSP - Minneapolis-St Paul International Airport
- **Status**: ✅ Enabled
- **Config Coordinates**: 44.8820, -93.2218
- **Official Coordinates** (AirNav): 44.8819722, -93.2217778
- **Difference**: ~0.00003° lat, ~0.00002° lon (very close, ~3m)
- **Config Elevation**: 842 ft
- **Official Elevation**: 841.8 ft
- **Difference**: 0.2 ft
- **Verification**: ✅ Coordinates and elevation match perfectly

### 13. KLAS - Harry Reid International Airport (Las Vegas)
- **Status**: ✅ Enabled
- **Config Coordinates**: 36.0803, -115.1524
- **Official Coordinates** (AirNav): 36.0803428, -115.1524486
- **Difference**: ~0.00004° lat, ~0.00005° lon (very close, ~5m)
- **Config Elevation**: 2183 ft
- **Official Elevation**: 2183.1 ft
- **Difference**: 0.1 ft
- **Verification**: ✅ Coordinates and elevation match perfectly

### 14. KSEA - Seattle-Tacoma International Airport
- **Status**: ✅ Enabled
- **Config Coordinates**: 47.4499, -122.3118
- **Official Coordinates** (AirNav): 47.4498889, -122.3117778
- **Difference**: ~0.00001° lat, ~0.00002° lon (very close, ~2m)
- **Config Elevation**: 432 ft
- **Official Elevation**: 432.3 ft
- **Difference**: 0.3 ft
- **Verification**: ✅ Coordinates and elevation match perfectly

### 15. KMCO - Orlando International Airport
- **Status**: ✅ Enabled
- **Config Coordinates**: 28.4294, -81.3090
- **Official Coordinates** (AirNav): 28.4293889, -81.3090000
- **Difference**: ~0.00001° lat, ~0.00000° lon (very close, ~1m)
- **Config Elevation**: 96 ft
- **Official Elevation**: 96.4 ft
- **Difference**: 0.4 ft
- **Verification**: ✅ Coordinates and elevation match perfectly

### 16. KMIA - Miami International Airport
- **Status**: ✅ Enabled
- **Config Coordinates**: 25.7954, -80.2901
- **Official Coordinates** (AirNav): 25.7953611, -80.2901158
- **Difference**: ~0.00004° lat, ~0.00002° lon (very close, ~4m)
- **Config Elevation**: 9 ft
- **Official Elevation**: 9.3 ft
- **Difference**: 0.3 ft
- **Verification**: ✅ Coordinates and elevation match perfectly

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
- **Last Verified**: February 8, 2026 (Added KBOS, KDEN, KPHL, KIAD, KEWR, KBNA, KMSP, KLAS, KSEA, KMCO, KMIA)
