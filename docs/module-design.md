# LabLog Module System — Design Document

*Last updated: 2026-04-09 (session 2)*

---

## Philosophy

A module is a self-contained unit that knows how to ingest one or more raw instrument files
for a given measurement technique, transform the data into a normalized output, and expose
that output to the rest of the application for plotting, analysis, and cross-sample comparison.

Modules are the extension point for the system. Built-in measurement types (PE, XRD, XRR,
dielectric) will eventually be reimplemented as modules. User-created modules follow exactly
the same interface.

**Core principle**: the module's job is transformation and normalization. It does not need to
know about the UI, the database, or other modules. It receives raw bytes and metadata; it
returns a structured dict.

---

## Module Types

### 1. Data Module (primary type — implemented)

Ingests raw instrument file(s), transforms them, and returns plottable data plus optional
analysis metrics.

**Source**: one or more uploaded files per sample, organized into named slots.

**Examples**: P-E hysteresis, XRD ω–2θ, XRR reflectivity, CV (up + down sweep files),
C-f single file, switching current collection.

### 2. Analysis Module (planned)

Operates on the output of one or more data modules rather than raw files. No file upload
on the sample page — runs automatically when its source module(s) have data.

**Source**: `source_module_id` pointing to another module's proc_code output.

**Examples**: XRR thickness/density fitter, XRD peak fitter, Merz fit on switching data.

*Design detail deferred — document separately when implemented.*

---

## File Slots (Data Modules)

Each module declares one or more named file slots in the Data section. All modules use the
slot interface, even single-file ones (just one slot).

```json
"file_slots": [
  { "key": "up_sweep",   "label": "↑ Up sweep"   },
  { "key": "down_sweep", "label": "↓ Down sweep" }
]
```

proc_code always receives a `files` dict:

```python
def _proc(files, meta):
    # files = {"up_sweep": {"bytes": b"...", "filename": "..."}, ...}
    up = files["up_sweep"]["bytes"].decode("utf-8")
    down = files["down_sweep"]["bytes"].decode("utf-8")
    ...
```

For single-slot modules, `file_bytes` and `filename` are also provided as convenience
aliases (backwards compatibility with the current PE module).

### Card UI scaling

- **1–2 slots**: individual drop zones shown side by side on the card (like the current
  diel_b up/down).
- **3+ slots**: a slot management drawer opens from the card header.

The plot renders only when all required slots have files. Optional slots (declared with
`"required": false`) do not block rendering.

### File storage

Files are stored at: `data/files/{sample_id}/{module_id}/{slot_key}/{filename}`

This replaces the flat `data/files/{sample_id}/{filename}` structure. Benefits: no
filename collisions between modules, clear organization, slot identity is recoverable
from path without the DB.

The `filenames` column in the `samples` table stores:
```json
{
  "module_id": {
    "slot_key": "original_filename.csv"
  }
}
```

*Migration needed for existing samples that use the flat structure.*

---

## proc_code Contract

proc_code is a Python function body executed as:

```python
def _proc(files, meta):
    # user code here
    return { ... }
```

### `meta` keys available

The full sample record is passed. Modules declare which keys they use in `meta_fields`
(drives UX warnings, not enforcement):

```python
meta = {
    "thickness_nm":    float | None,
    "area_m2":         float | None,
    "area_correction": float,          # from card input, default 1.0
    "technique":       str,
    # ... all other sample record fields
}
```

`meta_fields` declaration in schema (optional, for UX):
```json
"meta_fields": ["thickness_nm", "area_m2"]
```

When a declared meta field is null/missing on a sample, the card shows a warning:
"This module uses thickness — not set for this sample."

### Return dict — required keys

```python
{
    "x":  [float, ...],   # primary x-axis data
    "y":  [float, ...],   # primary y-axis data
}
```

A module that returns no `x`/`y` renders an error on the card.

### Return dict — optional / conventional keys

