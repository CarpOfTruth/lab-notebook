# Plan: align XRD scans to the substrate reflection

Implementation brief. Written 15 Oct 2026. Read `docs/architecture.md` and
`claude/rigaku-rasx-format.md` (project doc) first.

## Problem

A theta-2theta scan carries an instrument zero offset. The fix is to locate a
known substrate reflection, compare it to its theoretical position, and shift
the scan by the difference. Nothing in LabLog currently supports this:

- `materials_library.crystal` stores a, b, c but **no orientation**, so nothing
  knows which reflection is out-of-plane.
- For `Si:STO (001)` the entry has `a = 3.953` **and** `c = 3.900`, and the
  out-of-plane reflection uses **c**. Code that reaches for `a` is wrong by
  0.66 deg, which is larger than the film shifts being measured.
- Scandates have both `(o)` orthorhombic and `(pc)` pseudocubic entries. The
  pseudocubic parameter is a **volume average** and is *not* the out-of-plane
  spacing. Using it puts GSO 0.07 deg and DSO 0.06 deg off.
- `xrd_peaks` is empty on every sample; there is nowhere to record an offset.
- Three samples have substrate strings that match no library entry.

## Settled decisions

All agreed 15 Oct 2026. These are fixed; do not revisit them without asking.

1. **The `(o)` orthorhombic entry is canonical** for diffraction. Every sample's
   `substrate` points at it. The `(pc)` pseudocubic entries stay in the library
   but are **strain-arithmetic conveniences only** and must never be used to
   compute a reflection position.
2. **Wavelength is Cu Kalpha1, always.** No Kalpha-weighted average, no Kalpha2.
   Still *read the value from the file* via `rasx.py`'s `wavelength` property
   rather than hardcoding; it falls back to 1.540593 A when a file omits it.
   "Always Kalpha1" fixes which line is used, not the numeric constant.
3. **Alignment is triggered by an option in the notebook panel**, not
   automatically on upload. See "Trigger model" below.
4. **Si:STO aligns to Si (004)**, never the STO layer. See the section below.
5. **Orientation is separate from material.** The material entry holds the
   *cell*; the sample holds the *cut*. See "Material versus orientation".

### Trigger model

Separate *computing* the offset from *applying* it.

- The offset is computed once, on first enable, and stored in
  `xrd_peaks.alignment`. It is not recomputed on every render.
- The panel option controls whether the stored offset is **applied**. Toggling
  it off does not discard the offset.
- Recompute only when the reference, the wavelength or the underlying scan
  changes. Stale-cache rules follow `step0-result-envelope.md`.
- Because two panels can disagree, any view or export must state whether the
  offset was applied. A plot that is silently unaligned next to one that is
  aligned is the failure this design invites.

## Settled: Si:STO aligns to Si (004)

Decided 15 Oct 2026. The alignment reference for every `Si:STO (001)` sample is
the **silicon (004) reflection at 69.13 deg**, not the STO layer.

The STO template is 4 nm, so its peak is weak and broad, and more importantly
**its position is a result, not a reference**: the template's own strain state
is one of the things under study. Anchoring to it would fold that variation into
every film measurement. Silicon is thick, sharp, and fixed.

The STO (002) at 46.54 deg should still be *identified* in the scan, since it is
a quantity worth tracking, but it must never be used to compute the offset.

## Material versus orientation

Today orientation is recorded three inconsistent ways and nowhere usefully:

| where | state |
|---|---|
| vault note **filename** | `STO (001).md`, `Si-STO (001).md` carry it only here |
| vault `orientation:` field | present on GdScO3 and DyScO3 only |
| sample notes | nothing; `substrate: "[[GdScO3 (110)]]"` implies it by link |
| LabLog | absent entirely |

