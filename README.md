# LabLog

**A local lab notebook for ferroelectric oxide thin film growth and characterization.**

LabLog is a self-hosted web app that keeps deposition recipes, raw measurement files, and publication-ready plots in one place. No cloud, no accounts — just a SQLite database and a dev server running on your own machine.

---

## Installation

### Requirements

- Python 3.9+
- Node.js 18+

### 1. Clone

```bash
git clone https://github.com/CarpOfTruth/lab-notebook.git
cd lab-notebook
```

### 2. Backend

```bash
cd backend
python3 -m venv .venv
source .venv/bin/activate      # Windows: .venv\Scripts\activate
pip install -r requirements.txt
cp config.example.json config.json
uvicorn main:app --reload
```

### 3. Frontend

In a second terminal:

```bash
cd frontend
npm install
npm run dev
```

Open **http://localhost:5173**.

---

## Demo data

The repo ships with measurement files for three BaTiO₃ / SrRuO₃ / Si:STO samples (SP022 – SP024) from a sputter pressure series (3, 4, 5 mTorr), plus a pre-configured **Demo Analysis Book** comparing them across all panel types.

To load the demo data into a fresh database:

```bash
cd backend
python3 seed_demo.py
```

Re-run with `--overwrite` to reset:

```bash
python3 seed_demo.py --overwrite
```

Your live data lives in `backend/data/` (gitignored). Demo files are in `backend/demo_data/` and are committed to the repo.

---

## What it does

### Dashboard

Samples are organized into named, color-coded **folders** (growth series). Each card shows the deposition technique, substrate, layer material chips (SrRuO₃, BaTiO₃, etc.), notes, and a count of attached datasets. **Analysis Books** appear below for cross-sample comparisons.

A **dark / light mode** toggle is always visible in the top bar and persists across sessions.

![Dashboard — samples and analysis books](docs/screenshots/samples-dark.png)

---

### Creating a sample

Click **+ New Sample** to open the creation dialog. Choose sputter or PLD technique, enter an ID, date, substrate, thickness, notes, and optionally assign the sample to a folder.

![New Sample dialog](docs/screenshots/new-sample-modal.png)

---

### Settings & material library

The gear icon opens **Settings**, where you configure global deposition defaults (temperature, pressure, O₂ %, time, power/energy) for both sputter and PLD. The **Material Library** stores per-material target defaults — when you add a layer and type a known material, parameters auto-fill.

![Settings — global defaults and material library](docs/screenshots/settings.png)

---

### Deposition recipe editor

Multi-layer recipes are stored per sample. Both **sputter** and **PLD** techniques are supported with their own parameter sets. Layers are drag-reorderable. Click **+ Add Layer** to open the inline layer form, which pulls defaults from the material library.

| Sputter | PLD |
|---------|-----|
| Temperature (°C) | Temperature (°C) |
| Pressure (mTorr) | Pressure (mTorr) |
| O₂ % | Rep rate (Hz) |
| Power (W) | Energy (mJ) |
| Time (s) | Pulse count |

![Sample detail — layers and add-layer form](docs/screenshots/sample-layers.png)

---

### X-ray characterization

Three X-ray panels per sample: **XRD ω-2θ** (log-scale intensity vs 2θ), **XRR** (reflectivity curve for thickness extraction), and **RSM** (false-color Qₓ–Qz heatmap for epitaxial strain analysis).

![X-ray characterization row — XRD, XRR, RSM](docs/screenshots/sample-detail-xray.png)

---

### Electrical characterization

Three electrical panels per sample:

- **P-E Hysteresis** — polarization (µC/cm²) vs field (kV/cm). A loop toggle switches between full double loop and isolated 2nd loop.
- **εᵣ vs E** — butterfly permittivity curve from a bipolar voltage sweep, with tan δ on the right axis.
- **εᵣ vs frequency** — frequency dispersion from 1 kHz – 3 MHz on a log axis, with tan δ on the right axis.

The capacitor area is entered per sample and the correction factor is shown inline.

![Electrical characterization row — P-E, εᵣ vs E, εᵣ vs f](docs/screenshots/sample-detail-electrical.png)

---

### Analysis Books

Collect any set of samples into an **Analysis Book** for synchronized, side-by-side comparisons. Samples are assigned colors from a continuous scale (Viridis, Plasma, Inferno, Magma, or Coolwarm) with a configurable trim to avoid washed-out endpoints.

![Analysis Book — sample roster with color scale](docs/screenshots/book-roster.png)

Comparison panels (each independently added/removed via **+ Add Panel**):

| Panel | What it shows |
|-------|---------------|
| **XRD ω-2θ** | Waterfall with configurable inter-sample offset (decades) |
| **RSM** | Per-sample heatmap gallery |
| **P-E Hysteresis** | Overlaid loops, all-loop or 2nd-loop toggle |
| **εᵣ vs E** | Overlaid butterfly curves |
| **εᵣ vs frequency** | Overlaid frequency dispersion |

![Analysis Book — XRD waterfall](docs/screenshots/book-xrd.png)
![Analysis Book — RSM gallery](docs/screenshots/book-rsm.png)
![Analysis Book — P-E overlay](docs/screenshots/book-pe.png)
![Analysis Book — εᵣ vs E overlay](docs/screenshots/book-de.png)
![Analysis Book — εᵣ vs f overlay](docs/screenshots/book-df.png)
