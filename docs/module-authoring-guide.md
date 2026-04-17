# LabLog Module Authoring Guide

## What a module is

A module teaches LabLog how to process a specific type of measurement file. Once written, it appears as a card on every sample page, accepts file uploads of the types you specify, runs your processing code, and produces a plot. If the module includes analysis code, it also contributes computed values (coercive field, resistance, peak position, etc.) to analysis books.

You need to write a module when:
- You have a new instrument or file format not covered by any existing module.
- You want custom processing logic for an existing format (different normalization, unit conversions, derived quantities).
- You want to expose new scalar values for cross-sample analysis.

---

## Creating a new module

Navigate to the **Modules** section from the main LabLog page. Click **New Module**. This opens the module editor with empty fields and scaffolded code blocks.

Give the module a unique internal ID (snake_case, e.g. `iv_curve` or `xrd_scan`). This ID is used internally and in file storage — it cannot be changed after samples have data associated with it.

---

## The Identity block

The Identity block defines the module's schema — what it is and what it accepts.

| Field | What it does |
|---|---|
| **Name** | Display name shown on module cards and in the Modules browser. |
| **Version** | Freeform string, e.g. `"1.0"`. Increment when you change the processing logic in ways that would affect stored results. |
| **Description** | One-line description shown on the module card. |
| **Author** | Your name or lab. |
| **Accepts** | Comma-separated file extensions: `csv, dat, txt`. Determines which uploaded files are accepted by this module. |
| **Section** | Groups the module on the sample page (e.g. `Electrical`, `Structural`, `Optical`). Case-insensitive. |
| **Category** | Optional sub-grouping within a section. |
| **Folder** | Assigns the module to a folder in the Modules browser. |

The `accepts` list controls which files users can upload to this module's card. If a user tries to upload a `.xls` file to a module that only accepts `csv`, the upload is rejected. Be permissive here if your format has multiple common extensions.

---

## Uploading example data

Before writing any code, upload a representative data file using the **Example data** field. This file is used by the **Run / Preview** button throughout development. Without it, you cannot test your code in the editor.

Pick a real file from your instrument — not a hand-crafted minimal file. The more representative it is, the more confidently you can test edge cases.

---

## The three-block editor

Both `proc_code` and `analysis_code` are split into three blocks (A, B, C). Understanding the role of each block prevents a lot of confusion.

### Block A — Auto-generated preamble (locked)

Block A is generated automatically from the Identity block. You cannot edit it. It reads your example file and exposes its columns as Python variables, parses header metadata, and injects card control values.

Block A regenerates whenever you change the file type, delimiter, column mappings, or card controls in the schema. If you change the schema and your Block B code suddenly has undefined names, check Block A — the variable names may have changed.

**Never paste anything into Block A.** It will be overwritten.

### Block B — Your processing logic

This is where you write code. You receive the variables from Block A and produce whatever intermediate values you need. All the variables Block A declares are in scope here — column arrays, header metadata, `meta`, and any card control values.

### Block C — The return block

Block C contains the `return` statement. Click **Reset scaffold** to restore a clean template. You populate it with the keys your module produces. See the contracts below for what is required and what is optional.

The split between Block B and Block C is a matter of convention — you could put the return statement directly in Block B if you prefer, and leave Block C empty. But keeping them separate makes it easier to see at a glance what your module exposes.

---

## What proc_code receives

When LabLog runs `proc_code`, it wraps your code (Block A + B + C concatenated) in a function with this signature:

```python
def _proc(file_bytes, filename, meta):
    # your code runs here
```

### From Block A

Block A parses the file and declares variables. For a CSV file with columns `voltage` and `current`, Block A might produce:

```python
voltage = [r[0] for r in _rows]   # list of floats
current = [r[1] for r in _rows]   # list of floats
```

The exact names depend on your column mappings in the schema. For header metadata (key-value pairs in the file header), Block A declares separate variables by their assigned names.

### The meta dict

`meta` is passed in from the sample record and the active card controls:

```python
meta = {
    "thickness_nm":    float | None,   # film thickness from the sample record
    "area_m2":         float | None,   # electrode area from the sample record
    "area_correction": float,          # multiplier from the area card control (default 1.0)
    # any additional fields from the sample record
}
```

Access it in Block B with `meta.get("thickness_nm")` etc.

### Card control values

If you define card controls in the schema (toggle or area), their current values are injected into Block A as variables and available in Block B.

