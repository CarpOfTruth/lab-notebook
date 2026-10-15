"""Obsidian vault -> LabLog create-only sample import: scanning, parsing and conversion.

Everything here is read-only and database-free. Inputs are the vault root, the
materials library ([{id, name}]), the technique definitions from settings, and
the set of sample IDs already in LabLog. Persistence lives in main.py.

Conversion rules (see docs/user-manual.md, "Import from Obsidian"):
  * exact IDs only; unsafe or colliding identities block the record
  * no scientific defaults: absent values stay absent, ramps and placeholders
    leave the native field unset and are retained as text
  * the full original note is kept alongside the interpreted values
"""
import hashlib
import json
import math
import os
import re
import unicodedata
from datetime import date, datetime
from pathlib import Path
from typing import Optional

import yaml

SOURCE_FORMAT   = "lablog-vault-source"
SOURCE_VERSION  = 1
MAX_NOTE_BYTES  = 256 * 1024
SAMPLES_DIR     = "Samples"
MATERIALS_DIR   = "Materials"

CATEGORIES = ("ready", "review", "existing", "planned", "invalid")
CORE_ROLES = {"seed", "buffer", "barrier", "electrode", "film", "spacer", "cap", "sacrificial"}
# Frontmatter keys that become native sample fields. Everything else is retained only.
NATIVE_KEYS = ("type", "id", "date", "technique", "substrate", "lot", "bin", "description", "stack")

SHIPPED_TECHNIQUE_IDS = ("sputter", "pld")

# Stack grammar -> LabLog layer / target fields
CONDITION_FIELDS = {"P": "pressure", "O2": "oxygen_pct", "T": "temp", "t": "time_s", "f": "frequency_hz"}
DOSE_FIELDS      = {"W": "power_W", "mJ": "energy_mJ", "p": "pulses"}
MODE_NAMES       = {"RF": "RF", "DC": "DC", "pDC": "Pulsed DC"}   # vault term -> LabLog power_type option

NUMBER = r"[-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][-+]?\d+)?"
_RE_INT       = re.compile(r"[-+]?\d+")
_RE_NUM       = re.compile(NUMBER)
_RE_RAMP      = re.compile(rf"{NUMBER}(?:\s*>\s*{NUMBER})+")
_RE_DOSE      = re.compile(rf"({NUMBER})(W|mJ|p)")
_RE_DOSE_RAMP = re.compile(rf"({NUMBER}(?:\s*>\s*{NUMBER})+)(W|mJ|p)")
_RE_ROLE      = re.compile(r"([A-Za-z][A-Za-z0-9_-]*)(\*)?(?::\s*([^|*]*?))?\s*(\*)?")
_RE_COND      = re.compile(r"([A-Za-z][A-Za-z0-9]*)=(.*)")
_RE_WIKILINK  = re.compile(r"\[\[([^\[\]|]+)(?:\|([^\[\]]*))?\]\]")
_RE_ISO_DATE  = re.compile(r"\d{4}-\d{2}-\d{2}")
_RE_WIN_RESERVED = re.compile(r"(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?", re.IGNORECASE)
_ID_FORBIDDEN = set('/\\<>:"|?*#%')


class VaultError(Exception):
    """Configuration-level problem (root missing, no Samples folder)."""


class NoteError(Exception):
    """A single note cannot be read or parsed."""


# ── YAML ──────────────────────────────────────────────────────────────────────

class _StrictLoader(yaml.SafeLoader):
    """SafeLoader that rejects duplicate keys, merge keys, aliases and non-string keys."""

    def compose_node(self, parent, index):
        if self.check_event(yaml.events.AliasEvent):
            raise NoteError("YAML aliases are not supported in frontmatter")
        return super().compose_node(parent, index)

    def construct_mapping(self, node, deep=False):
        seen = set()
        for key_node, _ in node.value:
            if key_node.tag == "tag:yaml.org,2002:merge":
                raise NoteError("YAML merge keys are not supported in frontmatter")
            key = self.construct_object(key_node, deep=True)
            if not isinstance(key, str):
                raise NoteError(f"Frontmatter key {key!r} is not text")
            if key in seen:
                raise NoteError(f"Duplicate frontmatter key '{key}'")
            seen.add(key)
        return super().construct_mapping(node, deep)


