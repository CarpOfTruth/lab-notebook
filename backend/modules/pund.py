"""
PUND Module
===========
Parses the PUND suite's ``metadata.csv`` sweep index (format ``pund-csv/1``) and
plots switched polarization ΔP against whichever stimulus the run swept.

One ``metadata.csv`` = one full sweep (one row per measured condition). It already
contains every scalar needed for the canonical plot and for kinetics — the raw
transient CSVs it points at are only for waveform QC and are NOT ingested here (v1
is metadata-only).

Parsing
-------
1. Decode UTF-8, read as CSV (row 1 = header, produced by ``to_csv(index=False)``).
2. Confirm it is a PUND metadata file (``dP_pos_uCcm2`` + ``run_uid`` present).
3. Auto-detect the swept stimulus column — the stimulus with the most distinct
   values (A1→bias, A2→voltage, A3→pulse width, A4→delay). Width/delay sweeps get
   a log x-axis (per the spec's canonical rendering).
4. Sort by the swept value; pull ΔP⁺/ΔP⁻ and their across-rep std.

plot()
------
Switched ΔP vs swept variable: ΔP⁺ as circles, ΔP⁻ as squares (only when a
negative branch exists), across-rep error bars from ``dP_*_std``. y-axis anchored
to zero; x-axis log for width/delay sweeps.
"""

import csv
import io
import math
from .base import LabModule

# (column, axis label, unit, log-x?) — priority order for tie-breaking.
_SWEPT_CANDIDATES = [
    ("pulse_width_ns", "Pulse width", "ns", True),
    ("delay_time_ns",  "Inter-pulse delay", "ns", True),
    ("voltage_mV",     "Pulse amplitude", "mV", False),
    ("bias_mV",        "DC bias", "mV", False),
]

_NEG_COLOR = "#63b3ed"   # ΔP⁻ (blue); ΔP⁺ uses the caller-supplied colour

# Swept column → (stage id, label). The stage is identified by which parameter the
# run swept, NOT by filename (all are "metadata.csv") or runID (varies, e.g.
# "A4_delay_388mV"). Used to route each dropped file to the right stage card.
STAGE_BY_SWEPT = {
    "bias_mV":        ("a1", "A1 Imprint"),
    "voltage_mV":     ("a2", "A2 Voltage"),
    "pulse_width_ns": ("a3", "A3 Speed"),
    "delay_time_ns":  ("a4", "A4 Delay"),
}


def _to_float(v):
    """Parse a cell to float; blank / NaN / non-numeric → None."""
    if v is None:
        return None
    s = str(v).strip()
    if not s or s.lower() == "nan":
        return None
    try:
        f = float(s)
        return None if math.isnan(f) else f
    except ValueError:
        return None


