"""Obsidian vault import tests — synthetic vault, isolated data directory.

Run from the repository root:
    backend/.venv/bin/python3.11 -m unittest discover -s backend/tests -v
"""
import hashlib
import io
import json
import os
import sqlite3
import sys
import tempfile
import unittest
import zipfile
from pathlib import Path

_TMP = Path(tempfile.mkdtemp(prefix="lablog-vault-test-")).resolve()
os.environ["LABLOG_DATA_DIR"] = str(_TMP / "data")
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import main            # noqa: E402  — initialises the isolated database
import vault_import    # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

assert Path(main.DB_PATH).resolve().is_relative_to(_TMP), "tests must never use the daily database"

client = TestClient(main.app)

TECHNIQUES = [
    {"id": "sputter", "name": "Sputter", "params": [
        {"id": "temp", "name": "Temperature", "unit": "°C", "default": 600, "scope": "layer", "type": "number"},
        {"id": "pressure", "name": "Pressure", "unit": "mTorr", "default": 3, "scope": "layer", "type": "number"},
        {"id": "oxygen_pct", "name": "O2", "unit": "%", "default": 10, "scope": "layer", "type": "number"},
        {"id": "time_s", "name": "Time", "unit": "s", "default": 2000, "scope": "layer", "type": "number"},
        {"id": "power_type", "name": "Power type", "unit": "", "default": "RF", "scope": "target", "type": "select", "options": ["RF", "DC", "Pulsed DC"]},
        {"id": "power_W", "name": "Power", "unit": "W", "default": 150, "scope": "target", "type": "number"},
    ]},
    {"id": "pld", "name": "PLD", "params": [
        {"id": "temp", "name": "Temperature", "unit": "°C", "default": 670, "scope": "layer", "type": "number"},
        {"id": "pressure", "name": "Pressure", "unit": "mTorr", "default": 100, "scope": "layer", "type": "number"},
        {"id": "frequency_hz", "name": "Rep rate", "unit": "Hz", "default": 10, "scope": "layer", "type": "number"},
        {"id": "energy_mJ", "name": "Energy", "unit": "mJ", "default": 100, "scope": "target", "type": "number"},
        {"id": "pulses", "name": "Pulses", "unit": "", "default": 1000, "scope": "target", "type": "number"},
        {"id": "fp_test", "name": "Focal Position", "unit": "mm", "default": 75, "scope": "layer", "type": "number"},
    ]},
]
LIBRARY = [("sub_a", "Sub:A (001)"), ("bto_x", "BTO"), ("sro_x", "SRO"), ("ti_x", "Ti"),
           ("oxs_pc", "OxS (pc)"), ("oxs_o", "OxS (o)")]


def note(fields: str, body: str = "## Notes\n") -> str:
    return f"---\n{fields.strip()}\n---\n{body}"