def _to_json(value, where):
    """Convert safe-YAML values to JSON-compatible values, rejecting anything else."""
    if isinstance(value, dict):
        return {k: _to_json(v, f"{where}.{k}") for k, v in value.items()}
    if isinstance(value, list):
        return [_to_json(v, f"{where}[{i}]") for i, v in enumerate(value)]
    if value is None or isinstance(value, (str, bool, int)):
        return value
    if isinstance(value, float):
        if not math.isfinite(value):
            raise NoteError(f"Non-finite number in '{where}'")
        return value
    if isinstance(value, datetime):
        return value.isoformat()
    if isinstance(value, date):
        return value.isoformat()
    raise NoteError(f"Unsupported YAML value type {type(value).__name__} in '{where}'")


def split_note(text: str):
    """Return (frontmatter_text, body_text). Body is everything after the closing '---' line, intact."""
    lines = text.splitlines(keepends=True)
    first = lines[0].lstrip("﻿") if lines else ""
    if not lines or first.rstrip() != "---":
        raise NoteError("Note has no YAML frontmatter")
    for i in range(1, len(lines)):
        if lines[i].rstrip() == "---":
            return "".join(lines[1:i]), "".join(lines[i + 1:])
    raise NoteError("Frontmatter is not closed with '---'")


def parse_frontmatter(fm_text: str):
    """Return (values_json, raw_scalars, value_types). raw_scalars maps top-level keys to scalar source text."""
    loader = _StrictLoader(fm_text)
    try:
        node = loader.get_single_node()
        data = loader.construct_document(node) if node is not None else None
    except NoteError:
        raise
    except yaml.YAMLError as e:
        raise NoteError(f"Malformed YAML: {str(e).splitlines()[0]}")
    finally:
        loader.dispose()
    if not isinstance(data, dict):
        raise NoteError("Frontmatter is not a mapping")
    raw = {}
    for key_node, value_node in node.value:
        if isinstance(value_node, yaml.ScalarNode):
            raw[key_node.value] = value_node.value
    types = {k: type(v).__name__ for k, v in data.items()}
    return _to_json(data, "frontmatter"), raw, types


# ── Identity ──────────────────────────────────────────────────────────────────

def id_problem(sid) -> Optional[str]:
    """Return why a sample ID is unsafe, or None if it can be used exactly as written."""
    if not isinstance(sid, str) or sid == "":
        return "ID is missing"
    if len(sid) > 120:
        return "ID is longer than 120 characters"
    if sid in (".", ".."):
        return "ID is a path component"
    if sid != sid.strip():
        return "ID has leading or trailing whitespace"
    if sid.endswith("."):
        return "ID ends with a period"
    for ch in sid:
        if ch in _ID_FORBIDDEN:
            return f"ID contains the unsafe character {ch!r}"
        cat = unicodedata.category(ch)
        if cat[0] == "C" or cat in ("Zl", "Zp") or (ch.isspace() and ch != " "):
            return f"ID contains a control or invisible character (U+{ord(ch):04X})"
    if unicodedata.normalize("NFC", sid) != sid:
        return "ID is not in normalized Unicode form"
    if _RE_WIN_RESERVED.fullmatch(sid):
        return "ID is a reserved platform file name"
    return None


def fold_id(sid: str) -> str:
    return unicodedata.normalize("NFC", sid).casefold()


# ── Safe file access ──────────────────────────────────────────────────────────

def _read_inside(root: Path, path: Path) -> bytes:
    """Read a regular file that is inside root without following symlinks. Size-bounded, never truncated."""
    if path.is_symlink():
        raise NoteError("Symbolic link; not followed")
    try:
        resolved = path.resolve(strict=True)
    except OSError:
        raise NoteError("File not found")
    if not resolved.is_relative_to(root):
        raise NoteError("File resolves outside the vault root")
    flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0)
    try:
        fd = os.open(str(path), flags)
    except OSError as e:
        raise NoteError(f"Cannot open file: {e.strerror}")
    try:
        size = os.fstat(fd).st_size
        if size > MAX_NOTE_BYTES:
            raise NoteError(f"Note is {size} bytes, above the {MAX_NOTE_BYTES}-byte limit; not read")
        with os.fdopen(fd, "rb") as fh:
            fd = None
            data = fh.read(MAX_NOTE_BYTES + 1)
    finally:
        if fd is not None:
            os.close(fd)
    if len(data) > MAX_NOTE_BYTES:
        raise NoteError(f"Note is above the {MAX_NOTE_BYTES}-byte limit; not read")
    return data