class PUNDModule(LabModule):
    id          = "pund"
    name        = "PUND"
    description = "Switched polarization ΔP vs swept pulse parameter (PUND sweep index)"
    accepts     = [".csv"]
    version     = "1.0"
    author      = "built-in"

    # ── Parsing ────────────────────────────────────────────────────────────────

    def parse(self, file_bytes: bytes, filename: str, meta: dict) -> dict:
        try:
            text = file_bytes.decode("utf-8-sig", errors="replace")
        except Exception:
            return None

        reader = csv.DictReader(io.StringIO(text))
        cols = reader.fieldnames or []
        # Only claim genuine PUND metadata indices.
        if "dP_pos_uCcm2" not in cols or not ("run_uid" in cols or "measurement_type" in cols):
            return None
        rows = list(reader)
        if not rows:
            return None

        # Swept column = the stimulus with the most distinct finite values.
        best = None  # (distinct_count, index_in_priority, key, label, unit, logx)
        for pri, (key, label, unit, logx) in enumerate(_SWEPT_CANDIDATES):
            if key not in cols:
                continue
            distinct = len({_to_float(r.get(key)) for r in rows if _to_float(r.get(key)) is not None})
            cand = (distinct, -pri, key, label, unit, logx)
            if best is None or cand > best:
                best = cand
        if best is None:
            return None
        _, _, swept_key, swept_label, swept_unit, log_x = best

        # Build sorted per-condition arrays.
        recs = []
        for r in rows:
            x = _to_float(r.get(swept_key))
            if x is None:
                continue
            recs.append({
                "x":        x,
                "dP_pos":   _to_float(r.get("dP_pos_uCcm2")),
                "dP_neg":   _to_float(r.get("dP_neg_uCcm2")),
                "dP_pos_std": _to_float(r.get("dP_pos_std")),
                "dP_neg_std": _to_float(r.get("dP_neg_std")),
                "n_dropped": _to_float(r.get("n_dropped")),
            })
        recs.sort(key=lambda d: d["x"])
        if not recs:
            return None

        has_pos = any(d["dP_pos"] is not None for d in recs)
        has_neg = any(d["dP_neg"] is not None for d in recs)

        # Fixed (non-swept) stimulus values, for a subtitle.
        first = rows[0]
        fixed = []
        for key, label, unit, _ in _SWEPT_CANDIDATES:
            if key == swept_key or key not in cols:
                continue
            v = _to_float(first.get(key))
            if v is not None:
                fixed.append(f"{label} {v:g} {unit}")

        return {
            "swept_key":   swept_key,
            "swept_label": swept_label,
            "swept_unit":  swept_unit,
            "log_x":       log_x,
            "has_pos":     has_pos,
            "has_neg":     has_neg,
            "x":           [d["x"] for d in recs],
            "dP_pos":      [d["dP_pos"] for d in recs],
            "dP_neg":      [d["dP_neg"] for d in recs],
            "dP_pos_std":  [d["dP_pos_std"] for d in recs],
            "dP_neg_std":  [d["dP_neg_std"] for d in recs],
            "n_conditions": len(recs),
            "context": {
                "sampleID":      first.get("sampleID"),
                "deviceID":      first.get("deviceID"),
                "runID":         first.get("runID"),
                "run_uid":       first.get("run_uid"),
                "measurement_type": first.get("measurement_type"),
                "area_um2":      _to_float(first.get("area_um2")),
                "temperature_K": _to_float(first.get("temperature_K")),
                "fixed":         fixed,
            },
        }

    # ── Plotting ───────────────────────────────────────────────────────────────

    def plot(self, data: dict, meta: dict, options: dict) -> dict:
        pos_color = options.get("color", "#f6ad55")
        x = data.get("x", [])
        unit = data.get("swept_unit", "")
        y_unit = "µC/cm²"

        # Branch selection: "pos" | "neg" | "both". Default to whatever exists
        # (both branches if both were measured, else the single present one).
        has_pos, has_neg = data.get("has_pos", True), data.get("has_neg", False)
        branch = options.get("branch") or ("both" if (has_pos and has_neg) else ("neg" if has_neg else "pos"))
        show_pos = has_pos and branch in ("pos", "both")
        show_neg = has_neg and branch in ("neg", "both")

        def err(stds):
            # Missing std → 0 (no visible bar); keeps array length aligned.
            return [s if s is not None else 0 for s in stds]

        traces = []
        if show_pos:
            traces.append({
                "x": x,
                "y": data.get("dP_pos", []),
                "type": "scatter",
                "mode": "lines+markers",
                "name": "ΔP⁺",
                "marker": {"color": pos_color, "size": 8, "symbol": "circle"},
                "line": {"color": pos_color, "width": 1.5},
                "error_y": {"type": "data", "array": err(data.get("dP_pos_std", [])), "visible": True,
                            "thickness": 1.2, "width": 4, "color": pos_color},
                "hovertemplate": f"%{{x:g}} {unit}<br>ΔP⁺ %{{y:.3g}} {y_unit}<extra></extra>",
            })
        if show_neg:
            traces.append({
                "x": x,
                "y": data.get("dP_neg", []),
                "type": "scatter",
                "mode": "lines+markers",
                "name": "ΔP⁻",
                "marker": {"color": _NEG_COLOR, "size": 8, "symbol": "square"},
                "line": {"color": _NEG_COLOR, "width": 1.5},
                "error_y": {"type": "data", "array": err(data.get("dP_neg_std", [])), "visible": True,
                            "thickness": 1.2, "width": 4, "color": _NEG_COLOR},
                "hovertemplate": f"%{{x:g}} {unit}<br>ΔP⁻ %{{y:.3g}} {y_unit}<extra></extra>",
            })

        x_axis = {
            "title": f"{data.get('swept_label', 'Swept variable')} ({unit})",
            "zeroline": False,
        }
        if data.get("log_x"):
            x_axis["type"] = "log"

        layout = {
            "xaxis": x_axis,
            "yaxis": {"title": f"Switched ΔP ({y_unit})", "rangemode": "tozero", "zeroline": True, "zerolinewidth": 1},
            "margin": {"t": 20, "r": 20, "b": 50, "l": 62},
            "showlegend": show_pos and show_neg,
            "legend": {"x": 0.02, "y": 0.98},
            "hovermode": "closest",
        }
        return {"data": traces, "layout": layout}
