"""Substrate reference reflections and alignment — pure, no database.

Run from the repository root:
    backend/.venv/bin/python3.11 -m unittest backend.tests.test_xrdref -v
or
    backend/.venv/bin/python3.11 -m unittest discover -s backend/tests -p 'test_xrdref.py' -v

Acceptance criteria: docs/xrd-substrate-alignment.md, "Known-answer tests".
"""
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import xrdref  # noqa: E402

LAM = 1.5405980          # Cu Kα1, as in the known-answer table
RANGE = (15.0, 75.0)

GSO_O = {"a": "5.4862", "b": "5.7499", "c": "7.9345", "system": "orthorhombic", "space_group": "Pbnm"}
GSO_O_ROUNDED = {"a": "5.45", "b": "5.75", "c": "7.93", "space_group": "Pbnm"}   # the old library cell
DSO_O = {"a": "5.4424", "b": "5.7192", "c": "7.9043", "system": "orthorhombic", "space_group": "Pbnm"}
STO = {"a": 3.905, "b": 3.905, "c": 3.905, "system": "cubic", "space_group": "Pm-3m"}
SI = {"a": 5.431, "b": 5.431, "c": 5.431, "system": "cubic", "space_group": "Fd-3m"}
SI_STO = {"a": "3.953", "b": "3.953", "c": "3.9", "out_of_plane_axis": "c", "space_group": "Pm-3m"}
GSO_PC = {"a": "3.9612", "b": "3.965", "c": "3.9612", "pseudocubic": True}


def refl(cell, cut, label):
    hits = [r for r in xrdref.allowed_reflections(cell, cut, LAM, RANGE) if r["label"] == label]
    assert len(hits) == 1, f"{label} not found once in {cut}"
    return hits[0]


class KnownAnswers(unittest.TestCase):
    """The table in the design doc, to the quoted precision."""

    def check(self, cell, cut, label, d, tt):
        r = refl(cell, cut, label)
        self.assertAlmostEqual(r["d_A"], d, delta=1.5e-4)
        self.assertAlmostEqual(r["two_theta_deg"], tt, delta=0.005)
        return r

    def test_gso_220(self):
        """Literature cell (Veličkov et al. 2007). The old rounded cell gave 45.84°, which put (110)
        and (220) 0.08° apart on every real GSO scan; decided 15 Oct 2026 to use this cell."""
        self.check(GSO_O, "(110)", "(220)", 1.9846, 45.68)

    def test_dso_220(self):
        self.check(DSO_O, "(110)", "(220)", 1.9713, 46.00)

    def test_sto_002(self):
        self.check(STO, "(001)", "(002)", 1.9525, 46.47)

    def test_si_004(self):
        r = self.check(SI, "(001)", "(004)", 1.3578, 69.13)
        self.assertEqual(r["role"], "allowed")

    def test_si_sto_template_uses_c(self):
        self.check(SI_STO, "(001)", "(002)", 1.9500, 46.54)

    def test_scandate_family_in_range(self):
        got = [(r["label"], round(r["two_theta_deg"], 2)) for r in xrdref.allowed_reflections(GSO_O, "(110)", LAM, RANGE)]
        self.assertEqual(got, [("(110)", 22.38), ("(220)", 45.68), ("(330)", 71.21)])
        got = [(r["label"], round(r["two_theta_deg"], 2)) for r in xrdref.allowed_reflections(DSO_O, "(110)", LAM, RANGE)]
        self.assertEqual(got, [("(110)", 22.53), ("(220)", 46.0), ("(330)", 71.77)])

    def test_sto_family_in_range(self):
        got = [(r["label"], round(r["two_theta_deg"], 2)) for r in xrdref.allowed_reflections(STO, "(001)", LAM, RANGE)]
        self.assertEqual(got, [("(001)", 22.75), ("(002)", 46.47), ("(003)", 72.57)])