def resolve_root(root_input: str) -> Path:
    if not isinstance(root_input, str) or not root_input.strip():
        raise VaultError("Enter the vault folder path")
    p = Path(root_input.strip())
    if not p.is_absolute():
        raise VaultError("Use an absolute folder path on the computer running LabLog")
    try:
        root = p.resolve(strict=True)
    except OSError:
        raise VaultError(f"Folder not found: {p}")
    if not root.is_dir():
        raise VaultError(f"Not a folder: {p}")
    samples = root / SAMPLES_DIR
    if samples.is_symlink():
        raise VaultError(f"{SAMPLES_DIR}/ is a symbolic link; not followed")
    if not samples.is_dir():
        raise VaultError(f"No {SAMPLES_DIR}/ folder in {root}")
    if not os.access(samples, os.R_OK | os.X_OK):
        raise VaultError(f"{SAMPLES_DIR}/ is not readable")
    return root


# ── Materials ─────────────────────────────────────────────────────────────────

class MaterialResolver:
    """Resolve vault material/substrate names to library names. Reads Materials/<name>.md only as needed."""

    def __init__(self, root: Path, library: list):
        self.root = root
        self.library = [{"id": m.get("id"), "name": m.get("name")} for m in (library or [])]
        self._notes = {}

    def _note(self, name: str):
        if name in self._notes:
            return self._notes[name]
        result = None
        safe = (name and "/" not in name and "\\" not in name and not name.startswith(".")
                and not any(unicodedata.category(c)[0] == "C" for c in name))
        if safe:
            path = self.root / MATERIALS_DIR / f"{name}.md"
            if path.exists() or path.is_symlink():
                try:
                    raw = _read_inside(self.root, path)
                    fm, _ = split_note(raw.decode("utf-8"))
                    values, _, _ = parse_frontmatter(fm)
                    result = {"path": f"{MATERIALS_DIR}/{name}.md", "sha256": hashlib.sha256(raw).hexdigest(),
                              "values": values, "error": None}
                except (NoteError, UnicodeDecodeError) as e:
                    result = {"path": f"{MATERIALS_DIR}/{name}.md", "sha256": None, "values": {}, "error": str(e)}
        self._notes[name] = result
        return result

    def resolve(self, name: str) -> dict:
        """Return {name, library_id, basis, problem, ambiguous, note, orientation}. name is None when unresolved.
        orientation is the material note's `orientation:` field (the cut), carried onto the sample."""
        out = {"name": None, "library_id": None, "basis": None, "problem": None, "ambiguous": False, "note": None,
               "orientation": None}
        by_name = [m for m in self.library if m["name"] == name]
        note = self._note(name)
        if note:
            out["note"] = {"path": note["path"], "sha256": note["sha256"]}
        by_note = []
        note_id = None
        if note and note["error"]:
            out["problem"] = f"material note {note['path']} could not be read ({note['error']})"
        elif note:
            o = note["values"].get("orientation")
            out["orientation"] = o.strip() if isinstance(o, str) and o.strip() else None
            note_id = note["values"].get("lablog_id")
            if note_id is not None:
                by_note = [m for m in self.library if m["id"] == note_id]
                if not by_note:
                    out["problem"] = f"material note lablog_id '{note_id}' is not in the materials library"
        candidates = {m["id"]: m for m in by_name + by_note}
        if len(by_name) > 1 or len(candidates) > 1:
            out["ambiguous"] = True
            out["problem"] = f"'{name}' matches more than one library entry ({', '.join(sorted(str(c) for c in candidates))})"
            return out
        if len(candidates) == 1:
            entry = next(iter(candidates.values()))
            note_name = note["values"].get("lablog_name") if note and not note["error"] else None
            if note_name is not None and note_name != entry["name"]:
                out["ambiguous"] = True
                out["problem"] = f"material note says lablog_name '{note_name}' but library id resolves to '{entry['name']}'"
                return out
            out.update(name=entry["name"], library_id=entry["id"],
                       basis="library name" if by_name else "material note lablog_id", problem=None)
        elif out["problem"] is None:
            out["problem"] = f"'{name}' is not a materials library name and has no linked lablog_id"
        return out


# ── Stack grammar ─────────────────────────────────────────────────────────────

