# LabLog User Manual

LabLog is a self-hosted web application for recording and analyzing thin film growth experiments. It runs entirely on your machine — no cloud account, no internet dependency. Data is stored locally in a SQLite database.

---

## 1. Getting Started

### Requirements

- Python 3.9+
- Node.js 18+

### First-time setup

```bash
git clone https://github.com/CarpOfTruth/lab-notebook.git
cd lab-notebook
npm run setup
```

This creates the Python virtual environment and installs all dependencies. Run it once after cloning. You do not need to run it again unless you reinstall or pull major updates.

### Loading demo data (optional)

The repo ships with measurement files for four BaTiO₃/SrRuO₃/Si:STO samples (SP022–SP025) from a sputter pressure series. To load them:

```bash
npm run seed
```

To reset to a clean demo state (overwrites existing data):

```bash
npm run seed -- --overwrite
```

Your own data lives in `backend/data/` and is never touched by the seed script unless you pass `--overwrite`.

### Starting the application

```bash
npm start
```

This launches both the FastAPI backend (port 8000) and the React frontend (port 5173). Open **http://localhost:5173** in a browser. Both processes must be running — if you stop the terminal, the app stops.

### Home page layout

The home page has three sections:

- **Samples** — your sample cards, organized into folders
- **Analysis Books** — cross-sample comparison workspaces
- **Modules** — analysis routines for processing measurement files

A dark/light mode toggle is always visible in the top bar. The setting persists across sessions.

---

## 2. Creating and Organizing Samples

### What a sample represents

A sample record corresponds to one physical sample: a thin film on a substrate, for example. It stores growth metadata, deposition recipe layers, attached measurement files, and processed data.

### Creating a sample

Click **+ New Sample** in the Samples section. Fill in:

- **ID** — a short identifier you choose, e.g. `SP026`. Must be unique. This is used throughout the application to refer to the sample.
- **Date** — growth date.
- **Technique** — PLD, Sputter, or other.
- **Substrate** — e.g. `Si:STO`, `STO`, `LAO`.
- **Thickness (nm)** — active layer thickness. Used by modules to convert voltage to electric field.
- **Notes** — free text. Growth conditions, observations, anything relevant.
- **Folder** — optional. Assign the sample to a folder on creation, or move it later.

Click **Create** to save. The sample card appears in the Samples section.

### Sample cards

Each card on the home page shows the sample ID, technique, substrate, material layer chips, and a count of attached datasets. Cards within a folder can be dragged to reorder them.

### Opening a sample

Click a sample card to open the sample page. This is where you manage metadata, upload measurement files, and view processed plots.

---

## 3. The Sample Page

The sample page has a tab bar across the top. Tabs are added as you attach modules to the sample. Fixed entries in the tab bar:

- **Metadata** — editable fields and file attachment
- **Reparse** — re-run file processing for all modules on this sample
- **View Data** — inspect raw uploaded files
- **Export Sample** — export this sample as a `.labbook.zip`
- **Edit** — edit metadata fields (technique, substrate, thickness, notes, etc.)
- **Delete** — permanently delete the sample and all its files

Each module you attach to the sample gets its own tab.

### Metadata tab

Displays all growth parameters: technique, substrate, thickness, electrode area, area correction factor, notes, and layers. Fields are editable in place or via the **Edit** button. You can also attach arbitrary files here (PDFs, images, supplementary data) by dragging onto the upload zone or clicking to browse.

### Deposition layers

Layers are stored per sample and represent a multi-layer deposition recipe. Click **+ Add Layer** to open the layer form. Both sputter and PLD parameter sets are supported:

| Sputter | PLD |
|---------|-----|
| Temperature (°C) | Temperature (°C) |
| Pressure (mTorr) | Pressure (mTorr) |
| O₂ % | Rep rate (Hz) |
| Power (W) | Energy (mJ) |
| Time (s) | Pulse count |

Layers are drag-reorderable. If you have a material library configured in Settings, parameters auto-fill when you type a known material name.

---

## 4. Adding Modules to a Sample and Uploading Data

### What a module does

A module is an analysis routine that knows how to ingest one or more raw instrument files for a given measurement type, process them, and return plottable data. The built-in **P-E Loop** module, for example, parses polarization–electric-field hysteresis files from Radiant, aixACCT, or generic CSV instruments, converts units, and splits the trace into first and second loops.

### Adding a module tab to a sample

On the sample page, use the **+ Add Data** button (or equivalent control in the tab bar) to open the module picker. Modules are filtered by the file extensions they accept. Select the module you want — for example, **P-E Loop** — and it becomes a new tab on this sample.

### Uploading files

Click the new module tab. The card shows one or more upload zones, one per file slot defined by the module. For the P-E Loop module there is a single slot; some modules have two (e.g., separate up-sweep and down-sweep files for dielectric measurements).

Upload a file by:
- Dragging it onto the drop zone, or
- Clicking the drop zone to open a file browser

Once all required slots have files, the module processes them automatically and renders a plot on the card.

### Re-parsing

