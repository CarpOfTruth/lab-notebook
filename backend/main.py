from fastapi import FastAPI, HTTPException, UploadFile, File, Request
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
        try:
            conn.execute("ALTER TABLE analysis_books ADD COLUMN folder_id TEXT")
        except sqlite3.OperationalError:
            pass
        # Migrations for folders: book_folder flag
        try:
            conn.execute("ALTER TABLE folders ADD COLUMN book_folder INTEGER DEFAULT 0")
        except sqlite3.OperationalError:
            pass
        try:
            conn.execute("ALTER TABLE folders ADD COLUMN parent_id TEXT DEFAULT NULL")
        except sqlite3.OperationalError:
            pass
        try:
            conn.execute("ALTER TABLE folders ADD COLUMN sort_order INTEGER DEFAULT 0")
        except sqlite3.OperationalError:
            pass
        try:
            conn.execute("ALTER TABLE samples ADD COLUMN xrd_peaks TEXT DEFAULT '[]'")
        except sqlite3.OperationalError:
            pass
        conn.execute("""
            CREATE TABLE IF NOT EXISTS settings (
                key   TEXT PRIMARY KEY,
                value TEXT NOT NULL
            )
        """)
        conn.commit()

init_db()


# ── Helpers ───────────────────────────────────────────────────────────────────

def row_to_dict(row):
    return dict(row)

def row_to_sample(row):
    d = dict(row)
    d["layers"]    = json.loads(d.get("layers")    or "[]")
    d["filenames"] = json.loads(d.get("filenames") or "{}")
    d["xrd_peaks"] = json.loads(d.get("xrd_peaks") or "[]")
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
        rows = conn.execute("SELECT * FROM folders ORDER BY COALESCE(sort_order, 0), name").fetchall()
    return [row_to_dict(r) for r in rows]

@app.post("/api/folders")
def create_folder(folder: dict):
    with get_db() as conn:
        conn.execute(
            "INSERT INTO folders (id, name, color, book_folder, parent_id, sort_order) VALUES (:id, :name, :color, :book_folder, :parent_id, :sort_order)",
            {"id": folder["id"], "name": folder["name"], "color": folder.get("color", "#4a5568"), "book_folder": 1 if folder.get("book_folder") else 0, "parent_id": folder.get("parent_id") or None, "sort_order": folder.get("sort_order", 0)},
        )
        conn.commit()
    return {"ok": True, "id": folder["id"]}

@app.put("/api/folders/{folder_id}")
def update_folder(folder_id: str, folder: dict):
    with get_db() as conn:
        conn.execute(
            "UPDATE folders SET name=:name, color=:color, book_folder=:book_folder, parent_id=:parent_id, sort_order=:sort_order WHERE id=:id",
            {"id": folder_id, "name": folder["name"], "color": folder.get("color", "#4a5568"), "book_folder": 1 if folder.get("book_folder") else 0, "parent_id": folder.get("parent_id") or None, "sort_order": folder.get("sort_order", 0)},
        )
        conn.commit()
    return {"ok": True}

@app.delete("/api/folders/{folder_id}")
def delete_folder(folder_id: str):
    with get_db() as conn:
        # Promote children to the deleted folder's parent level
        row = conn.execute("SELECT parent_id FROM folders WHERE id=?", (folder_id,)).fetchone()
        new_parent = row["parent_id"] if row else None
        conn.execute("UPDATE folders SET parent_id=? WHERE parent_id=?", (new_parent, folder_id))
        conn.execute("UPDATE samples SET folder_id=NULL WHERE folder_id=?", (folder_id,))
        conn.execute("UPDATE analysis_books SET folder_id=NULL WHERE folder_id=?", (folder_id,))
        conn.execute("DELETE FROM folders WHERE id=?", (folder_id,))
        conn.commit()
    return {"ok": True}

