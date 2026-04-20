from fastapi import FastAPI, HTTPException, UploadFile, File, Request, Query
from fastapi.middleware.cors import CORSMiddleware
from typing import Optional
import sqlite3, json, os, shutil
from pathlib import Path
import modules as mod_registry

app = FastAPI(title="LabLog API")

BASE_DIR    = Path(__file__).parent
DATA_DIR    = BASE_DIR / "data"
FILES_DIR   = DATA_DIR / "files"
DB_PATH     = DATA_DIR / "lablog.db"
EXAMPLES_DIR         = DATA_DIR / "module_examples"          # user-uploaded (gitignored)
BUILTIN_EXAMPLES_DIR = BASE_DIR / "modules" / "examples"     # shipped with code (tracked)
SCHEMAS_DIR          = DATA_DIR / "module_schemas"            # user-saved (gitignored)
BUILTIN_SCHEMAS_DIR  = BASE_DIR / "modules" / "schemas"      # shipped with code (tracked)

DATA_DIR.mkdir(exist_ok=True)
FILES_DIR.mkdir(exist_ok=True)
EXAMPLES_DIR.mkdir(exist_ok=True)
SCHEMAS_DIR.mkdir(exist_ok=True)


def _find_example(module_id: str):
    """Return (path, is_builtin) for a module's example file.
    User-uploaded file takes precedence over the shipped built-in."""
    user = list(EXAMPLES_DIR.glob(f"{module_id}.*"))
    if user:
        return user[0], False
    builtin = list(BUILTIN_EXAMPLES_DIR.glob(f"{module_id}.*"))
    if builtin:
        return builtin[0], True
    return None, False


def _load_schema(module_id: str) -> dict | None:
    """Return schema dict for a module.
    User-saved schema takes precedence; falls back to built-in shipped schema."""
    user_path = SCHEMAS_DIR / f"{module_id}.json"
    if user_path.exists():
        return json.loads(user_path.read_text())
    builtin_path = BUILTIN_SCHEMAS_DIR / f"{module_id}.json"
    if builtin_path.exists():
        return json.loads(builtin_path.read_text())
    return None

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
            conn.execute("ALTER TABLE folders ADD COLUMN module_folder INTEGER DEFAULT 0")
        except sqlite3.OperationalError:
            pass
        try:
            conn.execute("ALTER TABLE samples ADD COLUMN xrd_peaks TEXT DEFAULT '[]'")
        except sqlite3.OperationalError:
            pass
        try:
            conn.execute("ALTER TABLE samples ADD COLUMN lot TEXT")
        except sqlite3.OperationalError:
            pass
        try:
            conn.execute("ALTER TABLE samples ADD COLUMN bin TEXT")
        except sqlite3.OperationalError:
            pass
        conn.execute("""
            CREATE TABLE IF NOT EXISTS settings (
                key   TEXT PRIMARY KEY,
                value TEXT NOT NULL
            )
        """)
        conn.execute("""
            CREATE TABLE IF NOT EXISTS sample_filter_index (
                sample_id  TEXT NOT NULL,
                field      TEXT NOT NULL,
                value_text TEXT,
                value_num  REAL
            )
        """)
        conn.execute("CREATE INDEX IF NOT EXISTS idx_sfi ON sample_filter_index(field, value_text, value_num)")
        conn.commit()

init_db()


# ── Helpers ───────────────────────────────────────────────────────────────────

def row_to_dict(row):
    return dict(row)

def _index_sample(conn, sample_id, layers_json, technique, substrate, lot):
    """Rebuild filter-index rows for one sample. Call inside an open transaction."""
    conn.execute("DELETE FROM sample_filter_index WHERE sample_id = ?", (sample_id,))
    rows = []

    def _add(field, text=None, num=None):
        if text is not None or num is not None:
            rows.append((sample_id, field, text, num))

    def _num(v):
        try:
            return float(v) if v not in (None, "") else None
        except (ValueError, TypeError):
            return None

    # Sample-level text fields
    if technique: _add("technique", text=str(technique).lower())
    if substrate: _add("substrate", text=str(substrate))
    if lot:       _add("lot",       text=str(lot))

    # Layer-level fields
    layers = json.loads(layers_json) if isinstance(layers_json, str) else (layers_json or [])
    for layer in layers:
        for idx_field, layer_key in [
            ("growth_temp",     "temp"),
            ("growth_pressure", "pressure"),
            ("growth_o2_pct",   "oxygen_pct"),
            ("growth_time_s",   "time_s"),
            ("thickness_nm",    "thickness_nm"),
            ("growth_freq_hz",  "frequency_hz"),
        ]:
            n = _num(layer.get(layer_key))
            if n is not None:
                _add(idx_field, num=n)

        # Custom growth params stored in layer.custom
        for k, v in (layer.get("custom") or {}).items():
            n = _num(v)
            if n is not None:
                _add(f"custom_{k}", num=n)
            elif v not in (None, ""):
                _add(f"custom_{k}", text=str(v))

        # Per-target fields (material name + numeric params)
        for target in (layer.get("targets") or []):
            mat = (target.get("material") or "").strip()
            if mat:
                _add("material", text=mat)
            for idx_field, t_key in [
                ("growth_power_w",   "power_W"),
                ("growth_energy_mj", "energy_mJ"),
                ("growth_pulses",    "pulses"),
            ]:
                n = _num(target.get(t_key))
                if n is not None:
                    _add(idx_field, num=n)
            pt = (target.get("power_type") or "").strip()
            if pt:
                _add("growth_power_type", text=pt)

    if rows:
        conn.executemany(
            "INSERT INTO sample_filter_index (sample_id, field, value_text, value_num) VALUES (?,?,?,?)",
            rows
        )

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
            "INSERT INTO folders (id, name, color, book_folder, module_folder, parent_id, sort_order) VALUES (:id, :name, :color, :book_folder, :module_folder, :parent_id, :sort_order)",
            {"id": folder["id"], "name": folder["name"], "color": folder.get("color", "#4a5568"),
             "book_folder": 1 if folder.get("book_folder") else 0,
             "module_folder": 1 if folder.get("module_folder") else 0,
             "parent_id": folder.get("parent_id") or None,
             "sort_order": folder.get("sort_order", 0)},
        )
        conn.commit()
    return {"ok": True, "id": folder["id"]}

@app.put("/api/folders/{folder_id}")
def update_folder(folder_id: str, folder: dict):
    with get_db() as conn:
        conn.execute(
            "UPDATE folders SET name=:name, color=:color, book_folder=:book_folder, module_folder=:module_folder, parent_id=:parent_id, sort_order=:sort_order WHERE id=:id",
            {"id": folder_id, "name": folder["name"], "color": folder.get("color", "#4a5568"),
             "book_folder": 1 if folder.get("book_folder") else 0,
             "module_folder": 1 if folder.get("module_folder") else 0,
             "parent_id": folder.get("parent_id") or None,
             "sort_order": folder.get("sort_order", 0)},
        )
        conn.commit()
    return {"ok": True}