If you update sample metadata that affects unit conversion (e.g., you forgot to enter the film thickness and the x-axis is showing volts instead of kV/cm), click **Reparse** in the tab bar. This re-runs file processing for all modules on the sample using the current metadata.

---

## 5. Understanding the Plot View and Controls

### The module card

Each module tab shows a card with the processed data plot and a set of controls. The exact controls depend on the module.

For **P-E Loop**, the card shows:

- **Plot** — polarization (µC/cm²) vs. electric field (kV/cm), or vs. voltage (V) if no thickness is set
- **Loop toggle** — switches between the full double loop ("All") and the isolated second loop ("2nd"). The second loop is cleaner and used for Pᵣ/Eᶜ extraction.
- **Electrode area** — shows the area detected from the file header, if any. A correction factor field lets you scale the area (e.g., if the instrument area differs from the actual electrode). The correction is saved to the sample record on blur and applied immediately.

### Plot config panel

In the comparison context (Analysis Books), each panel has configurable:

- **Color** — color swatch for this sample's trace
- **x/y variable selectors** — choose which output keys from the module to plot (available options depend on what the module returns)
- **Scale toggles** — linear or log scale on each axis
- **Fit overlay** — if the module returns fit data (`x_fit`, `y_fit`), a toggle shows or hides the fit trace overlaid on the data

### Unit conversion

The P-E Loop module converts units automatically:
- Voltage → kV/cm when film thickness is set on the sample
- C/m² → µC/cm² when raw polarization values are in SI units

If you see unexpected units, check that **thickness (nm)** is set in the sample metadata and click **Reparse**.

---

## 6. Organizing with Folders

### Three independent folder systems

Samples, Analysis Books, and Modules each have their own folder system. A folder in the Samples section has no connection to a folder in the Books section. All three work identically.

### Creating a folder

Click **+ Folder** in the section header (Samples, Analysis Books, or Modules). Enter a name and pick a border color. The color is purely visual — use it to group by project, substrate, or run series.

### Moving items into folders

- **Samples**: drag a sample card onto a folder tile, or set the folder when creating/editing the sample.
- **Modules**: drag a module card onto a folder tile in the Modules section.
- **Books**: assign a folder when creating a book, or edit the book to change its folder.

### Editing and deleting folders

Each folder tile has a pencil icon (edit name/color) and an × icon (delete). Deleting a folder does not delete its contents — samples and books are promoted to the top level.

### Reordering

Items within a folder and folders themselves can be dragged to reorder. The order is persisted.

### Collapsing

Click the folder tile to collapse or expand it. Collapsed folders show a count of their contents.

---

## 7. Analysis Books

### What a book is

An Analysis Book groups a set of samples for side-by-side comparison. You can overlay P-E loops from multiple samples, inspect XRD waterfalls, and run meta-analysis scatter plots across growth parameters and extracted metrics.

### Creating a book

Click **+ New Book** in the Analysis Books section. Provide:

- **Name** — e.g., `BTO Pressure Series`
- **Folder** — optional
- **Samples** — select from existing samples. You can add or remove samples later.

### The book view

Opening a book shows a panel-based workspace. Each panel is independently configured. Add panels with **+ Add Panel**. Available panel types include:

- **XRD ω-2θ** — waterfall plot with configurable inter-sample offset in decades
- **RSM** — per-sample heatmap gallery
- **P-E Hysteresis** — overlaid loops; toggle between all-loop and second-loop
- **εᵣ vs E** — overlaid butterfly curves
- **εᵣ vs frequency** — overlaid frequency dispersion curves
- **Module panel** — for any module you've added to these samples; rendered as overlaid traces
- **Meta-Analysis** — scatter plot of any extracted parameter vs any other

### Sample colors

Each sample in the book is assigned a color from a continuous colorscale. In the book roster panel, you can select the colorscale (Viridis, Plasma, Inferno, Magma, or Coolwarm) and configure a trim to avoid washed-out endpoints. Colors propagate consistently across all panels.

### Meta-Analysis panel

The Meta-Analysis panel plots any scalar parameter against any other across all samples in the book. X and Y axes are each chosen from a dropdown of all available quantities:

- Growth conditions: pressure, temperature, O₂ %, time, power/energy
- Fitted measurement parameters: Pᵣ, Eᶜ, Pₛ, εᵣ, tan δ (at specified field or frequency)

A second Y axis can be added for direct overlay of two different parameters. Marker color and style are configurable per axis.

### Exporting a book

In the Analysis Books section header, click **Export**. You can export:

- **With sample data** — includes all raw files and metadata for every sample in the book. The recipient can fully reimport the book and re-run analysis.
- **Without sample data** — book structure and panel configs only. Useful for sharing the book layout without the raw files.

Export produces a `.labbook.zip` file.

### Importing a book

Click **Import** in the Analysis Books section header and select a `.labbook.zip` file. If the zip includes sample data, those samples are imported along with the book. If a sample with the same ID already exists, you are given the option to merge or skip.

---

## 8. Working with Modules

### Built-in modules

LabLog ships with built-in modules for common ferroelectric characterization measurements. The **P-E Loop** module (ID: `pe`) handles polarization–electric-field hysteresis. Additional built-in modules cover XRD, XRR, dielectric (C-f, C-V), and RSM.

