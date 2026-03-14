#!/usr/bin/env python3
"""
seed_demo.py — Populate the LabLog database with demo samples SP022, SP023, SP024
and the Demo Analysis Book.

Usage:
    python seed_demo.py              # seeds without overwriting existing records
    python seed_demo.py --overwrite  # drops and re-inserts demo records

Run from the backend/ directory (or anywhere — paths are relative to this file).
"""

import argparse
import json
import shutil
import sqlite3
import sys
from pathlib import Path

HERE = Path(__file__).parent
DATA_DIR = HERE / "data"
FILES_DIR = DATA_DIR / "files"
DB_PATH = DATA_DIR / "lablog.db"
DEMO_DIR = HERE / "demo_data"
DEMO_FILES_DIR = DEMO_DIR / "files"
SEED_JSON = DEMO_DIR / "seed.json"


def init_db(conn: sqlite3.Connection) -> None:
    conn.executescript("""
        CREATE TABLE IF NOT EXISTS folders (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            color TEXT NOT NULL DEFAULT '#3182ce',
            created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );

        CREATE TABLE IF NOT EXISTS samples (
            id TEXT PRIMARY KEY,
            date TEXT,
            substrate TEXT,
            notes TEXT,
            thickness_nm REAL,
            area_m2 REAL,
            area_correction REAL DEFAULT 1.0,
            technique TEXT DEFAULT 'sputter',
            folder_id TEXT,
            layers TEXT DEFAULT '[]',
            filenames TEXT DEFAULT '{}',
            created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );

        CREATE TABLE IF NOT EXISTS analysis_books (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            sample_ids TEXT NOT NULL DEFAULT '[]',
            config TEXT NOT NULL DEFAULT '{}',
            created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
    """)
    conn.commit()


def seed(overwrite: bool = False) -> None:
    # Validate demo data exists
    if not SEED_JSON.exists():
        sys.exit(f"ERROR: {SEED_JSON} not found. Are you running from backend/?")
    if not DEMO_FILES_DIR.exists():
        sys.exit(f"ERROR: {DEMO_FILES_DIR} not found.")

    seed_data = json.loads(SEED_JSON.read_text())

    # Ensure data/ and data/files/ directories exist
    DATA_DIR.mkdir(exist_ok=True)
    FILES_DIR.mkdir(exist_ok=True)

    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    init_db(conn)

    # ── Folder ────────────────────────────────────────────────────────────────
    folder = seed_data["folder"]
    existing_folder = conn.execute(
        "SELECT id FROM folders WHERE id = ?", (folder["id"],)
    ).fetchone()

    if existing_folder and overwrite:
        conn.execute("DELETE FROM folders WHERE id = ?", (folder["id"],))
        existing_folder = None

    if not existing_folder:
        conn.execute(
            "INSERT INTO folders (id, name, color) VALUES (?, ?, ?)",
            (folder["id"], folder["name"], folder["color"]),
        )
        print(f"  ✓ Created folder: {folder['name']}")
    else:
        print(f"  · Folder already exists: {folder['name']} (skipped)")

    # ── Samples ───────────────────────────────────────────────────────────────
    for sample in seed_data["samples"]:
        sid = sample["id"]
        existing = conn.execute(
            "SELECT id FROM samples WHERE id = ?", (sid,)
        ).fetchone()

        if existing and overwrite:
            conn.execute("DELETE FROM samples WHERE id = ?", (sid,))
            existing = None

        if not existing:
            conn.execute(
                """INSERT INTO samples
                   (id, date, substrate, notes, thickness_nm, area_m2,
                    area_correction, technique, folder_id, layers, filenames)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                (
                    sid,
                    sample["date"],
                    sample["substrate"],
                    sample["notes"],
                    sample["thickness_nm"],
                    sample["area_m2"],
                    sample["area_correction"],
                    sample["technique"],
                    sample["folder_id"],
                    json.dumps(sample["layers"]),
                    json.dumps(sample["filenames"]),
                ),
            )
            print(f"  ✓ Created sample: {sid}")
        else:
            print(f"  · Sample already exists: {sid} (skipped)")

        # Copy measurement files
        src_dir = DEMO_FILES_DIR / sid
        dst_dir = FILES_DIR / sid
        if src_dir.exists():
            dst_dir.mkdir(exist_ok=True)
            copied = 0
            for src_file in src_dir.iterdir():
                dst_file = dst_dir / src_file.name
                if not dst_file.exists() or overwrite:
                    shutil.copy2(src_file, dst_file)
                    copied += 1
            if copied:
                print(f"    ✓ Copied {copied} file(s) → data/files/{sid}/")
            else:
                print(f"    · Files already present for {sid} (skipped)")

    # ── Analysis Books ─────────────────────────────────────────────────────────
    for book in seed_data["analysis_books"]:
        bid = book["id"]
        existing = conn.execute(
            "SELECT id FROM analysis_books WHERE id = ?", (bid,)
        ).fetchone()

        if existing and overwrite:
            conn.execute("DELETE FROM analysis_books WHERE id = ?", (bid,))
            existing = None

        if not existing:
            conn.execute(
                """INSERT INTO analysis_books (id, name, sample_ids, config)
                   VALUES (?, ?, ?, ?)""",
                (
                    bid,
                    book["name"],
                    json.dumps(book["sample_ids"]),
                    json.dumps(book["config"]),
                ),
            )
            print(f"  ✓ Created analysis book: {book['name']}")
        else:
            print(f"  · Analysis book already exists: {book['name']} (skipped)")

    conn.commit()
    conn.close()
    print("\nDone. Start the backend and open http://localhost:5173 to explore the demo data.")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Seed LabLog with demo data.")
    parser.add_argument(
        "--overwrite",
        action="store_true",
        help="Delete and re-insert demo records (folder, samples, analysis book).",
    )
    args = parser.parse_args()

    print("Seeding LabLog demo data…")
    seed(overwrite=args.overwrite)