**A cell is a material fact. A cut is a sample fact.** The physical thing that
got cut is the wafer, not the compound. Keeping them joined means a second cut
of the same material needs a duplicate library entry carrying a duplicate cell,
which is exactly the duplication that produced the `(o)` / `(pc)` confusion this
document exists to clean up.

So:

- **`materials_library.crystal`** holds the cell, plus `default_orientation`
  (the cut normally bought).
- **`samples`** carries `substrate_orientation`, set at import from the material
  default and overridable per sample.
- Resolution order: sample field, then material default, then **raise**. Never
  guess an orientation. A missing cut is `not_applicable`, not `(001)`.

### The reference reflection is derived, not stored

This replaces the fixed `reference_reflections` list sketched in Step 1. Given a
cell and a cut, the allowed reflections follow from the space group:

    allowed_reflections(cell, orientation, two_theta_range, wavelength) -> list

Implement the extinction rule for `Fd-3m` (allowed only when h, k, l are all
even and h+k+l divides by 4, which is why silicon needs (004) and not (002)) and
"all orders allowed" for the simple perovskites and `Pbnm`, driven by a
`space_group` key on the cell. `Si` already has `"space_group": "Fd-3m"`; the
others need one.

Deriving rather than storing means a new cut needs no new library entry, no
duplicated cell and no edit to any reference table.

### Use every allowed reflection in range, weighted by what is measured

Do **not** pick a single reference a priori, and do not use "lowest allowed
order": `(110)` is allowed in `Pbnm` and sits at 22.46 deg on GdScO3, but it is
a weak pseudocubic `(001)`-type reflection. The strong one is `(220)`. A rule
that picks the lowest allowed order would choose the weak peak and return a
confident, wrong answer.

Ranking by predicted intensity would need structure factors. Avoid that. Instead:

1. Predict **all** allowed reflections of the cut plane's family that fall in
   the scan range.
2. Attempt a peak fit at each predicted position, in a tight window.
3. Weight each result by its fitted amplitude and fit uncertainty.
4. Least-squares the offset model across whatever was found.

Weak reflections then contribute little automatically, and nothing needs to know
in advance which peak is strongest.

| substrate | cut | in-range symmetric reflections (15-75 deg) |
|---|---|---|
| GdScO3 (o) | (110) | (110) 22.38, **(220) 45.68**, (330) 71.21 (literature cell; see "Implementation decisions") |
| DyScO3 (o) | (110) | (110) 22.53, **(220) 46.00**, (330) 71.77 |
| STO | (001) | (001) 22.75, **(002) 46.47**, (003) 72.57 |
| Si:STO -> Si | (001) | **(004) 69.13**; (002) 32.96 forbidden but sometimes present, see below |

Bold is the strong one, and the one to fall back on if only a single peak is
wanted.

### Opportunistic references: look, but refuse to land on noise

Si (002) at **32.96 deg** is forbidden in `Fd-3m`, yet it is sometimes present
and sometimes not. The usual cause is **multiple diffraction**: with the right
azimuthal alignment, a pair of allowed reflections routes intensity into the
forbidden one. It therefore depends on how the piece happened to be rotated on
the stage, which is why it varies between mountings and cannot be predicted.

This is worth exploiting, because it is the difference between a one-reference
and a two-reference fit on the only substrate that cannot otherwise fit `D`:

| Si:STO case | cos(theta) sampled | span | model |
|---|---|---|---|
| (004) alone | 0.823 | 0 | `Z` only, `D` assumed |
| (002) + (004) | 0.959, 0.823 | **0.135** | fits `Z` and `D` |

For comparison a scandate's three reflections span 0.169, so a Si:STO scan with
(002) visible has nearly as good a lever arm as the best case elsewhere.

So mark such reflections `role: "opportunistic"` and search for them, but gate
acceptance hard. **A spurious fit here is worse than a missing one**: with two
references the model fits exactly and leaves no residual to catch the error, so
a noise peak would silently produce a confident, wrong `D`.

Accept an opportunistic reference only when all hold:

- amplitude at least 5 sigma above the **local** background, estimated beside the
  window rather than globally;
- fitted width physically plausible, wider than the step size and narrower than
  a stated maximum;
- fitted centre strictly inside the window, not pinned to an edge;
- goodness of fit above threshold.

Otherwise drop it silently. **An absent opportunistic reference is not a
failure**: it does not set `ok_flagged`, it simply does not contribute. Record
which reflections were searched and which were accepted, so that two scans of
the same sample giving different models are explainable rather than mysterious.

Two further rules:

- An opportunistic reflection must **never be the sole reference**. If the only
  accepted peak is opportunistic, treat the alignment as
  `failed_measurement`. Alignment to a reflection that should not exist, with
  nothing to corroborate it, is not alignment.
- When three or more references are accepted and the fit residual is poor,
  suspect an opportunistic peak first: drop it, refit, and compare. The
  residual is the only self-check available, so use it.

Generalise this rather than special-casing silicon. Any weak or
symmetry-forbidden reflection gets the same treatment: searched, gated,
optional, never load-bearing alone.

### Fitting the offset model

With two or more references at different angles, fit both terms instead of
choosing a model:

    delta_2theta(theta) = Z + D * cos(theta)

`Z` is the instrument zero offset, constant in 2theta. `D` carries the sample
height displacement, which varies as `cos(theta)`. This supersedes the
`correction_model` choice described above: the model is **fitted, not selected**,
whenever the data supports it.

- **3 references** (scandates, STO): fit `Z` and `D`, one degree of freedom left
  over as a residual check. Report the residual; a large one means a mis-assigned
  peak or a bad fit, not a real displacement.
- **2 references**: fit `Z` and `D` exactly, no residual. Usable, unvalidated.
- **1 reference** (Si:STO when Si (002) is absent): `Z` only, `D` assumed zero.
  Set `ok_flagged` and record `model: "zero_offset_assumed"` so the assumption
  is visible downstream. When Si (002) *is* present and passes the gate below,
  this becomes a two-reference fit and `D` is measured.

### The asymmetry worth knowing about

Si:STO is the substrate that **most** needs a displacement correction, because
its only reference sits at 69.13 deg while the film peaks of interest are near
45 deg, and it is the **only** substrate that cannot fit one. The scandates,
whose (220) sits within half a degree of the film peaks and which barely need
the correction at all, are the ones that can measure it.

There is no transferring `D` between samples: it is a property of how a given
piece sat on the stage, not of the material. So for Si:STO the fallback is a
`Z`-only correction with the residual risk recorded, roughly 12 percent of the
offset magnitude, per the angular-dependence section above.

That fallback is only needed when Si (002) is absent. When it shows, the
asymmetry disappears for that scan.

### Backfill

Every current material has exactly one cut in use, so the backfill is
mechanical: `GdScO3 (o)` and `DyScO3 (o)` get `default_orientation: "(110)"`,
`STO` and `Si:STO (001)` get `"(001)"`. Add `orientation: "(001)"` to the two
vault notes that lack it, `STO (001).md` and `Si-STO (001).md`, so the field is
uniform across substrates rather than implied by a filename.

Then teach the vault importer to carry `orientation` onto the sample as
`substrate_orientation`, alongside the existing substrate resolution.

## Step 0: data fixes, before any code

**19 samples point at a substrate name that matches no library entry**, so they
cannot resolve a reference at all. Three groups:

| samples | current | should be |
|---|---|---|
| PLD001-004, PLD006, PLD007, PLD008_GSO, PLD009_GSO, PLD010_GSO, PLD011_GSO | `GdScO3` | `GdScO3 (o)` |
| SP074_DSO | `DyScO3 (220)` | `DyScO3 (o)` |
| SP074_GSO | `GdScO3 (220)` | `GdScO3 (o)` |
| SP074_STO | `SrTiOe (001)` | `STO` (typo: "SrTiOe") |
| SP076_DSO, SP077_DSO, SP078_DSO | `DyScO3 (pc)` | `DyScO3 (o)` |
| SP076_GSO, SP077_GSO, SP078_GSO | `GdScO3 (pc)` | `GdScO3 (o)` |

