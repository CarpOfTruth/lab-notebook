"""
afm.py : flattening and roughness for AFM topography channels.

Processing always acts on the whole map. Rectangles drawn on the card only
decide which pixels the fits (and the region statistics) use:
  * include rectangles: if any exist, only pixels inside them are used;
  * exclude rectangles: pixels inside them are never used.

Only the height channel is processed (values in metres in, nanometres out):
  1. line correction per scan line (row after the display rotation):
     off | offset (median) | linear | quadratic
  2. background surface over the whole map: off | plane | poly2 | poly3
  3. zero reference: none | mean | median | min of the region pixels
Outliers beyond `outlier_iqr` interquartile ranges are left out of the fits
(0 turns this off). The defaults reproduce LabLog's original fixed flatten:
linear lines, then a 2nd-order surface, 3·IQR outlier rule, no zeroing.
"""

from typing import Dict, List, Optional, Tuple

import numpy as np

LINE_MODES = ("off", "offset", "linear", "quadratic")
SURFACE_MODES = ("off", "plane", "poly2", "poly3")
ZERO_MODES = ("none", "mean", "median", "min")
# Display-only colormap choice; "afm" is LabLog's original AFM palette, the rest match the notebooks.
COLORMAPS = ("afm", "viridis", "cividis", "inferno", "magma", "plasma", "coolwarm")
MIN_REGION_PIXELS = 16

DEFAULT_SETTINGS = {
    "line": "linear",
    "surface": "poly2",
    "outlier_iqr": 3.0,
    "zero": "none",
    "regions": [],             # [{x0, y0, x1, y1, mode: include|exclude}], fractions of the displayed map
    "regions_file": None,      # stored filename the regions were drawn on
    "range_min": None,         # height color scale limits in nm (None = automatic 0.5–99.5 %)
    "range_max": None,
    "colormap": "afm",         # display palette
    "color_trim": 0.0,         # % cut from each end of the palette (as in the notebooks' Trim %)
    "steps": None,             # processing chain (see run_chain); None = the single-pass flatten
}


def normalize_settings(raw: Optional[dict]) -> dict:
    """Merge saved settings over the defaults and drop anything invalid."""
    s = dict(DEFAULT_SETTINGS)
    raw = raw or {}
    if raw.get("line") in LINE_MODES:
        s["line"] = raw["line"]
    if raw.get("surface") in SURFACE_MODES:
        s["surface"] = raw["surface"]
    if raw.get("zero") in ZERO_MODES:
        s["zero"] = raw["zero"]
    try:
        k = float(raw.get("outlier_iqr", s["outlier_iqr"]))
        s["outlier_iqr"] = k if 0 <= k <= 100 else s["outlier_iqr"]
    except (TypeError, ValueError):
        pass
    regions = []
    for r in raw.get("regions") or []:
        try:
            x0, x1 = sorted((float(r["x0"]), float(r["x1"])))
            y0, y1 = sorted((float(r["y0"]), float(r["y1"])))
        except (KeyError, TypeError, ValueError):
            continue
        x0, y0 = max(0.0, x0), max(0.0, y0)
        x1, y1 = min(1.0, x1), min(1.0, y1)
        if x1 - x0 <= 0 or y1 - y0 <= 0:
            continue
        regions.append({"x0": x0, "y0": y0, "x1": x1, "y1": y1,
                        "mode": "exclude" if r.get("mode") == "exclude" else "include"})
    s["regions"] = regions
    s["regions_file"] = raw.get("regions_file") or None
    for k in ("range_min", "range_max"):
        try:
            v = raw.get(k)
            s[k] = float(v) if v is not None and v != "" and np.isfinite(float(v)) else None
        except (TypeError, ValueError):
            s[k] = None
    if raw.get("colormap") in COLORMAPS:
        s["colormap"] = raw["colormap"]
    try:
        t = float(raw.get("color_trim", 0) or 0)
        s["color_trim"] = t if 0 <= t <= 49 else 0.0
    except (TypeError, ValueError):
        s["color_trim"] = 0.0
    if s["range_min"] is not None and s["range_max"] is not None and s["range_min"] >= s["range_max"]:
        s["range_min"] = s["range_max"] = None      # inverted limits: fall back to automatic
    s["steps"] = normalize_steps(raw.get("steps"))  # processing chain; None = single-pass flatten
    return s