def _number(text: str):
    if _RE_INT.fullmatch(text):
        return int(text)
    value = float(text)
    if not math.isfinite(value):
        raise ValueError("non-finite")
    return value


def parse_stack_line(raw) -> dict:
    """Syntax-only parse of one stack entry. Returns {ok, error, role, label, primary, targets, conditions}.

    targets: [{name, terms: [{kind: dose|ramp|placeholder|mode, unit, value, text}]}]
    conditions: [{key, kind: value|ramp|placeholder, value, text}]
    Any malformed piece makes the whole line unparsed (ok=False); nothing is partially guessed.
    """
    fail = lambda msg: {"ok": False, "error": msg}
    if not isinstance(raw, str):
        return fail("stack entry is not text")
    pieces = raw.split("|")
    if len(pieces) != 3:
        return fail("expected 'role | targets | conditions'")
    role_txt, targets_txt, cond_txt = (p.strip() for p in pieces)

    m = _RE_ROLE.fullmatch(role_txt)
    if not m:
        return fail(f"unrecognised role syntax '{role_txt}'")
    if m.group(2) and m.group(4):
        return fail(f"role '{role_txt}' is starred twice")
    label = (m.group(3) or "").strip()
    if m.group(3) is not None and not label:
        return fail(f"role '{role_txt}' has an empty label")
    result = {"ok": True, "error": None, "role": m.group(1), "label": label or None,
              "primary": bool(m.group(2) or m.group(4)), "targets": [], "conditions": []}

    if targets_txt:
        for piece in re.split(r"(?<![eE])\+", targets_txt):
            piece = piece.strip()
            if piece.count("@") != 1:
                return fail(f"target '{piece}' must be written MATERIAL@terms")
            name, terms_txt = (s.strip() for s in piece.split("@"))
            if not name:
                return fail(f"target '{piece}' has no material")
            terms, kinds, modes = [], set(), 0
            for term in [t.strip() for t in terms_txt.split("/")]:
                if (dm := _RE_DOSE.fullmatch(term)):
                    try:
                        value = _number(dm.group(1))
                    except ValueError:
                        return fail(f"non-finite value in '{term}'")
                    terms.append({"kind": "dose", "unit": dm.group(2), "value": value, "text": term})
                    unit = dm.group(2)
                elif (rm := _RE_DOSE_RAMP.fullmatch(term)):
                    terms.append({"kind": "ramp", "unit": rm.group(2), "value": None, "text": term})
                    unit = rm.group(2)
                elif term in DOSE_FIELDS or term == "":
                    terms.append({"kind": "placeholder", "unit": term or None, "value": None, "text": term})
                    unit = term or None
                elif term in MODE_NAMES:
                    modes += 1
                    terms.append({"kind": "mode", "unit": None, "value": term, "text": term})
                    continue
                else:
                    return fail(f"unrecognised term '{term}' in target '{piece}'")
                if unit is not None:
                    if unit in kinds:
                        return fail(f"target '{piece}' repeats the {unit} term")
                    kinds.add(unit)
            if modes > 1:
                return fail(f"target '{piece}' has more than one power mode")
            result["targets"].append({"name": name, "raw": piece, "terms": terms})

    seen = set()
    for token in cond_txt.split():
        cm = _RE_COND.fullmatch(token)
        if not cm:
            return fail(f"condition '{token}' must be written key=value")
        key, val = cm.group(1), cm.group(2)
        if key in seen:
            return fail(f"condition '{key}' appears twice")
        seen.add(key)
        if val == "":
            result["conditions"].append({"key": key, "kind": "placeholder", "value": None, "text": token})
        elif _RE_NUM.fullmatch(val):
            try:
                result["conditions"].append({"key": key, "kind": "value", "value": _number(val), "text": token})
            except ValueError:
                return fail(f"non-finite value in '{token}'")
        elif _RE_RAMP.fullmatch(val):
            result["conditions"].append({"key": key, "kind": "ramp", "value": None, "text": token})
        else:
            return fail(f"unrecognised value in condition '{token}'")
    return result