Built-in modules appear in the Modules section and can be used on any sample but cannot be edited directly. To customize one, duplicate it first.

### Browsing modules

The Modules section on the home page shows all available modules as cards. Each card shows the module name, description, accepted file types, and author. Built-in modules are labeled accordingly.

### Creating a user module

Click **+ New Module** to open the module editor. The editor is divided into sections:

1. **Identity** — ID (unique, snake_case, e.g. `cv_sweep`), name, description, accepted file extensions, version
2. **Card** — section assignment, file slots (name and label for each upload zone), card controls (toggles, area input)
3. **Data** — upload an example file per slot; configure delimiter and skip rows; assign which columns map to which variables
4. **Processing** — write the Python transform logic:
   - Block 1 (auto-generated, locked): column extraction from your example file configuration
   - Block 2 (user-editable): your transform, normalization, and fitting logic
   - Block 3 (scaffolded): return dict with `x` and `y` keys required; optional keys like `x_label`, `y_label`, `x_fit`, `y_fit`, `area_m2`
   - Click **Run** to preview the plot against your example file
5. **Plot** — configure x/y variable selectors, extra traces, default color
6. **Analysis** — declare output metrics; write analysis code that extracts scalar values (Pᵣ, Eᶜ, etc.) from the processed result; click **Compute** to test
7. **Save** — the module becomes available in the module picker on sample pages and in book comparison panels

The `x` and `y` keys are required return values from processing code. All other keys are optional. Use Unicode in axis labels (µ, ε, Ω) for compatibility with card rendering.

### Duplicating a module

Open any module card and click **Duplicate**. The editor opens with a copy prefixed `copy_of_{id}`. Rename the ID and modify as needed before saving.

### Exporting a module

From the module editor, click **Export**. This produces a `.labmodule.zip` containing the module schema and any example files. Share this file to distribute your analysis routine.

### Importing a module

Click **Import** in the Modules section header and select a `.labmodule.zip` file. If the module ID conflicts with an existing module, you are prompted to rename before import. Overwriting without renaming is not allowed — delete the existing module first if you want to replace it.

### Deleting a module

From the module card, click the delete (×) control. Deleting a module does not delete data that was already processed — existing sample tabs that used the module retain their stored results, but the module can no longer be added to new samples or re-run.

---

## 9. Importing and Exporting

### Samples

**Export**: on the sample page, click **Export Sample** in the tab bar. Produces a `.labbook.zip` containing the sample metadata and all uploaded files.

**Import**: click **Import** in the Samples section header and select a `.zip` file. If a sample with the same ID already exists, you are given merge options.

### Analysis Books

**Export**: click **Export** in the Analysis Books section header. Choose whether to include sample data.

**Import**: click **Import** in the Analysis Books section header and select a `.labbook.zip` file.

### Modules

**Export**: from inside the module editor, click **Export**. Produces a `.labmodule.zip`.

**Import**: click **Import** in the Modules section header and select a `.labmodule.zip` file.

---

## 10. Settings and the Material Library

The gear icon in the top bar opens **Settings**. Here you configure:

- **Global deposition defaults** — default temperature, pressure, O₂ %, time, power/energy for both sputter and PLD techniques. These pre-populate the layer form when you add a new layer.
- **Material Library** — per-material target defaults. When you add a layer and type a material name that matches a library entry (e.g., `BaTiO₃`, `SrRuO₃`), the parameters auto-fill from the library.

---

## 11. Tips and Conventions

**Sample IDs**: use a consistent scheme from the start. `SP026` (technique prefix + sequential number) is readable in plot legends and filenames. Avoid spaces and special characters — the ID is used in file paths.

**Thickness first**: enter film thickness before uploading P-E or dielectric files. The P-E module converts voltage to kV/cm at parse time; if thickness is missing, x-axis will be in volts. Use Reparse after updating thickness.

**Electrode area**: the P-E module attempts to read electrode area from instrument file headers (recognizes cm², µm², and m² with various spellings). If detected, it auto-populates. The correction factor on the card lets you override or scale this without re-uploading.

**Second loop vs. all loops**: for ferroelectric hysteresis, the second loop is recommended for Pᵣ and Eᶜ extraction — it is cleaner because the ferroelectric is already pre-polarized. Use "All" only if you need to inspect the first cycle (e.g., for imprint or fatigue analysis).

**Analysis Books for series**: create one book per growth series (e.g., a pressure series, a temperature series). Assign all samples in the series to the book. Use the Meta-Analysis panel to plot Pᵣ vs. pressure, εᵣ vs. temperature, or any other parameter pair across the series.

**Module proc_code scope**: the processing code runs in a sandboxed Python environment. Standard library modules are available. NumPy is available as `np`. You cannot import arbitrary third-party packages — write self-contained transform logic.

**Backup**: your data lives in `backend/data/`. This directory is gitignored. Back it up independently — copy the directory or export samples/books regularly using the export functions.

**Reparse after code changes**: if you edit a module's processing code after samples already have data from that module, those samples will not automatically update. Open each affected sample and click **Reparse** to re-run processing with the new code.