The `(pc)` rows are the ones the vault importer created, and they are only
"wrong" because of decision 1. The bare `GdScO3` and `(220)` rows predate the
importer and were typed by hand.

After changing `samples.substrate`, **rebuild `sample_filter_index`** for every
touched row: `_index_sample()` in `main.py` writes a `substrate` text row that
otherwise keeps the stale value.

### The vault notes must be repointed too, or this recurs

`Materials/GdScO3 (110).md` and `Materials/DyScO3 (110).md` in the Obsidian
vault carry `lablog_id: gdsco3_pc` and `dysco3_pc`. The importer resolves a
sample's substrate through that field, so **every future import would recreate
the problem**. Change both to `gdsco3_o` and `dysco3_o`.

Those notes already hold `a_ortho`, `b_ortho`, `c_ortho` alongside the
pseudocubic `a`, `b`, `c`, so nothing is lost; they simply point at the entry
that matches their orthorhombic numbers.

### Gaps in the `(o)` entries

`GdScO3 (o)` has an empty `formula` and blank `alpha`, `beta`, `gamma`. Fill
them: `GdScO3`, 90/90/90. `DyScO3 (o)` is complete.

## Step 1: `backend/xrdref.py`, a pure DB-free module

Follow the `vault_import.py` pattern: no database, no I/O, no FastAPI imports,
fully unit-testable. This is the part that must be right.

```python
def d_hkl(cell: dict, hkl: tuple) -> float
    """Interplanar spacing. Orthorhombic is enough for every material here:
       1/d^2 = h^2/a^2 + k^2/b^2 + l^2/c^2
       Raise on a cell with missing or non-numeric axes rather than defaulting."""

def two_theta(d: float, wavelength_A: float) -> float
    """2*asin(lambda / (2d)), degrees. Return None if lambda/(2d) > 1."""

def allowed_reflections(cell: dict, orientation: str,
                        wavelength_A: float, two_theta_range: tuple) -> list[dict]
    """Every allowed out-of-plane reflection of the cut plane's family that
       falls in range. [{hkl, basis, d_A, two_theta_deg, label, role}] where
       role is 'allowed' or 'opportunistic'. Orientation comes from the sample,
       not the material: see "Material versus orientation"."""
```

Cell data is read from `materials_library.crystal`, which is a free-form JSON
blob, so **no schema migration is needed**. Add these keys:

```json
{
  "a": 5.45, "b": 5.75, "c": 7.93,
  "system": "orthorhombic",
  "orientation": "(110)",
  "space_group": "Pbnm",
  "default_orientation": "(110)"
}
```

For `Si:STO (001)`, the entry already has a `substrate_stack` of STO on Si. A
reference must be able to name a stack component:

```json
"default_orientation": "(001)",
"reference_component": "Si",
"tracked_components": [
  {"component": "STO", "axis": "c",
   "note": "identify but never align to: its position is a result"}
]
```

Note the `axis` key: that entry's `a` and `c` differ and the out-of-plane one is
`c`. Make `d_hkl` take the axis assignment from the cell rather than assuming
(00l) maps to `c` by convention, or add an explicit `out_of_plane_axis`.

### Known-answer tests, Cu Kalpha1 = 1.5405980 A

Put these in `backend/tests/test_xrdref.py`. They are the acceptance criteria.

