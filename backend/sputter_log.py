"""
Sputter deposition-log parser.

One log file corresponds to one deposited layer. The recorder emits a wide CSV
(~260 columns) sampled ~1 Hz with a 3-line preamble:

    line 1:  "Recording Name, Date Started, User"
    line 2:  "<name>,<date>,<user>"
    line 3:  (blank)
    line 4:  header row (260 columns)
    line 5+: data rows

Only a small, curated set of channels is extracted — the ones that vary or are
varied run-to-run. Everything else (match-network cap positions, motor status,
gauge filament flags, ambient thermocouples) is tool diagnostics and dropped.

Sources vs. power supplies:
  - Sources (guns) 1,2,3,6 hold targets; each reports Material / Loaded Target /
    Shutter Open / Active. Sources 1-3 carry a "Switch-RF-PWS1" signal (routed onto
    Power Supply 1 via the switch matrix); source 6 is wired to its own supply.
  - Power Supplies 1/6/7 each report Fwd / Rfl / DC Bias / Output Setpoint
    independently. PS7 is the substrate bias.
  - "Which material is depositing" is read from the log: the active source during
    the deposition (substrate-shutter-open) window.
"""

import csv
import io
import re
from datetime import datetime

# ── Column map ────────────────────────────────────────────────────────────────
# Centralized so a firmware rename is a one-line edit here.

TIMESTAMP_COL = "Time Stamp"
SHUTTER_COL = "PC Substrate Shutter Open"

# Timestamp looks like "Jul-01-2026 08:09:01.147 AM"
_TS_FMT = "%b-%d-%Y %I:%M:%S.%f %p"

CHANNELS = {
    "temp_pyro1":       "Substrate Heater Temperature",
    "temp_pyro2":       "Substrate Heater Temperature 2",
    "temp_setpoint":    "Substrate Heater Temperature Setpoint",
    "pressure_process": "PC Capman Pressure",
    "pressure_chamber": "PC Ion Gauge Pressure",
    "flow_ar":          "PC MFC 1 Flow",
    "flow_o2":          "PC MFC 2 Flow",
    "flow_n2":          "PC MFC 3 Flow",
    "flow_ar_sp":       "PC MFC 1 Setpoint",
    "flow_o2_sp":       "PC MFC 2 Setpoint",
    "ps1_fwd":          "Power Supply 1 Fwd Power",
    "ps1_rfl":          "Power Supply 1 Rfl Power",
    "ps1_setpoint":     "Power Supply 1 Output Setpoint",
    "ps1_dcbias":       "Power Supply 1 DC Bias",
    "ps6_fwd":          "Power Supply 6 Fwd Power",
    "ps6_dcbias":       "Power Supply 6 DC Bias",
    "ps7_fwd":          "Power Supply 7 Fwd Power",
    "ps7_dcbias":       "Power Supply 7 DC Bias",
    "rotation":         "Substrate Rotation_Velocity",
}

SOURCE_NUMS = [1, 2, 3, 6]


def _to_float(v):
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


def _parse_ts(s):
    s = (s or "").strip()
    if not s:
        return None
    try:
        return datetime.strptime(s, _TS_FMT)
    except ValueError:
        return None


def _read_rows(text):
    """Return (recording_meta, header, rows[list[dict]]). Tolerates missing preamble."""
    lines = text.splitlines()
    # Find the header row: the first line that starts with the timestamp column.
    header_idx = None
    for i, ln in enumerate(lines[:10]):
        if ln.startswith(TIMESTAMP_COL + ","):
            header_idx = i
            break
    if header_idx is None:
        return {}, [], []

    # Recording metadata (name/date/user) lives in the first two lines, if present.
    meta = {}
    if header_idx >= 2 and "," in lines[1]:
        keys = [k.strip() for k in lines[0].split(",")]
        vals = [v.strip() for v in lines[1].split(",")]
        meta = dict(zip(keys, vals))

    body = "\n".join(lines[header_idx:])
    reader = csv.reader(io.StringIO(body))
    header = next(reader, [])
    rows = [dict(zip(header, r)) for r in reader if any(c.strip() for c in r)]
    return meta, header, rows


def _stats(vals):
    """mean / std / min / max over non-None values; None if empty."""
    xs = [v for v in vals if v is not None]
    if not xs:
        return None
    n = len(xs)
    mean = sum(xs) / n
    var = sum((x - mean) ** 2 for x in xs) / n if n > 1 else 0.0
    return {"mean": mean, "std": var ** 0.5, "min": min(xs), "max": max(xs), "n": n}


def _find_windows(shutter_flags, time_s):
    """Return list of {start_s,end_s,duration_s,i0,i1} for each shutter-open interval."""
    windows = []
    open_start = None
    for i, f in enumerate(shutter_flags):
        is_open = f == 1
        if is_open and open_start is None:
            open_start = i
        elif not is_open and open_start is not None:
            windows.append((open_start, i - 1))
            open_start = None
    if open_start is not None:
        windows.append((open_start, len(shutter_flags) - 1))
    out = []
    for i0, i1 in windows:
        out.append({
            "i0": i0, "i1": i1,
            "start_s": time_s[i0], "end_s": time_s[i1],
            "duration_s": time_s[i1] - time_s[i0],
        })
    return out