class Extinctions(unittest.TestCase):
    def test_si_002_is_opportunistic_not_allowed(self):
        r = refl(SI, "(001)", "(002)")
        self.assertAlmostEqual(r["two_theta_deg"], 32.96, delta=0.005)
        self.assertEqual(r["role"], "opportunistic")

    def test_si_only_004_is_allowed_in_range(self):
        allowed = [r["label"] for r in xrdref.allowed_reflections(SI, "(001)", LAM, RANGE) if r["role"] == "allowed"]
        self.assertEqual(allowed, ["(004)"])

    def test_fd3m_rule(self):
        self.assertTrue(xrdref.is_allowed("Fd-3m", (1, 1, 1)))
        self.assertTrue(xrdref.is_allowed("Fd-3m", (2, 2, 0)))
        self.assertFalse(xrdref.is_allowed("Fd-3m", (2, 0, 0)))
        self.assertFalse(xrdref.is_allowed("Fd-3m", (0, 0, 6)))
        self.assertTrue(xrdref.is_allowed("Fd-3m", (0, 0, 8)))
        self.assertTrue(xrdref.is_allowed("Pbnm", (1, 1, 0)))
        self.assertEqual(xrdref.reflection_class("Fd-3m", (0, 0, 2)), "opportunistic")
        self.assertEqual(xrdref.reflection_class("Fd-3m", (0, 0, 1)), "absent")
        self.assertEqual(xrdref.reflection_class("Fd-3m", (0, 0, 3)), "absent")

    def test_si_lattice_absences_are_not_searched(self):
        labels = [r["label"] for r in xrdref.allowed_reflections(SI, "(001)", LAM, (10.0, 75.0))]
        self.assertEqual(labels, ["(002)", "(004)"])


class Negatives(unittest.TestCase):
    def test_si_sto_never_uses_a(self):
        """a = 3.953 would put the template (002) at 45.88°, 0.66° off. Must not happen."""
        tts = [r["two_theta_deg"] for r in xrdref.allowed_reflections(SI_STO, "(001)", LAM, RANGE)]
        self.assertFalse(any(abs(t - 45.88) < 0.02 for t in tts), tts)

    def test_pseudocubic_cell_is_refused(self):
        """The pseudocubic GSO a = 3.9612 gives 45.77°, 0.07° off: refuse it outright."""
        with self.assertRaises(ValueError):
            xrdref.allowed_reflections(GSO_PC, "(001)", LAM, RANGE)
        with self.assertRaises(ValueError):
            xrdref.d_hkl(GSO_PC, (0, 0, 2))

    def test_missing_axis_raises(self):
        with self.assertRaises(ValueError):
            xrdref.d_hkl({"a": 5.45, "b": "", "c": 7.93}, (2, 2, 0))
        with self.assertRaises(ValueError):
            xrdref.d_hkl({"a": 5.45, "c": 7.93}, (1, 1, 0))
        with self.assertRaises(ValueError):
            xrdref.d_hkl({"a": "n/a", "b": 5.75, "c": 7.93}, (2, 2, 0))

    def test_orientation_is_never_guessed(self):
        for bad in (None, "", "   ", "(000)", "abc"):
            with self.assertRaises(ValueError):
                xrdref.allowed_reflections(STO, bad, LAM, RANGE)

    def test_unreachable_reflection(self):
        self.assertIsNone(xrdref.two_theta(0.5, LAM))


if __name__ == "__main__":
    unittest.main()


# ── Peak search, gate and offset model (synthetic scans with a known offset) ──
import math  # noqa: E402
import numpy as np  # noqa: E402


def _pv(x, amp, x0, fwhm, eta=0.5):
    hw = fwhm / 2
    return amp * (eta / (1 + ((x - x0) / hw) ** 2) + (1 - eta) * np.exp(-math.log(2) * ((x - x0) / hw) ** 2))