@app.patch("/api/modules/{module_id}/folder")
async def update_module_folder(module_id: str, request: Request):
    """Set (or clear) the folder_id for a module by updating its schema JSON."""
    body = await request.json()
    folder_id = body.get("folder_id")  # None to ungroup
    schema_path = SCHEMAS_DIR / f"{module_id}.json"
    if not schema_path.exists():
        # Fall back to built-in schema path — create a user copy with just folder_id
        cfg = _load_schema(module_id) or {}
    else:
        cfg = json.loads(schema_path.read_text())
    if folder_id:
        cfg["folder_id"] = folder_id
    else:
        cfg.pop("folder_id", None)
    schema_path.write_text(json.dumps(cfg, indent=2))
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
        layers_json = json.dumps(sample.get("layers", []))
        conn.execute("""
            INSERT INTO samples
              (id, date, substrate, notes, thickness_nm, area_m2, area_correction,
               technique, folder_id, layers, filenames, xrd_peaks, lot, bin)
            VALUES
              (:id, :date, :substrate, :notes, :thickness_nm, :area_m2, :area_correction,
               :technique, :folder_id, :layers, :filenames, :xrd_peaks, :lot, :bin)
        """, {
            **sample,
            "technique":  sample.get("technique", "sputter"),
            "folder_id":  sample.get("folder_id"),
            "layers":     layers_json,
            "filenames":  json.dumps(sample.get("filenames", {})),
            "xrd_peaks":  json.dumps(sample.get("xrd_peaks", [])),
            "lot":        sample.get("lot"),
            "bin":        sample.get("bin"),
        })
        _index_sample(conn, sample["id"], layers_json,
                      sample.get("technique", "sputter"), sample.get("substrate"), sample.get("lot"))
        conn.commit()
    return {"ok": True, "id": sample["id"]}

@app.put("/api/samples/{sample_id}")
def update_sample(sample_id: str, sample: dict):
    with get_db() as conn:
        layers_json = json.dumps(sample.get("layers", []))
        conn.execute("""
            UPDATE samples SET
              date=:date, substrate=:substrate, notes=:notes,
              thickness_nm=:thickness_nm, area_m2=:area_m2, area_correction=:area_correction,
              technique=:technique, folder_id=:folder_id,
              layers=:layers, filenames=:filenames, xrd_peaks=:xrd_peaks,
              lot=:lot, bin=:bin
            WHERE id=:id
        """, {
            "id":         sample_id,
            "date":       sample.get("date"),
            "substrate":  sample.get("substrate"),
            "notes":      sample.get("notes"),
            "thickness_nm": sample.get("thickness_nm"),
            "area_m2":    sample.get("area_m2"),
            "area_correction": sample.get("area_correction", 1.0),
            "technique":  sample.get("technique", "sputter"),
            "folder_id":  sample.get("folder_id"),
            "layers":     layers_json,
            "filenames":  json.dumps(sample.get("filenames", {})),
            "xrd_peaks":  json.dumps(sample.get("xrd_peaks", [])),
            "lot":        sample.get("lot"),
            "bin":        sample.get("bin"),
        })
        _index_sample(conn, sample_id, layers_json,
                      sample.get("technique", "sputter"), sample.get("substrate"), sample.get("lot"))
        conn.commit()
    return {"ok": True}

@app.patch("/api/samples/{sample_id}/area-correction")
def patch_area_correction(sample_id: str, body: dict):
    factor = float(body.get("area_correction", 1.0) or 1.0)
    with get_db() as conn:
        conn.execute("UPDATE samples SET area_correction=? WHERE id=?", (factor, sample_id))
        conn.commit()
    return {"ok": True}

@app.delete("/api/samples/{sample_id}")
def delete_sample(sample_id: str):
    sample_files = FILES_DIR / sample_id
    if sample_files.exists():
        shutil.rmtree(sample_files)
    with get_db() as conn:
        conn.execute("DELETE FROM samples WHERE id=?", (sample_id,))
        conn.execute("DELETE FROM sample_filter_index WHERE sample_id=?", (sample_id,))
        conn.commit()
    return {"ok": True}


# ── Sample filter ────────────────────────────────────────────────────────────

@app.post("/api/samples/filter")
def filter_samples(body: dict):
    """Return sample IDs matching ALL supplied conditions (AND logic via INTERSECT)."""
    conditions = body.get("conditions", [])
    if not conditions:
        return {"ids": []}

    parts, params = [], []
    for cond in conditions:
        field = cond.get("field", "")
        op    = cond.get("op", "eq")
        base  = "SELECT DISTINCT sample_id FROM sample_filter_index WHERE field=?"
        if op == "between":
            parts.append(f"{base} AND value_num>=? AND value_num<=?")
            params += [field, float(cond.get("min", 0)), float(cond.get("max", 0))]
        elif op in ("gt", "gte", "lt", "lte"):
            sql_op = {"gt": ">", "gte": ">=", "lt": "<", "lte": "<="}[op]
            parts.append(f"{base} AND value_num{sql_op}?")
            params += [field, float(cond.get("value", 0))]
        elif op == "eq":
            val = cond.get("value", "")
            try:
                parts.append(f"{base} AND value_num=?")
                params += [field, float(val)]
            except (ValueError, TypeError):
                parts.append(f"{base} AND LOWER(value_text)=LOWER(?)")
                params += [field, str(val)]
        elif op == "contains":
            parts.append(f"{base} AND value_text LIKE ?")
            params += [field, f"%{cond.get('value', '')}%"]
        elif op == "neq":
            # "not equal" — samples that have the field but NOT that value
            val = cond.get("value", "")
            try:
                parts.append(f"SELECT DISTINCT sample_id FROM sample_filter_index WHERE field=? AND (value_num IS NULL OR value_num!=?)")
                params += [field, float(val)]
            except (ValueError, TypeError):
                parts.append(f"SELECT DISTINCT sample_id FROM sample_filter_index WHERE field=? AND (value_text IS NULL OR LOWER(value_text)!=LOWER(?))")
                params += [field, str(val)]

    if not parts:
        return {"ids": []}

    query = " INTERSECT ".join(parts)
    with get_db() as conn:
        rows = conn.execute(query, params).fetchall()
    return {"ids": [r[0] for r in rows]}


@app.post("/api/samples/reindex-filter")
def reindex_filter():
    """Rebuild the entire filter index from scratch (use after bulk imports or schema changes)."""
    with get_db() as conn:
        rows = conn.execute("SELECT id, technique, substrate, lot, layers FROM samples").fetchall()
        conn.execute("DELETE FROM sample_filter_index")
        for row in rows:
            _index_sample(conn, row["id"], row["layers"],
                          row["technique"], row["substrate"], row["lot"])
        conn.commit()
    return {"indexed": len(rows)}


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


@app.post("/api/samples/import-preview")
async def import_sample_preview(file: UploadFile = File(...)):
    """Read a .zip sample export and return a conflict preview without writing anything."""
    import zipfile, io as _io

    data = await file.read()
    try:
        zf = zipfile.ZipFile(_io.BytesIO(data))
    except zipfile.BadZipFile:
        raise HTTPException(400, "Not a valid zip file")

    names = zf.namelist()
    json_names = [n for n in names if n.endswith("/sample.json")]
    if not json_names:
        raise HTTPException(400, "zip does not contain sample.json")

    try:
        sample_data = json.loads(zf.read(json_names[0]))
    except Exception:
        raise HTTPException(400, "Could not parse sample.json")

    sample_id = sample_data.get("id")
    if not sample_id:
        raise HTTPException(400, "sample.json has no 'id' field")

    has_files = any("/files/" in n and not n.endswith("/") for n in names)

    with get_db() as conn:
        existing_ids = {r[0] for r in conn.execute("SELECT id FROM samples").fetchall()}

    exists = sample_id in existing_ids

    def _propose(sid):
        candidate = f"{sid}_imp"
        n = 2
        while candidate in existing_ids:
            candidate = f"{sid}_imp{n}"
            n += 1
        return candidate

    return {
        "sample": {
            "id":        sample_id,
            "name":      sample_data.get("id"),
            "technique": sample_data.get("technique", "sputter"),
            "date":      sample_data.get("date"),
            "substrate": sample_data.get("substrate"),
            "exists":    exists,
            "proposed_id": _propose(sample_id) if exists else sample_id,
            "has_files": has_files,
        }
    }