```python
{
    # Axis labels — inferred from module name/units if omitted.
    # Plotly panels support MathJax LaTeX via $...$ syntax.
    # recharts cards render plain text (Unicode subscripts/superscripts work: µ, ε, Ω).
    "x_label": str,
    "y_label": str,

    # Plot type — tells the renderer which visualization to use.
    # Default: "line". See Plot Types section below.
    "plot_type": "line" | "heatmap" | "scatter2d",

    # Fit overlay — rendered as a second trace on the card and comparison panel
    # (dashed, same color at reduced opacity — style TBD).
    "x_fit":   [float, ...],
    "y_fit":   [float, ...],

    # Additional named trace sets for multi-trace data (e.g., CV).
    # Convention: x_{name}, y_{name}.
    # Declared in plot_config.extra_traces; selectable via card_controls toggles.
    "x_loss":  [float, ...],
    "y_loss":  [float, ...],

    # Area from file header — stored to sample record if sample has none.
    "area_m2": float | None,

    # Any scalar values accessible by analysis_code.
    "thickness_nm": float,
    # ... arbitrary scalar keys
}
```

### Output key declaration (planned)

The schema should declare `output_keys` — what proc_code promises to return. This enables:
- plot_config x_var/y_var dropdowns to show only declared keys
- save-time warning if book configs reference keys no longer returned
- documentation for users writing analysis_code

```json
"output_keys": ["x", "y", "x_fit", "y_fit", "area_m2", "thickness_nm"]
```

### Multi-trace example (CV / permittivity + loss)

```python
return {
    "x":       freq_hz,
    "y":       eps_r,
    "x_label": "Frequency (Hz)",
    "y_label":  "ε'",          # Unicode works everywhere; $\varepsilon'$ works in Plotly
    "x_loss":  freq_hz,
    "y_loss":  tan_delta,
}
```

---

## Plot Types

### `"line"` (default)

Standard x/y line plot. Card uses recharts LinePlot. Comparison panel uses Plotly.

### `"heatmap"`

2D gridded intensity map. Return dict:
```python
{
    "plot_type": "heatmap",
    "x": [float, ...],       # 1D x axis values
    "y": [float, ...],       # 1D y axis values
    "z": [[float, ...], ...] # 2D array, shape [len(y), len(x)]
}
```

Card uses Plotly heatmap (recharts cannot render this). Comparison panel uses Plotly.

**Use cases**: RSM (Qx/Qy/intensity), optical maps, thermal maps.

### `"scatter2d"`

Non-gridded 3D point cloud rendered as a scatter with color-mapped intensity.
```python
{
    "plot_type": "scatter2d",
    "x": [float, ...],
    "y": [float, ...],
    "z": [float, ...]   # intensity/color values, same length as x/y
}
```

**Use cases**: AFM, EBSD, non-uniform spatial data.

### Card renderer selection

The card branches on `plot_type`:
- `"line"` → recharts LinePlot (current)
- `"heatmap"` / `"scatter2d"` → thin Plotly wrapper (same Plotly instance already loaded
  for the module editor)

This is a planned migration; recharts and Plotly already coexist in the bundle.

---

## LaTeX / Formatting in Labels

| Context | Support |
|---|---|
| Plotly book panels | Full MathJax via `$...$` — free, already works |
| recharts card LinePlot | Plain text only; Unicode chars work (µ, ε, Ω, ², ³) |
| Card labels (planned Plotly) | Full MathJax after recharts → Plotly card migration |

Users should write labels with Unicode for card compatibility and LaTeX for book panels.
When the card migrates to Plotly, both will work everywhere.

---

## analysis_code Contract

analysis_code receives the full dict returned by proc_code as `result`:

```python
def _analysis(result):
    # result is proc_code's return dict
    return {
        "metric_name": float | None,
        ...
    }
```

Metrics declared in `analysis_metrics` become available in:
- The Analysis tab of the module editor (per example file)
- The meta-analysis panel in analysis books (fetched per-sample on-demand)

---

## Three-Block Code Editor

The proc_code editor (and analysis_code editor) is split into three visually distinct blocks
concatenated at run/save time.

### Processing Blocks

**Block 1 — Column Imports (auto-generated, locked)**
Generated from the Data section: DELIMITER, SKIP_ROWS, column extraction, header metadata.
Read-only. Lists available variable names in a comment header for Block 2 reference.
Auto-regenerates when Data assignments change — **never touches Blocks 2 or 3**.

**Block 2 — Processing (user-editable)**
Transform, normalization, fitting logic. Block 1 variables in scope. User writes from scratch.

**Block 3 — Return Dict (scaffolded, with reset)**
Pre-populated with required keys (`x`, `y`) and commented optional keys (`x_label`,
`y_label`, `x_fit`, `y_fit`, `area_m2`). User fills in values.
**"Reset to scaffold"** button restores to the initial template without touching Block 2.

