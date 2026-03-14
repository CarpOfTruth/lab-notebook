from fastapi import FastAPI, HTTPException, UploadFile, File
from fastapi.middleware.cors import CORSMiddleware
import sqlite3, json, os, shutil
from pathlib import Path

app = FastAPI(title="LabLog API")

BASE_DIR = Path(__file__).parent
DATA_DIR = BASE_DIR / "data"
FILES_DIR = DATA_DIR / "files"
DB_PATH   = DATA_DIR / "lablog.db"

DATA_DIR.mkdir(exist_ok=True)
FILES_DIR.mkdir(exist_ok=True)

config_path = BASE_DIR / "config.json"
config = json.loads(config_path.read_text()) if config_path.exists() else {}
ORIGINS = config.get("cors_origins", ["http://localhost:5173"])

app.add_middleware(
    CORSMiddleware,
    allow_origins=ORIGINS,
    allow_methods=["*"],
    allow_headers=["*"],
)


# ── Database ──────────────────────────────────────────────────────────────────

def get_db():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn

def init_db():
    with get_db() as conn:
        conn.execute("""
            CREATE TABLE IF NOT EXISTS folders (
                id         TEXT PRIMARY KEY,
                name       TEXT NOT NULL,
                color      TEXT DEFAULT '#4a5568',
                created_at TEXT DEFAULT (datetime('now'))
            )
        """)
        conn.execute("""
            CREATE TABLE IF NOT EXISTS samples (
                id               TEXT PRIMARY KEY,
                date             TEXT,
                substrate        TEXT,
                notes            TEXT,
                thickness_nm     REAL,
                area_m2          REAL,
                area_correction  REAL DEFAULT 1.0,
                technique        TEXT DEFAULT 'sputter',
                folder_id        TEXT REFERENCES folders(id) ON DELETE SET NULL,
                layers           TEXT DEFAULT '[]',
                filenames        TEXT DEFAULT '{}',
                created_at       TEXT DEFAULT (datetime('now'))
            )
        """)
        conn.execute("""
            CREATE TABLE IF NOT EXISTS analysis_books (
                id         TEXT PRIMARY KEY,
                name       TEXT NOT NULL,
                sample_ids TEXT DEFAULT '[]',
                created_at TEXT DEFAULT (datetime('now'))
            )
        """)
        # Migrations: add columns that may not exist in older DBs
        for col, defn in [
            ("technique",  "TEXT DEFAULT 'sputter'"),
            ("folder_id",  "TEXT"),
        ]:
            try:
                conn.execute(f"ALTER TABLE samples ADD COLUMN {col} {defn}")
            except sqlite3.OperationalError:
                pass  # column already exists
        # Migrations for analysis_books
        try:
            conn.execute("ALTER TABLE analysis_books ADD COLUMN config TEXT DEFAULT '{}'")
        except sqlite3.OperationalError:
            pass  # column already exists
        conn.commit()

init_db()


# ── Helpers ───────────────────────────────────────────────────────────────────

def row_to_dict(row):
    return dict(row)

def row_to_sample(row):
    d = dict(row)
    d["layers"]    = json.loads(d.get("layers")    or "[]")
    d["filenames"] = json.loads(d.get("filenames") or "{}")
    return d

def row_to_book(row):
    d = dict(row)
    d["sample_ids"] = json.loads(d.get("sample_ids") or "[]")
    d["config"]     = json.loads(d.get("config")     or "{}")
    return d


# ── Folders ───────────────────────────────────────────────────────────────────

@app.get("/api/folders")
def list_folders():
    with get_db() as conn:
        rows = conn.execute("SELECT * FROM folders ORDER BY name").fetchall()
    return [row_to_dict(r) for r in rows]

@app.post("/api/folders")
def create_folder(folder: dict):
    with get_db() as conn:
        conn.execute(
            "INSERT INTO folders (id, name, color) VALUES (:id, :name, :color)",
            {"id": folder["id"], "name": folder["name"], "color": folder.get("color", "#4a5568")},
        )
        conn.commit()
    return {"ok": True, "id": folder["id"]}

@app.put("/api/folders/{folder_id}")
def update_folder(folder_id: str, folder: dict):
    with get_db() as conn:
        conn.execute(
            "UPDATE folders SET name=:name, color=:color WHERE id=:id",
            {"id": folder_id, "name": folder["name"], "color": folder.get("color", "#4a5568")},
        )
        conn.commit()
    return {"ok": True}

@app.delete("/api/folders/{folder_id}")
def delete_folder(folder_id: str):
    with get_db() as conn:
        # Unassign samples from this folder before deleting
        conn.execute("UPDATE samples SET folder_id=NULL WHERE folder_id=?", (folder_id,))
        conn.execute("DELETE FROM folders WHERE id=?", (folder_id,))
        conn.commit()
    return {"ok": True}


# ── Samples ───────────────────────────────────────────────────────────────────

@app.get("/api/samples")
def list_samples():
    with get_db() as conn:
        rows = conn.execute("SELECT * FROM samples ORDER BY date DESC, created_at DESC").fetchall()
    return [row_to_sample(r) for r in rows]

@app.get("/api/samples/{sample_id}")
def get_sample(sample_id: str):
    with get_db() as conn:
        row = conn.execute("SELECT * FROM samples WHERE id=?", (sample_id,)).fetchone()
    if not row:
        raise HTTPException(404, "Sample not found")
    return row_to_sample(row)