@app.post("/api/samples/import")
async def import_sample(file: UploadFile = File(...), merge: bool = False, config: str = "{}"):
    """
    Accept a .zip produced by /export.

    config JSON: { action: "overwrite"|"rename"|"skip", new_id: str }
      - action "overwrite" (default): overwrite metadata, restore missing files
      - action "rename": import under new_id instead of original
      - action "skip": no-op, return ok immediately
    merge param is kept for backward compatibility (treated as action=overwrite).
    """
    import zipfile, io as _io

    cfg = json.loads(config)
    action = cfg.get("action", "overwrite" if merge else "overwrite")
    new_id = cfg.get("new_id")  # used when action == "rename"

    data = await file.read()
    try:
        zf = zipfile.ZipFile(_io.BytesIO(data))
    except zipfile.BadZipFile:
        raise HTTPException(400, "Not a valid zip file")

    names = zf.namelist()
    json_names = [n for n in names if n.endswith("/sample.json")]
    if not json_names:
        raise HTTPException(400, "zip does not contain sample.json")

    try:
        sample_data = json.loads(zf.read(json_names[0]))
    except Exception:
        raise HTTPException(400, "Could not parse sample.json")

    original_id = sample_data.get("id")
    if not original_id:
        raise HTTPException(400, "sample.json has no 'id' field")

    # Resolve the actual import ID
    if action == "rename" and new_id:
        sample_id = new_id
    else:
        sample_id = original_id

    if action == "skip":
        return {"ok": True, "id": sample_id, "skipped": True}

    params = {
        "id":            sample_id,
        "date":          sample_data.get("date"),
        "substrate":     sample_data.get("substrate"),
        "notes":         sample_data.get("notes"),
        "thickness_nm":  sample_data.get("thickness_nm"),
        "area_m2":       sample_data.get("area_m2"),
        "area_correction": sample_data.get("area_correction", 1.0),
        "technique":     sample_data.get("technique", "sputter"),
        "layers":        json.dumps(sample_data.get("layers", [])),
        "filenames":     json.dumps(sample_data.get("filenames", {})),
        "xrd_peaks":     json.dumps(sample_data.get("xrd_peaks", [])),
        "lot":           sample_data.get("lot"),
        "bin":           sample_data.get("bin"),
    }

    with get_db() as conn:
        exists = conn.execute("SELECT id FROM samples WHERE id=?", (sample_id,)).fetchone()
        if exists and action not in ("overwrite",) and not merge:
            raise HTTPException(409, f"Sample '{sample_id}' already exists")
        if exists:
            # Overwrite: update metadata, preserve folder_id
            conn.execute("""
                UPDATE samples SET
                  date=:date, substrate=:substrate, notes=:notes,
                  thickness_nm=:thickness_nm, area_m2=:area_m2, area_correction=:area_correction,
                  technique=:technique, layers=:layers, filenames=:filenames,
                  xrd_peaks=:xrd_peaks, lot=:lot, bin=:bin
                WHERE id=:id
            """, params)
        else:
            params["folder_id"] = None  # don't transplant folder membership
            conn.execute("""
                INSERT INTO samples
                  (id, date, substrate, notes, thickness_nm, area_m2, area_correction,
                   technique, folder_id, layers, filenames, xrd_peaks, lot, bin)
                VALUES
                  (:id, :date, :substrate, :notes, :thickness_nm, :area_m2, :area_correction,
                   :technique, :folder_id, :layers, :filenames, :xrd_peaks, :lot, :bin)
            """, params)
        conn.commit()

    # Restore data files — on overwrite, skip files that already exist on disk
    file_entries = [n for n in names if "/files/" in n and not n.endswith("/")]
    dest_dir = FILES_DIR / sample_id
    files_written = 0
    files_skipped = 0
    if file_entries:
        dest_dir.mkdir(exist_ok=True)
        for entry in file_entries:
            dest = dest_dir / Path(entry).name
            if (merge or action == "overwrite") and dest.exists():
                files_skipped += 1
                continue
            dest.write_bytes(zf.read(entry))
            files_written += 1

    zf.close()
    return {"ok": True, "id": sample_id, "files_written": files_written, "files_skipped": files_skipped}


@app.get("/api/samples/{sample_id}/files")
def list_files(sample_id: str):
    """Return metadata for every file stored under this sample."""
    dest_dir = FILES_DIR / sample_id
    if not dest_dir.exists():
        return []
    files = []
    for p in sorted(dest_dir.iterdir()):
        if not p.is_file():
            continue
        stat = p.stat()
        files.append({
            "filename": p.name,
            "size_bytes": stat.st_size,
            "modified": stat.st_mtime,
        })
    return files


@app.get("/api/samples/{sample_id}/export")
def export_sample(sample_id: str):
    """
    Package the sample's DB record (sample.json) plus all uploaded files
    into a .zip archive and stream it back for download.
    """
    import zipfile, io, time
    from fastapi.responses import StreamingResponse

    with get_db() as conn:
        row = conn.execute("SELECT * FROM samples WHERE id=?", (sample_id,)).fetchone()
    if not row:
        raise HTTPException(404, "Sample not found")

    sample_data = row_to_sample(row)

    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        # 1. sample metadata as JSON
        zf.writestr(
            f"{sample_id}/sample.json",
            json.dumps(sample_data, indent=2, default=str),
        )
        # 2. all uploaded data files
        dest_dir = FILES_DIR / sample_id
        if dest_dir.exists():
            for p in sorted(dest_dir.iterdir()):
                if p.is_file():
                    zf.write(p, arcname=f"{sample_id}/files/{p.name}")

    buf.seek(0)

    def iter_zip():
        yield from iter(lambda: buf.read(65536), b"")

    safe_id = sample_id.replace("/", "_")
    return StreamingResponse(
        iter_zip(),
        media_type="application/zip",
        headers={"Content-Disposition": f'attachment; filename="{safe_id}_export.zip"'},
    )


@app.delete("/api/samples/{sample_id}/files/{filename}")
def delete_file(sample_id: str, filename: str):
    path = FILES_DIR / sample_id / filename
    if not path.exists():
        raise HTTPException(404, "File not found")
    path.unlink()
    # Remove from the sample's filenames dict if present
    with get_db() as conn:
        row = conn.execute("SELECT filenames FROM samples WHERE id=?", (sample_id,)).fetchone()
        if row:
            filenames = json.loads(row["filenames"] or "{}")
            updated = {k: v for k, v in filenames.items() if v != filename}
            conn.execute("UPDATE samples SET filenames=? WHERE id=?", (json.dumps(updated), sample_id))
            conn.commit()
    return {"ok": True}


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


# ── Module system ─────────────────────────────────────────────────────────────

@app.get("/api/modules")
def list_modules():
    """Return metadata for all registered modules, merged with visual editor config."""
    result = []
    for m in mod_registry.all_modules():
        info = m.to_info()
        cfg = _load_schema(m.id) or {}
        info["section"]          = cfg.get("section", "")
        info["card_controls"]    = cfg.get("card_controls", [])
        info["analysis_metrics"] = cfg.get("analysis_metrics", [])
        info["analysis_code"]    = cfg.get("analysis_code", "")
        info["folder_id"]        = cfg.get("folder_id", None)
        result.append(info)
    return result


@app.get("/api/modules/{module_id}/source")
def get_module_source(module_id: str):
    """Return the raw Python source of a module."""
    src = mod_registry.source(module_id)
    if src is None:
        raise HTTPException(404, f"Module '{module_id}' not found")
    # Determine built-in by file location, not author field — so imported
    # copies of built-in modules are correctly treated as user-editable.
    user_path = BASE_DIR / "data" / "user_modules" / f"{module_id}.py"
    return {
        "id":      module_id,
        "builtin": not user_path.exists(),
        "source":  src,
    }


@app.delete("/api/samples/{sample_id}/module-files/{module_id}")
def delete_module_file(sample_id: str, module_id: str):
    """Remove a module's file from a sample — deletes the file and clears the filenames entry."""
    with get_db() as conn:
        row = conn.execute("SELECT filenames FROM samples WHERE id=?", (sample_id,)).fetchone()
    if not row:
        raise HTTPException(404, "Sample not found")
    filenames = json.loads(row["filenames"] or "{}")
    filename = filenames.pop(module_id, None)
    if filename:
        fp = FILES_DIR / sample_id / filename
        if fp.exists():
            fp.unlink(missing_ok=True)
    with get_db() as conn:
        conn.execute("UPDATE samples SET filenames=? WHERE id=?", (json.dumps(filenames), sample_id))
        conn.commit()
    return {"ok": True}


