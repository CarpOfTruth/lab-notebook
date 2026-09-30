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
MIN_REGION_PIXELS = 16

DEFAULT_SETTINGS = {
    "line": "linear",
    "surface": "poly2",
    "outlier_iqr": 3.0,
    "zero": "none",
    "regions": [],             # [{x0, y0, x1, y1, mode: include|exclude}], fractions of the displayed map
    "regions_file": None,      # stored filename the regions were drawn on
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
