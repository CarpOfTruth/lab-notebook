# Roadmap

This document describes planned features and their designs. It reflects current thinking as of April 2026 and is updated as design decisions are made or revised. It is not a commitment or a release schedule — priorities shift based on what real use surfaces.

All work happens on **dev**. Nothing merges to main without explicit approval.

---

## Priority Tiers

### Tier 1 — True Foundation
No dependencies. Everything downstream builds on these.
1. Universal import framework
2. Growth parameters in settings
3. Materials library — must be scoped correctly from the start (lab-specific properties + crystallographic/physical data). Modules will be written against it; retrofitting the scope later is costly.
4. Search and filter (depends on #2)

### Tier 2 — Module Infrastructure
Unlocks large classes of features. Should be in place before the module system grows significantly.
5. Module configuration schema + system resource API — must precede derived module implementation, or fit-type modules get built without proper configuration support
6. Collection file mode + metafile handling — unblocks switching, RSM, scanning probe, and other complex measurement types
7. 2D/image plot type — discrete work item needed before RSM and scanning probe modules can be built
8. Custom package dependencies — unblocks serious custom module authoring

### Tier 3 — Module System Depth
Builds on Tier 2. Derived module framework moved up from Tier 4 — needed sooner than originally placed.
9. Derived/hybrid module type + Identity block UI
10. Invisible modules + auto-fire + tunable panel
11. Run chain button + stale flag system
↳ Rolling alongside Tier 3: simple hardcoded panel conversions (XRD ω-2θ, XRR, dielectric) — single-file capable, done incrementally

### Tier 4 — Full Pipeline
Requires Tier 3 to be solid before touching.
12. Multi-source DAG execution + cache layer
13. analysis_code interface for derived modules + exports mechanism
14. Fit-type module design session → first fit module implementation
15. Config/settings export

### Tier 5 — Deferred
Blocked on specific infrastructure, or needs concrete use cases to design against.
16. Primary flag richness and multi-condition collection analysis
17. Multi-point meta returns per sample
18. Derivative module plot/analysis boundary details
- RSM module (after 2D plot type; may also need collection mode)
- Scanning probe module (after 2D plot type)
- Switching module (after collection mode + derived modules)
- XRD fitting migration (after full fit-type framework — one of the last conversions)

---

## Feature Designs

---

### 1. Universal Import Framework

A single `ImportModal` component used across all import contexts: samples, books, modules, materials, growth conditions, settings.

**Flow:**
1. User clicks Import (in a section header, settings, etc.)
2. File picker opens using the existing `FileBtn` pattern
3. File is sent to a context-specific preview endpoint
4. Modal shows: contents of the file, conflicts with existing data, resolution options per item
5. User resolves conflicts and confirms
6. Import proceeds

**Resolution options by context** (the framework provides scaffolding; each type defines which options are valid):
- Sample: skip, overwrite, rename, merge (add unpopulated data/modules)
- Material: skip, overwrite, rename, merge (add missing parameters only)
- Module: skip, overwrite, rename
- Book: skip, overwrite, rename
- Growth condition: skip, overwrite, rename, merge

**Component interface:**
```jsx
ImportModal({ type, previewEndpoint, onConfirm, onClose })
```

All Import buttons in the app call the same component pointed at their endpoint. This replaces the current per-domain import modals over time.

---

### 2. Growth Parameters in Settings

User-defined field schema per deposition technique (PLD, Sputter, etc.) stored in settings.

**Field definition:**
```json
{ "name": "...", "type": "number|text|select", "unit": "...", "default": ..., "required": true, "filterable": true }
```

**Storage:** `settings.json` under `growth_params.PLD`, `growth_params.Sputter`, etc.

**Sample integration:**
- Fields appear in the Growth section during sample creation and editing
- Values stored in existing sample metadata JSON
- Fields auto-appear in meta plot axes

Adding a field: existing samples show it as empty. Removing a field: data persists silently, field just stops appearing.

Mark filterable fields at definition time — this avoids retrofitting queryability onto fields that were not originally indexed.

---

### 3. Search and Filter

**Filter index table (EAV):**
```sql
sample_filter_index (sample_id, field, value_text, value_num)
```

One row per sample per growth parameter. Written on every sample save; rebuildable from scratch on demand. This table is never the source of truth — it exists only for query performance. Multi-condition queries use INTERSECT subqueries. Future extension: index module output values (e.g. filter by computed `area_m2`).

**Shared `SampleFilter` component** used on the home page (narrow the sample list) and in the book sample picker (narrow available samples). Filter state: `{ field → { type, condition, value } }`. Supports numeric range, categorical match, and text search. Backend receives filter spec, builds SQL, returns matching sample IDs.

Fine at research-lab scale: 10k samples × 20 params = 200k rows, trivial for SQLite.

---

### 4. Materials and Growth Conditions Library

**Materials entry:** `{ id (human-readable string), name, lattice_params, properties, notes, ... }`

A materials entry must accommodate two distinct categories of properties, and the design must keep them clearly separated:

- **Lab-specific properties** — growth conditions, deposition parameters, in-house characterization results, notes. These are lab-generated and vary between groups.
- **Crystallographic and physical properties** — lattice parameters, space group, scattering factors, density, and other literature reference values. These are material constants, not lab-specific. They are needed by physics-based fit modules (XRD, XRR, dielectric) that cannot rely solely on what is passed in `meta`.

Both categories live on the same entry, but the UI and import tooling should distinguish them so users can populate reference values from literature without conflating them with lab-specific data.

**Growth condition entry:** `{ id, name, technique, params }` — params match the growth_params schema for that technique. Growth conditions are named presets of the growth parameter fields, which makes them a natural extension of feature 2.

**Import/export:** uses the universal import framework. Individual entries or bulk. Conflict resolution: skip/overwrite/rename/merge (additive, non-destructive).

**ID convention:** human-readable strings (e.g. `"BTO_cubic"`), not UUIDs. This avoids breakage when libraries are partially imported between labs.

---

### 5. Custom Package Dependencies

**Per-module declaration in schema:**
```json
{ "dependencies": ["lmfit>=1.0", "peakutils"] }
```

**On module import:**
1. Preview step shows the dependency list explicitly — user must accept before import proceeds
2. Backend checks whether each package is importable and pip-installs missing ones
3. Version conflicts surface in the preview step, not as install failures after the fact
4. If any install fails: rollback the entire import, no partial state
5. UI shows install status per module: installed / missing / failed

Built-in modules have all their dependencies covered in `requirements.txt` — no user action needed for them.

A global escape hatch in settings allows specifying additional packages outside any module.

---

### 6. Full Config/Settings Export

Bundles `settings.json`, the materials library, the growth conditions library, and optionally module schemas into a portable user profile. Import side uses the universal import framework.

---

### 7. Collection File Mode

A module's data is a collection of files, each tagged with parameter values. The module's parameter manifest defines what metadata each file carries.

**Metadata sources** (declared in schema; module author chooses which applies):
- `manual` — user tags each file through the UI (baseline/fallback)
- `metafile` — one designated file describes the rest; backend parses it and pre-populates the registry on upload
- `header` — each file's header contains parameters; schema provides parsing hints
- `columns` — extra columns in each data file carry parameter values
- `filename` — a regex in the schema extracts named groups from filenames

**Registry:** `{ filename, params: { field: value, ... } }` per file, stored with the module's sample data.

`proc_code` receives the full registry plus all loaded file data. Filtering and slicing happens in code.

**Card controls** can be auto-generated from the parameter manifest — user selects a slice (e.g. `voltage=5V, area=1e-4cm²`) from the card; selections are passed to `proc_code` via `meta`.

**Primary flag:** one file designated as primary, used for card display and simple meta analysis. Orthogonal to collection-level analysis via `analysis_code`.

**Metafile specifics:**
- Separate upload zone from data files — clearly labeled, no ambiguity
- Module shows as "awaiting metafile" until the metafile is provided, if one is required
- Backend can generate a skeleton metafile (correct format, data filenames pre-filled, parameter columns empty) for user to download, fill in, and re-upload

**Upload UI by complexity:**
- Single/named slot: existing drag-drop on card
- Collection (simple): compact inline table on card — file list + parameter columns
- Collection (complex): "Manage data" button opens a dedicated modal with bulk upload, full registry table, and metafile zone

**View/manage data:** a "Manage data" button appears on every collection card. Opens the registry modal: table of files + parameters, add/remove/edit, parse error details. Distinct from the existing "View data" raw file inspection.

**Underlying model:** all modules store a file collection with a primary flag. Single-file modules are the degenerate case (a collection of one). Users can accumulate file versions; the primary flag determines which is active for analysis. The distinction from collection mode: collection carries metadata tags per file; simple multi-file accumulation does not.

---

### 8. Invisible Modules + Auto-fire + Tunable Panel

**Visibility flag** on module (`visible: true/false`), set at creation, overridable per-sample.

**Visible modules:** own card at the same level as source module cards. Position declared via `display_after: "module_id"` in schema.

**Invisible modules:**
- Run automatically when declared sources have fresh cached outputs
- No card — appear as a collapsible panel attached to a relevant source card (via `display_after` or first declared source)
- Panel is interactive, not read-only: user can adjust parameters (fit bounds, initial guesses, etc.)
- "Re-run" button to recompute with adjusted parameters
- "Reset to defaults" option
- Per-sample parameter overrides stored in sample-level module configuration; take precedence over module defaults during auto-fire

**Auto-fire scope:** fires for a sample when all declared sources for that sample have fresh cached outputs. Does not trigger across other samples.

---

### 9. Run Chain Button + Stale Flag System

**Run chain button** on any module card:
1. Topological sort of the full upstream dependency graph for that sample
2. Run anything stale or missing, in dependency order
3. Run the target module
4. Fire any invisible auto-fire derivatives downstream

Scope: per-sample, per-terminal-module. Does not touch other samples.

**Stale flag system:**
- Files hashed once on upload; hash stored in DB. Subsequent staleness checks are string comparisons.
- Proc_code changes hashed as text.
- Each cached output stores the input hash used to produce it (hash of source files for source modules; hash of upstream outputs for derived modules).
- On any change: compare current input hash to stored. Mismatch → stale. Match → clear stale flag automatically (handles "changed back" without requiring re-run).
- Staleness propagates to direct dependents as flag-only — no auto-recompute, no output clearing.
- Analysis book panels check staleness lazily on load, not proactively.
- Cache invalidation = stale flag. Output is preserved and still displayable as outdated. User triggers recompute explicitly via "Re-run" or "Run chain."

---

### 10. Module Configuration Schema

A structured per-sample configuration system for modules that need richer input than card controls can express.

**What it is:** modules declare a configuration schema in their definition. The system persists a configuration object per sample per module and renders appropriate UI for editing it. This is distinct from card controls (which are transient display parameters) — configuration is persistent, structured, and potentially complex.

**Why:** fit-type modules in particular require configuration that card controls cannot express: layer stacks, model selection, fit bounds, initial guesses, and topology choices. Attempting to squeeze this into card controls produces bad UX. The module configuration schema is the general solution.

**Schema declaration:** the module schema includes a `config_schema` block defining the fields, their types, structure, and defaults. The system generates UI from this declaration. Possible field types include scalar (number, text, select), structured (layer stack rows, parameter tables), and nested objects.

**Persistence:** configuration is stored per `(sample_id, module_id)`. When a module runs, its configuration is passed to `proc_code` alongside the data and card control values. The module author accesses it as a structured object, not a flat dict.

**Configuration presets:** named saved configurations per module (e.g. `"standard BTO stack"`, `"STO substrate baseline"`). A preset can be applied to a sample to populate its configuration from the named template. Presets are stored at the module level, not the sample level. Users build a library of named presets for common configurations and recall them per sample without re-entering values.

**System resource access:** `proc_code` needs a well-defined API for querying system-level resources — specifically the materials library (including crystallographic data) and potentially other system stores. This is not the same as what is passed in `meta`. A `resources` object (or equivalent) is injected alongside the data, providing access to materials entries by ID, so fit modules can look up scattering factors, lattice parameters, etc. without the user having to manually copy values into meta fields.

**Examples of modules that would use this:**
- XRD fitting: layer stack editor (material, thickness, roughness per layer), model selection (kinematic vs. dynamical diffraction)
- XRR fitting: same layer stack structure, additional density and SLD columns
- Dielectric equivalent circuit fitting: circuit topology editor, component bounds and initial values
- Peak assignment tables: peak positions, assignments, fit windows

This feature is a prerequisite for any fit-type module conversion.

---

### 11. Derived/Hybrid Module Types

**Module type flag** (set in Identity block of editor):
- **Source** — consumes raw uploaded files → produces output dict
- **Derived** — consumes outputs of other modules → produces output dict
- **Hybrid** — consumes both raw files and other module outputs

**Identity block additions:**
- Type toggle (Source / Derived / Hybrid)
- Sources selector (multi-select from available modules) — appears for Derived and Hybrid

**Block 1 generation** driven by type:
- Source: file column imports (as now)
- Derived: namespaced upstream dicts (see feature 13)
- Hybrid: both

**No circular dependencies** — enforced at schema save time by checking for cycles in the declared source graph.

**Applicable modules on sample page:** a derived module only appears for a sample if all its declared sources have been run (or can be run) for that sample. Modules with unsatisfied sources show as unavailable with a clear indication of what is missing. Users can pre-configure a module before data is present; the module shows as "waiting on [source]."

---

### 12. Multi-source DAG Execution + Cache Layer

**Source declaration:** `source_modules: ["module_id_a", "module_id_b"]` array in schema.

**Execution model:** each module runs independently. It reads cached outputs of declared sources from disk and does not trigger upstream execution. If upstream output is missing or stale, that is surfaced to the user. "Run chain" handles topological execution order.

**Cache storage abstraction (`ModuleOutputStore`):**
- Initial implementation: `.npy` files on disk, path + cache key stored in DB
- Interface abstracted so storage backend (HDF5, Parquet) can be swapped without changing other code
- Keyed on `(sample_id, module_id, input_hash)`
- Only current module's input and output held in memory at one time; upstream data loaded from disk, not retained

**Memory model:** sequential disk-swap execution — load upstream output, run `proc_code`, write output, free memory.

---

### 13. Inter-module Namespace + analysis_code for Derived Modules

**Inter-module contract:** derived module `proc_code` receives both `proc_code` and `analysis_code` return dicts from each upstream module, for that sample.

**Namespace design — collisions impossible by construction:**

Block 1 auto-generates namespaced dicts keyed by module ID:
```python
# Auto-generated — do not edit
pe_loop    = { "proc": _upstream["pe_loop"]["proc"],    "analysis": _upstream["pe_loop"]["analysis"] }
xrd_result = { "proc": _upstream["xrd_result"]["proc"], "analysis": _upstream["xrd_result"]["analysis"] }
```

Module author unpacks explicitly in Block 2:
```python
ec      = pe_loop["analysis"]["ec"]
raw_x   = pe_loop["proc"]["x"]
lattice = xrd_result["proc"]["lattice_param"]
```

This handles all collision cases: same name in proc vs analysis of one module (different sub-keys), same name from two different modules (different top-level keys).

**analysis_code for derived modules:** structure TBD — workshop before implementation. The current three-block editor may need a variant. Flagged as an open design question.

**Exports to analysis notebooks:** `analysis_code` explicitly returns what it wants exposed. Notebooks never see the raw `proc_code` namespace. Exact exports mechanism (dedicated `exports` dict vs. full return) to be workshopped before implementation.

---

## Deferred — Design Against Real Use Cases

These items are understood well enough to describe but not well enough to implement correctly without a concrete module driving the design.

**14. Primary flag richness and multi-condition collection analysis**

Two distinct cases: (a) one file designated as primary for card display and simple meta analysis — straightforward; (b) aggregate analysis across a collection (e.g. Ec vs. frequency where each file contributes one point) — handled by `analysis_code` iterating the full file collection. The second case needs a concrete module use case before designing the contract.

**15. Multi-point meta returns per sample**

`analysis_code` returning structured multi-point data (e.g. `{ec_vs_freq: [{freq, ec}, ...]}`) for meta-analysis across samples. Design against a real module when building it.

**16. Derivative module plot/analysis boundary**

All modules (source and derived) produce plots via `proc_code` returning `{x, y, ...}`. The open question is what `analysis_code` looks like for derived modules and how its outputs flow into meta-analysis. Workshop when building the first real derived module.

**Card controls + collection module interaction**

If a card control filters a collection to a specific slice, does a derived module downstream see the filtered output or the full collection? This has significant implications for the module contract. Resolve before building collection mode and derived modules together.

**17. Fit-type module interface**

Fit-type modules — XRD fitting, XRR fitting, dielectric equivalent circuit fitting, switching model fits, P-E model fitting — share a set of interface needs that distinguish them from all other module types: external reference data (simulation targets, crystallographic databases), rich per-sample configuration (layer stacks, circuit topologies, bounds, initial guesses), iterative refinement interaction (run, inspect, adjust, re-run), and direct `proc_code` access to system-level resources such as the materials library.

These requirements span multiple planned features: module configuration schema (feature 10), materials library with crystallographic data (feature 4), and potentially a new interactive refinement mode not yet described anywhere. The fit-type interface is a design question that sits at the intersection of all of these.

XRD fitting migration is blocked on: the derived module framework (features 11–13) + the materials library with crystallographic data (feature 4) + module configuration schema (feature 10). Despite being a built-in panel today, XRD fitting is one of the later conversions because the infrastructure it requires is among the most complex.

A dedicated design discussion is required before building any fit-type module infrastructure. Do not begin implementation of fit-type modules until that discussion has produced a clear interface contract.

---

*This document is updated as design decisions are made. It reflects current thinking, not firm commitments. Features may be reordered, redesigned, or dropped as real use cases surface new information.*