@app.post("/api/samples/{sample_id}/upload-module-file")
async def upload_module_file(sample_id: str, module_id: str = Query(...), file: UploadFile = File(...)):
    """Save a data file for a module on a sample, update filenames dict. No parsing."""
    with get_db() as conn:
        row = conn.execute("SELECT filenames FROM samples WHERE id=?", (sample_id,)).fetchone()
    if not row:
        raise HTTPException(404, f"Sample '{sample_id}' not found")
    dest_dir = FILES_DIR / sample_id
    dest_dir.mkdir(exist_ok=True)
    file_bytes = await file.read()
    dest = dest_dir / f"{module_id}_{file.filename}"
    dest.write_bytes(file_bytes)
    filenames = json.loads(row["filenames"] or "{}")
    filenames[module_id] = dest.name
    with get_db() as conn:
        conn.execute("UPDATE samples SET filenames=? WHERE id=?", (json.dumps(filenames), sample_id))
        conn.commit()
    return {"ok": True, "filename": dest.name}


@app.post("/api/modules/{module_id}/parse")
async def parse_with_module(
    module_id: str,
    sample_id: str = Query(...),
    file: UploadFile = File(...),
):
    """
    Parse an uploaded file using the named module and return structured data.
    Also saves the file to disk under FILES_DIR/{sample_id}/.
    """
    m = mod_registry.get(module_id)
    if not m:
        raise HTTPException(404, f"Module '{module_id}' not found")

    file_bytes = await file.read()

    # Fetch sample meta for unit conversion
    with get_db() as conn:
        row = conn.execute("SELECT * FROM samples WHERE id=?", (sample_id,)).fetchone()
    meta = row_to_sample(row) if row else {}

    result = m.parse(file_bytes, file.filename, meta)
    if result is None:
        raise HTTPException(422, "Module could not parse this file")

    # Save file to disk (same convention as the generic upload endpoint)
    dest_dir = FILES_DIR / sample_id
    dest_dir.mkdir(exist_ok=True)
    dest = dest_dir / f"{module_id}_{file.filename}"
    dest.write_bytes(file_bytes)

    # Update sample filenames dict
    if row:
        sample = row_to_sample(row)
        filenames = sample.get("filenames", {})
        filenames[module_id] = dest.name
        with get_db() as conn:
            conn.execute(
                "UPDATE samples SET filenames=? WHERE id=?",
                (json.dumps(filenames), sample_id),
            )
            conn.commit()

    return {"ok": True, "filename": dest.name, "data": result}


@app.post("/api/modules/{module_id}/plot")
def plot_with_module(module_id: str, body: dict):
    """
    Generate a Plotly figure dict from already-parsed data.
    body: { data: {...}, meta: {...}, options: {...} }
    """
    m = mod_registry.get(module_id)
    if not m:
        raise HTTPException(404, f"Module '{module_id}' not found")
    try:
        fig = m.plot(body.get("data", {}), body.get("meta", {}), body.get("options", {}))
    except Exception as e:
        raise HTTPException(500, str(e))
    return fig


@app.put("/api/modules/{module_id}/source")
def save_module_source(module_id: str, body: dict):
    """Save / update a user module. Built-ins must be duplicated first."""
    code = body.get("source", "")
    if not code.strip():
        raise HTTPException(400, "Source cannot be empty")
    try:
        inst = mod_registry.save_user_module(module_id, code)
    except ValueError as e:
        raise HTTPException(422, str(e))
    return {"ok": True, "id": inst.id, "name": inst.name}


@app.get("/api/modules/{module_id}/export")
def export_module(module_id: str):
    """Export a module as a self-contained .labmodule.zip archive."""
    from fastapi.responses import StreamingResponse
    import zipfile, io
    from datetime import datetime, timezone

    schema      = _load_schema(module_id)
    source_code = mod_registry.source(module_id)
    example_path, _ = _find_example(module_id)
    m = mod_registry.get(module_id)

    if source_code is None and schema is None:
        raise HTTPException(404, f"Module '{module_id}' not found")

    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        manifest = {
            "module_id":   module_id,
            "name":        m.name if m else module_id,
            "exported_at": datetime.now(timezone.utc).isoformat(),
            "format":      "labmodule/1.0",
            "has_example": example_path is not None,
        }
        zf.writestr("manifest.json", json.dumps(manifest, indent=2))
        if schema:
            zf.writestr("schema.json", json.dumps(schema, indent=2))
        if source_code:
            zf.writestr("source.py", source_code)
        if example_path:
            zf.write(str(example_path), f"example{example_path.suffix}")

    buf.seek(0)
    fname = f"{module_id}.labmodule.zip"
    return StreamingResponse(
        buf,
        media_type="application/zip",
        headers={"Content-Disposition": f'attachment; filename="{fname}"'},
    )


@app.post("/api/modules/import-preview")
async def import_module_preview(file: UploadFile = File(...)):
    """Read a .labmodule.zip and return metadata + source for user review, without installing anything."""
    import zipfile, io

    data = await file.read()
    try:
        zf = zipfile.ZipFile(io.BytesIO(data))
    except zipfile.BadZipFile:
        raise HTTPException(400, "Not a valid zip file")

    names = zf.namelist()

    if "manifest.json" not in names:
        raise HTTPException(400, "Archive is missing manifest.json")
    manifest = json.loads(zf.read("manifest.json"))
    if manifest.get("format", "").split("/")[0] == "labbook":
        raise HTTPException(400, "This is a book archive — use book Import instead")

    module_id = manifest.get("module_id")
    if not module_id:
        raise HTTPException(400, "manifest.json has no module_id")

    schema = {}
    if "schema.json" in names:
        schema = json.loads(zf.read("schema.json"))

    source_code = None
    if "source.py" in names:
        source_code = zf.read("source.py").decode("utf-8")

    # Check if module already exists (user module or built-in)
    user_path    = BASE_DIR / "data" / "user_modules" / f"{module_id}.py"
    builtin_path = BASE_DIR / "modules" / f"{module_id}.py"
    exists = user_path.exists() or builtin_path.exists()

    return {
        "module_id":    module_id,
        "name":         schema.get("name", module_id),
        "version":      schema.get("version", ""),
        "author":       schema.get("author", ""),
        "description":  schema.get("description", ""),
        "accepts":      schema.get("accepts", []),
        "dependencies": schema.get("dependencies", []),
        "exists":       exists,
        "builtin":      builtin_path.exists(),
        "source_code":  source_code,
    }