def is_default(s: dict, regions_active: bool) -> bool:
    return (s["line"] == DEFAULT_SETTINGS["line"] and s["surface"] == DEFAULT_SETTINGS["surface"]
            and s["outlier_iqr"] == DEFAULT_SETTINGS["outlier_iqr"] and s["zero"] == "none"
            and not regions_active)


def region_mask(shape: Tuple[int, int], regions: List[dict]) -> Optional[np.ndarray]:
    """Boolean mask of region pixels (True = used), or None when there are no regions."""
    if not regions:
        return None
    H, W = shape

    def rect(r):
        m = np.zeros((H, W), dtype=bool)
        c0, c1 = int(np.floor(r["x0"] * W)), int(np.ceil(r["x1"] * W))
        r0, r1 = int(np.floor(r["y0"] * H)), int(np.ceil(r["y1"] * H))
        m[r0:max(r1, r0 + 1), c0:max(c1, c0 + 1)] = True
        return m

    inc = [r for r in regions if r["mode"] == "include"]
    exc = [r for r in regions if r["mode"] == "exclude"]
    mask = np.zeros((H, W), dtype=bool) if inc else np.ones((H, W), dtype=bool)
    for r in inc:
        mask |= rect(r)
    for r in exc:
        mask &= ~rect(r)
    return mask


def _iqr_mask(a: np.ndarray, k: float) -> np.ndarray:
    ok = np.isfinite(a)
    if k <= 0 or not ok.any():
        return ok
    q1, q3 = np.percentile(a[ok], [25, 75])
    iqr = q3 - q1
    return ok & (a >= q1 - k * iqr) & (a <= q3 + k * iqr)


def _surface_terms(x: np.ndarray, y: np.ndarray, mode: str) -> List[np.ndarray]:
    one = np.ones_like(x)
    if mode == "plane":
        return [one, x, y]
    if mode == "poly2":
        return [one, x, y, x * x, x * y, y * y]
    return [one, x, y, x * x, x * y, y * y, x ** 3, x * x * y, x * y * y, y ** 3]


def process_topography(ch_m: np.ndarray, s: dict, mask: Optional[np.ndarray]) -> Tuple[np.ndarray, dict]:
    """Flatten one topography channel (metres) over the whole map; returns (nm array, info)."""
    ch = ch_m.astype(np.float64).copy()
    H, W = ch.shape
    use = mask if mask is not None else np.ones((H, W), dtype=bool)
    info = {"fallback_lines": 0, "fit_pixels": None, "warnings": []}

    # 1. line correction (fit per row on region ∩ non-outlier pixels; a row with too few
    #    such pixels falls back to all its finite pixels, as the original flatten did)
    if s["line"] != "off":
        deg = {"offset": 0, "linear": 1, "quadratic": 2}[s["line"]]
        xs = np.arange(W, dtype=np.float64)
        line_mask = _iqr_mask(ch, s["outlier_iqr"]) & use
        need = max(deg + 1, 2)
        for r in range(H):
            m = line_mask[r]
            if m.sum() < need:
                m = np.isfinite(ch[r])
                if mask is not None:
                    info["fallback_lines"] += 1
            if m.sum() < need:
                continue
            if deg == 0:
                ch[r] -= np.median(ch[r, m])
            else:
                c = np.polyfit(xs[m], ch[r, m], deg)
                ch[r] -= np.polyval(c, xs)

    # 2. background surface over the whole map, fit on region ∩ non-outlier pixels
    if s["surface"] != "off":
        ys, xs2 = np.mgrid[0:H, 0:W].astype(np.float64)
        fit = _iqr_mask(ch, s["outlier_iqr"]) & use
        n_terms = len(_surface_terms(np.zeros(1), np.zeros(1), s["surface"]))
        if fit.sum() < n_terms:
            info["warnings"].append("too few region pixels for the surface fit; surface step skipped")
        else:
            if s["surface"] == "poly3":
                # scale coordinates to [-1, 1] so cubic terms stay well conditioned
                xs2 = xs2 / max(W - 1, 1) * 2 - 1
                ys = ys / max(H - 1, 1) * 2 - 1
            A = np.stack([t[fit] for t in _surface_terms(xs2, ys, s["surface"])], axis=1)
            c, *_ = np.linalg.lstsq(A, ch[fit], rcond=None)
            ch -= sum(ci * t for ci, t in zip(c, _surface_terms(xs2, ys, s["surface"])))
            info["fit_pixels"] = int(fit.sum())

    ch *= 1e9  # m → nm

    # 3. zero reference from the region pixels
    if s["zero"] != "none":
        vals = ch[use & np.isfinite(ch)]
        if vals.size:
            ch -= {"mean": np.mean, "median": np.median, "min": np.min}[s["zero"]](vals)
    return ch, info