def synth(peaks, Z=0.0, D=0.0, lo=15.0, hi=75.0, step=0.01, bg=20.0, seed=0):
    """Counts with Poisson noise. peaks = [(true_2theta, amplitude, fwhm)]; each peak is
    shifted by the instrument error Z + D·cos θ before being drawn."""
    rng = np.random.default_rng(seed)
    x = np.round(np.arange(lo, hi + step / 2, step), 6)
    y = np.full_like(x, bg)
    for t, a, w in peaks:
        y = y + _pv(x, a, t + Z + D * math.cos(math.radians(t / 2)), w)
    return x, rng.poisson(y).astype(float)


def gso_refs():
    return xrdref.allowed_reflections(GSO_O, "(110)", LAM, RANGE)


def si_refs():
    return xrdref.allowed_reflections(SI, "(001)", LAM, RANGE)


class PeakSearch(unittest.TestCase):
    def test_recovers_injected_offset_three_refs(self):
        refs = gso_refs()
        film = (45.68 - 0.30, 3000, 0.25)                     # film peak 0.3° below the substrate (220)
        x, y = synth([(r["two_theta_deg"], a, 0.03) for r, a in zip(refs, (2e3, 2e5, 4e4))] + [film], Z=0.042, D=-0.095)
        env = xrdref.alignment_offset(x, y, refs, LAM, "GdScO3 (o)")
        self.assertEqual(env["conditions"]["correction_model"], "zero_plus_displacement")
        self.assertAlmostEqual(env["value"], 0.042, delta=0.004)
        self.assertAlmostEqual(env["conditions"]["D"], -0.095, delta=0.01)
        # the correction puts every substrate reflection back on its theoretical position
        for r in refs:
            corr = r["two_theta_deg"] + 0.042 - 0.095 * math.cos(math.radians(r["two_theta_deg"] / 2))
            fixed = float(xrdref.apply_alignment([corr], env)[0])
            self.assertAlmostEqual(fixed, r["two_theta_deg"], delta=0.003)

    def test_close_pair_without_real_displacement_is_zero_offset(self):
        """STO (001)+(002) differ by only 0.06 in cos θ: a few-mdeg disagreement must not become
        Z and D of ±0.1°. D is tested, found insignificant, and a weighted zero offset is used."""
        refs = xrdref.allowed_reflections(STO, "(001)", LAM, (15.0, 50.0))
        x, y = synth([(r["two_theta_deg"], 1e5, 0.02) for r in refs], Z=0.05, hi=50)
        y2 = y.copy()
        env = xrdref.alignment_offset(x, y2, refs, LAM, "STO")
        self.assertEqual(env["conditions"]["correction_model"], "zero_offset")
        self.assertAlmostEqual(env["value"], 0.05, delta=0.003)
        self.assertEqual(env["conditions"]["D"], 0.0)

    def test_undersampled_sharp_peak_is_accepted(self):
        """Monochromated substrate peaks can be narrower than a coarse step; a 0.017°-wide peak
        on a 0.025° step is real and must not be rejected."""
        refs = [r for r in si_refs() if r["label"] == "(004)"]
        x, y = synth([(69.13, 5e5, 0.017)], Z=0.01, step=0.025)
        env = xrdref.alignment_offset(x, y, refs, LAM, "Si")
        self.assertEqual(env["status"], "ok_flagged")              # one reference: zero offset assumed
        self.assertAlmostEqual(env["value"], 0.01, delta=0.004)

    def test_film_peak_is_not_mistaken_for_substrate(self):
        refs = [r for r in gso_refs() if r["label"] == "(220)"]
        t = refs[0]["two_theta_deg"]
        x, y = synth([(t, 2e5, 0.03), (t - 0.30, 8e4, 0.2)], Z=0.05)
        env = xrdref.alignment_offset(x, y, refs, LAM, "GdScO3 (o)")
        self.assertAlmostEqual(env["value"], 0.05, delta=0.004)

    def test_single_reference_is_zero_offset_assumed_and_flagged(self):
        refs = si_refs()
        x, y = synth([(69.13, 5e5, 0.02)], Z=-0.12)            # no Si (002)
        env = xrdref.alignment_offset(x, y, refs, LAM, "Si")
        self.assertEqual(env["status"], "ok_flagged")
        self.assertEqual(env["conditions"]["correction_model"], "zero_offset_assumed")
        self.assertAlmostEqual(env["value"], -0.12, delta=0.003)
        si002 = [s for s in env["conditions"]["references"] if s["label"] == "(002)"][0]
        self.assertFalse(si002["accepted"])

    def test_opportunistic_si002_is_a_cross_check_never_the_source_of_d(self):
        """Decided 15 Oct 2026: a visible Si (002) is reported against the model but never sets Z or D."""
        refs = si_refs()
        x, y = synth([(69.13, 5e5, 0.02), (32.96, 3e3, 0.03)], Z=-0.10, D=0.06)
        env = xrdref.alignment_offset(x, y, refs, LAM, "Si")
        c = env["conditions"]
        self.assertEqual(c["correction_model"], "zero_offset_assumed")
        self.assertEqual(c["used"], ["(004)"])
        self.assertEqual(c["cross_checks"], ["(002)"])
        self.assertEqual(env["status"], "ok_flagged")
        # Z comes from (004) alone: −0.10 + 0.06·cos(34.57°)
        self.assertAlmostEqual(env["value"], -0.10 + 0.06 * math.cos(math.radians(69.13 / 2)), delta=0.003)
        si002 = [r for r in c["references"] if r["label"] == "(002)"][0]
        self.assertTrue(si002["cross_check"])
        self.assertIn("cross-check", env["note"])

    def test_displacement_beyond_the_physical_cap_is_refused_and_flagged(self):
        refs = gso_refs()
        x, y = synth([(r["two_theta_deg"], a, 0.03) for r, a in zip(refs, (2e3, 2e5, 4e4))], Z=0.04, D=-0.4)
        env = xrdref.alignment_offset(x, y, refs, LAM, "GdScO3 (o)")
        self.assertEqual(env["conditions"]["correction_model"], "zero_offset")
        self.assertEqual(env["status"], "ok_flagged")
        self.assertIn("beyond any physical displacement", env["note"])

    def test_inconsistent_opportunistic_never_moves_the_offset(self):
        refs = gso_refs() + [{"hkl": [9, 9, 9], "label": "(999)", "role": "opportunistic", "d_A": 0.0, "two_theta_deg": 30.0}]
        peaks = [(r["two_theta_deg"], a, 0.03) for r, a in zip(refs[:3], (2e3, 2e5, 4e4))]
        x, y = synth(peaks + [(30.0 + 0.20, 2e4, 0.03)], Z=0.04)   # a real-looking peak in the wrong place
        env = xrdref.alignment_offset(x, y, refs, LAM, "GdScO3 (o)")
        self.assertNotIn("(999)", env["conditions"]["used"])
        self.assertAlmostEqual(env["value"], 0.04, delta=0.004)
        self.assertIn("(999)", env["conditions"]["cross_checks"])

    def test_noise_in_window_is_rejected(self):
        """Pure noise where Si (002) would be must never be fitted: a spurious second
        reference would give an exact, unvalidated, wrong D."""
        refs = si_refs()
        for seed in range(25):
            x, y = synth([(69.13, 5e5, 0.02)], Z=0.08, seed=seed)
            env = xrdref.alignment_offset(x, y, refs, LAM, "Si")
            si002 = [s for s in env["conditions"]["references"] if s["label"] == "(002)"][0]
            self.assertFalse(si002["accepted"], f"seed {seed}: noise accepted as Si (002)")
            self.assertEqual(env["conditions"]["correction_model"], "zero_offset_assumed")

    def test_opportunistic_alone_is_failed_measurement(self):
        refs = si_refs()
        x, y = synth([(32.96, 3e3, 0.03)], Z=0.05, hi=60)      # scan stops before Si (004)
        env = xrdref.alignment_offset(x, y, refs, LAM, "Si")
        self.assertEqual(env["status"], "failed_measurement")
        self.assertIsNone(env["value"])

    def test_no_peak_is_failed_measurement_not_largest_peak(self):
        refs = [r for r in gso_refs() if r["label"] == "(220)"]
        x, y = synth([(44.5, 2e5, 0.05)])                       # a big peak, but outside the (220) window
        env = xrdref.alignment_offset(x, y, refs, LAM, "GdScO3 (o)")
        self.assertEqual(env["status"], "failed_measurement")
        self.assertIsNone(env["value"])

    def test_not_applicable_without_references(self):
        env = xrdref.alignment_offset([1, 2], [1, 2], [], LAM, "X")
        self.assertEqual(env["status"], "not_applicable")

    def test_inputs_are_never_mutated(self):
        refs = gso_refs()
        x, y = synth([(r["two_theta_deg"], 1e5, 0.03) for r in refs], Z=0.03)
        x0, y0 = x.copy(), y.copy()
        env = xrdref.alignment_offset(x, y, refs, LAM, "GdScO3 (o)")
        xrdref.apply_alignment(x, env)
        np.testing.assert_array_equal(x, x0)
        np.testing.assert_array_equal(y, y0)