def focal_param(techniques: list, technique_id: str) -> dict:
    """Find the layer parameter that 'L' (focal position, mm) maps to for a technique.

    Returns {param_id, problem}. Only an unambiguous single candidate is used.
    """
    tech = next((t for t in techniques or [] if t.get("id") == technique_id), None)
    params = (tech or {}).get("params") or []
    hits = [p for p in params
            if p.get("scope") == "layer" and str(p.get("unit", "")).strip().lower() == "mm"
            and ("focal" in str(p.get("name", "")).lower() or p.get("id") == "focal_position")]
    if len(hits) == 1:
        return {"param_id": hits[0]["id"], "problem": None}
    if not hits:
        return {"param_id": None, "problem": f"no Focal Position (mm) layer parameter is configured for technique '{technique_id}'"}
    return {"param_id": None, "problem": f"more than one focal-position parameter is configured for '{technique_id}'"}


def convert_stack(stack, technique: str, techniques: list, resolver: MaterialResolver, evidence: str):
    """Map a vault stack onto native LabLog layers.

    Returns (layers, lines, warnings, dependencies). Layer ids are left None for the caller to assign.
    If any line is unparseable no native layers are proposed; every raw line is retained regardless.
    """
    warnings, lines, deps = [], [], {"materials": {}, "focal_param": None}
    if stack is None:
        return [], [], [_warn("stack_missing", "No stack recorded; no layers will be created", ack=False)], deps
    if not isinstance(stack, list):
        warnings.append(_warn("stack_unparsed", "Stack is not a list; it is retained as text and no layers are created"))
        return [], [{"index": 0, "raw": stack, "status": "unparsed", "problems": ["stack is not a list"]}], warnings, deps
    if not stack:
        warnings.append(_warn("stack_empty", "Empty stack: substrate-only record, no layers", ack=False))
        return [], [], warnings, deps

    parsed = [parse_stack_line(raw) for raw in stack]
    if any(not p["ok"] for p in parsed):
        for i, (raw, p) in enumerate(zip(stack, parsed)):
            lines.append({"index": i, "raw": raw, "status": "unparsed" if not p["ok"] else "not created",
                          "problems": [p["error"]] if not p["ok"] else []})
        bad = [f"layer {i + 1}: {p['error']}" for i, p in enumerate(parsed) if not p["ok"]]
        warnings.append(_warn("stack_unparsed",
                              "Stack syntax not recognised (" + "; ".join(bad) + "). The whole stack is retained "
                              "as text and no native layers are created"))
        return [], lines, warnings, deps

    focal = None
    layers = []
    for i, (raw, p) in enumerate(zip(stack, parsed)):
        n = i + 1
        unmapped, problems = [], []
        layer = {"id": None, "technique": technique, "role": p["role"]}
        if p["label"]:
            layer["role_label"] = p["label"]
        if p["primary"]:
            layer["primary"] = True
        if p["role"] not in CORE_ROLES:
            warnings.append(_warn("role_unknown", f"Layer {n}: role '{p['role']}' is not in the standard set; kept as written", ack=False, layer=i))

        targets = []
        for t in p["targets"]:
            res = resolver.resolve(t["name"])
            deps["materials"][t["name"]] = {k: res[k] for k in ("name", "library_id", "note")}
            target = {"material": res["name"] if res["name"] else t["name"]}
            if not res["name"]:
                warnings.append(_warn("material_ambiguous" if res["ambiguous"] else "material_unresolved",
                                      f"Layer {n}: target {res['problem']}; the text is kept as the material name", layer=i))
            has_power = False
            for term in t["terms"]:
                if term["kind"] == "mode":
                    target["power_type"] = MODE_NAMES[term["value"]]
                    target["power_type_basis"] = "explicit"
                    continue
                if term["unit"] == "W":
                    has_power = True
                if term["kind"] == "dose":
                    target[DOSE_FIELDS[term["unit"]]] = term["value"]
                elif term["kind"] == "ramp":
                    unmapped.append({"term": term["text"], "reason": "ramp; LabLog stores a single value"})
                    warnings.append(_warn("ramp", f"Layer {n}: ramp '{t['name']}@{term['text']}' kept as text; "
                                                  f"{DOSE_FIELDS[term['unit']]} left unset", layer=i))
                else:
                    unmapped.append({"term": t["raw"], "reason": "incomplete placeholder"})
                    warnings.append(_warn("placeholder", f"Layer {n}: '{t['raw']}' is an incomplete placeholder; "
                                                         f"value left unset", layer=i))
            if has_power and "power_type" not in target:
                target["power_type"] = "RF"
                target["power_type_basis"] = "convention (RF when no mode is written)"
            targets.append(target)
        layer["targets"] = targets
        if not targets:
            warnings.append(_warn("no_targets", f"Layer {n}: no target recorded", layer=i))

        for c in p["conditions"]:
            if c["key"] == "L":
                if focal is None:
                    focal = focal_param(techniques, technique)
                    deps["focal_param"] = focal["param_id"]
                if c["kind"] == "value" and focal["param_id"]:
                    layer.setdefault("custom", {})[focal["param_id"]] = c["value"]
                    continue
                if c["kind"] == "value":
                    unmapped.append({"term": c["text"], "reason": focal["problem"]})
                    warnings.append(_warn("focal_unmapped", f"Layer {n}: '{c['text']}' kept as text; {focal['problem']}", layer=i))
                    continue
            elif c["key"] not in CONDITION_FIELDS:
                unmapped.append({"term": c["text"], "reason": "unknown condition key"})
                warnings.append(_warn("condition_unknown", f"Layer {n}: unknown condition '{c['text']}' kept as text", layer=i))
                continue
            if c["kind"] == "value":
                layer[CONDITION_FIELDS[c["key"]]] = c["value"]
            elif c["kind"] == "ramp":
                unmapped.append({"term": c["text"], "reason": "ramp; LabLog stores a single value"})
                warnings.append(_warn("ramp", f"Layer {n}: ramp '{c['text']}' kept as text; value left unset", layer=i))
            else:
                unmapped.append({"term": c["text"], "reason": "incomplete placeholder"})
                warnings.append(_warn("placeholder", f"Layer {n}: '{c['text']}' has no value; left unset", layer=i))

        status = "partial" if unmapped else "full"
        layer["vault_source"] = {"index": i, "raw": raw, "mapping": status, "unmapped": unmapped, "basis": evidence}
        layers.append(layer)
        lines.append({"index": i, "raw": raw, "status": status, "role": p["role"], "role_label": p["label"],
                      "primary": p["primary"], "unmapped": unmapped, "problems": problems})
    return layers, lines, warnings, deps


