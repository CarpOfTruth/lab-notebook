# LabLog — Claude Code Guide

Local lab notebook for ferroelectric oxide thin film growth and characterization.
FastAPI backend + React (Vite) frontend, SQLite database, no cloud dependencies.

---

## Repository layout

```
backend/
  main.py              # All API routes (FastAPI, ~800 lines)
  modules/
    base.py            # LabModule ABC — the module interface
    pe.py              # P-E loop built-in module
    __init__.py        # Registry: loads built-ins + user_modules/
  data/
    lablog.db          # SQLite database
    files/{sample_id}/ # Raw data files per sample
    module_schemas/    # JSON schema for each module (e.g. pe.json)
    module_examples/   # Example files shown on the module detail page
    user_modules/      # User-created .py module files (gitignored)
frontend/
  src/LabLog.jsx       # Entire UI (~9000 lines, one file)
```

## Running locally

```bash
# Terminal 1 — backend
cd backend && ../.venv/bin/uvicorn main:app --reload --port 8000

# Terminal 2 — frontend
cd frontend && npm run dev        # Vite dev server on :5173
```

Or use the launch.json configurations in the preview tools.

---

## Architecture

### Backend

- **FastAPI** on port 8000. All routes prefixed `/api/`.
- **SQLite** at `backend/data/lablog.db`. Schema defined in `init_db()` in `main.py`.
- **Files** stored at `backend/data/files/{sample_id}/`. Filenames tracked in `samples.filenames` (JSON dict `{ module_id: filename }`).
- **Module registry** (`backend/modules/__init__.py`): auto-loads all `LabModule` subclasses from `modules/` and `data/user_modules/`. Dynamic loading via `importlib.util` with `mod.__package__ = "modules"` and manual `sys.modules` seeding to resolve relative imports.

### Frontend

- **Single file**: `frontend/src/LabLog.jsx`. All components, hooks, and state live here.
- **Theme**: `T` is a module-level variable (not a React context). Set by `const T = darkMode ? DARK_T : LIGHT_T` at the top of the `App` component. Always use `T.*` for colors — never hardcode hex.
- **Key theme tokens**: `T.bg0/bg1/bg2/bg3`, `T.textPrimary/textSecondary/textDim`, `T.border/borderBright`, `T.amber/teal/blue/red`, `T.accent`.
- **API calls**: `api(method, path, body?)` helper at the top of the file — returns parsed JSON or throws.
- **Plot data**: cached in `plotCache[sampleId][measType]` (e.g. `plotCache["SP025"]["pe"]`).
- **Navigation**: three top-level views controlled by `active` (sample id), `activeBook` (book id), `activeModule` (module id or `"__new__"`). Null = main list.

### Module system

Every measurement type is a `LabModule` subclass (`backend/modules/base.py`):

```python
class MyModule(LabModule):
    id          = "my_module"   # snake_case, unique
    name        = "My Module"
    description = "One line"
    accepts     = [".csv", ".txt"]
    version     = "1.0"
    author      = "built-in"   # or your name

    def parse(self, file_bytes, filename, meta) -> dict:
        # meta keys: thickness_nm, area_m2, technique
        # Return JSON-serialisable dict; None = parse failure
        ...

    def plot(self, data, meta, options) -> dict:
        # Return Plotly figure dict: {"data": [...], "layout": {...}}
        ...
```

Schema JSON lives at `backend/data/module_schemas/{id}.json` (optional, drives the Overview tab on the module detail page). Example file at `backend/data/module_examples/{id}_example.*`.

---

## Key conventions

- **Branch**: all active development on `dev`. Do not commit to `main` — another collaborator uses it.
- **No new files unless necessary.** Edit existing files; avoid file bloat.
- **No speculative abstractions.** Implement exactly what was asked.
- **T is module-level** in LabLog.jsx — never call `useTheme()` or try to import T. It's already in scope everywhere in the file.
- **`moduleSource` state** is the old source-modal approach (now superseded by `activeModule` navigation). Don't re-add modal-based source viewing.
- Python 3.9 compatibility: use `Optional[X]` from `typing`, not `X | None`.

---

## Database schema (key tables)

```sql
samples (id, date, substrate, notes, thickness_nm, area_m2, area_correction,
         technique, folder_id, layers, filenames, lot, bin, created_at)

folders (id, name, color, book_folder, created_at)

analysis_books (id, name, sample_ids, panels, folder_id, created_at)

settings (key, value)   -- JSON blobs keyed by string
```

---

## Common tasks

**Add a new API endpoint**: add route to `backend/main.py`. Pattern:
```python
@app.get("/api/thing/{id}")
def get_thing(id: str):
    with get_db() as conn:
        row = conn.execute("SELECT ...", (id,)).fetchone()
    if not row: raise HTTPException(404, "Not found")
    return dict(row)
```

**Add a new built-in module**: create `backend/modules/{id}.py` subclassing `LabModule`. Add schema JSON at `backend/data/module_schemas/{id}.json` and an example file at `backend/data/module_examples/{id}_example.*`. The registry auto-discovers it on restart.

**Add a new UI component**: define a function component in `LabLog.jsx` outside the `App` function. Use `T.*` for all colors. Use `"'DM Mono', monospace"` for code/data and `"'Playfair Display', serif"` for headings.

**Add a new top-level navigation view**: add a state variable like `activeModule`, add a branch to the header toolbar (search for the `active && activeSample ?` ternary chain), and add a branch to the main content area (search for `active && activeSample ? (`).