| material | cell used | reflection | d (A) | 2theta |
|---|---|---|---|---|
| GdScO3 (o) | a=5.4862, b=5.7499 | (220) ortho = pc (002) | 1.9846 | **45.68** (was 45.84 with the rounded cell; see below) |
| DyScO3 (o) | a=5.4424, b=5.7192 | (220) ortho = pc (002) | 1.9713 | **46.00** |
| STO | a=3.905 | (002) | 1.9525 | **46.47** |
| Si | a=5.431 | (004) | 1.3578 | **69.13** |
| Si:STO, STO layer | **c=3.900** | (002) | 1.9500 | **46.54** (tracked, not a reference) |

Add negative tests:

- Si:STO using `a = 3.953` gives 45.88, which is **wrong**. Assert the function
  does not return this.
- GSO using the pseudocubic `a = 3.9612` gives 45.77, which is **wrong** by
  0.07 deg. Assert the pseudocubic entry is either rejected for diffraction or
  flagged.
- A cell with a missing axis raises rather than silently defaulting.

## Step 2: the alignment calculation

```python
def find_substrate_peak(two_theta, intensity, expected_deg, window_deg) -> dict
def alignment_offset(...) -> dict   # the envelope below
```

Return a result envelope in the shape `step0-result-envelope.md` specifies, in
`/Users/admin/Projects/Personal Research`:

```json
{"value": 0.042, "sigma": 0.004, "unit": "deg", "status": "ok",
 "censored": null,
 "conditions": {"reference": {"material": "GdScO3 (o)", "hkl": [2,2,0],
                              "d_A": 1.9777, "expected_2theta": 45.84},
                "measured_2theta": 45.882, "window_deg": 1.0,
                "wavelength_A": 1.540593, "method": "pseudo-voigt"},
 "note": null}
```

Status rules, using the module-assignable vocabulary:

- `ok` — peak found, well inside the window, good fit.
- `ok_flagged` — found but weak, asymmetric, or within ~0.1 deg of the window
  edge. Still usable, needs a human glance.
- `failed_measurement` — no peak in the window. **Do not fall back to the
  largest peak in the scan**; on these samples the film peak sits 0.3 deg from
  the substrate and would be picked up instead.
- `not_applicable` — material has no reference reflection defined.

Hard rule: **never mutate stored intensity or angle arrays.** The offset is
metadata; apply it at plot time. That keeps it reversible and lets the
reference be changed later without re-uploading.

### The offset is not necessarily constant in 2theta

This matters because the Si:STO reference is at 69.13 deg while the film peaks
of interest sit near 45 deg. Two error sources behave differently over that gap:

- **Instrument zero offset** is constant in 2theta. A shift measured at 69 deg
  applies unchanged at 45 deg.
- **Sample height displacement** is not: `d(2theta) = -2 s cos(theta) / R`, for
  displacement `s` and goniometer radius `R`. Between Si (004) and a film peak
  at 45.8 deg, `cos(theta)` runs 0.824 to 0.921, so the correction at the film
  peak is about **12 percent larger** than the one measured at silicon.

At a 0.04 deg offset that is a 0.005 deg error, which is negligible. At 0.2 deg
it becomes 0.024 deg, which is not, given the film shifts being resolved are
around 0.2 deg.

So: record the fitted model and its inputs in `conditions`, as
`correction_model` (`"zero_offset"`, `"zero_offset_assumed"` or
`"zero_plus_displacement"`), together with the reflections used. Per "Fitting the
offset model" above, the model is **fitted from the available references, not
chosen by the user**; the single-reference case is the only one where a model is
assumed, and it is labelled as such.

**`ok_flagged` is informational and never gates the correction.** A large offset
is still applied in full. The flag says "look at this", not "skip this". The
only status that results in no correction is `failed_measurement`, where no peak
was found and therefore no offset exists, and `not_applicable`, where the
material has no reference reflection. An uncorrected scan is worse than a
corrected one carrying a warning.

Substrates whose reference reflection is near the film peaks, the scandates and
bulk STO, are not exposed to this. It is specific to aligning Si:STO on silicon.

### Scope: the correction applies to every stored point