A **toggle** control lets users switch between named modes (e.g. "linear" vs "log", "raw" vs "normalized"). Its current value is a string matching one of the defined choices. In `proc_code`, you can branch on it or use it to select which data to return:

```python
# if you defined a toggle named "scale" with choices ["raw", "normalized"]
if scale == "normalized":
    ys = [v / max(ys) for v in ys]
```

An **area** control provides a correction factor. Its value flows in through `meta["area_correction"]` (a float, default 1.0). Apply it to normalize by area.

---

## What proc_code must return

`proc_code` must return a dict. At minimum:

```python
return {
    "x": x_array,   # list or numpy array of floats
    "y": y_array,   # list or numpy array of floats
}
```

The `x` and `y` keys are what the card plots by default. If you define a toggle that switches the plot between two data series, you expose multiple named arrays and map them in the card controls config:

```python
return {
    "x":     e_field,        # electric field (kV/cm)
    "y":     polarization,   # second loop
    "x_all": e_field_full,   # full loop
    "y_all": pol_full,
}
```

### Optional return keys

| Key | Effect |
|---|---|
| `x_label` | Axis label for x (overrides the plot config default). |
| `y_label` | Axis label for y. |
| `x_fit` | A second x array. If present and **Show fit** is enabled on the card, overlaid on the plot as a dashed fit curve. |
| `y_fit` | Paired y array for the fit curve. |
| `area_m2` | If returned, overrides the device area from the card control for this measurement. Useful when the area is encoded in the data file itself. |
| Any other key | Available to `analysis_code` via the `result` dict, and (in future) to derived modules. |

All values in the returned dict must be JSON-serializable — use plain Python lists, not numpy arrays, unless LabLog converts them automatically. When in doubt, wrap with `list(array)`.

---

## Testing with Run / Preview

Click **Run / Preview** to execute `proc_code` against the example file and display the result. The preview shows:

- The plot rendered from the returned `x` and `y` arrays.
- The full returned dict, so you can inspect all keys.
- Any Python exception with a traceback if execution fails.

Iterate here before saving. Common things to check:

- The plot looks right (correct units, reasonable scale).
- `x_label` and `y_label` are populated.
- Any optional keys you intend to expose (fit curves, area, intermediate values) are present.
- The return dict contains no numpy dtypes — convert arrays to lists if you see serialization errors.

---

## analysis_code — purpose, inputs, outputs

`analysis_code` runs in the context of an **analysis book**: a collection of samples that share a module. It receives the `result` dict returned by `proc_code` for a single sample and must return a dict of scalar metrics.

The signature LabLog wraps your code in:

```python
def _analysis(result):
    # your code runs here
```

`result` is the complete dict your `proc_code` returned. All keys are available.

### What to return

Return scalar values (floats, ints, or `None`). Each key becomes a plottable axis in the analysis book panel:

```python
return {
    "r_series":     r_series,      # series resistance in Ω
    "r_shunt":      r_shunt,       # shunt resistance in Ω
    "ideality":     n,             # diode ideality factor
    "v_oc":         v_oc,          # open-circuit voltage in V
}
```

Any key in the return dict that you also declare in `analysis_metrics` in the schema (with `name`, `label`, `unit`) will appear with a proper label and units in the analysis panel. Keys without a metric declaration still appear but with raw names.

`analysis_code` is optional. If you don't write it, the module works fine for single-sample plotting — it just won't contribute values to analysis books.

---

## Saving, exporting, and sharing

**Save** commits the module to your local LabLog instance. It becomes available immediately on sample pages.

**Export** packages the module as a `.labmodule.zip` file containing:
- The schema (JSON)
- Your Block B and Block C source for both `proc_code` and `analysis_code`
- The example data file

Send this file to a collaborator. They import it from their own Modules section. The module ID must not conflict with an existing module on their instance — if it does, they can rename it during import.

---

## Worked example: I-V curve module

This walks through writing a module for a simple current-voltage sweep from a two-column CSV file:

```
# I-V measurement
Voltage (V),Current (A)
-1.0,-8.2e-6
-0.9,-4.1e-6
...
1.0,2.3e-3
```

### Identity block

- **Name:** I-V Curve
- **Accepts:** csv, txt
- **Section:** Electrical
- **Category:** DC Transport

### Block A (generated)

After configuring the schema — tab delimiter, skip 1 header row, column 0 = `voltage_v`, column 1 = `current_a` — Block A generates something like:

```python
DELIMITER = ","
SKIP_ROWS = 1

_text = file_bytes.decode("utf-8", errors="replace")
_rows = []
for _line in _text.splitlines()[SKIP_ROWS:]:
    _cells = _line.strip().split(DELIMITER)
    try:
        _rows.append([float(c) for c in _cells])
    except ValueError:
        continue

voltage_v = [r[0] for r in _rows]
current_a = [r[1] for r in _rows]
```

You do not write this. You configure it in the schema and it appears locked in Block A.

### Block B — processing logic

```python
import numpy as np

area_cm2 = meta.get("area_m2", None)
if area_cm2 is not None:
    area_cm2 = area_cm2 * 1e4   # m² → cm²

# Current density if area is known, otherwise raw current
if area_cm2 and area_cm2 > 0:
    j = [i / area_cm2 for i in current_a]
    y_label = "Current Density (A/cm²)"
else:
    j = list(current_a)
    y_label = "Current (A)"

# Log-scale absolute values for Fowler-Nordheim or diode analysis
j_abs = [abs(v) for v in j]

# Simple series resistance estimate from slope near V=0
# Find points closest to zero voltage
mid = sorted(range(len(voltage_v)), key=lambda i: abs(voltage_v[i]))[:10]
dv = [voltage_v[i] for i in mid]
di = [j[i] for i in mid]
if len(dv) > 1 and (max(dv) - min(dv)) > 0:
    # linear fit: dV/dI
    slope = (max(dv) - min(dv)) / (max(di) - min(di)) if (max(di) - min(di)) != 0 else None
else:
    slope = None
```

### Block C — return

```python
return {
    "x":       list(voltage_v),
    "y":       j,
    "y_abs":   j_abs,
    "x_label": "Voltage (V)",
    "y_label": y_label,
    "r_series": slope,   # rough Ω·cm² if area-normalized, Ω otherwise
}
```

### analysis_code Block B

```python
x = result["x"]
y = result["y"]

# Find open-circuit voltage (where current changes sign)
v_oc = None
for i in range(len(x) - 1):
    if y[i] * y[i+1] <= 0 and x[i+1] != x[i]:
        t = -y[i] / (y[i+1] - y[i])
        v_oc = x[i] + t * (x[i+1] - x[i])
        break

r_series = result.get("r_series")
```

### analysis_code Block C

```python
return {
    "v_oc":     v_oc,
    "r_series": r_series,
}
```

---

## Common mistakes and gotchas

**Returning numpy types.** If your Block B uses numpy, the return dict may contain `numpy.float64` or `numpy.ndarray` objects. LabLog tries to convert these, but if you see a serialization error, add `list(array)` or `float(value)` around the problematic values in Block C.

**Forgetting that Block A regenerates.** If you change the column assignments or file type in the schema, Block A is rewritten. Variable names you relied on in Block B may change. Always check Block A after a schema change.

**Assuming area is always set.** `meta["area_m2"]` is `None` if the user hasn't set it on the sample record. Guard against it: `area = meta.get("area_m2") or 1.0`.

**Returning arrays of different lengths.** `x` and `y` must have the same length. Mismatched lengths will produce a broken plot. If you derive `x_fit`/`y_fit`, they can have a different length from `x`/`y` — the fit is plotted as a separate trace.

**Mutable defaults in analysis_code.** `analysis_code` runs once per sample in the book. It receives a fresh `result` dict each time. Don't try to accumulate state across calls — `analysis_code` is not designed for that.

**Empty file.** If the example file has no numeric rows (e.g. all comment lines, wrong delimiter), Block A will produce empty lists. Your Block B code should handle empty input without crashing, or at minimum return a clear error. A `try/except` around the whole Block B with a `return {"x": [], "y": [], "error": str(e)}` is reasonable for robustness.

**Module ID conflicts on import.** If you share a `.labmodule.zip` and the recipient already has a module with the same ID, the import may overwrite or be rejected depending on the version. Use a distinctive ID (e.g. `smith_lab_iv_curve` rather than `iv`) if your module is intended for wide distribution.

**Area correction double-application.** If your data file contains an area value and you return it as `area_m2`, LabLog uses that to display the area on the card. If you also manually divide by area in Block B, and the user additionally sets an area correction in the card control, the correction may be applied twice. Either extract area from the file and return it as `area_m2` (letting LabLog handle the correction), or apply `meta["area_correction"]` yourself but don't also return `area_m2`.
