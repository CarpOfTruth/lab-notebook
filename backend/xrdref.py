"""
xrdref.py : substrate reference reflections and theta-2theta alignment.

Pure and database-free (the vault_import.py pattern): no FastAPI, no I/O. Callers
pass in a materials-library `crystal` dict, a cut, a wavelength and the scan arrays.

Design: docs/xrd-substrate-alignment.md. The rules that matter most:

* The orthorhombic `(o)` entries are canonical for diffraction. A cell flagged
  `"pseudocubic": true` is for strain arithmetic only and is refused here, because
  the pseudocubic parameter is a volume average, not the out-of-plane spacing.
* The cell belongs to the material; the cut (orientation) belongs to the sample.
  Orientation must be given explicitly. Nothing here guesses one.
* Reflections are derived from the cell, the cut and the space group, not stored.
  Fd-3m extinctions are applied (Si (002) is forbidden); simple perovskites and
  Pbnm allow every order. Forbidden reflections in range are still returned, with
  role "opportunistic", because multiple diffraction sometimes makes them visible.
"""

import math
import re
from typing import Dict, List, Optional, Tuple

CU_KA1_A = 1.540593          # fallback only; read the wavelength from the file when it has one

_AXES = ("a", "b", "c")


# ── cell and reflection geometry ──────────────────────────────────────────────
def _axis(cell: dict, name: str) -> float:
    v = (cell or {}).get(name)
    try:
        f = float(v)
    except (TypeError, ValueError):
        raise ValueError(f"cell axis '{name}' is missing or not numeric ({v!r})")
    if not math.isfinite(f) or f <= 0:
        raise ValueError(f"cell axis '{name}' must be a positive number ({v!r})")
    return f


def check_diffraction_cell(cell: dict) -> None:
    """Raise if this cell must not be used to compute reflection positions."""
    if (cell or {}).get("pseudocubic"):
        raise ValueError("pseudocubic cell: a volume-averaged parameter for strain arithmetic only, "
                         "not an out-of-plane spacing; use the orthorhombic (o) entry")


def d_hkl(cell: dict, hkl: Tuple[int, int, int]) -> float:
    """Interplanar spacing in Å. Orthorhombic metric (covers cubic and tetragonal):
       1/d² = h²/a² + k²/b² + l²/c². Missing or non-numeric axes raise."""
    check_diffraction_cell(cell)
    h, k, l = hkl
    if h == 0 and k == 0 and l == 0:
        raise ValueError("hkl (000) has no spacing")
    inv = 0.0
    for idx, name in zip((h, k, l), _AXES):
        if idx:
            inv += idx * idx / _axis(cell, name) ** 2
    return 1.0 / math.sqrt(inv)


def two_theta(d: float, wavelength_A: float) -> Optional[float]:
    """Bragg angle 2θ in degrees, or None when λ/(2d) > 1 (unreachable)."""
    s = wavelength_A / (2.0 * d)
    if s > 1:
        return None
    return math.degrees(2.0 * math.asin(s))