The offset is applied to the **complete parsed array**, never to whatever the
viewer happens to be showing. This holds everywhere the data is used: the plot
card, an analysis book, an export, an ad hoc notebook.

Three separate ideas that must not be confused:

| | scope |
|---|---|
| peak **search** window | deliberately narrow, around the expected position |
| offset **application** | the entire stored range, always |
| viewer zoom / visible range | display only, scopes nothing |

The search window is correct and necessary, since the film peak sits as close as
0.3 deg to the substrate on these samples. It must not leak into the application
step.

**Implementation ordering rule:** shift the full array *before* any windowing,
decimation or downsampling for display. A render path that slices to the visible
range and then applies the offset will silently produce a plot where part of the
data is corrected and part is not, and the seam moves as the user zooms. Write a
test that corrects a scan, slices it two different ways, and asserts both slices
carry identical angles for the same points.

Since the offset is stored as metadata rather than written into the arrays, this
is cheap to get right and easy to get wrong: the correction happens once, at the
point where the stored array is handed to anything else.

## Step 3: storage

`samples.xrd_peaks` is free-form JSON already carrying fit UI state
(`lines`, `fitWindow`, `fittedCurve`, `peakCurves`, `bgCurve`, `nBgTerms`).
Add a sibling key so alignment is not entangled with fit state:

```json
"alignment": { ...the envelope above..., "computed_at": "2026-10-15T.." }
```

Migration: none. Samples without the key are simply unaligned.

## Step 4: wiring

- `rasx.py` already exposes `wavelength` (Kalpha1) and `summary()` includes
  `wavelength_A`. Read it from the file; do not hardcode. Per decision 2 there
  is no weighted-average path to build.
- There is **no XRD module** in `backend/modules/` yet (only afm, pe, pund,
  xrr, xrr_fit). Decide whether this becomes `modules/xrd.py` with a schema
  JSON, or a service used by the existing XRD card. The module pattern puts
  runtime work in the schema's `proc_code`, which is awkward for something this
  numeric; a plain service module is probably the better fit.
- Surface in the UI: expected vs measured position, the offset, the status, and
  which reference was used. A silent offset is worse than none.

## Order of work

All five decisions are settled; nothing is waiting on a judgement call.

1. **Step 0 data fixes**: 19 substrate strings, the two vault note `lablog_id`
   values, the `GdScO3 (o)` gaps. Rebuild `sample_filter_index` for every row
   touched.
2. **`xrdref.py` + `test_xrdref.py`**, passing the known-answer table exactly,
   including the negative cases. Pure, DB-free, no FastAPI imports.
3. **Populate `crystal`** for GSO, DSO, STO, Si:STO and Si: `space_group`,
   `default_orientation`, and `out_of_plane_axis` where `a` and `c` differ.
4. **Add `substrate_orientation`** to samples and teach the vault importer to
   carry it across from the material note.
5. **Peak search and acceptance gate**, including the opportunistic path.
   Test against synthetic peaks with a known injected offset, and against pure
   noise in the window, which must be rejected rather than fitted.
6. **Offset fitting** for the one, two and three reference cases, with the
   residual check.
7. **Storage** in `xrd_peaks.alignment`, then the notebook panel option.

Steps 2 and 3 are where the physics goes silently wrong, so do not start 5 until
the table passes exactly. Step 5's noise-rejection test is the one protecting
against a confident wrong answer on Si (002).

## Out of scope

RSM alignment, which needs both in-plane and out-of-plane references, and the
pseudocubic strain conversion. Both build on `xrdref.py` once it exists.

## Implementation decisions, 15 Oct 2026

Built in `backend/xrdref.py` (pure), endpoints in `main.py`, the option in the notebook
XRD panel. Real-data dry runs over all 103 stored scans drove these changes to the plan
above; each was agreed before it was applied.