@app.post("/api/samples")
def create_sample(sample: dict):
    with get_db() as conn:
        if conn.execute("SELECT id FROM samples WHERE id=?", (sample["id"],)).fetchone():
            raise HTTPException(409, f"Sample {sample['id']} already exists")
        conn.execute("""
            INSERT INTO samples
              (id, date, substrate, notes, thickness_nm, area_m2, area_correction,
               technique, folder_id, layers, filenames)
            VALUES
              (:id, :date, :substrate, :notes, :thickness_nm, :area_m2, :area_correction,
               :technique, :folder_id, :layers, :filenames)
        """, {
            **sample,
            "technique":  sample.get("technique", "sputter"),
            "folder_id":  sample.get("folder_id"),
            "layers":     json.dumps(sample.get("layers", [])),
            "filenames":  json.dumps(sample.get("filenames", {})),
        })
        conn.commit()
    return {"ok": True, "id": sample["id"]}

@app.put("/api/samples/{sample_id}")
def update_sample(sample_id: str, sample: dict):
    with get_db() as conn:
        conn.execute("""
            UPDATE samples SET
              date=:date, substrate=:substrate, notes=:notes,
              thickness_nm=:thickness_nm, area_m2=:area_m2, area_correction=:area_correction,
              technique=:technique, folder_id=:folder_id,
              layers=:layers, filenames=:filenames
            WHERE id=:id
        """, {
            **sample,
            "id":         sample_id,
            "technique":  sample.get("technique", "sputter"),
            "folder_id":  sample.get("folder_id"),
            "layers":     json.dumps(sample.get("layers", [])),
            "filenames":  json.dumps(sample.get("filenames", {})),
        })
        conn.commit()
    return {"ok": True}

@app.delete("/api/samples/{sample_id}")
def delete_sample(sample_id: str):
    sample_files = FILES_DIR / sample_id
    if sample_files.exists():
        shutil.rmtree(sample_files)
    with get_db() as conn:
        conn.execute("DELETE FROM samples WHERE id=?", (sample_id,))
        conn.commit()
    return {"ok": True}


# ── Materials autocomplete ────────────────────────────────────────────────────
# Returns a sorted, deduplicated list of all material names ever used across
# all layers in all samples. Used to power the material combobox.

@app.get("/api/materials")
def list_materials():
    with get_db() as conn:
        rows = conn.execute("SELECT layers FROM samples").fetchall()
    materials = set()
    for row in rows:
        layers = json.loads(row["layers"] or "[]")
        for layer in layers:
            for target in layer.get("targets", []):
                m = target.get("material", "").strip()
                if m:
                    materials.add(m)
    return sorted(materials)


# ── File upload / retrieval ───────────────────────────────────────────────────

@app.post("/api/samples/{sample_id}/files/{meas_type}")
async def upload_file(sample_id: str, meas_type: str, file: UploadFile = File(...)):
    dest_dir = FILES_DIR / sample_id
    dest_dir.mkdir(exist_ok=True)
    dest = dest_dir / f"{meas_type}_{file.filename}"
    with open(dest, "wb") as f:
        f.write(await file.read())
    return {"ok": True, "filename": dest.name}

@app.get("/api/samples/{sample_id}/files/{filename}")
def get_file(sample_id: str, filename: str):
    path = FILES_DIR / sample_id / filename
    if not path.exists():
        raise HTTPException(404, "File not found")
    from fastapi.responses import FileResponse
    return FileResponse(path)


# ── Analysis Books (stub) ─────────────────────────────────────────────────────

@app.get("/api/analysis-books")
def list_books():
    with get_db() as conn:
        rows = conn.execute("SELECT * FROM analysis_books ORDER BY created_at DESC").fetchall()
    return [row_to_book(r) for r in rows]

@app.post("/api/analysis-books")
def create_book(book: dict):
    with get_db() as conn:
        conn.execute(
            "INSERT INTO analysis_books (id, name, sample_ids, config) VALUES (:id, :name, :sample_ids, :config)",
            {
                "id":         book["id"],
                "name":       book["name"],
                "sample_ids": json.dumps(book.get("sample_ids", [])),
                "config":     json.dumps(book.get("config", {})),
            },
        )
        conn.commit()
    return {"ok": True, "id": book["id"]}

@app.put("/api/analysis-books/{book_id}")
def update_book(book_id: str, book: dict):
    with get_db() as conn:
        conn.execute(
            "UPDATE analysis_books SET name=:name, sample_ids=:sample_ids, config=:config WHERE id=:id",
            {
                "id":         book_id,
                "name":       book["name"],
                "sample_ids": json.dumps(book.get("sample_ids", [])),
                "config":     json.dumps(book.get("config", {})),
            },
        )
        conn.commit()
    return {"ok": True}

@app.delete("/api/analysis-books/{book_id}")
def delete_book(book_id: str):
    with get_db() as conn:
        conn.execute("DELETE FROM analysis_books WHERE id=?", (book_id,))
        conn.commit()
    return {"ok": True}


# ── Screenshot helper (dev only) ───────────────────────────────────────────────
import base64

SCREENSHOTS_DIR = BASE_DIR.parent / "docs" / "screenshots"

@app.post("/api/dev/screenshot")
def save_screenshot(body: dict):
    """Receive a base64 PNG from the browser and save to docs/screenshots/."""
    name = body.get("name", "screenshot.png")
    data = body.get("data", "")
    if not data:
        raise HTTPException(400, "No data")
    # strip data-url prefix if present
    if "," in data:
        data = data.split(",", 1)[1]
    SCREENSHOTS_DIR.mkdir(parents=True, exist_ok=True)
    (SCREENSHOTS_DIR / name).write_bytes(base64.b64decode(data))
    return {"ok": True, "path": str(SCREENSHOTS_DIR / name)}