@app.post("/api/modules/import")
async def import_module(file: UploadFile = File(...), config: str = "{}"):
    """Import a .labmodule.zip archive — installs source, schema, and example file.
    config JSON: { action: "overwrite"|"rename"|"skip", new_id: str }
    """
    import zipfile, io

    cfg = json.loads(config)
    action = cfg.get("action", "overwrite")
    new_id = cfg.get("new_id")

    data = await file.read()
    try:
        zf = zipfile.ZipFile(io.BytesIO(data))
    except zipfile.BadZipFile:
        raise HTTPException(400, "Not a valid zip file")

    names = zf.namelist()

    # Read manifest to get module_id
    if "manifest.json" not in names:
        raise HTTPException(400, "Archive is missing manifest.json")
    manifest = json.loads(zf.read("manifest.json"))
    original_id = manifest.get("module_id")
    if not original_id:
        raise HTTPException(400, "manifest.json has no module_id")

    if action == "rename" and new_id:
        module_id = new_id
    else:
        module_id = original_id

    if action == "skip":
        return {"ok": True, "module_id": module_id, "skipped": True}

    installed = []

    # Install Python source
    if "source.py" in names:
        source_code = zf.read("source.py").decode("utf-8")
        try:
            mod_registry.save_user_module(module_id, source_code)
            installed.append("source")
        except ValueError as e:
            raise HTTPException(422, f"Invalid module source: {e}")

    # Install schema / config (update module_id in schema if renamed)
    if "schema.json" in names:
        schema = json.loads(zf.read("schema.json"))
        if action == "rename" and new_id:
            schema["id"] = new_id
        schema_path = SCHEMAS_DIR / f"{module_id}.json"
        schema_path.write_text(json.dumps(schema, indent=2))
        installed.append("schema")

    # Install example data file
    example_entries = [n for n in names if n.startswith("example.")]
    if example_entries:
        entry = example_entries[0]
        ext   = Path(entry).suffix
        for old in EXAMPLES_DIR.glob(f"{module_id}.*"):
            old.unlink()
        dest = EXAMPLES_DIR / f"{module_id}{ext}"
        dest.write_bytes(zf.read(entry))
        installed.append("example")

    return {"ok": True, "module_id": module_id, "installed": installed}


@app.get("/api/books/{book_id}/export")
def export_book(book_id: str, include_files: bool = True):
    """Export an analysis book as a zip — includes book config, sample metadata,
    referenced module schemas/source, and optionally sample data files."""
    from fastapi.responses import StreamingResponse
    import zipfile, io
    from datetime import datetime, timezone

    with get_db() as conn:
        row = conn.execute("SELECT * FROM analysis_books WHERE id=?", (book_id,)).fetchone()
    if not row:
        raise HTTPException(404, "Book not found")

    book = row_to_book(row)
    sample_ids = book.get("sample_ids") or []
    if not sample_ids and book.get("config", {}).get("sample_order"):
        sample_ids = book["config"]["sample_order"]

    # Collect samples
    samples_data = []
    with get_db() as conn:
        for sid in sample_ids:
            srow = conn.execute("SELECT * FROM samples WHERE id=?", (sid,)).fetchone()
            if srow:
                samples_data.append(row_to_sample(srow))

    # Collect module IDs referenced by any sample's filenames
    module_ids = set()
    for s in samples_data:
        module_ids.update(s.get("filenames", {}).keys())

    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        manifest = {
            "book_id": book_id,
            "book_name": book["name"],
            "exported_at": datetime.now(timezone.utc).isoformat(),
            "format": "labbook/1.0",
            "sample_ids": sample_ids,
            "module_ids": list(module_ids),
            "include_files": include_files,
        }
        zf.writestr("manifest.json", json.dumps(manifest, indent=2))
        zf.writestr("book.json", json.dumps(book, indent=2, default=str))

        # Samples
        for s in samples_data:
            sid = s["id"]
            zf.writestr(f"samples/{sid}/metadata.json", json.dumps(s, indent=2, default=str))
            if include_files:
                sdir = FILES_DIR / sid
                if sdir.exists():
                    for p in sorted(sdir.iterdir()):
                        if p.is_file():
                            zf.write(str(p), f"samples/{sid}/files/{p.name}")

        # Modules
        for mid in module_ids:
            schema = _load_schema(mid)
            if schema:
                zf.writestr(f"modules/{mid}/schema.json", json.dumps(schema, indent=2))
            src = mod_registry.source(mid)
            if src:
                zf.writestr(f"modules/{mid}/source.py", src)
            ex_path, _ = _find_example(mid)
            if ex_path:
                zf.write(str(ex_path), f"modules/{mid}/example{ex_path.suffix}")

    buf.seek(0)
    fname = f"{book['name'].replace(' ', '_')}.labbook.zip"
    return StreamingResponse(
        buf,
        media_type="application/zip",
        headers={"Content-Disposition": f'attachment; filename="{fname}"'},
    )


@app.post("/api/books/import-preview")
async def import_book_preview(file: UploadFile = File(...)):
    """Read a .labbook.zip and return a preview of what would be imported, without writing anything."""
    import zipfile, io as _io

    data = await file.read()
    try:
        zf = zipfile.ZipFile(_io.BytesIO(data))
    except zipfile.BadZipFile:
        raise HTTPException(400, "Not a valid zip file")

    names = zf.namelist()
    if "manifest.json" not in names:
        raise HTTPException(400, "Not a valid .labbook.zip (missing manifest.json)")
    manifest = json.loads(zf.read("manifest.json"))
    if manifest.get("format", "").split("/")[0] != "labbook":
        raise HTTPException(400, "This zip is not a book export (use module Import for .labmodule.zip)")

    book = json.loads(zf.read("book.json")) if "book.json" in names else {}

    # Check each sample for conflicts
    sample_entries = {}
    for n in names:
        parts = n.split("/")
        if len(parts) >= 3 and parts[0] == "samples" and parts[2] == "metadata.json":
            sid = parts[1]
            meta = json.loads(zf.read(n))
            sample_entries[sid] = meta

    with get_db() as conn:
        existing_ids = {r[0] for r in conn.execute("SELECT id FROM samples").fetchall()}

    def _propose(sid):
        candidate = f"{sid}_imp"
        n = 2
        while candidate in existing_ids or candidate in {v["proposed_id"] for v in samples_preview if "proposed_id" in v}:
            candidate = f"{sid}_imp{n}"
            n += 1
        return candidate

    samples_preview = []
    for sid, meta in sample_entries.items():
        exists = sid in existing_ids
        entry = {"original_id": sid, "exists": exists, "has_files": any(f"samples/{sid}/files/" in n for n in names)}
        if exists:
            entry["proposed_id"] = _propose(sid)
        else:
            entry["proposed_id"] = sid
        samples_preview.append(entry)

    return {
        "book": {"id": book.get("id", ""), "name": book.get("name", "Imported Book")},
        "samples": samples_preview,
        "modules": manifest.get("module_ids", []),
        "has_files": manifest.get("include_files", False),
    }