# ── Record conversion ─────────────────────────────────────────────────────────

def _warn(code, message, ack=True, layer=None):
    return {"code": code, "message": message, "ack": ack, "layer": layer}


def _text_field(key, values, raw, warnings):
    """Exact text for lot/bin/description. Non-text YAML scalars keep their source spelling."""
    if key not in values or values[key] is None:
        return None
    v = values[key]
    if isinstance(v, str):
        return v
    if key in raw and not isinstance(v, (dict, list)):
        warnings.append(_warn(f"{key}_text", f"'{key}' was not written as text; its exact spelling '{raw[key]}' is used", ack=False))
        return raw[key]
    warnings.append(_warn(f"{key}_structured", f"'{key}' is not a single value; retained only"))
    return None


def _resolve_substrate(value, resolver, warnings, deps):
    out = {"original": value, "link_target": None, "alias": None, "name": None, "library_id": None, "orientation": None}
    if value is None or value == "":
        return out
    if not isinstance(value, str):
        warnings.append(_warn("substrate_unresolved", "Substrate is not text; retained only"))
        return out
    m = _RE_WIKILINK.fullmatch(value.strip())
    target = value.strip()
    if m:
        target = m.group(1).strip()
        out["link_target"] = target
        out["alias"] = m.group(2)
    res = resolver.resolve(target)
    deps["substrate"] = {k: res[k] for k in ("name", "library_id", "note")}
    if res["name"]:
        out.update(name=res["name"], library_id=res["library_id"], orientation=res.get("orientation"))
        if res["basis"] != "library name":
            warnings.append(_warn("substrate_mapped", f"Substrate '{value}' resolved to library entry "
                                                      f"'{res['name']}' via {res['basis']}", ack=False))
    else:
        out["name"] = target
        warnings.append(_warn("substrate_ambiguous" if res["ambiguous"] else "substrate_unresolved",
                              f"Substrate {res['problem']}; the text '{target}' is kept"))
    return out


def fingerprint(obj) -> str:
    return hashlib.sha256(json.dumps(obj, sort_keys=True, ensure_ascii=False, default=str).encode("utf-8")).hexdigest()


