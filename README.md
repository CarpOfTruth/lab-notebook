# LabLog

A local lab notebook for tracking ferroelectric oxide thin film growth and characterization.

## Stack

- **Frontend** — Vite + React (runs at `localhost:5173`)
- **Backend** — FastAPI + SQLite (runs at `localhost:8000`)

## Setup

### Backend

```bash
cd backend
python -m venv .venv
source .venv/bin/activate      # Windows: .venv\Scripts\activate
pip install -r requirements.txt
cp config.example.json config.json
uvicorn main:app --reload
```

### Frontend

```bash
cd frontend
npm install
npm run dev
```

Then open `http://localhost:5173`.

## Data

All sample data and uploaded files live in `backend/data/` — this directory is `.gitignore`d and will never be committed. Back it up separately.

## Contributing

- `main` — stable branch
- `dev` — active development; PRs go here before merging to main