NOTES = {
    "TST001": note("""
type: sample
id: TST001
description: "Co-sputter trilayer, [[Series A]]"
technique: sputter
substrate: "[[Sub-A (001)]]"
stack:
  - buffer | Ti@87W + BTO@150W | P=4 O2=20 T=600 t=2300
  - "electrode*   |  SRO@125W/DC |  T=600   P=3 O2=0 t=1000"
  - "film:lower | BTO@1.5e2W | P=4.0 O2=20 T=600 t=2.3e3"
lot: WAFER01
bin: C8
date: 2026-09-01
planned_date: 2026-08-30
campaign: "[[Series A]]"
growth_id: G1
position_in: 1.5
pocket: 2
reference: false
lablog_status: draft
char_xrd: done
char_afm: pending
char_fab: na
char_elec: skipped
film_material: BTO
future_field:
  nested: [1, 2]
tags:
  - growth
""", "## Notes\n\nGrown fine. See [[Series A]] and ![[photo.png]].\n<script>alert(1)</script>\n"),
    "TST002": note("""
type: sample
id: TST002
description: graded PLD
technique: pld
substrate: "[[OxS (110)|OxS]]"
stack:
  - "electrode | SRO@100mJ/850p | P=100 T=670 f=10 L=75"
  - "film* | BTO@100mJ/550p | P=50>90 T=670 f=2 L=75"
date: 2026-09-02
lablog_status: synced
"""),
    "TST003": note("""
type: sample
id: TST003
technique: sputter
stack:
  - film | BTO@150W | P=4 O2=20 T=600 t=2300
date: 2026-09-20
lablog_status: planned
"""),
    "TST004": note("""
type: sample
id: TST004
description: vault disagrees with LabLog
technique: sputter
substrate: "[[Sub-A (001)]]"
stack:
  - film | BTO@150W | P=4 O2=20 T=600 t=2300
date: 2026-01-01
lablog_status: draft
"""),
    "TST 005": note("""
type: sample
id: TST 005
technique: sputter
substrate: "[[Sub-A (001)]]"
stack: []
date: 2026-09-03
lablog_status: draft
char_xrd: pending
char_fab: na
"""),
    "malformed": "---\ntype: sample\nid: [unclosed\n---\n",
    "dupkey": note("type: sample\nid: dupkey\nid: dupkey\nlablog_status: draft"),
    "series": note("type: series\ntitle: Series A"),
    "TST006": note("type: sample\nid: TST06\ntechnique: sputter\nlablog_status: draft\nstack: []"),
    "TST007": note("type: sample\nid: TST007\ntechnique: sputter\nlablog_status: draft\nstack: []"),
    "sub/tst007": note("type: sample\nid: tst007\ntechnique: sputter\nlablog_status: draft\nstack: []"),
    "TST008": note("type: sample\nid: TST008\ntechnique: sputter\nstack: []\ndate: 2026-09-04"),
    "TST009": note("type: sample\nid: TST009\ntechnique: mbe\nlablog_status: draft\nstack: []"),
    "TST010": note("""
type: sample
id: TST010
technique: sputter
stack:
  - film | Ti@W + BTO@150W | P=4 T=600 O2=
lablog_status: draft
"""),
    "TST011": note("""
type: sample
id: TST011
technique: sputter
stack:
  - electrode | SRO@125W | P=3 T=600
  - film BTO@150W P=4
lablog_status: draft
"""),
    "TST012": note("""
type: sample
id: TST012
technique: sputter
stack:
  - film | BTO@150W | P=4 O2=10 T=600 t=2300
lablog_status: draft
""", "## Notes\n\nStack reconstructed from the base recipe.\n"),
    "_parked/TST013": note("type: sample\nid: TST013\ntechnique: sputter\nlablog_status: draft\nstack: []"),
    ".hidden/TST019": note("type: sample\nid: TST019\ntechnique: sputter\nlablog_status: draft\nstack: []"),
    "tst016": note("type: sample\nid: tst016\ntechnique: sputter\nlablog_status: draft\nstack: []"),
    "TST#17": note("type: sample\nid: \"TST#17\"\ntechnique: sputter\nlablog_status: draft\nstack: []"),
    "TST018": note("""
type: sample
id: TST018
technique: sputter
stack:
  - widget | Unobtainium@10W | P=1
lablog_status: draft
"""),
    "TST020": note("type: sample\nid: TST020\ntechnique: sputter\nlablog_status: draft\nstack: []\nweird: .inf"),
}
MATERIAL_NOTES = {
    "Sub-A (001)": note("type: substrate\nlablog_id: sub_a\nlablog_name: \"Sub:A (001)\""),
    "OxS (110)": note("type: substrate\nlablog_id: oxs_pc\naliases:\n  - OxS"),
    "BTO": note("type: material\nlablog_id: bto_x"),
}


def tree_digest(root: Path) -> dict:
    return {p.relative_to(root).as_posix(): (hashlib.sha256(p.read_bytes()).hexdigest() if p.is_file() and not p.is_symlink() else os.readlink(p) if p.is_symlink() else "dir")
            for p in sorted(root.rglob("*"))}


def db_rows(sql, params=()):
    conn = sqlite3.connect(main.DB_PATH)
    conn.row_factory = sqlite3.Row
    try:
        return [dict(r) for r in conn.execute(sql, params).fetchall()]
    finally:
        conn.close()


def db_exec(sql, params=()):
    conn = sqlite3.connect(main.DB_PATH)
    try:
        conn.execute(sql, params)
        conn.commit()
    finally:
        conn.close()