def roughness(ch_nm: np.ndarray, mask: Optional[np.ndarray] = None) -> Optional[Dict[str, float]]:
    """Rq (RMS), Ra, peak-to-valley and mean of the processed map, over `mask` if given."""
    sel = np.isfinite(ch_nm) if mask is None else (mask & np.isfinite(ch_nm))
    v = ch_nm[sel]
    if v.size == 0:
        return None
    d = v - v.mean()
    return {"rq_nm": float(np.sqrt(np.mean(d * d))), "ra_nm": float(np.mean(np.abs(d))),
            "pv_nm": float(v.max() - v.min()), "mean_nm": float(v.mean()), "pixels": int(v.size)}


# ══════════════════════════════════════════════════════════════════════════════
# Processing chain
# ══════════════════════════════════════════════════════════════════════════════
# A saved chain (settings["steps"]) replaces the single-pass flatten above. Steps run
# in order on the height map (nm) and share one mask of EXCLUDED pixels: mask steps
# add to it; fit steps (lines, surface, zero) use only pixels outside it; the flatten
# itself always acts on the whole map. Samples without a chain keep the flatten above.
#
#   particles  auto-detect features: coarse level → |Δ| > k·MAD (robust σ) → drop specks
#              → grow by `grow` px; repeated `passes` times, each pass re-levelling the
#              background without the features found so far.
#   regions    user rectangles: include (only these pixels) / exclude.
#   lines      per scan line: offset (median) | linear | quadratic | mdiff (median of
#              differences to the previous line).
#   surface    plane | poly2 | poly3 over the whole map.
#   scars      single-line glitches (a line that sits above or below BOTH neighbours by
#              > k·MAD over ≥ min_len px) replaced by the mean of the neighbours.
#   zero       mean | median | min of the unmasked pixels set to 0.

STEP_TYPES = ("particles", "regions", "lines", "surface", "scars", "zero")


def _num(v, default, lo, hi, cast=float):
    try:
        v = cast(v)
    except (TypeError, ValueError):
        return default
    return v if lo <= v <= hi else default