@app.post("/api/folders/reorder")
async def reorder_folders(request: Request):
    updates = await request.json()
    with get_db() as conn:
        for u in updates:
            conn.execute("UPDATE folders SET sort_order=?, parent_id=? WHERE id=?",
                         (u.get("sort_order", 0), u.get("parent_id") or None, u["id"]))
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
               technique, folder_id, layers, filenames, xrd_peaks)
            VALUES
              (:id, :date, :substrate, :notes, :thickness_nm, :area_m2, :area_correction,
               :technique, :folder_id, :layers, :filenames, :xrd_peaks)
        """, {
            **sample,
            "technique":  sample.get("technique", "sputter"),
            "folder_id":  sample.get("folder_id"),
            "layers":     json.dumps(sample.get("layers", [])),
            "filenames":  json.dumps(sample.get("filenames", {})),
            "xrd_peaks":  json.dumps(sample.get("xrd_peaks", [])),
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
              layers=:layers, filenames=:filenames, xrd_peaks=:xrd_peaks
            WHERE id=:id
        """, {
            **sample,
            "id":         sample_id,
            "technique":  sample.get("technique", "sputter"),
            "folder_id":  sample.get("folder_id"),
            "layers":     json.dumps(sample.get("layers", [])),
            "filenames":  json.dumps(sample.get("filenames", {})),
            "xrd_peaks":  json.dumps(sample.get("xrd_peaks", [])),
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


# ── Settings ─────────────────────────────────────────────────────────────────

@app.get("/api/settings")
def get_settings():
    with get_db() as conn:
        row = conn.execute("SELECT value FROM settings WHERE key = 'main'").fetchone()
    if row:
        return json.loads(row["value"])
    return {}

@app.put("/api/settings")
def put_settings(body: dict):
    with get_db() as conn:
        conn.execute(
            "INSERT INTO settings (key, value) VALUES ('main', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            (json.dumps(body),)
        )
        conn.commit()
    return body


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


@app.get("/api/samples/{sample_id}/afm_data")
def get_afm_data(sample_id: str):
    """Read the stored .ibw file, process each channel, and return display-ready JSON."""
    try:
        import numpy as np
        import igor2.binarywave as bw
    except ImportError:
        raise HTTPException(500, "igor2 / numpy not installed — run: pip install igor2 numpy")

    dest_dir = FILES_DIR / sample_id
    afm_files = sorted(dest_dir.glob("afm_*.ibw"), key=lambda p: p.stat().st_mtime, reverse=True)
    if not afm_files:
        raise HTTPException(404, "No AFM file found for this sample")

    path = afm_files[0]
    wave = bw.load(str(path))
    wdata = wave["wave"]["wData"]          # (H, W, C) float32, values already in SI units
    note_raw = wave["wave"].get("note", b"")

    # Parse note field (Key:Value\r pairs)
    note: dict = {}
    for line in note_raw.decode("latin-1", errors="replace").replace("\r\n", "\r").split("\r"):
        if ":" in line:
            k, _, v = line.partition(":")
            note[k.strip()] = v.strip()

    scan_size_m = float(note.get("ScanSize", 20e-6))

    # Channel labels: dim2 of labels list; index 0 is always an empty placeholder in Igor
    raw_labels = wave["wave"].get("labels", [])
    dim2 = raw_labels[2] if len(raw_labels) > 2 else []
    labels: list[str] = []
    for lbl in dim2:
        s = (lbl.decode("latin-1") if isinstance(lbl, bytes) else lbl).rstrip("\x00").strip()
        labels.append(s)
    # Drop the leading empty placeholder so index i matches channel i
    while labels and not labels[0]:
        labels.pop(0)

    # Ensure 3-D shape
    if wdata.ndim == 2:
        wdata = wdata[:, :, np.newaxis]
    H, W, C = wdata.shape

    channels: dict = {}
    channel_ranges: dict = {}
    for i in range(C):
        ch = np.rot90(wdata[:, :, i].astype(np.float64), k=1)  # 90° CCW before processing
        Hr, Wr = ch.shape
        ch_label = labels[i] if i < len(labels) else f"Ch{i}"

        # Height channel: linewise (row-by-row) flatten to remove scan-line Z-drift,
        # followed by a global plane tilt removal, then m → nm.
        if "height" in ch_label.lower() or i == 0:
            xs_row = np.arange(Wr, dtype=np.float64)

            # Global IQR mask: exclude large features/outliers from all fits
            flat_g = ch.ravel()
            ok_g   = np.isfinite(flat_g)
            q1g, q3g = np.percentile(flat_g[ok_g], [25, 75])
            iqr_g    = q3g - q1g
            global_mask = (np.isfinite(ch)
                           & (ch >= q1g - 3.0 * iqr_g)
                           & (ch <= q3g + 3.0 * iqr_g))

            # Row-by-row 1st-order (linear) flatten — removes per-line Z drift
            for r in range(Hr):
                mask = global_mask[r]
                if mask.sum() < 2:          # fallback if most of row is masked
                    mask = np.isfinite(ch[r])
                if mask.sum() < 2:
                    continue
                c = np.polyfit(xs_row[mask], ch[r, mask], 1)
                ch[r] -= np.polyval(c, xs_row)

            # Global 2nd-order polynomial flatten on post-linewise residuals
            ys2, xs2 = np.mgrid[0:Hr, 0:Wr]
            flat2 = ch.ravel()
            ok2   = np.isfinite(flat2)
            q1b, q3b = np.percentile(flat2[ok2], [25, 75])
            iqr_b    = q3b - q1b
            ok2 &= (flat2 >= q1b - 3.0 * iqr_b) & (flat2 <= q3b + 3.0 * iqr_b)
            xf2, yf2 = xs2.ravel()[ok2], ys2.ravel()[ok2]
            A2 = np.stack([np.ones(ok2.sum()), xf2, yf2, xf2**2, xf2*yf2, yf2**2], axis=1)
            c2, *_ = np.linalg.lstsq(A2, flat2[ok2], rcond=None)
            ch -= (c2[0] + c2[1]*xs2 + c2[2]*ys2
                   + c2[3]*xs2**2 + c2[4]*xs2*ys2 + c2[5]*ys2**2)

            ch *= 1e9  # m → nm

        # Percentile-clipped display range (robust against outliers for all channels)
        ch_flat = ch.ravel()
        ch_ok = np.isfinite(ch_flat)
        if ch_ok.any():
            vmin, vmax = np.percentile(ch_flat[ch_ok], [0.5, 99.5])
        else:
            vmin, vmax = 0.0, 1.0
        channel_ranges[ch_label] = [round(float(vmin), 4), round(float(vmax), 4)]

        channels[ch_label] = ch.tolist()

    first = next(iter(channels.values())) if channels else [[]]
    out_h, out_w = len(first), len(first[0]) if first else 0

    return {
        "channels":       channels,
        "channel_names":  list(channels.keys()),
        "channel_ranges": channel_ranges,
        "scan_size_um":   round(scan_size_m * 1e6, 3),
        "pixels":         [out_h, out_w],
        "filename":       path.name,
    }


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
            "INSERT INTO analysis_books (id, name, sample_ids, config, folder_id) VALUES (:id, :name, :sample_ids, :config, :folder_id)",
            {
                "id":         book["id"],
                "name":       book["name"],
                "sample_ids": json.dumps(book.get("sample_ids", [])),
                "config":     json.dumps(book.get("config", {})),
                "folder_id":  book.get("folder_id"),
            },
        )
        conn.commit()
    return {"ok": True, "id": book["id"]}

@app.put("/api/analysis-books/{book_id}")
def update_book(book_id: str, book: dict):
    with get_db() as conn:
        conn.execute(
            "UPDATE analysis_books SET name=:name, sample_ids=:sample_ids, config=:config, folder_id=:folder_id WHERE id=:id",
            {
                "id":         book_id,
                "name":       book["name"],
                "sample_ids": json.dumps(book.get("sample_ids", [])),
                "config":     json.dumps(book.get("config", {})),
                "folder_id":  book.get("folder_id"),
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