### Analysis Blocks

**Block A — Result scaffold (auto-generated, locked)**
Shows available keys from declared `output_keys` as a comment reference. Read-only.

**Block B — Analysis computation (user-editable)**
Metric extraction using `result` keys.

**Block C — Return dict (scaffolded, with reset)**
Template: `{"metric_name": value}`. Same reset behavior as Block 3.

---

## Card Controls

```json
"card_controls": [
  {
    "name":           "loop",
    "type":           "toggle",
    "label":          "Loop",        // displayed above toggle on card
    "choices":        ["all", "2nd"],
    "default":        "2nd",
    "plot_overrides": { "all": {"x_var": "x_all", "y_var": "y_all"}, "2nd": {"x_var": "x", "y_var": "y"} }
  },
  {
    "name":    "area",
    "type":    "area",
    "label":   "Electrode area",
    "default": "1.0"
  }
]
```

### Control types

**`toggle`** — labeled buttons switching between `plot_overrides` (selects x_var/y_var).

**`area`** — electrode area from file + math-expression correction factor. Saved to
`samples.area_correction` on blur. Value passed to proc_code via `meta["area_correction"]`.

**`number`** (planned) — numeric input, passed via options at render time. For user-tunable
parameters (fit initial guess, frequency cutoff, etc.). Stored in panel/card config.

**`colorscale`** (pinned for later) — colorscale picker for heatmap/scatter2d modules.

---

## Sample Page Integration

### Module identification

Users pick the module from the `+Add Data` menu, filtered by section. The `accepts` field
narrows the picker by file extension (hint, not a guarantee). Module identity is always
explicit — set at upload time.

### Card visibility

Hidden until all required file slots have files. Optional slots may be empty.

### Card render

Calls `POST /modules/{id}/render-for-sample` → runs proc_code → returns x/y arrays.
Renderer selected by `plot_type`. Fit overlay rendered if `x_fit`/`y_fit` present.

### Area correction flow

1. Correction factor initialized from `sample.area_correction`
2. Passed to proc_code via `meta["area_correction"]`
3. Saved to `sample.area_correction` on blur
4. Plot re-fetched with updated factor

---

## Analysis Book Integration

### Comparison panel

Type `"mod:{id}"`. `ModuleComparisonPanel` fetches `render-for-sample` per sample,
overlays with Plotly. card_controls toggles available at panel level.

### Meta-analysis

`compute-analysis-for-sample` called per `sample × module` pair where the sample has
files and the module has `analysis_metrics`. Results cached in component state per session.

*Planned*: cache analysis results to DB keyed by `(sample_id, module_id, proc_code_hash)`
for near-instant meta-analysis and to enable display on the sample list view.

---

## File Storage Migration

Current: `data/files/{sample_id}/{filename}`
Target: `data/files/{sample_id}/{module_id}/{slot_key}/{filename}`

`filenames` column: `{"module_id": {"slot_key": "filename.csv"}}`

Existing hardcoded measurement types (pe, xrd_ot, diel_f, etc.) map to:
`{"pe": {"data": "pe_SP025_....txt"}}` during migration.

---

## Transition from Hardcoded Types to Modules

Hardcoded measurement types (PE, XRD, dielectric, RSM, AFM) coexist with the module system
during a transition period. The strategy:

1. Each hardcoded type gets a matching built-in module when parity is achieved
2. The hardcoded card becomes a wrapper that reads from the module's plotCache entry
3. Once all samples have been reparsed through the module, the hardcoded type is retired

Migration order: PE is furthest along. XRD ω–2θ is the simplest next candidate (single file,
line plot, few derived quantities). RSM and AFM migrate last — both involve specialized
rendering (2D binning, binary data) that requires `plot_type: "heatmap"` to be solid first.

---

## Analysis Result Caching

Analysis computation (proc_code + analysis_code) is expensive and must not run on every
meta-analysis panel load. Results are cached in a new table:

```sql
module_analysis_cache (
    sample_id   TEXT,
    module_id   TEXT,
    code_hash   TEXT,   -- SHA256 of proc_code + analysis_code concatenated
    values_json TEXT,   -- JSON object of metric_name → value
    computed_at TEXT,   -- ISO timestamp
    PRIMARY KEY (sample_id, module_id)
)
```