def normalize_steps(raw) -> Optional[List[dict]]:
    """Validated chain, or None when the sample has no chain saved."""
    if raw is None:
        return None
    steps = []
    for st in raw if isinstance(raw, list) else []:
        t = (st or {}).get("type")
        if t == "particles":
            steps.append({"type": t, "k": _num(st.get("k"), 5.0, 1, 50), "grow": _num(st.get("grow"), 2, 0, 20, int),
                          "min_px": _num(st.get("min_px"), 4, 1, 10000, int), "passes": _num(st.get("passes"), 3, 1, 6, int),
                          "polarity": "both" if st.get("polarity") == "both" else "up"})
        elif t == "regions":
            regs = normalize_settings({"regions": st.get("regions")})["regions"]
            if regs:
                steps.append({"type": t, "regions": regs, "file": st.get("file") or None})
        elif t == "lines":
            steps.append({"type": t, "mode": st.get("mode") if st.get("mode") in ("offset", "linear", "quadratic", "mdiff") else "linear"})
        elif t == "surface":
            steps.append({"type": t, "order": st.get("order") if st.get("order") in ("plane", "poly2", "poly3") else "poly2"})
        elif t == "scars":
            steps.append({"type": t, "k": _num(st.get("k"), 4.0, 1, 50), "min_len": _num(st.get("min_len"), 8, 2, 4096, int)})
        elif t == "zero":
            steps.append({"type": t, "mode": st.get("mode") if st.get("mode") in ("mean", "median", "min") else "median"})
    return steps


def _robust_sigma(v: np.ndarray) -> float:
    v = v[np.isfinite(v)]
    if v.size == 0:
        return 0.0
    return float(1.4826 * np.median(np.abs(v - np.median(v))))


def _fit_surface(z: np.ndarray, use: np.ndarray, order: str) -> Optional[np.ndarray]:
    H, W = z.shape
    y, x = np.mgrid[0:H, 0:W].astype(np.float64)
    x = x / max(W - 1, 1) * 2 - 1
    y = y / max(H - 1, 1) * 2 - 1
    terms = _surface_terms(x, y, order)
    fit = use & np.isfinite(z)
    if fit.sum() < len(terms):
        return None
    A = np.stack([t[fit] for t in terms], axis=1)
    c, *_ = np.linalg.lstsq(A, z[fit], rcond=None)
    return sum(ci * t for ci, t in zip(c, terms))


