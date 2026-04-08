"""
P-E Loop Module
===============
Parses polarization–electric-field (hysteresis) loop data from tabular text
files exported by Radiant, aixACCT, and generic CSV instruments.

Parsing steps
-------------
1. Strip comment lines (# ; !).
2. Detect the voltage and polarization columns by searching header lines for
   the words "voltage" and "polariz".  Falls back to columns 0 and 1.
3. Convert voltage → electric field (kV/cm) if the raw values look like
   volts (|max| < 50) and a film thickness is available.
4. Convert polarization → µC/cm² if the raw values look like C/m²
   (|max| < 1e-3).
5. Extract electrode area from file headers when present (supports cm²,
   µm², and bare m²).
6. Return a structured dict ready for plot().

plot() output
-------------
Returns a Plotly figure dict with:
  - Full loop trace (faint, for reference)
  - Second loop trace (cleaner, used for Pr/Ec extraction)
  x-axis: electric field (kV/cm)  or  voltage (V) if no thickness
  y-axis: polarization (µC/cm²)
"""

import re
from .base import LabModule


class PEModule(LabModule):
    id          = "pe"
    name        = "P-E Loop"
    description = "Ferroelectric polarization–electric-field hysteresis loops"
    accepts     = [".csv", ".dat", ".txt", ".pe"]
    version     = "1.0"
    author      = "built-in"

    # ── Parsing ────────────────────────────────────────────────────────────────

    def parse(self, file_bytes: bytes, filename: str, meta: dict) -> dict:
        try:
            text = file_bytes.decode("utf-8", errors="replace")
        except Exception:
            return None

        thickness_nm = meta.get("thickness_nm") or 0.0
        rows         = _parse_csv(text)
        if not rows:
            return None

        v_col, p_col = _find_pe_cols(text)
        xs = [r[v_col] if v_col < len(r) else r[0] for r in rows]
        ys = [r[p_col] if p_col < len(r) else r[1] for r in rows]

        # Voltage → kV/cm when thickness is known
        x_unit = "V"
        max_abs_x = max(abs(v) for v in xs) if xs else 0
        if max_abs_x < 50 and thickness_nm > 0:
            thickness_cm = thickness_nm * 1e-7   # nm → cm
            xs = [v / thickness_cm / 1e3 for v in xs]   # V/cm → kV/cm
            x_unit = "kV/cm"

        # C/m² → µC/cm²  (1 C/m² = 100 µC/cm²)
        y_unit = "µC/cm²"
        max_abs_y = max(abs(p) for p in ys) if ys else 0
        if max_abs_y > 0 and max_abs_y < 1e-3:
            ys = [p * 100 for p in ys]

        # Electrode area from file header
        area_m2 = _find_area(text)

        # Split into first / second loop for display
        points   = [{"x": xs[i], "y": ys[i]} for i in range(len(xs))]
        first, second = _split_loops(points)

        return {
            "points":  points,
            "first":   first,
            "second":  second,
            "x_unit":  x_unit,
            "y_unit":  y_unit,
            "area_m2": area_m2,
        }

    # ── Plotting ───────────────────────────────────────────────────────────────

    def plot(self, data: dict, meta: dict, options: dict) -> dict:
        loop    = options.get("loop", "second")   # "all" | "second"
        color   = options.get("color", "#e2e8f0")
        area_m2 = meta.get("area_m2") or data.get("area_m2")

        points = data.get("points", [])
        second = data.get("second", [])
        x_unit = data.get("x_unit", "kV/cm")
        y_unit = data.get("y_unit", "µC/cm²")

        traces = []

        if loop == "all" and points:
            traces.append({
                "x":    [p["x"] for p in points],
                "y":    [p["y"] for p in points],
                "type": "scatter",
                "mode": "lines",
                "line": {"color": color, "width": 1.5},
                "name": "Full loop",
                "hovertemplate": f"%{{x:.2f}} {x_unit}<br>%{{y:.2f}} {y_unit}<extra></extra>",
            })
        elif second:
            traces.append({
                "x":    [p["x"] for p in second],
                "y":    [p["y"] for p in second],
                "type": "scatter",
                "mode": "lines",
                "line": {"color": color, "width": 1.5},
                "name": "2nd loop",
                "hovertemplate": f"%{{x:.2f}} {x_unit}<br>%{{y:.2f}} {y_unit}<extra></extra>",
            })

        x_label = f"Electric Field ({x_unit})" if x_unit == "kV/cm" else f"Voltage ({x_unit})"
        y_label = f"Polarization ({y_unit})"

        layout = {
            "xaxis": {"title": x_label, "zeroline": True, "zerolinewidth": 1},
            "yaxis": {"title": y_label, "zeroline": True, "zerolinewidth": 1},
            "margin": {"t": 20, "r": 20, "b": 50, "l": 60},
            "showlegend": False,
            "hovermode": "closest",
        }

        return {"data": traces, "layout": layout}