@app.post("/api/books/import")
async def import_book(file: UploadFile = File(...), config: str = "{}"):
    """Import a .labbook.zip. config is a JSON string: { sample_renames, create_folder, folder_name }"""
    import zipfile, io as _io

    cfg = json.loads(config)
    sample_renames = cfg.get("sample_renames", {})   # { original_id: new_id }
    create_folder = cfg.get("create_folder", False)
    folder_name = cfg.get("folder_name", "Imported")

    data = await file.read()
    try:
        zf = zipfile.ZipFile(_io.BytesIO(data))
    except zipfile.BadZipFile:
        raise HTTPException(400, "Not a valid zip file")

    names = zf.namelist()
    book = json.loads(zf.read("book.json")) if "book.json" in names else {}

    # Create folder for new samples if requested
    folder_id = None
    if create_folder:
        folder_id = str(int(__import__("time").time() * 1000))
        with get_db() as conn:
            conn.execute(
                "INSERT INTO folders (id, name, color, book_folder, module_folder, sort_order) VALUES (?, ?, ?, 0, 0, 0)",
                (folder_id, folder_name, "#4a5568")
            )
            conn.commit()

    # Import modules
    module_dirs = set()
    for n in names:
        parts = n.split("/")
        if len(parts) >= 2 and parts[0] == "modules":
            module_dirs.add(parts[1])

    for mid in module_dirs:
        if not mid:
            continue
        if f"modules/{mid}/schema.json" in names:
            schema = json.loads(zf.read(f"modules/{mid}/schema.json"))
            (SCHEMAS_DIR / f"{mid}.json").write_text(json.dumps(schema, indent=2))
        if f"modules/{mid}/source.py" in names:
            src = zf.read(f"modules/{mid}/source.py").decode("utf-8")
            try:
                mod_registry.save_user_module(mid, src)
            except Exception:
                pass
        ex_entries = [n for n in names if n.startswith(f"modules/{mid}/example.")]
        if ex_entries:
            ext = Path(ex_entries[0]).suffix
            for old in EXAMPLES_DIR.glob(f"{mid}.*"):
                old.unlink()
            (EXAMPLES_DIR / f"{mid}{ext}").write_bytes(zf.read(ex_entries[0]))

    # Import samples
    created = []
    renamed = []
    skipped = []

    sample_dirs = set()
    for n in names:
        parts = n.split("/")
        if len(parts) >= 3 and parts[0] == "samples" and parts[2] == "metadata.json":
            sample_dirs.add(parts[1])

    with get_db() as conn:
        existing_ids = {r[0] for r in conn.execute("SELECT id FROM samples").fetchall()}

    id_map = {}  # original_id -> actual_id used
    for orig_id in sample_dirs:
        new_id = sample_renames.get(orig_id, orig_id)
        id_map[orig_id] = new_id
        if new_id in existing_ids:
            skipped.append(orig_id)
            continue
        meta = json.loads(zf.read(f"samples/{orig_id}/metadata.json"))
        meta["id"] = new_id
        meta["folder_id"] = folder_id
        with get_db() as conn:
            conn.execute("""
                INSERT OR IGNORE INTO samples
                  (id, date, substrate, notes, thickness_nm, area_m2, area_correction,
                   technique, folder_id, layers, filenames, xrd_peaks, lot, bin)
                VALUES
                  (:id, :date, :substrate, :notes, :thickness_nm, :area_m2, :area_correction,
                   :technique, :folder_id, :layers, :filenames, :xrd_peaks, :lot, :bin)
            """, {
                "id": new_id,
                "date": meta.get("date"),
                "substrate": meta.get("substrate"),
                "notes": meta.get("notes"),
                "thickness_nm": meta.get("thickness_nm"),
                "area_m2": meta.get("area_m2"),
                "area_correction": meta.get("area_correction", 1.0),
                "technique": meta.get("technique", "sputter"),
                "folder_id": folder_id,
                "layers": json.dumps(meta.get("layers", [])),
                "filenames": json.dumps(meta.get("filenames", {})),
                "xrd_peaks": json.dumps(meta.get("xrd_peaks", [])),
                "lot": meta.get("lot"),
                "bin": meta.get("bin"),
            })
            conn.commit()
        # Restore data files
        file_entries = [n for n in names if n.startswith(f"samples/{orig_id}/files/") and not n.endswith("/")]
        if file_entries:
            dest_dir = FILES_DIR / new_id
            dest_dir.mkdir(exist_ok=True)
            for entry in file_entries:
                dest = dest_dir / Path(entry).name
                dest.write_bytes(zf.read(entry))
        if orig_id != new_id:
            renamed.append({"original": orig_id, "new": new_id})
        else:
            created.append(new_id)

    # Import book — update sample IDs if any were renamed
    book_sample_ids = book.get("sample_ids") or []
    remapped_ids = [id_map.get(sid, sid) for sid in book_sample_ids]

    book_cfg = book.get("config", {})
    if "sample_order" in book_cfg:
        book_cfg["sample_order"] = [id_map.get(sid, sid) for sid in book_cfg["sample_order"]]

    book_id = book.get("id") or str(int(__import__("time").time() * 1000))
    with get_db() as conn:
        existing_book = conn.execute("SELECT id FROM analysis_books WHERE id=?", (book_id,)).fetchone()
        if existing_book:
            book_id = f"{book_id}_imp"
        conn.execute(
            "INSERT INTO analysis_books (id, name, sample_ids, config) VALUES (?, ?, ?, ?)",
            (book_id, book.get("name", "Imported Book"), json.dumps(remapped_ids), json.dumps(book_cfg))
        )
        conn.commit()

    return {
        "ok": True,
        "book_id": book_id,
        "created": created,
        "renamed": renamed,
        "skipped": skipped,
        "folder_id": folder_id,
    }


@app.delete("/api/modules/{module_id}")
def delete_module(module_id: str):
    """Delete a user module. Built-ins cannot be deleted."""
    try:
        mod_registry.delete_user_module(module_id)
    except ValueError as e:
        raise HTTPException(403, str(e))
    except FileNotFoundError as e:
        raise HTTPException(404, str(e))
    return {"ok": True}


# ── Module example-file & config endpoints ────────────────────────────────────

COMMENT_CHARS = ('#', ';', '!')


def _sniff_file(file_bytes: bytes, delimiter: str = "auto",
                skip_rows: Optional[int] = None) -> dict:
    """Parse raw bytes and return a preview structure for the visual editor."""
    text = file_bytes.decode("utf-8", errors="replace")
    raw_lines = text.splitlines()

    # Detect delimiter by majority vote over first 20 non-comment, non-blank lines
    det_delim = delimiter
    if det_delim == "auto":
        counts: dict = {"\t": 0, ",": 0, ";": 0, None: 0}
        checked = 0
        for line in raw_lines:
            s = line.strip()
            if not s or s[0] in COMMENT_CHARS:
                continue
            # Skip lines that are mostly non-ASCII (binary preamble)
            ascii_ratio = sum(1 for c in s if ord(c) < 128) / len(s)
            if ascii_ratio < 0.5:
                continue
            if "\t" in s:
                counts["\t"] += 1
            elif "," in s:
                counts[","] += 1
            elif ";" in s:
                counts[";"] += 1
            else:
                counts[None] += 1
            checked += 1
            if checked >= 20:
                break
        if checked == 0:
            det_delim = ","
        else:
            det_delim = max(counts, key=lambda k: counts[k])

    def split_line(line):
        s = line.strip()
        if det_delim:
            return [c.strip().strip("\"'") for c in s.split(det_delim)]
        return s.split()

    # Classify lines
    data_rows = []
    for line in raw_lines:
        s = line.strip()
        if not s or s[0] in COMMENT_CHARS:
            continue
        data_rows.append(split_line(line))

    def is_numeric_row(cells):
        if not cells:
            return False
        ok = sum(1 for c in cells if c not in ("", "nan", "inf")
                 and _try_float(c) is not None)
        return ok / len(cells) > 0.5

    def _try_float(v):
        try:
            return float(v)
        except (ValueError, TypeError):
            return None

    # Auto-detect skip_rows: first row index where majority of cells are numeric
    auto_skip = 0
    headers: list = []
    if skip_rows is None:
        for i, row in enumerate(data_rows[:200]):
            if is_numeric_row(row):
                auto_skip = i
                if i > 0:
                    headers = data_rows[i - 1]
                break
    else:
        auto_skip = skip_rows
        if skip_rows > 0 and data_rows:
            headers = data_rows[min(skip_rows - 1, len(data_rows) - 1)]

    preview_rows = [r for r in data_rows[auto_skip: auto_skip + 20]]
    num_cols = max((len(r) for r in preview_rows), default=0)

    # Normalise headers to num_cols length
    headers = list(headers)
    while len(headers) < num_cols:
        headers.append(f"col_{len(headers)}")
    headers = headers[:num_cols]

    # Extract key-value metadata from header rows (before the data section).
    # Skip the last pre-data row if it was used as column headers.
    meta_rows = data_rows[:auto_skip - 1] if auto_skip > 0 and headers else data_rows[:auto_skip]
    header_meta = []
    for row in meta_rows:
        if len(row) != 2:
            continue
        key, val = row[0], row[1]
        if not key or not val:
            continue
        # Strip leading replacement characters from binary preamble artifacts
        clean_key = key.lstrip("\ufffd").lstrip()
        # Require key starts with an ASCII letter
        if not clean_key or not (clean_key[0].isascii() and clean_key[0].isalpha()):
            continue
        header_meta.append({"key": clean_key.rstrip(":").strip(), "value": val.strip()})

    return {
        "delimiter": det_delim if det_delim else "whitespace",
        "skip_rows": auto_skip,
        "headers": headers,
        "preview_rows": preview_rows,
        "num_cols": num_cols,
        "total_lines": len(raw_lines),
        "header_meta": header_meta,
    }