def _level_lines(z: np.ndarray, use: np.ndarray, mode: str) -> Tuple[np.ndarray, int]:
    """Per-line correction on unmasked pixels; lines with too few fall back to the whole line."""
    out = z.copy()
    H, W = z.shape
    fallback = 0
    if mode == "mdiff":
        for r in range(1, H):
            d = out[r] - out[r - 1]
            m = use[r] & use[r - 1] & np.isfinite(d)
            if m.sum() < 5:
                m = np.isfinite(d)
                fallback += 1
            if m.any():
                out[r] -= np.median(d[m])
        return out, fallback
    deg = {"offset": 0, "linear": 1, "quadratic": 2}[mode]
    xs = np.arange(W, dtype=np.float64)
    need = max(deg + 1, W // 20)
    for r in range(H):
        m = use[r] & np.isfinite(z[r])
        if m.sum() < need:
            m = np.isfinite(z[r])
            fallback += 1
        if m.sum() < deg + 1:
            continue
        if deg == 0:
            out[r] -= np.median(z[r, m])
        else:
            out[r] -= np.polyval(np.polyfit(xs[m], z[r, m], deg), xs)
    return out, fallback


def _detect_particles(z: np.ndarray, excl: np.ndarray, st: dict) -> Tuple[np.ndarray, int]:
    from scipy import ndimage as ndi
    base = ~excl
    tmp, _ = _level_lines(z, base, "offset")                 # coarse, robust first level
    s = _fit_surface(tmp, base, "poly2")
    tmp = tmp - s if s is not None else tmp
    found = np.zeros_like(excl)
    n_found = 0
    for _ in range(st["passes"]):
        bg = base & ~found
        ref = tmp[bg & np.isfinite(tmp)]
        if ref.size < 16:
            break
        med, sig = np.median(ref), _robust_sigma(ref)
        dev = tmp - med
        core = (dev > st["k"] * sig) if st["polarity"] == "up" else (np.abs(dev) > st["k"] * sig)
        core &= base
        lab, n = ndi.label(core)
        if n:
            sizes = ndi.sum(core, lab, range(1, n + 1))
            keep = np.nonzero(sizes >= st["min_px"])[0] + 1
            core = np.isin(lab, keep)
            n_found = int(keep.size)
        else:
            n_found = 0
        found = ndi.binary_dilation(core, structure=ndi.generate_binary_structure(2, 1), iterations=st["grow"]) if st["grow"] else core
        found &= base
        # re-level the raw input on the background without the features, for the next pass
        bg = base & ~found
        tmp, _ = _level_lines(z, bg, "linear")
        s = _fit_surface(tmp, bg, "poly2")
        tmp = tmp - s if s is not None else tmp
    return found, n_found


def _remove_scars(z: np.ndarray, excl: np.ndarray, st: dict) -> Tuple[np.ndarray, int]:
    out = z.copy()
    H, W = z.shape
    if H < 3:
        return out, 0
    up = out[1:-1] - out[:-2]
    dn = out[1:-1] - out[2:]
    ok = ~excl[1:-1] & ~excl[:-2] & ~excl[2:]
    sig = _robust_sigma(np.concatenate([up[ok], dn[ok]])) if ok.any() else 0.0
    if sig <= 0:
        return out, 0
    thr = st["k"] * sig
    cand = ok & (((up > thr) & (dn > thr)) | ((up < -thr) & (dn < -thr)))
    fixed_lines = 0
    for i in range(cand.shape[0]):
        row = cand[i]
        if not row.any():
            continue
        # runs of at least min_len consecutive pixels along the line
        edges = np.diff(np.concatenate([[0], row.view(np.int8), [0]]))
        starts, ends = np.nonzero(edges == 1)[0], np.nonzero(edges == -1)[0]
        hit = False
        for a, b in zip(starts, ends):
            if b - a >= st["min_len"]:
                r = i + 1
                out[r, a:b] = (out[r - 1, a:b] + out[r + 1, a:b]) / 2
                hit = True
        fixed_lines += int(hit)
    return out, fixed_lines


def run_chain(z_m: np.ndarray, steps: List[dict], filename: Optional[str] = None) -> Tuple[np.ndarray, np.ndarray, List[dict]]:
    """Run the chain on a height map in metres. Returns (height nm, excluded mask, per-step info)."""
    z = z_m.astype(np.float64) * 1e9
    excl = ~np.isfinite(z)
    infos = []
    for st in steps:
        info: dict = {"type": st["type"]}
        t = st["type"]
        if t == "particles":
            found, n = _detect_particles(z, excl, st)
            excl = excl | found
            info.update(found=n, coverage=float(found.mean()))
        elif t == "regions":
            if st.get("file") and filename and st["file"] != filename:
                info["skipped"] = "drawn on a different file"
            else:
                rm = region_mask(z.shape, st["regions"])
                excl = excl | ~rm
                info["kept"] = float(rm.mean())
        elif t == "lines":
            z, fb = _level_lines(z, ~excl, st["mode"])
            info["fallback_lines"] = fb
        elif t == "surface":
            s = _fit_surface(z, ~excl, st["order"])
            if s is None:
                info["skipped"] = "too few unmasked pixels"
            else:
                z = z - s
        elif t == "scars":
            z, n = _remove_scars(z, excl, st)
            info["fixed_lines"] = n
        elif t == "zero":
            v = z[~excl & np.isfinite(z)]
            if v.size:
                z = z - {"mean": np.mean, "median": np.median, "min": np.min}[st["mode"]](v)
        infos.append(info)
    return z, excl, infos


def pack_mask(mask: np.ndarray) -> str:
    """Row-major bit-packed mask, base64 (for the editor's overlay)."""
    import base64
    return base64.b64encode(np.packbits(mask.astype(np.uint8).ravel()).tobytes()).decode("ascii")