class WholeArrayCorrection(unittest.TestCase):
    def test_slicing_does_not_change_corrected_angles(self):
        """Correct first, slice after: two different slices must agree point for point."""
        env = {"value": 0.04, "conditions": {"Z": 0.04, "D": -0.05}}
        x = np.arange(15.0, 75.0, 0.01)
        full = xrdref.apply_alignment(x, env)
        a, b = full[1000:3000], full[2000:4000]
        np.testing.assert_array_equal(a[1000:], b[:1000])
        # and correcting a slice directly gives the same numbers as slicing the corrected array
        np.testing.assert_allclose(xrdref.apply_alignment(x[2000:4000], env), b, rtol=0, atol=1e-12)

    def test_no_value_means_unchanged(self):
        x = np.arange(20.0, 21.0, 0.1)
        np.testing.assert_array_equal(xrdref.apply_alignment(x, {"value": None, "status": "failed_measurement"}), x)
        np.testing.assert_array_equal(xrdref.apply_alignment(x, None), x)


class SampleReferences(unittest.TestCase):
    LIB = {"GdScO3 (o)": {"crystal": {**GSO_O, "default_orientation": "(110)"}},
           "GdScO3 (pc)": {"crystal": GSO_PC},
           "Si": {"crystal": {**SI, "default_orientation": "(001)"}},
           "Si:STO (001)": {"crystal": {**SI_STO, "default_orientation": "(001)", "reference_component": "Si",
                                        "tracked_components": [{"component": "STO", "axis": "c"}]}}}

    def test_si_sto_aligns_to_silicon_and_tracks_sto(self):
        r = xrdref.references_for_sample(self.LIB, "Si:STO (001)", "(001)", LAM, RANGE)
        self.assertEqual(r["status"], "ok")
        self.assertEqual([(x["label"], x["role"]) for x in r["references"]], [("(002)", "opportunistic"), ("(004)", "allowed")])
        sto002 = [t for t in r["tracked"] if t["label"] == "(002)"][0]
        self.assertAlmostEqual(sto002["two_theta_deg"], 46.54, delta=0.005)
        self.assertFalse(any(abs(x["two_theta_deg"] - 46.54) < 0.05 for x in r["references"]))

    def test_material_default_orientation_is_used(self):
        r = xrdref.references_for_sample(self.LIB, "GdScO3 (o)", None, LAM, RANGE)
        self.assertEqual(r["orientation"], "(110)")

    def test_pseudocubic_and_unknown_are_not_applicable(self):
        self.assertEqual(xrdref.references_for_sample(self.LIB, "GdScO3 (pc)", "(001)", LAM, RANGE)["status"], "not_applicable")
        self.assertEqual(xrdref.references_for_sample(self.LIB, "Nope", "(001)", LAM, RANGE)["status"], "not_applicable")
        no_cut = {"X": {"crystal": {"a": 4, "b": 4, "c": 4}}}
        self.assertEqual(xrdref.references_for_sample(no_cut, "X", None, LAM, RANGE)["status"], "not_applicable")