class VaultImportTests(unittest.TestCase):

    def setUp(self):
        self.work = Path(tempfile.mkdtemp(dir=_TMP))
        self.vault = self.work / "Vault"
        (self.vault / "Samples").mkdir(parents=True)
        (self.vault / "Materials").mkdir()
        for name, text in NOTES.items():
            p = self.vault / "Samples" / f"{name}.md"
            p.parent.mkdir(parents=True, exist_ok=True)
            p.write_text(text, encoding="utf-8")
        for name, text in MATERIAL_NOTES.items():
            (self.vault / "Materials" / f"{name}.md").write_text(text, encoding="utf-8")
        (self.vault / "Samples" / "TST015.md").write_text(
            note("type: sample\nid: TST015\ntechnique: sputter\nlablog_status: draft\nstack: []", "x" * (vault_import.MAX_NOTE_BYTES + 10)))
        outside = self.work / "outside.md"
        outside.write_text(note("type: sample\nid: TST014\ntechnique: sputter\nlablog_status: draft\nstack: []"))
        os.symlink(outside, self.vault / "Samples" / "TST014.md")

        for table in ("samples", "sample_filter_index", "materials_library", "settings", "folders", "analysis_books"):
            db_exec(f"DELETE FROM {table}")
        for mid, name in LIBRARY:
            db_exec("INSERT INTO materials_library (id, name) VALUES (?, ?)", (mid, name))
        db_exec("INSERT INTO settings (key, value) VALUES ('main', ?)", (json.dumps({"techniques": TECHNIQUES}),))
        client.post("/api/samples", json={"id": "TST004", "date": "2025-12-31", "substrate": "Other", "notes": "LabLog note",
                                          "thickness_nm": None, "area_m2": None, "area_correction": 1.0,
                                          "technique": "sputter", "layers": [], "lot": None, "bin": None})
        client.post("/api/samples", json={"id": "TST016", "date": None, "substrate": None, "notes": None,
                                          "thickness_nm": None, "area_m2": None, "area_correction": 1.0,
                                          "technique": "sputter", "layers": [], "lot": None, "bin": None})
        (main.FILES_DIR / "TST004").mkdir(parents=True, exist_ok=True)
        (main.FILES_DIR / "TST004" / "xrd_ot_scan.csv").write_text("40,1\n41,2\n")
        for b in main.BACKUPS_DIR.glob("*.db") if main.BACKUPS_DIR.exists() else []:
            b.unlink()

    # helpers
    def preview(self):
        r = client.post("/api/vault-import/preview", json={"root": str(self.vault)})
        self.assertEqual(r.status_code, 200, r.text)
        data = r.json()
        return data, {rec["key"]: rec for rec in data["records"]}

    def apply(self, preview_id, selections):
        r = client.post("/api/vault-import/apply", json={"preview_id": preview_id, "selections": selections})
        self.assertEqual(r.status_code, 200, r.text)
        return r.json(), {x["key"]: x for x in r.json()["results"]}

    def sample(self, sid):
        rows = db_rows("SELECT * FROM samples WHERE id=?", (sid,))
        return main.row_to_sample(rows[0]) if rows else None

    # 1, 11: read-only preview with a mixed batch
    def test_preview_categories_and_read_only(self):
        vault_before = tree_digest(self.vault)
        db_before = hashlib.sha256(Path(main.DB_PATH).read_bytes()).hexdigest()
        data, recs = self.preview()
        cat = {k: r["category"] for k, r in recs.items()}
        self.assertEqual(cat["Samples/TST001.md"], "ready")
        self.assertEqual(cat["Samples/TST002.md"], "review")          # ramp
        self.assertEqual(cat["Samples/TST003.md"], "planned")
        self.assertEqual(cat["Samples/TST004.md"], "existing")
        self.assertEqual(cat["Samples/TST 005.md"], "ready")          # legitimate space, substrate-only
        self.assertEqual(cat["Samples/malformed.md"], "invalid")
        self.assertIn("Duplicate frontmatter key", recs["Samples/dupkey.md"]["errors"][0])
        self.assertNotIn("Samples/series.md", recs)
        self.assertIn("Samples/series.md", [i["path"] for i in data["ignored"]])
        self.assertIn("does not match", recs["Samples/TST006.md"]["errors"][0])
        self.assertEqual(cat["Samples/TST007.md"], "invalid")
        self.assertEqual(cat["Samples/sub/tst007.md"], "invalid")
        self.assertEqual(cat["Samples/TST008.md"], "review")
        self.assertTrue(recs["Samples/TST008.md"]["needs_confirmation"])
        self.assertIn("not a LabLog technique", recs["Samples/TST009.md"]["errors"][0])
        self.assertEqual(cat["Samples/TST010.md"], "review")
        self.assertEqual(cat["Samples/TST011.md"], "review")
        self.assertEqual(cat["Samples/TST012.md"], "review")
        self.assertNotIn("Samples/_parked/TST013.md", recs)
        self.assertNotIn("Samples/.hidden/TST019.md", recs)
        self.assertIn("Symbolic link", recs["Samples/TST014.md"]["errors"][0])
        self.assertIn("limit", recs["Samples/TST015.md"]["errors"][0])
        self.assertIn("letter case", recs["Samples/tst016.md"]["errors"][0])
        self.assertIn("unsafe character", recs["Samples/TST#17.md"]["errors"][0])
        self.assertIn("Non-finite", recs["Samples/TST020.md"]["errors"][0])
        self.assertTrue(all("source" not in r and "_text" not in r for r in data["records"]))
        self.assertEqual(tree_digest(self.vault), vault_before)
        self.assertEqual(hashlib.sha256(Path(main.DB_PATH).read_bytes()).hexdigest(), db_before)
        self.assertFalse(list(main.BACKUPS_DIR.glob("*.db")) if main.BACKUPS_DIR.exists() else [])

    # 2, 3, 5, 6, 7, 11: native creation without defaults
    def test_create_native_samples(self):
        vault_before = tree_digest(self.vault)
        data, recs = self.preview()
        result, res = self.apply(data["preview_id"], [
            {"key": "Samples/TST001.md"}, {"key": "Samples/TST 005.md"},
            {"key": "Samples/TST002.md", "acknowledged": True},
        ])
        self.assertEqual(result["counts"]["created"], 3, result)
        self.assertTrue(result["backup"])
        self.assertEqual(len(list(main.BACKUPS_DIR.glob("*.db"))), 1)

        s = self.sample("TST001")
        self.assertIsNone(s["folder_id"])
        self.assertIsNone(s["thickness_nm"])
        self.assertIsNone(s["area_m2"])
        self.assertEqual((s["filenames"], s["xrd_peaks"], s["module_config"]), ({}, [], {}))
        self.assertEqual(s["date"], "2026-09-01")
        self.assertEqual(s["substrate"], "Sub:A (001)")
        self.assertEqual((s["lot"], s["bin"]), ("WAFER01", "C8"))
        self.assertEqual(s["notes"], "Co-sputter trilayer, [[Series A]]")
        L = s["layers"]
        self.assertEqual([l["role"] for l in L], ["buffer", "electrode", "film"])
        self.assertEqual(len({l["id"] for l in L}), 3)
        self.assertTrue(L[1]["primary"])
        self.assertEqual(L[2]["role_label"], "lower")
        self.assertEqual([t["material"] for t in L[0]["targets"]], ["Ti", "BTO"])
        self.assertEqual(L[0]["targets"][0], {"material": "Ti", "power_W": 87, "power_type": "RF",
                                              "power_type_basis": "convention (RF when no mode is written)"})
        self.assertEqual(L[1]["targets"][0]["power_type"], "DC")
        self.assertEqual(L[1]["targets"][0]["power_type_basis"], "explicit")
        self.assertEqual(L[1]["oxygen_pct"], 0)                     # real zero preserved
        self.assertEqual((L[2]["targets"][0]["power_W"], L[2]["pressure"], L[2]["time_s"]), (150.0, 4.0, 2300.0))
        self.assertTrue(all(l["vault_source"]["mapping"] == "full" for l in L))
        self.assertTrue(all("thickness_nm" not in l for l in L))

        p = self.sample("TST002")
        self.assertEqual(p["substrate"], "OxS (pc)")                 # via lablog_id, not spelling
        e, f = p["layers"]
        self.assertEqual(e["custom"], {"fp_test": 75})
        self.assertNotIn("oxygen_pct", e)                          # no inferred PLD oxygen
        self.assertNotIn("time_s", e)                              # no derived deposition time
        self.assertNotIn("pressure", f)                            # ramp not collapsed
        self.assertEqual(f["vault_source"]["mapping"], "partial")
        self.assertEqual(f["vault_source"]["unmapped"][0]["term"], "P=50>90")
        self.assertEqual((f["targets"][0]["energy_mJ"], f["targets"][0]["pulses"]), (100, 550))
        self.assertNotIn("power_type", f["targets"][0])

        z = self.sample("TST 005")
        self.assertEqual(z["layers"], [])
        self.assertIsNone(z["lot"])

        rec = z = None
        rec = main.get_sample_source_record("TST001")
        text = rec["source"]["text"]
        self.assertEqual(hashlib.sha256(text.encode("utf-8")).hexdigest(), rec["source"]["sha256"])
        self.assertEqual(text, NOTES["TST001"])
        self.assertIn("<script>alert(1)</script>", rec["source"]["body"])
        self.assertEqual(rec["source"]["relative_path"], "Samples/TST001.md")
        self.assertEqual(rec["source"]["frontmatter"]["char_fab"], "na")
        self.assertEqual(rec["source"]["frontmatter"]["reference"], False)
        self.assertEqual(rec["source"]["frontmatter"]["position_in"], 1.5)
        self.assertEqual(rec["source"]["frontmatter"]["future_field"], {"nested": [1, 2]})
        self.assertIn("growth_id", rec["retained_keys"])
        self.assertNotIn(str(self.work), json.dumps(rec))            # no absolute vault path
        rec2 = main.get_sample_source_record("TST002")
        self.assertIn("ramp", rec2["import_choices"]["acknowledged_warnings"])

        idx = db_rows("SELECT field, value_text, value_num FROM sample_filter_index WHERE sample_id='TST002'")
        self.assertIn({"field": "custom_fp_test", "value_text": None, "value_num": 75.0}, idx)
        self.assertEqual(sorted({r["value_num"] for r in idx if r["field"] == "growth_pressure"}), [100.0])
        self.assertEqual(db_rows("SELECT COUNT(*) n FROM folders")[0]["n"], 0)
        self.assertEqual(db_rows("SELECT COUNT(*) n FROM analysis_books")[0]["n"], 0)
        self.assertEqual(tree_digest(self.vault), vault_before)

        listed = {x["id"]: x for x in client.get("/api/samples").json()}
        self.assertTrue(listed["TST001"]["has_source_record"])
        self.assertNotIn("source_record", listed["TST001"])
        self.assertFalse(listed["TST004"]["has_source_record"])

    # 4, 9, 10: existing records untouched; races; no-op repeat
    def test_existing_and_race_and_repeat(self):
        before_row = db_rows("SELECT * FROM samples WHERE id='TST004'")
        before_idx = db_rows("SELECT * FROM sample_filter_index WHERE sample_id='TST004'")
        file_hash = hashlib.sha256((main.FILES_DIR / "TST004" / "xrd_ot_scan.csv").read_bytes()).hexdigest()
        data, recs = self.preview()
        # a forged selection of an existing record is refused
        _, res = self.apply(data["preview_id"], [{"key": "Samples/TST004.md", "acknowledged": True}, {"key": "Samples/TST003.md"}])
        self.assertEqual(res["Samples/TST004.md"]["outcome"], "skipped")
        self.assertEqual(res["Samples/TST003.md"]["outcome"], "skipped")
        # created by another action after preview
        client.post("/api/samples", json={"id": "TST001", "date": None, "substrate": None, "notes": "manual",
                                          "thickness_nm": None, "area_m2": None, "area_correction": 1.0,
                                          "technique": "sputter", "layers": [], "lot": None, "bin": None})
        manual = db_rows("SELECT * FROM samples WHERE id='TST001'")
        result, res = self.apply(data["preview_id"], [{"key": "Samples/TST001.md"}])
        self.assertEqual(res["Samples/TST001.md"]["outcome"], "already_exists")
        self.assertIsNone(result["backup"])
        self.assertEqual(db_rows("SELECT * FROM samples WHERE id='TST001'"), manual)
        self.assertEqual(db_rows("SELECT * FROM samples WHERE id='TST004'"), before_row)
        self.assertEqual(db_rows("SELECT * FROM sample_filter_index WHERE sample_id='TST004'"), before_idx)
        self.assertEqual(hashlib.sha256((main.FILES_DIR / "TST004" / "xrd_ot_scan.csv").read_bytes()).hexdigest(), file_hash)

        # insert race past the in-transaction check: the primary key still refuses it
        data, _ = self.preview()
        client.post("/api/samples", json={"id": "TST 005", "date": None, "substrate": None, "notes": "race",
                                          "thickness_nm": None, "area_m2": None, "area_correction": 1.0,
                                          "technique": "sputter", "layers": [], "lot": None, "bin": None})
        original = main._sample_ids
        try:
            main._sample_ids = lambda conn: []
            raced = db_rows("SELECT * FROM samples WHERE id='TST 005'")
            outcome, _ = main._insert_vault_sample({**recs["Samples/TST 005.md"]["sample"]}, {"format": "x"})
            self.assertEqual(outcome, "already_exists")
            self.assertEqual(db_rows("SELECT * FROM samples WHERE id='TST 005'"), raced)
        finally:
            main._sample_ids = original

        # repeat import is a no-op
        data, _ = self.preview()
        _, res = self.apply(data["preview_id"], [{"key": "Samples/TST012.md", "acknowledged": True}])
        self.assertEqual(res["Samples/TST012.md"]["outcome"], "created")
        first = db_rows("SELECT * FROM samples WHERE id='TST012'")
        first_idx = db_rows("SELECT * FROM sample_filter_index WHERE sample_id='TST012'")
        _, res = self.apply(data["preview_id"], [{"key": "Samples/TST012.md", "acknowledged": True}])
        self.assertEqual(res["Samples/TST012.md"]["outcome"], "already_exists")
        self.assertEqual(db_rows("SELECT * FROM samples WHERE id='TST012'"), first)
        self.assertEqual(db_rows("SELECT * FROM sample_filter_index WHERE sample_id='TST012'"), first_idx)
        self.assertEqual(main.get_sample_source_record("TST012")["evidence"], "reconstructed")
        self.assertEqual(self.sample("TST012")["layers"][0]["vault_source"]["basis"], "reconstructed")

    # 5, 6, 7: acknowledgement, confirmation, placeholders, unparsed stacks
    def test_acknowledgement_and_partial_records(self):
        data, recs = self.preview()
        _, res = self.apply(data["preview_id"], [{"key": "Samples/TST002.md"}, {"key": "Samples/TST008.md", "acknowledged": True}])
        self.assertEqual(res["Samples/TST002.md"]["outcome"], "skipped")
        self.assertEqual(res["Samples/TST008.md"]["outcome"], "skipped")
        self.assertIsNone(self.sample("TST002"))
        _, res = self.apply(data["preview_id"], [
            {"key": "Samples/TST008.md", "acknowledged": True, "confirmed_physical": True},
            {"key": "Samples/TST010.md", "acknowledged": True},
            {"key": "Samples/TST011.md", "acknowledged": True},
            {"key": "Samples/TST018.md", "acknowledged": True},
        ])
        self.assertTrue(all(r["outcome"] == "created" for r in res.values()), res)
        self.assertTrue(main.get_sample_source_record("TST008")["import_choices"]["confirmed_physical_sample"])
        t10 = self.sample("TST010")["layers"][0]
        self.assertEqual(t10["targets"][0], {"material": "Ti", "power_type": "RF", "power_type_basis": "convention (RF when no mode is written)"})
        self.assertNotIn("oxygen_pct", t10)
        self.assertEqual(t10["vault_source"]["mapping"], "partial")
        self.assertEqual(self.sample("TST011")["layers"], [])
        src11 = main.get_sample_source_record("TST011")
        self.assertEqual([l["raw"] for l in src11["stack"]], ["electrode | SRO@125W | P=3 T=600", "film BTO@150W P=4"])
        self.assertEqual([l["status"] for l in src11["stack"]], ["not created", "unparsed"])
        t18 = self.sample("TST018")["layers"][0]
        self.assertEqual((t18["role"], t18["targets"][0]["material"]), ("widget", "Unobtainium"))
        self.assertTrue(any(w["code"] == "material_unresolved" for w in recs["Samples/TST018.md"]["warnings"]))
        self.assertTrue(any(w["code"] == "role_unknown" and not w["ack"] for w in recs["Samples/TST018.md"]["warnings"]))

    # 9: stale source, stale dependencies, unselected new records
    def test_stale_and_selection_enforcement(self):
        data, _ = self.preview()
        p = self.vault / "Samples" / "TST001.md"
        p.write_text(NOTES["TST001"].replace("bin: C8", "bin: C9"))
        (self.vault / "Samples" / "TST030.md").write_text(note("type: sample\nid: TST030\ntechnique: sputter\nlablog_status: draft\nstack: []"))
        (self.vault / "Materials" / "BTO.md").write_text(note("type: material\nlablog_id: ti_x"))   # now ambiguous
        _, res = self.apply(data["preview_id"], [{"key": "Samples/TST001.md"}, {"key": "Samples/TST 005.md"},
                                                 {"key": "Samples/TST012.md", "acknowledged": True},
                                                 {"key": "Samples/TST030.md"}])
        self.assertEqual(res["Samples/TST001.md"]["outcome"], "source_changed")
        self.assertEqual(res["Samples/TST012.md"]["outcome"], "source_changed")   # material dependency changed
        self.assertEqual(res["Samples/TST 005.md"]["outcome"], "created")
        self.assertEqual(res["Samples/TST030.md"]["outcome"], "skipped")
        self.assertIsNone(self.sample("TST030"))
        # settings dependency
        data, _ = self.preview()
        techs = json.loads(json.dumps(TECHNIQUES))
        techs[1]["params"] = [x for x in techs[1]["params"] if x["id"] != "fp_test"]
        db_exec("UPDATE settings SET value=? WHERE key='main'", (json.dumps({"techniques": techs}),))
        _, res = self.apply(data["preview_id"], [{"key": "Samples/TST002.md", "acknowledged": True}])
        self.assertEqual(res["Samples/TST002.md"]["outcome"], "source_changed")
        self.assertEqual(client.post("/api/vault-import/apply", json={"preview_id": "nope", "selections": []}).status_code, 409)

    # 10: failed record rolls back, others remain, retry is clean
    def test_rollback_and_retry(self):
        data, _ = self.preview()
        original = main._index_sample

        def failing(conn, sid, *a):
            original(conn, sid, *a)
            if sid == "TST001":
                raise RuntimeError("simulated failure")
        main._index_sample = failing
        try:
            result, res = self.apply(data["preview_id"], [{"key": "Samples/TST001.md"}, {"key": "Samples/TST 005.md"}])
        finally:
            main._index_sample = original
        self.assertEqual(res["Samples/TST001.md"]["outcome"], "failed")
        self.assertEqual(res["Samples/TST 005.md"]["outcome"], "created")
        self.assertIsNone(self.sample("TST001"))
        self.assertEqual(db_rows("SELECT * FROM sample_filter_index WHERE sample_id='TST001'"), [])
        _, res = self.apply(data["preview_id"], [{"key": "Samples/TST001.md"}, {"key": "Samples/TST 005.md"}])
        self.assertEqual(res["Samples/TST001.md"]["outcome"], "created")
        self.assertEqual(res["Samples/TST 005.md"]["outcome"], "already_exists")
        self.assertEqual(len(self.sample("TST001")["layers"]), 3)

    # 12: ordinary edits, archive export/import, old archives
    def test_edit_and_archive_roundtrip(self):
        data, _ = self.preview()
        self.apply(data["preview_id"], [{"key": "Samples/TST001.md"}])
        s = client.get("/api/samples/TST001").json()
        s["notes"] = "edited in LabLog"
        s["layers"][0]["temp"] = 610
        self.assertEqual(client.put("/api/samples/TST001", json=s).status_code, 200)
        rec = client.get("/api/samples/TST001/source-record").json()
        self.assertEqual(rec["source"]["text"], NOTES["TST001"])

        # measurement data and notebooks work with an imported sample
        up = client.post("/api/samples/TST001/files/xrd_ot", files={"file": ("scan.csv", b"40,1\n41,5\n")})
        self.assertEqual(up.status_code, 200)
        self.assertEqual(client.post("/api/analysis-books", json={"id": "b1", "name": "Book", "sample_ids": ["TST001"]}).status_code, 200)

        z = client.get("/api/samples/TST001/export").content
        self.assertIn("source_record", json.loads(zipfile.ZipFile(io.BytesIO(z)).read("TST001/sample.json")))
        client.delete("/api/samples/TST001")
        r = client.post("/api/samples/import", files={"file": ("a.zip", z)}, data={})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(client.get("/api/samples/TST001/source-record").json()["source"]["sha256"], rec["source"]["sha256"])

        # old archive (no source_record) overwriting keeps the record; creating a new sample works
        sj = json.loads(zipfile.ZipFile(io.BytesIO(z)).read("TST001/sample.json"))
        sj.pop("source_record")
        buf = io.BytesIO()
        with zipfile.ZipFile(buf, "w") as zf:
            zf.writestr("TST001/sample.json", json.dumps(sj))
        old = buf.getvalue()
        r = client.post("/api/samples/import?config=" + json.dumps({"action": "overwrite"}), files={"file": ("old.zip", old)})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(client.get("/api/samples/TST001/source-record").status_code, 200)
        r = client.post("/api/samples/import?config=" + json.dumps({"action": "rename", "new_id": "OLD1"}), files={"file": ("old.zip", old)})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(client.get("/api/samples/OLD1/source-record").status_code, 404)

        # book export carries the record into another sample
        bz = client.get("/api/books/b1/export").content
        client.delete("/api/samples/TST001")
        r = client.post("/api/books/import", files={"file": ("b.labbook.zip", bz)})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(client.get("/api/samples/TST001/source-record").json()["source"]["sha256"], rec["source"]["sha256"])


