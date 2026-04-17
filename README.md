# LabLog

A self-hosted lab notebook for materials science researchers. Tracks samples, measurement files, and analysis routines in one place. No cloud, no accounts — SQLite database and a dev server on your local machine.

---

## Installation

**Requirements:** Python 3.9+, Node.js 18+

```bash
git clone https://github.com/CarpOfTruth/lab-notebook.git
cd lab-notebook
npm run setup
```

This creates the Python virtual environment, installs all dependencies, and copies the default config.

### Demo data (optional)

Loads four BaTiO₃/SrRuO₃/Si:STO samples (SP022–SP025) from a sputter pressure series, plus a pre-configured Analysis Book.

```bash
npm run seed
```

Re-run with `--overwrite` to reset to a clean demo state.

### Start

```bash
npm start
```

Open **http://localhost:5173**. Backend runs on port 8000, frontend on port 5173.

All user data lives in `backend/data/` and is gitignored.

---

## Overview

The home page has three sections.

### Samples

Physical samples (thin films, etc.), each with an ID (SP###), name, deposition technique (PLD or Sputter), substrate, notes, and metadata. Samples are organized into color-coded folders. Clicking a sample opens its detail page.

The sample page has a tab per module added to the sample, plus a metadata tab. The metadata tab holds editable fields and file attachments. Each module tab shows the processed data plot, a file upload zone, and plot controls (color, axis variables, log/linear scale, fit overlay). Tab bar actions include Reparse, View Data, Export Sample, Edit, and Delete.

### Analysis Books

Books group samples for cross-sample comparison and meta-analysis. The book view is panel-based — add comparison panels for any module, plus a meta-analysis panel that plots any extracted parameter against any other across all samples in the book. Books can be organized into folders and exported/imported as `.labbook.zip` files (optionally including sample data).

### Modules

Modules define how measurement data is processed and how results are aggregated across samples in a book. They are independent of specific measurement types — any file format can be supported by writing the appropriate module.

**Built-in modules:** P-E Loop (ferroelectric hysteresis; accepts `.csv`, `.dat`, `.txt`, `.pe`)

**Custom modules:** The module editor provides a three-block Python editor: Block 1 auto-generates column imports (locked), Block 2 is user processing code, Block 3 returns the output dict. Modules have a name, version, description, author, accepted file types, and section/category. They can be tested against example data in the editor, then saved, exported as `.labmodule.zip`, and shared or imported elsewhere.

Modules are organized into folders with drag-drop assignment.

---

## Security

Module `proc_code` and `analysis_code` execute as Python on the backend server. Only import modules from sources you trust. The import flow displays full module source before any code is executed.

---

## Documentation

- `docs/user-manual.md` — full application usage guide
- `docs/module-authoring-guide.md` — writing custom analysis modules
- `docs/lab-guide.md` — lab-specific conventions and workflows
