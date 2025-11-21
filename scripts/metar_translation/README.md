METAR CSV → Structured JSON Translator

This tool converts raw METAR CSV files (as provided by Iowa State / IEM or similar sources) into clean, structured JSON files suitable for downstream analytics (fuel planning, arrival-time modeling, congestion modeling, etc.).

It recursively scans a directory for .csv files, parses each row, merges in additional METAR-derived features, and outputs a JSON file next to each CSV.

Features

Converts fields like M → null and T → numeric 0.0 + a \*\_is_trace flag.

Uses CSV fields as authoritative (no overwriting from METAR text).

Extracts supplementary details from the raw metar string (wind, visibility tokens, cloud strings, altimeter, basic wx codes).

Produces a single JSON file per CSV:

yourfile.csv → yourfile.json

Fully recursive: point it at a root directory and it processes all subfolders.

Requirements

Python 3.9+

pandas

Install dependencies:

pip install pandas

Usage
python3 metar_translator.py /path/to/root_folder/

Examples:

# Convert CSV files from temp/weather to cache/metar

python3 metar_translator.py ../temp/weather/

# Or convert from any directory structure

python3 metar_translator.py data/2024/

This will:

Walk every directory under the specified path

Find all .csv files

Generate a .json file with the same name next to each CSV

**Note**: For the standard workflow, CSV files are downloaded to `temp/weather/` by `populate-aws-metar.js`. After conversion, you may want to move the JSON files to `cache/metar/AIRPORT/` to match the expected directory structure for analysis scripts.

Output example:

[OK] wrote data/2024/KORD_2024.json (8736 rows)

Output Format

Each JSON file contains:

{
"source_csv": "path/to/file.csv",
"generated_at": "2025-11-18T13:22:07Z",
"n_rows": 8736,
"records": [
{
"station": "ORD",
"valid": "2025-01-01T11:08:00Z",
"tmpf_F_raw": "31.00",
"tmpf_F_v": 31.0,
"tmpf_F_is_trace": false,
"cloud_groups_raw": [
{"type_raw": "OVC", "height_raw": "2500.00"}
],
"metar_raw": "KORD 011108Z 28007KT ...",
"metar_parsed": {
"wind_dir": "280",
"wind_spd_kt": 7,
"clouds": ["OVC025"]
},
"...": "other original or cleaned fields"
}
]
}

Every CSV field appears as either \*\_raw or parsed structured data.

METAR text is preserved but CSV fields are authoritative.

Directory Structure Example

Before:

data/
2024/
KORD_2024.csv
KLGA_2024.csv
2025/
KORD_2025.csv

After running:

data/
2024/
KORD_2024.csv
KORD_2024.json
KLGA_2024.csv
KLGA_2024.json
2025/
KORD_2025.csv
KORD_2025.json

Notes

The parser intentionally handles only the most useful subsets of METAR text; CSV values remain authoritative.

METAR trace precipitation (T) is converted to 0.0 but flagged so you can distinguish it from missing data.

The code is intentionally modular and easy to extend as new features become relevant.