def _read_note(root: Path, path: Path) -> dict:
    rel = path.relative_to(root).as_posix()
    rec = {"key": rel, "path": rel, "stem": path.stem, "id": path.stem, "sha256": None, "bytes": None,
           "category": "invalid", "status": None, "errors": [], "warnings": [], "needs_confirmation": False}
    try:
        data = _read_inside(root, path)
        rec["sha256"], rec["bytes"] = hashlib.sha256(data).hexdigest(), len(data)
        try:
            text = data.decode("utf-8")
        except UnicodeDecodeError:
            raise NoteError("Note is not valid UTF-8")
        fm_text, body = split_note(text)
        values, raw, types = parse_frontmatter(fm_text)
    except NoteError as e:
        rec["errors"].append(str(e))
        return rec
    rec.update(_text=text, _values=values, _raw=raw, _types=types, _body=body)
    return rec


def _convert(rec: dict, resolver: MaterialResolver, techniques: list, technique_ids: set):
    values, raw, body = rec["_values"], rec["_raw"], rec["_body"]
    warnings = rec["warnings"]
    deps = {}

    status = values.get("lablog_status")
    if status not in ("draft", "synced"):
        rec["needs_confirmation"] = True
        warnings.append(_warn("status_unrecognised",
                              f"lablog_status is {'missing' if status is None else repr(status)}; confirm this is an "
                              f"existing, physically grown sample"))
    elif status == "synced":
        warnings.append(_warn("synced_absent", "Labelled 'synced' in the vault but not present in this database", ack=False))

    technique = values.get("technique")
    if not isinstance(technique, str) or technique not in technique_ids:
        rec["errors"].append(f"Technique {technique!r} is not a LabLog technique ({', '.join(sorted(technique_ids))}); "
                             f"fix the note or add the technique in Settings, then rescan")
        return

    d = values.get("date")
    sample_date = None
    if d is None or d == "":
        warnings.append(_warn("date_missing", "No growth date recorded; date left empty", ack=False))
    elif rec["_types"].get("date") == "date" or (isinstance(d, str) and _RE_ISO_DATE.fullmatch(d)):
        try:
            date.fromisoformat(d)
            sample_date = d
        except ValueError:
            warnings.append(_warn("date_invalid", f"Date '{d}' is not a valid calendar date; left empty"))
    else:
        warnings.append(_warn("date_invalid", f"Date {d!r} is not a plain YYYY-MM-DD growth date; left empty"))

    notes = _text_field("description", values, raw, warnings)
    lot = _text_field("lot", values, raw, warnings)
    bin_ = _text_field("bin", values, raw, warnings)
    substrate = _resolve_substrate(values.get("substrate"), resolver, warnings, deps)

    evidence = "recorded"
    if re.search(r"reconstruct", body, re.IGNORECASE) or (isinstance(notes, str) and re.search(r"reconstruct", notes, re.IGNORECASE)):
        evidence = "reconstructed"
        if values.get("stack"):
            warnings.append(_warn("reconstructed", "The note describes reconstructed growth information; "
                                                   "layers created from it are marked as reconstructed"))

    layers, lines, stack_warnings, stack_deps = convert_stack(values.get("stack"), technique, techniques, resolver, evidence)
    warnings.extend(stack_warnings)
    deps.update(stack_deps)

    rec["sample"] = {
        "id": rec["id"], "date": sample_date, "substrate": substrate["name"], "notes": notes,
        "thickness_nm": None, "area_m2": None, "area_correction": 1.0,
        "technique": technique, "folder_id": None, "layers": layers,
        "filenames": {}, "xrd_peaks": [], "module_config": {}, "lot": lot, "bin": bin_,
        "substrate_orientation": substrate.get("orientation"),
    }
    rec["substrate"] = substrate
    rec["stack"] = lines
    rec["evidence"] = evidence
    rec["dependencies"] = deps
    rec["retained"] = {k: v for k, v in values.items() if k not in NATIVE_KEYS}
    rec["description"] = notes
    rec["body"] = body
    rec["category"] = "review" if any(w["ack"] for w in warnings) else "ready"