class ParserTests(unittest.TestCase):

    def test_stack_lines(self):
        p = vault_import.parse_stack_line
        ok = p("film* |  Ti@1e+2W  +  BTO@150W/pDC | P=4  O2=20\tT=600 t=2.3E3")
        self.assertTrue(ok["ok"], ok)
        self.assertEqual([t["name"] for t in ok["targets"]], ["Ti", "BTO"])
        self.assertEqual(ok["targets"][0]["terms"][0]["value"], 100.0)
        self.assertEqual(ok["targets"][1]["terms"][1], {"kind": "mode", "unit": None, "value": "pDC", "text": "pDC"})
        self.assertEqual(p("electrode | BTO@125>175W | P=4")["targets"][0]["terms"][0]["kind"], "ramp")
        self.assertEqual(p("film | Ti@W | P=4")["targets"][0]["terms"][0]["kind"], "placeholder")
        for bad in ("film | BTO@150W | P=4x", "film | BTO@150W | P=nan", "film | BTO@1e999W | P=4",
                    "film | BTO@150W/150W | P=4", "film | BTO@150W | P=4 P=5", "film BTO@150W",
                    "film | BTO150W | P=4", "film | BTO@150W/RF/DC | P=4", "film:| BTO@1W | P=1", {"film": 1}):
            self.assertFalse(p(bad)["ok"], bad)

    def test_ids(self):
        for good in ("SP071", "TST 005", "PLD011_GSO", "Échantillon-1"):
            self.assertIsNone(vault_import.id_problem(good), good)
        for bad in ("", "../x", "a/b", "a\\b", "CON", "nul.txt", "a\x00b", " a", "a.", "é", "a​b", "a#b"):
            self.assertIsNotNone(vault_import.id_problem(bad), repr(bad))

    def test_yaml_safety(self):
        for text in ("a: !!python/object/apply:os.system ['true']", "a: &x 1\nb: *x", "a: 1\na: 2",
                     "a: .nan", "<<: {b: 1}", "? [1]\n: 2", "- 1"):
            with self.assertRaises(vault_import.NoteError, msg=text):
                vault_import.parse_frontmatter(text)
        values, raw, types = vault_import.parse_frontmatter("date: 2026-09-01\nlot: 0012\nflag: false\nz: 0")
        # YAML 1.1 reads 0012 as octal 10 — which is why lot/bin use the scalar's source spelling
        self.assertEqual(values, {"date": "2026-09-01", "lot": 10, "flag": False, "z": 0})
        self.assertEqual(raw["lot"], "0012")
        w = []
        self.assertEqual(vault_import._text_field("lot", values, raw, w), "0012")
        self.assertFalse(w[0]["ack"])
        self.assertEqual(types["date"], "date")

    def test_ambiguous_material_identity(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d).resolve()
            (root / "Materials").mkdir()
            (root / "Materials" / "OxS (110).md").write_text(note("type: substrate\nlablog_id: oxs_pc\nlablog_name: OxS (o)"))
            r = vault_import.MaterialResolver(root, [{"id": i, "name": n} for i, n in LIBRARY])
            self.assertTrue(r.resolve("OxS (110)")["ambiguous"])
            self.assertIsNone(r.resolve("OxS")["name"])
            self.assertEqual(r.resolve("BTO")["name"], "BTO")

    def test_root_validation(self):
        for bad in ("", "relative/path", "/definitely/not/here"):
            with self.assertRaises(vault_import.VaultError):
                vault_import.resolve_root(bad)
        with tempfile.TemporaryDirectory() as d:
            with self.assertRaises(vault_import.VaultError):
                vault_import.resolve_root(d)          # no Samples/


if __name__ == "__main__":
    unittest.main()