def _active_source(rows, i0, i1):
    """
    Identify the source depositing during [i0,i1]: prefer a source whose shutter is
    open, else Active, else Switch-RF-PWS1. Returns {num,material,target} or None.
    """
    def col(n, suffix):
        return f"PC Source {n} {suffix}"

    def frac_true(n, suffix):
        key = col(n, suffix)
        if key not in rows[0]:
            return 0.0
        hits = sum(1 for i in range(i0, i1 + 1) if (rows[i].get(key, "") or "").strip() == "1")
        return hits / max(1, (i1 - i0 + 1))

    best = None
    for n in SOURCE_NUMS:
        score = max(frac_true(n, "Shutter Open"),
                    frac_true(n, "Active"),
                    frac_true(n, "Switch-RF-PWS1"))
        if score > 0 and (best is None or score > best[0]):
            best = (score, n)
    if not best:
        return None
    n = best[1]
    mid = (i0 + i1) // 2
    return {
        "num": n,
        "material": (rows[mid].get(col(n, "Material"), "") or "").strip() or None,
        "target": (rows[mid].get(col(n, "Loaded Target"), "") or "").strip() or None,
    }


def parse_sputter_log(text):
    """
    Parse one deposition-log CSV. Returns a structured dict (see module docstring),
    or None if the file doesn't look like a recording.
    """
    meta_raw, header, rows = _read_rows(text)
    if not rows:
        return None

    # Absolute timestamps → seconds from log start.
    ts = [_parse_ts(r.get(TIMESTAMP_COL, "")) for r in rows]
    t0 = next((t for t in ts if t is not None), None)
    if t0 is None:
        return None
    time_s = [(t - t0).total_seconds() if t is not None else None for t in ts]
    # Forward-fill any unparseable timestamps so the axis stays monotonic.
    last = 0.0
    for i, v in enumerate(time_s):
        if v is None:
            time_s[i] = last
        else:
            last = v

    # Extract curated channels.
    channels = {}
    for key, col in CHANNELS.items():
        if col in header:
            channels[key] = [_to_float(r.get(col, "")) for r in rows]

    # Derived channels.
    derived = {}
    if "flow_ar" in channels and "flow_o2" in channels:
        o2f = []
        for a, o in zip(channels["flow_ar"], channels["flow_o2"]):
            # Flows can read slightly negative at zero; clamp before ratio.
            a = max(0.0, a) if a is not None else 0.0
            o = max(0.0, o) if o is not None else 0.0
            tot = a + o
            o2f.append(o / tot if tot > 1e-6 else None)
        derived["o2_fraction"] = o2f
    if "ps1_fwd" in channels and "ps1_rfl" in channels:
        derived["ps1_net"] = [
            (f - r) if (f is not None and r is not None) else None
            for f, r in zip(channels["ps1_fwd"], channels["ps1_rfl"])
        ]
        derived["ps1_rfl_pct"] = [
            (100.0 * r / f) if (f and r is not None and f > 1e-6) else None
            for f, r in zip(channels["ps1_fwd"], channels["ps1_rfl"])
        ]
    if "temp_pyro1" in channels and "temp_pyro2" in channels:
        derived["pyro_delta"] = [
            (b - a) if (a is not None and b is not None) else None
            for a, b in zip(channels["temp_pyro1"], channels["temp_pyro2"])
        ]

    # Deposition window(s) from substrate shutter.
    shutter = [1 if (r.get(SHUTTER_COL, "") or "").strip() == "1" else 0 for r in rows] \
        if SHUTTER_COL in header else [0] * len(rows)
    windows = _find_windows(shutter, time_s)

    # Attach active source + per-channel window stats to each window.
    for w in windows:
        i0, i1 = w["i0"], w["i1"]
        w["source"] = _active_source(rows, i0, i1)
        wstats = {}
        for key, series in {**channels, **derived}.items():
            st = _stats(series[i0:i1 + 1])
            if st is not None:
                wstats[key] = st
        w["stats"] = wstats

    # Sources present in the file (from first row) — for labeling.
    sources = {}
    for n in SOURCE_NUMS:
        mat = (rows[0].get(f"PC Source {n} Material", "") or "").strip()
        tgt = (rows[0].get(f"PC Source {n} Loaded Target", "") or "").strip()
        if mat or tgt:
            sources[str(n)] = {"material": mat or None, "target": tgt or None}

    return {
        "meta": {
            "recording_name": meta_raw.get("Recording Name"),
            "user": meta_raw.get("User"),
            "t_start": t0.isoformat(),
            "duration_s": time_s[-1] if time_s else 0.0,
            "n_rows": len(rows),
            "sources": sources,
            "has_deposition": bool(windows),
        },
        "time_s": time_s,
        "channels": channels,
        "derived": derived,
        "shutter": shutter,
        "deposition_windows": windows,
    }


if __name__ == "__main__":
    import sys, json
    path = sys.argv[1]
    with open(path, encoding="utf-8-sig") as f:
        result = parse_sputter_log(f.read())
    if result is None:
        print("Not a recognizable sputter log.")
        sys.exit(1)
    m = result["meta"]
    print(f"Recording: {m['recording_name']}  user={m['user']}")
    print(f"Start: {m['t_start']}  duration: {m['duration_s']:.0f}s  rows: {m['n_rows']}")
    print(f"Sources: {m['sources']}")
    print(f"Channels extracted: {sorted(result['channels'])}")
    print(f"Derived: {sorted(result['derived'])}")
    print(f"Deposition windows: {len(result['deposition_windows'])}")
    for w in result["deposition_windows"]:
        print(f"  {w['start_s']:.0f}-{w['end_s']:.0f}s ({w['duration_s']:.0f}s)  source={w.get('source')}")
        for k, st in sorted(w["stats"].items()):
            print(f"    {k:18s} mean={st['mean']:.4g} std={st['std']:.3g}")