def scan_vault(root_input: str, library: list, techniques: Optional[list], existing_ids) -> dict:
    """Read-only scan of <root>/Samples. Returns {root, records, ignored, counts}."""
    root = resolve_root(root_input)
    techniques = techniques or []
    technique_ids = {t.get("id") for t in techniques if t.get("id")} or set(SHIPPED_TECHNIQUE_IDS)
    resolver = MaterialResolver(root, library)
    existing = set(existing_ids)
    existing_folded = {}
    for sid in existing:
        existing_folded.setdefault(fold_id(sid), []).append(sid)

    notes, ignored = [], []
    samples_dir = root / SAMPLES_DIR
    for dirpath, dirnames, filenames in os.walk(samples_dir, followlinks=False):
        here = Path(dirpath)
        keep = []
        for d in sorted(dirnames):
            if d.startswith((".", "_")):
                continue
            if (here / d).is_symlink():
                ignored.append({"path": (here / d).relative_to(root).as_posix(), "reason": "symbolic link folder; not followed"})
                continue
            keep.append(d)
        dirnames[:] = keep
        for fn in sorted(filenames):
            if fn.startswith(".") or not fn.lower().endswith(".md"):
                continue
            notes.append(_read_note(root, here / fn))

    records = []
    for rec in notes:
        if rec["errors"]:
            records.append(rec)
            continue
        values = rec["_values"]
        if values.get("type") != "sample":
            ignored.append({"path": rec["path"], "reason": f"type is {values.get('type')!r}, not 'sample'"})
            continue
        rec["status"] = values.get("lablog_status")
        fid = values.get("id")
        if not isinstance(fid, str) and "id" in rec["_raw"] and rec["_raw"]["id"] == rec["stem"]:
            fid = rec["_raw"]["id"]
        rec["id"] = fid if isinstance(fid, str) else rec["stem"]
        rec["_fm_id"] = fid
        records.append(rec)

    # Identity collisions across all sample notes (planned included)
    by_fold = {}
    for rec in records:
        if "_values" in rec:
            by_fold.setdefault(fold_id(rec["stem"]), []).append(rec)

    for rec in records:
        if rec["errors"]:
            continue
        values = rec["_values"]
        if rec["status"] == "planned":
            rec["category"] = "planned"
            continue
        fid = rec["_fm_id"]
        problem = id_problem(rec["stem"])
        if problem:
            rec["errors"].append(f"Filename: {problem}")
        elif fid != rec["stem"]:
            rec["errors"].append(f"Frontmatter id {fid!r} does not match the filename '{rec['stem']}'")
        elif len(by_fold[fold_id(rec["stem"])]) > 1:
            others = [r["path"] for r in by_fold[fold_id(rec["stem"])] if r is not rec]
            rec["errors"].append(f"ID collides with {', '.join(others)}")
        if rec["errors"]:
            continue
        if rec["id"] in existing:
            rec["category"] = "existing"
            continue
        folded = existing_folded.get(fold_id(rec["id"]))
        if folded:
            rec["errors"].append(f"ID differs only in letter case from existing LabLog sample {', '.join(folded)}")
            continue
        _convert(rec, resolver, techniques, technique_ids)

    out = []
    for rec in records:
        if rec["errors"]:
            rec["category"] = "invalid"
        rec["fingerprint"] = fingerprint({k: rec.get(k) for k in
                                          ("sha256", "category", "sample", "stack", "warnings", "errors", "dependencies", "id")})
        rec["source"] = {k: rec.get(k) for k in ("_text", "_values", "_body")}
        out.append({k: v for k, v in rec.items() if not k.startswith("_")})
    counts = {c: sum(1 for r in out if r["category"] == c) for c in CATEGORIES}
    counts["ignored"] = len(ignored)
    return {"root": str(root), "records": out, "ignored": ignored, "counts": counts}


def public_record(rec: dict) -> dict:
    """Preview payload for the UI (drops the raw note text, which the source record keeps)."""
    return {k: v for k, v in rec.items() if k != "source"}


def build_source_record(rec: dict, imported_at: str, choices: dict) -> dict:
    src = rec["source"]
    return {
        "format": SOURCE_FORMAT,
        "version": SOURCE_VERSION,
        "source": {
            "kind": "obsidian-note",
            "relative_path": rec["path"],
            "sha256": rec["sha256"],
            "bytes": rec["bytes"],
            "encoding": "utf-8",
            "text": src["_text"],          # exact original note; .encode("utf-8") reproduces the bytes
            "frontmatter": src["_values"],
            "body": src["_body"],
        },
        "retained_keys": sorted(rec.get("retained", {}).keys()),
        "substrate": rec.get("substrate"),
        "stack": rec.get("stack"),
        "evidence": rec.get("evidence"),
        "warnings": rec.get("warnings"),
        "dependencies": rec.get("dependencies"),
        "imported_at": imported_at,
        "import_choices": choices,
    }