def parse_orientation(orientation: str) -> Tuple[int, int, int]:
    """'(110)' or '(1 1 0)' or '(-1 1 0)' → (1, 1, 0). Raises on anything else."""
    if not isinstance(orientation, str) or not orientation.strip():
        raise ValueError("orientation is required (e.g. '(001)'); it is never guessed")
    body = orientation.strip().strip("()[]{}").strip()
    if re.fullmatch(r"\d{3}", body):
        nums = [int(ch) for ch in body]
    else:
        nums = [int(t) for t in re.split(r"[\s,]+", body) if t]
    if len(nums) != 3 or not any(nums):
        raise ValueError(f"cannot read orientation {orientation!r}")
    g = math.gcd(math.gcd(abs(nums[0]), abs(nums[1])), abs(nums[2]))
    return tuple(n // g for n in nums)


def reflection_class(space_group: Optional[str], hkl: Tuple[int, int, int]) -> str:
    """'allowed', 'opportunistic' or 'absent' for the space groups in use.

    Fd-3m (diamond): allowed when h, k, l are all odd, or all even with h+k+l = 4n.
    All even with h+k+l = 4n+2 (Si (002), (006)) is killed only by the diamond glide;
    two allowed reflections can sum to it, so multiple diffraction sometimes shows it:
    'opportunistic'. Mixed parity (Si (001), (003)) is killed by the face-centred lattice
    itself; no pair of allowed reflections sums to it, so it can never appear: 'absent'.
    Everything else here (simple perovskites, Pbnm for the symmetric cuts in use)
    allows every order."""
    h, k, l = (abs(x) for x in hkl)
    if (space_group or "").replace(" ", "").lower() in ("fd-3m", "fd3m"):
        parities = {h % 2, k % 2, l % 2}
        if len(parities) > 1:
            return "absent"
        if parities == {1} or (h + k + l) % 4 == 0:
            return "allowed"
        return "opportunistic"
    return "allowed"


def is_allowed(space_group: Optional[str], hkl: Tuple[int, int, int]) -> bool:
    return reflection_class(space_group, hkl) == "allowed"


def _cut_spacing(cell: dict, base: Tuple[int, int, int], n: int) -> float:
    """d for the n-th order of the cut. For a principal-axis cut, an explicit
    `out_of_plane_axis` on the cell names which cell length is out of plane
    (Si:STO's template has a ≠ c and the out-of-plane one is c)."""
    oop = (cell or {}).get("out_of_plane_axis")
    nonzero = [i for i, v in enumerate(base) if v]
    if oop and len(nonzero) == 1:
        if oop not in _AXES:
            raise ValueError(f"out_of_plane_axis must be a, b or c ({oop!r})")
        check_diffraction_cell(cell)
        return _axis(cell, oop) / (n * abs(base[nonzero[0]]))
    return d_hkl(cell, tuple(n * x for x in base))


def allowed_reflections(cell: dict, orientation: str, wavelength_A: float,
                        two_theta_range: Tuple[float, float]) -> List[dict]:
    """Every symmetric reflection n·(hkl) of the cut that falls in the 2θ range.
    [{hkl, order, basis, d_A, two_theta_deg, label, role}]; role is 'allowed' or
    'opportunistic' (systematically forbidden, may appear through multiple
    diffraction; must never be the only reference)."""
    check_diffraction_cell(cell)
    base = parse_orientation(orientation)
    lo, hi = sorted(two_theta_range)
    out = []
    for n in range(1, 41):
        d = _cut_spacing(cell, base, n)
        tt = two_theta(d, wavelength_A)
        if tt is None:
            break
        if tt < lo:
            continue
        if tt > hi:
            break
        hkl = tuple(n * x for x in base)
        role = reflection_class(cell.get("space_group"), hkl)
        if role == "absent":
            continue
        out.append({
            "hkl": list(hkl), "order": n,
            "basis": (cell or {}).get("system") or "orthorhombic",
            "d_A": d, "two_theta_deg": tt,
            "label": "(" + "".join(str(x) for x in hkl) + ")",
            "role": role,
        })
    return out


# ══════════════════════════════════════════════════════════════════════════════
# Peak search and the offset model
# ══════════════════════════════════════════════════════════════════════════════
# The search window is narrow on purpose: on these samples the film peak can sit
# 0.3° from the substrate. A reflection is never "found" by falling back to the
# largest peak in the scan. Every candidate passes the same gate; opportunistic
# (forbidden) reflections pass a stricter one and can never be the sole reference.

import numpy as np   # noqa: E402  (kept below the geometry so the pure-math part has no numpy dependency)

EXTRACTOR_VERSION = "1.0"
SEARCH_HALF_WIDTH_DEG = 0.5      # search window = expected ± this
EDGE_FLAG_DEG = 0.1              # centre closer than this to the window edge → ok_flagged
MAX_FWHM_DEG = 0.5               # wider than this is not a substrate reflection
MIN_SNR = 5.0                    # amplitude above local background, in local-background σ
WEAK_SNR = 20.0                  # below this an accepted allowed peak is flagged as weak
MIN_R2 = 0.90                    # goodness of fit in the fit region
RESIDUAL_FLAG_DEG = 0.01         # 3+ references: weighted RMS residual above this is suspicious
SIGMA_FLOOR_DEG = 5e-4           # no single reference gets more than this much certainty
SYSTEMATIC_DEG = 0.003           # per-reference systematic uncertainty (cell, peak shape, mounting), added in quadrature
D_SIGNIFICANCE = 3.0             # keep the displacement term only when |D| exceeds this many σ_D
D_MAX_DEG = 0.1                  # |D| above this (~0.25 mm height error at R = 300 mm) is not a physical displacement


def _pv(x, amp, x0, fwhm, eta, b0, b1):
    """Pseudo-Voigt (area-free amplitude form) on a linear background."""
    hw = fwhm / 2.0
    lor = 1.0 / (1.0 + ((x - x0) / hw) ** 2)
    gau = np.exp(-np.log(2.0) * ((x - x0) / hw) ** 2)
    return amp * (eta * lor + (1.0 - eta) * gau) + b0 + b1 * (x - x0)


def _local_background(x, y, lo, hi, band=0.5):
    """Median and robust σ of the intensity just outside the search window."""
    side = ((x >= lo - band) & (x < lo)) | ((x > hi) & (x <= hi + band))
    v = y[side]
    if v.size < 5:
        return None, None
    med = float(np.median(v))
    sig = float(1.4826 * np.median(np.abs(v - med)))
    sig = max(sig, math.sqrt(max(med, 1.0)))           # counting statistics as a floor
    return med, sig


def find_substrate_peak(two_theta_deg, intensity, expected_deg: float,
                        half_width_deg: float = SEARCH_HALF_WIDTH_DEG, role: str = "allowed") -> dict:
    """Fit one reflection near its expected position. Never mutates the inputs.
    Returns {accepted, reason, center, sigma, amplitude, fwhm, eta, snr, r2, edge_distance, flags}."""
    from scipy.optimize import curve_fit

    x = np.asarray(two_theta_deg, dtype=float)
    y = np.asarray(intensity, dtype=float)
    lo, hi = expected_deg - half_width_deg, expected_deg + half_width_deg
    out = {"expected": expected_deg, "window": [lo, hi], "role": role, "accepted": False, "reason": None,
           "center": None, "sigma": None, "amplitude": None, "fwhm": None, "eta": None,
           "snr": None, "r2": None, "edge_distance": None, "flags": []}
    if x.size < 10 or x.min() > lo or x.max() < hi:
        out["reason"] = "scan does not cover the search window"
        return out
    inwin = (x >= lo) & (x <= hi) & np.isfinite(y)
    if inwin.sum() < 8:
        out["reason"] = "too few points in the search window"
        return out
    step = float(np.median(np.diff(np.sort(x[inwin]))))
    bg, bg_sig = _local_background(x, y, lo, hi)
    xw, yw = x[inwin], y[inwin]
    if bg is None:
        bg = float(np.percentile(yw, 10))
        bg_sig = math.sqrt(max(bg, 1.0))
    i0 = int(np.argmax(yw))
    amp0 = float(yw[i0] - bg)
    if amp0 <= MIN_SNR * bg_sig:
        out["reason"] = f"no peak above {MIN_SNR:g}σ of the local background"
        out["snr"] = amp0 / bg_sig if bg_sig else None
        return out
    # FWHM guess from the half-maximum crossings around the maximum
    half = bg + amp0 / 2.0
    left = i0
    while left > 0 and yw[left] > half:
        left -= 1
    right = i0
    while right < yw.size - 1 and yw[right] > half:
        right += 1
    fwhm0 = max(float(xw[right] - xw[left]), 2.0 * step)
    # Fit in a sub-window around the maximum (±4 FWHM, kept inside the search window)
    fit_lo = max(lo, float(xw[i0]) - 4.0 * fwhm0)
    fit_hi = min(hi, float(xw[i0]) + 4.0 * fwhm0)
    sel = (xw >= fit_lo) & (xw <= fit_hi)
    xf, yf = xw[sel], yw[sel]
    if xf.size < 6:
        out["reason"] = "peak too narrow to fit at this step size"
        return out
    p0 = [amp0, float(xw[i0]), fwhm0, 0.5, bg, 0.0]
    bounds = ([0.0, fit_lo, step * 0.5, 0.0, -np.inf, -np.inf], [np.inf, fit_hi, MAX_FWHM_DEG * 3, 1.0, np.inf, np.inf])
    weights = 1.0 / np.sqrt(np.maximum(yf, 1.0))        # Poisson-like
    try:
        popt, pcov = curve_fit(_pv, xf, yf, p0=p0, bounds=bounds, sigma=1.0 / weights, absolute_sigma=False, maxfev=20000)
    except Exception as e:                              # noqa: BLE001 — a failed fit is a result, not a crash
        out["reason"] = f"fit did not converge ({type(e).__name__})"
        return out
    amp, x0, fwhm, eta = (float(v) for v in popt[:4])
    perr = np.sqrt(np.clip(np.diag(pcov), 0, None)) if np.all(np.isfinite(pcov)) else np.full(6, np.nan)
    resid = yf - _pv(xf, *popt)
    ss_tot = float(np.sum((yf - yf.mean()) ** 2))
    r2 = 1.0 - float(np.sum(resid ** 2)) / ss_tot if ss_tot > 0 else 0.0
    edge = min(x0 - lo, hi - x0)
    out.update(center=x0, sigma=float(perr[1]) if np.isfinite(perr[1]) else None, amplitude=amp, fwhm=fwhm, eta=eta,
               snr=amp / bg_sig, r2=r2, edge_distance=edge)
    # The gate. Opportunistic reflections must pass every condition; allowed ones may be flagged instead.
    problems = []
    if amp < MIN_SNR * bg_sig:
        problems.append(f"fitted amplitude below {MIN_SNR:g}σ of the local background")
    if not (0.5 * step < fwhm < MAX_FWHM_DEG):
        problems.append(f"implausible width {fwhm:.4f}° (step {step:.4f}°, max {MAX_FWHM_DEG}°)")
    if edge <= 2 * step:
        problems.append("centre pinned to the window edge")
    if r2 < MIN_R2:
        problems.append(f"poor fit (R² {r2:.2f})")
    if role == "opportunistic":
        if problems:
            out["reason"] = "; ".join(problems)
            return out
    else:
        hard = [p for p in problems if p.startswith(("fitted amplitude", "implausible width", "centre pinned"))]
        if hard:
            out["reason"] = "; ".join(hard)
            return out
        out["flags"] += [p for p in problems if p not in hard]
    if edge < EDGE_FLAG_DEG:
        out["flags"].append(f"centre within {EDGE_FLAG_DEG}° of the window edge")
    if out["snr"] < WEAK_SNR:
        out["flags"].append(f"weak peak (S/N {out['snr']:.0f})")
    out["accepted"] = True
    return out


def _fit_model(refs: List[dict]) -> dict:
    """Weighted least squares of Δ2θ(θ) = Z + D·cos θ over the accepted references.

    Each reference carries its fit σ plus a systematic floor (SYSTEMATIC_DEG) in quadrature,
    because the fit σ alone (~1e-4°) ignores the cell, peak-shape and mounting errors. D is
    kept only when it is significant (|D| > D_SIGNIFICANCE·σ_D): two references close in
    cos θ (e.g. STO (001)+(002)) otherwise turn a 0.01° disagreement into Z and D of ±1°.
    When D is not significant the model is a weighted zero offset with its residual reported."""
    d = np.array([r["delta"] for r in refs])
    s = np.array([math.hypot(max(r["sigma"] or SIGMA_FLOOR_DEG, SIGMA_FLOOR_DEG), SYSTEMATIC_DEG) for r in refs])
    c = np.array([math.cos(math.radians(r["expected"] / 2.0)) for r in refs])
    w = 1.0 / s ** 2
    if len(refs) == 1:
        return {"Z": float(d[0]), "D": 0.0, "sigma_Z": float(s[0]), "sigma_D": None, "residual_rms": None,
                "model": "zero_offset_assumed", "d_tested": None}
    A = np.stack([np.ones_like(c), c], axis=1)
    Aw = A * np.sqrt(w)[:, None]
    dw = d * np.sqrt(w)
    coef, *_ = np.linalg.lstsq(Aw, dw, rcond=None)
    cov = np.linalg.pinv(Aw.T @ Aw)
    resid = d - A @ coef
    rms = float(np.sqrt(np.sum(w * resid ** 2) / np.sum(w))) if len(refs) > 2 else None
    if len(refs) > 2:
        dof = len(refs) - 2
        chi2 = float(np.sum(w * resid ** 2)) / dof
        cov = cov * max(chi2, 1.0)                        # do not claim more certainty than the scatter allows
    sigma_D = float(math.sqrt(max(cov[1, 1], 0)))
    if D_SIGNIFICANCE * sigma_D < abs(float(coef[1])) <= D_MAX_DEG:
        return {"Z": float(coef[0]), "D": float(coef[1]), "sigma_Z": float(math.sqrt(max(cov[0, 0], 0))),
                "sigma_D": sigma_D, "residual_rms": rms, "model": "zero_plus_displacement",
                "d_tested": {"D": float(coef[1]), "sigma_D": sigma_D}}
    # D not resolved by these references: weighted zero offset, residual reported
    Z = float(np.sum(w * d) / np.sum(w))
    res0 = d - Z
    rms0 = float(np.sqrt(np.sum(w * res0 ** 2) / np.sum(w)))
    sigma_Z = float(math.sqrt(1.0 / np.sum(w)))
    if len(refs) > 1:
        chi2 = float(np.sum(w * res0 ** 2)) / (len(refs) - 1)
        sigma_Z *= math.sqrt(max(chi2, 1.0))
    return {"Z": Z, "D": 0.0, "sigma_Z": sigma_Z, "sigma_D": None, "residual_rms": rms0, "model": "zero_offset",
            "d_tested": {"D": float(coef[1]), "sigma_D": sigma_D}}


def offset_at(alignment_conditions: dict, two_theta_deg):
    """Δ2θ to subtract at each angle: Z + D·cos(θ). Works on scalars and arrays."""
    Z = float(alignment_conditions.get("Z") or 0.0)
    D = float(alignment_conditions.get("D") or 0.0)
    tt = np.asarray(two_theta_deg, dtype=float)
    return Z + D * np.cos(np.radians(tt / 2.0))


def apply_alignment(two_theta_deg, alignment: Optional[dict]):
    """Corrected 2θ for the WHOLE array (never a view of it). Returns a new array;
    the input is untouched. No alignment, or a status with no value → unchanged copy."""
    tt = np.array(two_theta_deg, dtype=float, copy=True)
    if not alignment or alignment.get("value") is None:
        return tt
    return tt - offset_at(alignment.get("conditions") or {}, tt)


def alignment_offset(two_theta_deg, intensity, references: List[dict], wavelength_A: float,
                     reference_material: str, tracked: Optional[List[dict]] = None,
                     half_width_deg: float = SEARCH_HALF_WIDTH_DEG) -> dict:
    """Search every reference, gate, fit the offset model, return a Quantity envelope
    (docs/xrd-substrate-alignment.md, Step 2). `value` is Z, the zero offset in 2θ;
    D (displacement term) and every searched reflection are in `conditions`."""
    def env(status, value=None, sigma=None, note=None, conditions=None):
        return {"value": value, "sigma": sigma, "unit": "deg", "status": status, "censored": None,
                "conditions": conditions, "note": note}

    if not references:
        return env("not_applicable", note=f"{reference_material} has no reference reflection in the scan range",
                   conditions={"reference_material": reference_material, "references": [], "wavelength_A": wavelength_A})
    searched = []
    for r in references:
        fit = find_substrate_peak(two_theta_deg, intensity, r["two_theta_deg"], half_width_deg, r["role"])
        searched.append({**{k: r[k] for k in ("hkl", "label", "role", "d_A")},
                         "expected": r["two_theta_deg"], "measured": fit["center"], "sigma": fit["sigma"],
                         "delta": (fit["center"] - r["two_theta_deg"]) if fit["center"] is not None else None,
                         "accepted": fit["accepted"], "reason": fit["reason"], "flags": fit["flags"],
                         "snr": fit["snr"], "fwhm": fit["fwhm"], "r2": fit["r2"]})
    accepted = [s for s in searched if s["accepted"]]
    conditions = {"reference_material": reference_material, "references": searched, "wavelength_A": wavelength_A,
                  "window_half_width_deg": half_width_deg, "method": "pseudo-voigt", "extractor_version": EXTRACTOR_VERSION}
    if not accepted:
        return env("failed_measurement", note="no reference reflection found in its search window", conditions=conditions)
    if all(s["role"] == "opportunistic" for s in accepted):
        return env("failed_measurement", conditions=conditions,
                   note="only a symmetry-forbidden reflection was found; it is never used as the sole reference")
    # Z and D come from allowed reflections only. Accepted opportunistic (symmetry-forbidden)
    # peaks are cross-checks: they are reported with their deviation from the model but never
    # move the correction. Decided 15 Oct 2026: on 75 Si:STO scans Si (002)−(004) is a constant
    # −0.0135°, a shift of the forbidden peak itself, which fitted as a spurious displacement.
    used = [s for s in accepted if s["role"] == "allowed"]
    cross = [s for s in accepted if s["role"] != "allowed"]
    model = _fit_model(used)
    notes, flagged = [], False
    dt = model.get("d_tested")
    if dt and model["model"] == "zero_offset" and abs(dt["D"]) > D_MAX_DEG and abs(dt["D"]) > D_SIGNIFICANCE * dt["sigma_D"]:
        flagged = True
        notes.append(f"references disagree beyond any physical displacement (would need D = {dt['D']:+.2f}°); "
                     "zero offset used: check the reference cell or a mis-assigned peak")
    if model["residual_rms"] is not None and model["residual_rms"] > RESIDUAL_FLAG_DEG:
        flagged = True
        notes.append(f"references disagree (weighted RMS residual {model['residual_rms']:.4f}°): "
                     "a mis-assigned peak or a bad fit, not a real displacement")
    for s in cross:
        s["cross_check"] = True
        s["residual"] = s["delta"] - float(offset_at({"Z": model["Z"], "D": model["D"]}, s["expected"]))
        s["reason"] = f"cross-check only (symmetry-forbidden); {s['residual']:+.4f}° from the model"
    if model["model"] == "zero_offset_assumed":
        flagged = True
        notes.append("one reference: zero offset only, sample-height displacement assumed zero")
    for s in used:
        if s["flags"]:
            flagged = True
            notes.append(f"{s['label']}: {', '.join(s['flags'])}")
    if cross:
        notes.append("cross-check " + ", ".join(f"{s['label']} {s['residual']:+.4f}°" for s in cross))
    conditions.update(correction_model=model["model"], Z=model["Z"], D=model["D"], sigma_D=model["sigma_D"],
                      residual_rms=model["residual_rms"], n_used=len(used), displacement_test=model["d_tested"],
                      used=[s["label"] for s in used], cross_checks=[s["label"] for s in cross])
    if tracked:
        conditions["tracked"] = []
        for t in tracked:
            fit = find_substrate_peak(two_theta_deg, intensity, t["two_theta_deg"], half_width_deg, "opportunistic")
            corrected = None
            if fit["center"] is not None and fit["accepted"]:
                corrected = fit["center"] - float(offset_at(conditions, fit["center"]))
            conditions["tracked"].append({"component": t.get("component"), "label": t["label"],
                                          "expected": t["two_theta_deg"], "measured": fit["center"] if fit["accepted"] else None,
                                          "corrected": corrected, "found": fit["accepted"], "reason": fit["reason"],
                                          "note": "identified only; never used for the offset"})
    return env("ok_flagged" if flagged else "ok", value=model["Z"], sigma=model["sigma_Z"],
               note="; ".join(notes) or None, conditions=conditions)


def references_for_sample(library_by_name: Dict[str, dict], substrate: str, orientation: Optional[str],
                          wavelength_A: float, two_theta_range: Tuple[float, float]) -> dict:
    """Resolve what to align a sample to. Returns {status, note, reference_material,
    orientation, references, tracked}. status is 'ok' or 'not_applicable'.
    Orientation: the sample's own, else the material's default_orientation, else not_applicable."""
    entry = library_by_name.get(substrate or "")
    if not entry:
        return {"status": "not_applicable", "note": f"substrate '{substrate}' is not in the materials library",
                "references": [], "tracked": []}
    cell = entry.get("crystal") or {}
    if cell.get("pseudocubic"):
        return {"status": "not_applicable", "references": [], "tracked": [],
                "note": f"'{substrate}' is a pseudocubic entry, which is never used for diffraction; point the sample at the (o) entry"}
    orient = orientation or cell.get("default_orientation")
    if not orient:
        return {"status": "not_applicable", "references": [], "tracked": [],
                "note": f"no orientation for '{substrate}' (sample or material default); it is never guessed"}
    ref_name = cell.get("reference_component") or substrate
    ref_entry = library_by_name.get(ref_name)
    if not ref_entry:
        return {"status": "not_applicable", "references": [], "tracked": [],
                "note": f"reference component '{ref_name}' is not in the materials library"}
    try:
        refs = allowed_reflections(ref_entry.get("crystal") or {}, orient, wavelength_A, two_theta_range)
        tracked = []
        for tc in cell.get("tracked_components") or []:
            tcell = {**cell, "out_of_plane_axis": tc.get("axis") or cell.get("out_of_plane_axis")}
            for r in allowed_reflections(tcell, orient, wavelength_A, two_theta_range):
                tracked.append({**r, "component": tc.get("component")})
    except ValueError as e:
        return {"status": "not_applicable", "note": str(e), "references": [], "tracked": []}
    return {"status": "ok", "note": None, "reference_material": ref_name if ref_name == substrate else f"{substrate} → {ref_name}",
            "orientation": orient, "references": refs, "tracked": tracked}
