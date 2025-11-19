#!/usr/bin/env python3
"""
METAR CSV → Structured JSON translator
--------------------------------------

- Recursively walks a directory for *.csv files
- For each CSV:
    - Reads rows
    - Applies cleaning rules:
        M → None
        T → 0.0 and *_is_trace = True
    - Extracts basic METAR text info (wind, vis, clouds, weather codes, altimeter)
    - Keeps CSV fields as authoritative (METAR text is supplementary)
    - Outputs <sameName>.json beside each CSV (JSON dict containing "records")
"""

import re
import csv
import json
from pathlib import Path
from datetime import datetime
from typing import Optional, Tuple, Dict, Any, List

import pandas as pd


# ------------------------------------------------------------
# Helpers
# ------------------------------------------------------------

def is_missing(s: Optional[str]) -> bool:
    return s is None or (isinstance(s, str) and s.strip() in ("", "M", "NA", "None"))


def is_trace_token(s: Optional[str]) -> bool:
    return isinstance(s, str) and s.strip() == "T"


def parse_numeric_field(raw: Optional[str], cast=float) -> Tuple[Optional[Any], bool]:
    """
    Convert numeric-like fields.
        M → (None, False)
        T → (0.0, True)
        else → (cast(value), False)
    """
    if is_missing(raw):
        return None, False

    r = raw.strip()

    if is_trace_token(r):
        try:
            return cast(0), True
        except Exception:
            return 0, True

    try:
        return cast(r), False
    except Exception:
        return None, False


# ------------------------------------------------------------
# Lightweight METAR text parsing (optional verification)
# ------------------------------------------------------------

wind_re = re.compile(r"(?P<dir>\d{3}|VRB)(?P<spd>\d{2,3})(G(?P<gst>\d{2,3}))?KT")
vis_re = re.compile(r"(?P<vis>\d{1,2}(?: ?/?\d)?SM|M?1/4|M1/2)")
altimeter_re = re.compile(r"A(?P<alt>\d{4})")
cloud_re = re.compile(r"\b(FEW|SCT|BKN|OVC|VV)(\d{3}|\d{3}CB|\d{3}TCU)?\b")
wxcode_re = re.compile(
    r" (-|\+)?(DZ|RA|SN|SG|IC|PL|GR|GS|BR|FG|TS|SH|VA|HZ|BL|DR|SQ|FS|SS|DS)\b"
)


def parse_metar_text(metar: Optional[str]) -> Dict[str, Any]:
    """Extracts a few useful tokens from raw METAR text."""
    if not metar or is_missing(metar):
        return {}

    s = metar.strip()
    out: Dict[str, Any] = {}

    m = wind_re.search(s)
    if m:
        out["wind_dir"] = m.group("dir")
        out["wind_spd_kt"] = int(m.group("spd"))
        out["wind_gust_kt"] = int(m.group("gst")) if m.group("gst") else None

    vis = vis_re.search(s)
    if vis:
        out["visibility_raw"] = vis.group("vis")

    a = altimeter_re.search(s)
    if a:
        out["altimeter_A"] = a.group("alt")

    clouds = cloud_re.findall(s)
    if clouds:
        out["clouds"] = ["".join(c).strip() for c in clouds]

    wx = wxcode_re.findall(s + " ")
    if wx:
        out["wx_codes"] = [w[1] for w in wx]

    return out


# ------------------------------------------------------------
# Convert a CSV row into structured JSON object
# ------------------------------------------------------------

def row_to_record(row: Dict[str, str], csv_fieldnames: List[str]) -> Dict[str, Any]:
    rec: Dict[str, Any] = {}

    rec["station"] = row.get("station")

    # Timestamp
    raw_valid = row.get("valid")
    rec["valid_raw"] = raw_valid
    try:
        rec["valid"] = (
            pd.to_datetime(raw_valid) if raw_valid and raw_valid.strip() != "M" else None
        )
    except Exception:
        rec["valid"] = None

    # Standard numeric fields (CSV is authoritative)
    numeric_specs = [
        ("tmpf", "tmpf_F", float),
        ("dwpf", "dwpf_F", float),
        ("relh", "relh_pct", float),
        ("drct", "wind_dir_deg", float),
        ("sknt", "wind_spd_kt", float),
        ("p01i", "precip_1hr_in", float),
        ("alti", "altim_inHg", float),
        ("mslp", "mslp_hPa", float),
        ("vsby", "visibility_sm", float),
        ("gust", "gust_kt", float),
        ("snowdepth", "snowdepth_in", float),
    ]

    for col, outname, cast in numeric_specs:
        if col in row:
            v, trace = parse_numeric_field(row.get(col), cast=cast)
            rec[f"{outname}_raw"] = row.get(col)
            rec[f"{outname}_v"] = v
            rec[f"{outname}_is_trace"] = trace

    # Clouds: structured
    cloud_groups = []
    for i in range(1, 5):
        ctype = row.get(f"skyc{i}")
        cheight = row.get(f"skyl{i}")
        if not is_missing(ctype) or not is_missing(cheight):
            cloud_groups.append({"type_raw": ctype, "height_raw": cheight})
    if cloud_groups:
        rec["cloud_groups_raw"] = cloud_groups

    # Weather codes
    wxc = row.get("wxcodes")
    rec["wxcodes_raw"] = wxc
    if wxc and not is_missing(wxc):
        rec["wxcodes_tokens"] = re.findall(r"[+-]?\w+", wxc)

    # METAR raw + parsed subset
    metar_raw = row.get("metar")
    rec["metar_raw"] = metar_raw
    rec["metar_parsed"] = parse_metar_text(metar_raw)

    # Include all remaining raw CSV fields
    for k in csv_fieldnames:
        if k not in rec:
            rec[f"{k}_raw"] = row.get(k)

    return rec


# ------------------------------------------------------------
# File processing
# ------------------------------------------------------------

def process_csv_to_json(csv_path: Path, json_path: Optional[Path] = None) -> Dict[str, Any]:
    csv_path = Path(csv_path)

    if json_path is None:
        json_path = csv_path.with_suffix(".json")

    records: List[Dict[str, Any]] = []

    with csv_path.open("r", newline="", encoding="utf-8") as fh:
        reader = csv.DictReader(fh)
        fieldnames = reader.fieldnames or []
        for row in reader:
            records.append(row_to_record(row, fieldnames))

    payload = {
        "source_csv": str(csv_path),
        "generated_at": datetime.utcnow().isoformat() + "Z",
        "n_rows": len(records),
        "records": records,
    }

    with json_path.open("w", encoding="utf-8") as jfh:
        json.dump(payload, jfh, indent=2, default=str)

    print(f"[OK] wrote {json_path}  ({len(records)} rows)")
    return payload


def recurse_and_process(root: Path, pattern: str = "*.csv") -> List[Dict[str, Any]]:
    """
    Recursively process all CSV files under a directory.
    """
    root = Path(root)
    results = []

    for p in root.rglob(pattern):
        try:
            results.append(process_csv_to_json(p))
        except Exception as e:
            print(f"[ERROR] Failed on {p}: {e}")

    return results


# ------------------------------------------------------------
# Command-line entry
# ------------------------------------------------------------

if __name__ == "__main__":
    import argparse

    parser = argparse.ArgumentParser(description="METAR CSV → structured JSON translator")
    parser.add_argument("root", type=str, help="Root directory containing CSV files")
    args = parser.parse_args()

    recurse_and_process(Path(args.root))