@app.post("/api/modules/{module_id}/example")
async def upload_module_example(module_id: str, file: UploadFile,
                                delimiter: str = "auto"):
    """Upload and store an example data file for a module, return sniff preview."""
    file_bytes = await file.read()
    ext = Path(file.filename).suffix or ".csv"

    # Remove any existing example for this module
    for old in EXAMPLES_DIR.glob(f"{module_id}.*"):
        old.unlink()

    dest = EXAMPLES_DIR / f"{module_id}{ext}"
    dest.write_bytes(file_bytes)

    sniff = _sniff_file(file_bytes, delimiter)
    return {"ok": True, "filename": file.filename, "stored": dest.name, **sniff}


@app.get("/api/modules/{module_id}/example")
def get_module_example(module_id: str, delimiter: str = "auto",
                       skip_rows: Optional[int] = None):
    """Return sniff preview of the stored example file."""
    f, _ = _find_example(module_id)
    if not f:
        raise HTTPException(404, f"No example file for module '{module_id}'")
    sniff = _sniff_file(f.read_bytes(), delimiter, skip_rows)
    return {"filename": f.name, **sniff}


@app.delete("/api/modules/{module_id}/example")
def delete_module_example(module_id: str):
    """Delete the user-uploaded example file for a module (built-in examples are not deleted)."""
    files = list(EXAMPLES_DIR.glob(f"{module_id}.*"))
    if not files:
        raise HTTPException(404, "No user-uploaded example file found")
    for f in files:
        f.unlink()
    return {"ok": True}


@app.get("/api/modules/{module_id}/config")
def get_module_config(module_id: str):
    """Return the visual editor config JSON for a module."""
    schema = _load_schema(module_id)
    return schema if schema is not None else {}


@app.put("/api/modules/{module_id}/config")
def save_module_config(module_id: str, body: dict):
    """Save the visual editor config JSON for a module."""
    path = SCHEMAS_DIR / f"{module_id}.json"
    path.write_text(json.dumps(body, indent=2))
    return {"ok": True}


def _json_safe(obj):
    """Recursively convert obj to a JSON-serialisable form."""
    if obj is None or isinstance(obj, (bool, int, float, str)):
        return obj
    if isinstance(obj, dict):
        return {str(k): _json_safe(v) for k, v in obj.items()}
    if isinstance(obj, (list, tuple)):
        return [_json_safe(v) for v in obj]
    # numpy support (optional)
    try:
        import numpy as np
        if isinstance(obj, np.ndarray):
            return obj.tolist()
        if isinstance(obj, (np.integer, np.floating)):
            return obj.item()
    except ImportError:
        pass
    return str(obj)


@app.post("/api/modules/{module_id}/run-processing")
def run_module_processing(module_id: str, body: dict):
    """Execute processing code against the stored example file and return the result."""
    import traceback as tb
    code = body.get("code", "")
    f, _ = _find_example(module_id)
    if not f:
        raise HTTPException(404, "No example file for this module")
    file_bytes = f.read_bytes()
    filename   = f.name
    # Wrap user code (which uses `return`) in a function
    indented = "\n".join(f"    {line}" for line in code.splitlines())
    wrapped  = f"def _proc(file_bytes, filename, meta):\n{indented}\n"
    namespace: dict = {"file_bytes": file_bytes, "filename": filename, "meta": {}}
    try:
        exec(compile(wrapped, "<processing>", "exec"), namespace)   # noqa: S102
        result = namespace["_proc"](file_bytes, filename, {})
        return {"ok": True, "result": _json_safe(result)}
    except Exception as exc:
        return {"ok": False, "error": str(exc), "traceback": tb.format_exc()}


@app.post("/api/modules/{module_id}/preview-plot")
def preview_module_plot(module_id: str, body: dict):
    """Run processing code, then build a Plotly figure from visual plot config."""
    import traceback as tb
    code       = body.get("code", "")
    plot_cfg   = body.get("plot_config", {})
    x_var      = plot_cfg.get("x_var") or "x"
    y_var      = plot_cfg.get("y_var") or "y"
    color      = plot_cfg.get("color") or "#94a3b8"
    opacity    = float(plot_cfg.get("opacity") or 1.0)
    show_fit   = plot_cfg.get("show_fit", True)
    fit_color  = plot_cfg.get("fit_color") or None
    fit_opacity= float(plot_cfg.get("fit_opacity") or 0.6)
    x_scale    = plot_cfg.get("x_scale") or "linear"
    y_scale    = plot_cfg.get("y_scale") or "linear"

    f, _ = _find_example(module_id)
    if not f:
        raise HTTPException(404, "No example file for this module")
    file_bytes = f.read_bytes()
    filename   = f.name
    # Run processing code
    indented = "\n".join(f"    {line}" for line in code.splitlines())
    wrapped  = f"def _proc(file_bytes, filename, meta):\n{indented}\n"
    namespace: dict = {"file_bytes": file_bytes, "filename": filename, "meta": {}}
    try:
        exec(compile(wrapped, "<processing>", "exec"), namespace)   # noqa: S102
        data = namespace["_proc"](file_bytes, filename, {})
    except Exception as exc:
        return {"ok": False, "stage": "processing", "error": str(exc), "traceback": tb.format_exc()}
    if not isinstance(data, dict):
        return {"ok": False, "stage": "plot", "error": "Processing result must be a dict"}
    # Extract x/y arrays from result — handle both lists and numpy arrays
    import numpy as np
    def _to_list(v):
        if isinstance(v, np.ndarray):
            return v.tolist()
        return v if isinstance(v, list) else list(v)

    def _is_numeric_array(v):
        if isinstance(v, np.ndarray):
            return v.ndim == 1 and np.issubdtype(v.dtype, np.number) and len(v) > 0
        return isinstance(v, list) and v and isinstance(v[0], (int, float))

    x_data = data.get(x_var)
    y_data = data.get(y_var)
    missing = (x_data is None or (hasattr(x_data, '__len__') and len(x_data) == 0))
    missing = missing or (y_data is None or (hasattr(y_data, '__len__') and len(y_data) == 0))
    if missing:
        available = [k for k, v in data.items() if _is_numeric_array(v)]
        return {"ok": False, "stage": "plot",
                "error": f"Variable '{x_var}' or '{y_var}' not found or empty. "
                         f"Available array keys: {available}"}
    x_data = _to_list(x_data)
    y_data = _to_list(y_data)
    # Derive axis labels: prefer explicit config, fall back to result metadata
    x_label = plot_cfg.get("x_label") or data.get("x_label") or x_var
    y_label = plot_cfg.get("y_label") or data.get("y_label") or y_var

    traces = [{
        "x": x_data, "y": y_data,
        "type": "scatter", "mode": "lines",
        "opacity": opacity,
        "line": {"color": color, "width": 1.5},
        "hovertemplate": f"%{{x:.3g}} {x_label}<br>%{{y:.3g}} {y_label}<extra></extra>",
    }]
    # Fit overlay — add if x_fit/y_fit in result and show_fit is True
    if show_fit and data.get("x_fit") and data.get("y_fit"):
        traces.append({
            "x": _to_list(data["x_fit"]), "y": _to_list(data["y_fit"]),
            "type": "scatter", "mode": "lines",
            "opacity": fit_opacity,
            "line": {"color": fit_color or color, "width": 1.5, "dash": "dash"},
            "hovertemplate": f"fit %{{x:.3g}} {x_label}<br>%{{y:.3g}} {y_label}<extra></extra>",
        })

    figure = {
        "data": traces,
        "layout": {
            "xaxis": {"title": x_label, "type": x_scale, "zeroline": True, "zerolinewidth": 1},
            "yaxis": {"title": y_label, "type": y_scale, "zeroline": True, "zerolinewidth": 1},
            "margin": {"t": 20, "r": 20, "b": 56, "l": 72},
            "showlegend": False, "hovermode": "closest",
        },
        "available_vars": [k for k, v in data.items() if _is_numeric_array(v)],
    }
    return {"ok": True, "figure": figure}