**Cache invalidation**: on read, compare stored `code_hash` against the current module's
hash. If they differ, the cache row is stale — fall back to live computation and update.

**Per-sample re-compute**: a "Re-compute" button appears on the module card (next to the
existing re-parse affordance). Clicking it deletes the cache row and re-runs immediately,
updating stored values. Useful after manually editing analysis_code or when sample metadata
changes in a way that affects output.

**Meta-analysis panel**: hits the cache first. Only falls back to live computation when no
cache row exists or the hash is stale.

*Planned, not yet implemented.*

---

## Output Key Stability

`output_keys` is the module's public API. Keys are referenced in:
- Book panel `plot_config` (`x_var`, `y_var`)
- Module's own `card_controls.plot_overrides`
- Meta-analysis parameter selections (planned)

**Rename warning + crawl**: at save time, diff the declared `output_keys` against the
previously saved set. For any renamed or removed keys, show a modal listing all affected
book panels by name and offer a "rename across all usages" action. This patches the
`x_var`/`y_var` fields in the `panels` JSON column of every affected book row. The user
must approve — no silent patching.

**Key uniqueness**: output keys do not need to be globally unique across modules. They are
always accessed in a module-namespaced context (`module_id.key_name`) in meta-analysis.
Only module IDs must be globally unique.

---

## Module ID Uniqueness and Import Safety

Module IDs must be globally unique. Enforcement points:

**Create flow**: editor validates the ID field in real time; warns if the ID already exists
(currently implemented).

**Duplicate flow**: always generates a `copy_of_{id}` ID; user can rename before saving
(currently implemented).

**Import flow**: when importing an external module file (.py or .json), extract the `id`
field before writing anything. If the ID conflicts with an existing module:
- Show a blocking conflict modal naming the existing module.
- Options: (a) **Rename** — import under a new ID the user specifies; (b) **Cancel**.
- **Overwrite is not offered in the UI.** A user who wants to replace a module must
  explicitly delete the existing one first, then import the new one. This prevents
  accidental silent overwrites of modules that may be referenced by existing samples and
  books.

---

## User Workflow (New Module)

1. **+ New** in Modules → ModuleEditorPage in create mode
2. **Identity**: id, name, description, accepted file types, version
3. **Card**: section assignment, file slots (name + label each), card controls
4. **Data**: upload example file(s) per slot; configure delimiter/skip rows; assign columns
5. **Processing**: Block 1 auto-generated; write Block 2 transforms; fill Block 3 return dict; **Run** to see plot
6. **Plot**: configure x_var/y_var, extra traces, color
7. **Analysis**: declare metrics; write Block B; fill Block C return dict; **Compute**
8. **Save** — module live in section cards, comparison panels, meta-analysis

---

## Key Design Invariants

- **Modules don't know about the UI.** proc_code receives bytes + meta dict, returns plain dict.
- **`x` and `y` are required return keys.** All other keys optional.
- **`files` is always a dict**, even for single-slot modules.
- **Block 1 auto-generation never touches Blocks 2 or 3.**
- **`area_correction` always in meta.** proc_code applies it if the module uses electrode area.
- **`plot_type` determines the renderer.** Default `"line"` uses recharts. `"heatmap"` and `"scatter2d"` require Plotly on the card.
- **output_keys declaration is the module's public API.** Changing them is a breaking change for saved configs. Warn at save time when declared keys differ from previously saved set.

---

## Open Questions / Deferred

- **Collection file mode**: parametric series (N files, each tagged with a scalar). How does the user tag each file — manual input, parsed from filename, both?
- **Fit overlay styling**: dashed, opacity, same color? Separate color per trace?
- **Plotly on cards**: handle heatmap/scatter2d cards like existing RSM/AFM rendering as needed. Line-plot cards stay on recharts for now.
- **`number` control**: passed via `meta` or separate `controls` dict? Must not collide with sample record keys.
- **Analysis module source chaining**: caching, re-run triggers, circular dependency detection.
- **In-editor "test on sample"**: picker for real sample data. Less useful during initial authoring (no samples have the new module's data yet); more useful for iteration after first deployment.
- **Multi-trace plot_config**: how are extra trace pairs (`x_loss`/`y_loss`, etc.) declared and selected in the comparison panel?
- **colorscale control**: for heatmap modules — colorscale picker, intensity range, log scale toggle.
