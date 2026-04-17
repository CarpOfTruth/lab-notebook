# Architecture Reference

This document describes how LabLog is structured. It is intended for contributors who need to understand the codebase before making changes.

---

## Stack

- **Backend:** FastAPI (Python), running on port 8000
- **Frontend:** React + Vite, running on port 5173; all UI lives in a single file (`LabLog.jsx`)
- **Database:** SQLite, accessed via a `get_db()` dependency
- **Proxy:** Vite proxies `/api` → `http://localhost:8000`, so the frontend makes relative `/api/...` requests

The single-file frontend is intentional. It avoids the overhead of a component tree split across many files for a codebase of this scale, and keeps all UI logic in one place for fast navigation.

---

## Key Directories

```
backend/
  modules/            Built-in module source (.py) and schemas (.json). Tracked in git.
  data/
    user_modules/     User-created module source + schemas. Gitignored.
    module_schemas/   SCHEMAS_DIR. User-saved schemas take precedence over built-ins here.
    files/            Uploaded sample data files.
  data.bak/           Local backup of data directory. Gitignored.
```

Backend endpoints are intentionally thin. Heavy logic (processing, fitting, analysis) belongs in module source files, not in the API layer.

---

## Branch Policy

All active development happens on **dev**. The **main** branch is never touched without explicit approval from the project owner. After each session, dev is pushed to GitHub. Main is only updated when a PR is explicitly approved.

Do not merge to main unilaterally.

---

## Shared UI Primitives

Rather than building new UI patterns for each feature, LabLog reuses a small set of canonical building blocks:

| Primitive | Description |
|---|---|
| `Btn` | Primary (amber), ghost (border), danger, teal variants. Accepts a `small` prop. |
| `FileBtn` | A ghost button that triggers a hidden `<input type="file">` via `useRef`. |
| `FolderTile` | Sample folder tile: colored border, collapsible, supports drag-and-drop. |
| `BookFolderTile` | Book folder tile: same visual pattern as `FolderTile`. |
| `ModuleFolderTile` | Module folder tile: same visual, supports dragging modules onto it. |
| `ModCard` | Module card: draggable when module folders exist in the system. |

New features should compose from these primitives. Adding a new one-off component should be the exception, not the default.

Each major domain (Samples, Analysis Books, Modules) follows the same structural pattern: a section header with folder and creation controls, folder tiles with colored borders grouping related items, and an ungrouped grid below for items not assigned to a folder.

Modals are split by context — `AddSampleFolderModal`, `AddBookFolderModal`, `AddModuleFolderModal` — rather than sharing a single modal that tries to handle too many cases.

### Section Header Button Order

All section headers follow the same button order, left to right:

```
+ Folder  |  Import  |  Export (if applicable)  |  + New X
```

This is a convention, not enforced by code. Maintain it when adding new sections.

---

## Folder Infrastructure

Folders for all three domain types (Samples, Books, Modules) are stored in a single `folders` DB table. Two boolean columns distinguish type:

- `book_folder` — true for book folders
- `module_folder` — true for module folders
- Both false — sample folder

The `getSiblings()` utility filters by `!!book_folder === isBook && !module_folder` to keep the three types isolated from each other when computing sibling relationships (e.g. for drag-and-drop ordering).

---

## Module System

### proc_code Contract

Every module's `proc_code` must return a dict with at minimum:

```python
{ "x": ..., "y": ... }
```

Optional keys: `x_label`, `y_label`, `x_fit`, `y_fit`, `area_m2`, and any additional values the module author wants to surface. The same A/B/C three-block structure applies to `analysis_code`.

### Three-Block Editor

The module editor is split into three blocks:

- **Block 1:** Auto-generated column imports. Locked. Regenerates automatically when the schema changes. Never touches Blocks 2 or 3.
- **Block 2:** User processing code. Freely editable.
- **Block 3:** Return dict scaffold. Has a reset button to restore to the default scaffold.

### File Modes

- **`single`** — one file per module per sample. Currently shipping.
- **`named`**, **`collection`** — planned (see `roadmap.md`).

### Module Folders

Module folder assignment is stored as `folder_id` in the module's schema JSON. The endpoint `PATCH /api/modules/{id}/folder` updates only the folder assignment. On the home page, modules are rendered grouped under `ModuleFolderTile` components. Users can drag module cards onto folder tiles to assign them.

### Module Export / Import

- **Export:** `GET /api/modules/{id}/export` → `.labmodule.zip` containing manifest, schema, source, and example data.
- **Import:** `POST /api/modules/import` → installs source + schema, opens editor.
- **Built-in detection:** determined by file location (`user_modules/{id}.py` exists on disk), not by any `author` field in the schema.

### Plot Config State

Plot configuration is held in a `plotConfig` object:

```js
{ x_var, y_var, x_label, y_label, x_scale, y_scale, color, show_fit, primary, secondary_opacity }
```

- `primary`: either `"data"` or `"fit"` — controls which trace renders at full opacity.
- `_fitMemory` ref: saves and restores fit display state across toggle operations.
- **Auto-replot:** a debounced `useEffect` watches `JSON.stringify(plotConfig)` (350ms delay) and triggers a replot automatically when any config value changes. Do not manually trigger replots on config changes — the effect handles it.

---

## Analysis Books

Books bundle samples and their module outputs into a shareable/archivable unit.

- **Export:** `GET /api/books/{id}/export?include_files=bool` → `.labbook.zip`
- **Import preview:** `POST /api/books/import-preview` → returns conflict analysis (existing samples, module ID collisions, etc.)
- **Import confirm:** `POST /api/books/import` → handles renames, folder creation, module installation, and sample/book recreation
- **`BookImportModal`:** presents conflicts, rename proposals, and a folder creation option to the user before confirming import.

---

## Design Principles

- **Reuse shared primitives.** Before adding a new component or pattern, check whether an existing one covers the case.
- **Parallel structure across domains.** Samples, Books, and Modules should feel structurally consistent to the user and to contributors reading the code.
- **Thin endpoints, logic in modules.** API routes orchestrate; processing lives in Python module files.
- **One robust system beats N ad-hoc ones.** When a pattern recurs (import flows, folder types, modal structure), generalize it rather than copying.