# ── Private helpers ────────────────────────────────────────────────────────────

def _parse_csv(text: str) -> list[list[float]]:
    """Strip comments, split on comma/semicolon/tab/whitespace, return numeric rows."""
    rows = []
    for line in text.splitlines():
        t = line.strip()
        if not t or t[0] in ("#", ";", "!"):
            continue
        # Try delimited first, then whitespace
        cols = re.split(r"[,;\t]", t)
        if len(cols) < 2:
            cols = t.split()
        cells = [c.strip().strip('"\'') for c in cols]
        try:
            nums = [float(c) for c in cells]
            if len(nums) >= 2:
                rows.append(nums)
        except ValueError:
            continue   # header / label line
    return rows


def _find_pe_cols(text: str) -> tuple[int, int]:
    """Scan header lines for 'voltage' and 'polariz' column names."""
    for line in text.splitlines():
        raw = re.split(r"[,;\t]", line.strip())
        cols = [c.strip().strip('"\'').lower() for c in raw]
        has_volt = any("voltage" in c for c in cols)
        has_pol  = any("polariz" in c for c in cols)
        if has_volt and has_pol:
            v_col = next((i for i, c in enumerate(cols) if "voltage" in c and "ref" not in c), 0)
            p_col = next((i for i, c in enumerate(cols) if "polariz" in c and "ref" not in c), 1)
            return v_col, p_col
    return 0, 1


def _find_area(text: str):
    """
    Search file header lines for an electrode area value.
    Recognises cm², µm², and bare m² with various spellings.
    Returns area in m², or None if not found.
    """
    number_re = re.compile(r"[\d]*\.[\d]+(?:[eE][+-]?\d+)?|[\d]+[eE][+-]?\d+")
    for line in text.splitlines():
        lo = line.lower()
        if "area" not in lo:
            continue
        matches = number_re.findall(line)
        if not matches:
            continue
        val = float(matches[-1])
        if not (0 < val < float("inf")):
            continue
        if any(u in lo for u in ("sq. cm", "sq.cm", "cm^2", "cm2", "cm²")):
            return val * 1e-4
        if any(u in lo for u in ("um^2", "µm^2", "μm^2", "um2", "µm2")):
            return val * 1e-12
        if re.search(r"\bm\^?2\b", lo) and "cm" not in lo:
            return val
        # Bare number with no unit: heuristic range
        if 1e-9 <= val <= 0.1:
            return val * 1e-4   # assume cm²
    return None


def _split_loops(points):
    """
    Split a double-bipolar sweep into first and second loops.
    Finds the midpoint closest to the starting voltage to handle biased sweeps.
    """
    n = len(points)
    if n < 4:
        return points, points
    start_x  = points[0]["x"]
    mid      = n // 2
    window   = max(1, int(n * 0.15))
    best_idx = mid
    best_d   = float("inf")
    for i in range(max(1, mid - window), min(n - 1, mid + window + 1)):
        d = abs(points[i]["x"] - start_x)
        if d < best_d:
            best_d   = d
            best_idx = i
    return points[:best_idx], points[best_idx:]