@app.post("/api/modules/{module_id}/render-for-sample")
def render_for_sample(module_id: str, body: dict):
    """
    Run processing code against a sample's actual data file, build a Plotly figure.
    Body: { sample_id, proc_code, plot_config, options }
    options are merged into plot_config (overrides x_var/y_var etc. for card controls).
    """
    import traceback as tb
    sample_id  = body.get("sample_id", "")
    proc_code  = body.get("proc_code", "")
    plot_cfg   = {**(body.get("plot_config") or {}), **(body.get("options") or {})}
    x_var   = plot_cfg.get("x_var") or "x"
    y_var   = plot_cfg.get("y_var") or "y"
    color   = plot_cfg.get("color") or "#94a3b8"
    x_scale = plot_cfg.get("x_scale") or "linear"
    y_scale = plot_cfg.get("y_scale") or "linear"

    # Find the sample's file for this module
    sample_dir = FILES_DIR / sample_id
    if not sample_dir.is_dir():
        raise HTTPException(404, f"No data directory for sample '{sample_id}'")

    # Look for a file matching the module_id key in filenames
    with get_db() as conn:
        row = conn.execute("SELECT filenames, thickness_nm, area_m2 FROM samples WHERE id=?", (sample_id,)).fetchone()
    if not row:
        raise HTTPException(404, f"Sample '{sample_id}' not found")
    filenames   = json.loads(row["filenames"] or "{}")
    thickness   = row["thickness_nm"] or 0.0
    area        = row["area_m2"]
    filename    = filenames.get(module_id)
    if not filename:
        return {"ok": False, "error": f"No file for module '{module_id}' on sample '{sample_id}'"}
    file_path = sample_dir / filename
    if not file_path.exists():
        return {"ok": False, "error": f"File not found: {filename}"}
    file_bytes = file_path.read_bytes()
    area_correction = float((body.get("options") or {}).get("area_correction", 1.0) or 1.0)
    meta = {"thickness_nm": thickness, "area_m2": area, "area_correction": area_correction}

    # Run processing code
    indented = "\n".join(f"    {line}" for line in proc_code.splitlines())
    wrapped  = f"def _proc(file_bytes, filename, meta):\n{indented}\n"
    namespace: dict = {}
    try:
        exec(compile(wrapped, "<processing>", "exec"), namespace)   # noqa: S102
        data = namespace["_proc"](file_bytes, filename, meta)
    except Exception as exc:
        return {"ok": False, "stage": "processing", "error": str(exc), "traceback": tb.format_exc()}
    if not isinstance(data, dict):
        return {"ok": False, "stage": "plot", "error": "Processing result must be a dict"}

    x_data = data.get(x_var)
    y_data = data.get(y_var)
    if not x_data or not y_data:
        available = [k for k, v in data.items() if isinstance(v, list) and v and isinstance(v[0], (int, float))]
        return {"ok": False, "stage": "plot",
                "error": f"Variable '{x_var}' or '{y_var}' not found. Available: {available}"}
    x_label = plot_cfg.get("x_label") or data.get("x_label") or x_var
    y_label = plot_cfg.get("y_label") or data.get("y_label") or y_var
    result_area = data.get("area_m2")
    return {
        "ok": True,
        "x": _json_safe(x_data),
        "y": _json_safe(y_data),
        "x_label": x_label,
        "y_label": y_label,
        "color": color,
        "area_m2": result_area,
    }


@app.post("/api/modules/{module_id}/compute-analysis-for-sample")
def compute_module_analysis_for_sample(module_id: str, body: dict):
    """Run proc_code + analysis_code against a sample's actual data file."""
    import traceback as tb
    sample_id     = body.get("sample_id", "")
    proc_code     = body.get("proc_code", "")
    analysis_code = body.get("analysis_code", "")

    with get_db() as conn:
        row = conn.execute("SELECT filenames, thickness_nm, area_m2, area_correction FROM samples WHERE id=?", (sample_id,)).fetchone()
    if not row:
        raise HTTPException(404, f"Sample '{sample_id}' not found")
    filenames    = json.loads(row["filenames"] or "{}")
    thickness    = row["thickness_nm"] or 0.0
    area         = row["area_m2"]
    area_corr    = float(row["area_correction"] or 1.0)
    filename     = filenames.get(module_id)
    if not filename:
        return {"ok": False, "error": f"No file for module '{module_id}' on sample '{sample_id}'"}
    file_path = FILES_DIR / sample_id / filename
    if not file_path.exists():
        return {"ok": False, "error": f"File not found: {filename}"}
    file_bytes = file_path.read_bytes()
    meta = {"thickness_nm": thickness, "area_m2": area, "area_correction": area_corr}

    indented = "\n".join(f"    {line}" for line in proc_code.splitlines())
    wrapped  = f"def _proc(file_bytes, filename, meta):\n{indented}\n"
    namespace: dict = {}
    try:
        exec(compile(wrapped, "<processing>", "exec"), namespace)   # noqa: S102
        result = namespace["_proc"](file_bytes, filename, meta)
    except Exception as exc:
        return {"ok": False, "stage": "processing", "error": str(exc), "traceback": tb.format_exc()}
    if not isinstance(result, dict):
        return {"ok": False, "stage": "processing", "error": "Processing result must be a dict"}

    indented2 = "\n".join(f"    {line}" for line in analysis_code.splitlines())
    wrapped2  = f"def _analysis(result):\n{indented2}\n"
    namespace2: dict = {}
    try:
        exec(compile(wrapped2, "<analysis>", "exec"), namespace2)   # noqa: S102
        metrics = namespace2["_analysis"](result)
    except Exception as exc:
        return {"ok": False, "stage": "analysis", "error": str(exc), "traceback": tb.format_exc()}
    if not isinstance(metrics, dict):
        return {"ok": False, "stage": "analysis", "error": "Analysis code must return a dict"}

    return {"ok": True, "values": _json_safe(metrics)}


@app.post("/api/modules/{module_id}/compute-analysis")
def compute_module_analysis(module_id: str, body: dict):
    """Run processing code then analysis code; return computed metric values."""
    import traceback as tb
    proc_code     = body.get("proc_code", "")
    analysis_code = body.get("analysis_code", "")

    f, _ = _find_example(module_id)
    if not f:
        raise HTTPException(404, "No example file for this module")
    file_bytes = f.read_bytes()
    filename   = f.name

    # Run processing code
    indented = "\n".join(f"    {line}" for line in proc_code.splitlines())
    wrapped  = f"def _proc(file_bytes, filename, meta):\n{indented}\n"
    namespace: dict = {}
    try:
        exec(compile(wrapped, "<processing>", "exec"), namespace)   # noqa: S102
        result = namespace["_proc"](file_bytes, filename, {})
    except Exception as exc:
        return {"ok": False, "stage": "processing", "error": str(exc), "traceback": tb.format_exc()}
    if not isinstance(result, dict):
        return {"ok": False, "stage": "processing", "error": "Processing result must be a dict"}

    # Run analysis code — wrap in a function that receives `result` and must return a dict
    indented2 = "\n".join(f"    {line}" for line in analysis_code.splitlines())
    wrapped2  = f"def _analysis(result):\n{indented2}\n"
    namespace2: dict = {}
    try:
        exec(compile(wrapped2, "<analysis>", "exec"), namespace2)   # noqa: S102
        metrics = namespace2["_analysis"](result)
    except Exception as exc:
        return {"ok": False, "stage": "analysis", "error": str(exc), "traceback": tb.format_exc()}
    if not isinstance(metrics, dict):
        return {"ok": False, "stage": "analysis", "error": "Analysis code must return a dict"}

    return {"ok": True, "values": _json_safe(metrics)}


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