1. **GdScO3 (o) cell corrected.** The rounded cell a=5.45, b=5.75, c=7.93 put (110) and
   (220) 0.065–0.092 deg apart on every one of the 14 GSO scans: a d-spacing error, not an
   instrument one. The literature cell a=5.4862, b=5.7499, c=7.9345 A (Velickov et al.
   2007) brings them within -0.003 to +0.024 deg. The library entry now uses it and its
   notes record the old values; the known-answer test is 45.68 deg. Not yet done: the
   `GdScO3 (pc)` entry and the vault note `GdScO3 (110).md` still carry numbers derived
   from the old cell.
2. **Two references close in cos(theta) do not determine D.** STO (001)+(002) and GSO
   (110)+(220) span only 0.06 in cos(theta), so an exact two-reference fit turned a 0.01
   deg disagreement into Z and D of +/-0.1 to 1.5 deg. Each reference now carries a
   0.003 deg systematic floor in quadrature; D is kept only if |D| > 3 sigma_D **and**
   |D| <= 0.1 deg (about 0.25 mm of height at R = 300 mm). Otherwise the model is a
   weighted `zero_offset` with its residual reported, and a D beyond the cap is flagged as
   "references disagree beyond any physical displacement".
3. **Opportunistic reflections are cross-checks, never a source of Z or D.** On 75 Si:STO
   scans Si (002) - (004) is -0.0135 +/- 0.0033 deg, the same on every mounting. A height
   error would scatter with the mounting, so this is a shift of the forbidden peak itself.
   Z and D now come from allowed reflections only; an accepted opportunistic peak is
   reported with its deviation from the model. Si:STO is therefore always
   `zero_offset_assumed` (`ok_flagged`), as intended for a single reference.
4. **Fd-3m has two kinds of forbidden reflection.** Mixed parity (Si (001), (003)) is
   killed by the face-centred lattice and cannot appear by multiple diffraction: not
   searched. All-even with h+k+l = 4n+2 (Si (002)) is killed by the diamond glide and can:
   `opportunistic`.
5. **Width gate.** With the Ge(220)x2 monochromator substrate peaks are ~0.017 deg wide,
   narrower than a 0.02-0.025 deg step; "wider than the step" rejected 50,000-sigma Si
   (004) peaks. The floor is half a step, which still rejects single-point spikes.
6. **Storage safety.** Whole-sample saves (and the XRD analysis view saving its fit state)
   never drop `xrd_peaks.alignment`; only the alignment endpoints change it. The old list
   form of `xrd_peaks` is wrapped as `{"lines": [...]}` when an alignment is added.
7. **Staleness.** The stored alignment records its inputs (file, sha256, frame, substrate,
   cut, wavelength and its source, reference cells, extractor version). Any change marks
   it stale; the panel recomputes stale or missing alignments when the option is on.
8. **The panel's old "zero to substrate peak" option is replaced.** It shifted the largest
   peak in the cropped view onto a substrate position, which this design forbids on both
   counts. Books that had it on now read as "align". The sample card's "zeroed" button
   still uses the old largest-peak shift and is out of scope here.
9. **No in-figure statement; details collapsed** (owner's call, 15 Oct 2026). The plot no
   longer carries an "aligned / as measured" annotation, so an exported figure does not
   say whether the offset was applied: the panel option and the per-sample table are the
   record. The table sits behind "substrate alignment details", closed by default.
10. **Text exports carry no wavelength**: Cu Kalpha1 is assumed and recorded as assumed in
   `conditions.wavelength_source`; `.rasx` files supply their own.

Data fixes applied with this work: 24 substrate strings repointed (the 19 in Step 0 plus
SP030, SP009_STO and SP009_STO_a1-a3, `STO (001)` -> `STO`), `substrate_orientation`
added and backfilled from each material's `default_orientation` for all 109 samples, and
the four vault notes edited as in Step 0. SP030's XRD slot holds SP029's scan, so it
reports `failed_measurement`.

