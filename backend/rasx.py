"""
rasx.py : read Rigaku SmartLab .rasx files (no CSV export needed).

A .rasx is a plain zip archive:

    root.xml                          index of Data blocks + a signature
    Data0/Profile0.txt                tab-separated: position, intensity, attenuator coefficient
    Data0/MesurementConditions0.xml   (sic) full instrument state for that block
    Data1/...                         one block per frame for multi-frame data (RSMs)

Conventions (checked point by point against SmartLab Studio II CSV exports):
* Axis "Position" values are already alignment-corrected. Do not add "Offset".
* Intensity = column 2 * column 3 (attenuator coefficient), in counts.
* Q is reported as Q/(2*pi) in 1/nm, the way Rigaku exports it:
      Qx = (cos(2th - om) - cos(om)) / lambda
      Qz = (sin(om) + sin(2th - om)) / lambda
  with lambda = Cu Ka1 taken from the XML.
"""

import re
import zipfile
import xml.etree.ElementTree as ET
from typing import Dict, List, Optional, Tuple, Union

import numpy as np

__all__ = ["read_rasx", "RasxScan", "classify", "XRR_MAX_2THETA"]

# A symmetric 2θ/θ scan whose stop angle is at or below this is treated as
# reflectivity. Reflectivity on our films dies out well before 8–10°; a
# diffraction scan starting near 10–20° always ends far above this.
XRR_MAX_2THETA = 12.0


# --------------------------------------------------------------------------- helpers
def _num(s):
    """Convert XML text to float when possible, otherwise return it unchanged."""
    if s is None:
        return None
    try:
        return float(s)
    except (TypeError, ValueError):
        return s


def _parse_conditions(xml_bytes: bytes) -> dict:
    root = ET.fromstring(xml_bytes)
    meta: dict = {}

    gi = root.find("GeneralInformation")
    meta["general"] = {e.tag: e.text for e in gi} if gi is not None else {}

    hw = root.find("HWConfigurations")
    meta["hardware"] = {}
    if hw is not None:
        cats = hw.find("Categories")
        if cats is not None:
            meta["hardware"]["units"] = {c.get("Name"): c.get("SelectedUnit") for c in cats}
        for block in ("XrayGenerator", "Detector", "Optics"):
            b = hw.find(block)
            if b is not None:
                meta["hardware"][block] = {e.tag: _num(e.text) for e in b}

    # Axes: some names (IS, LLS, RS2) appear several times with different units.
    # `axes` keeps the first numeric entry; `axes_all` keeps every entry.
    axes: Dict[str, dict] = {}
    axes_all: Dict[str, List[dict]] = {}
    ax_block = root.find("Axes")
    if ax_block is not None:
        for a in ax_block:
            rec = {
                "position": _num(a.get("Position")),
                "offset": _num(a.get("Offset")),
                "unit": a.get("Unit"),
                "state": a.get("State"),
            }
            name = a.get("Name")
            axes_all.setdefault(name, []).append(rec)
            if name not in axes or (
                not isinstance(axes[name]["position"], float) and isinstance(rec["position"], float)
            ):
                axes[name] = rec
    meta["axes"], meta["axes_all"] = axes, axes_all

    si = root.find("ScanInformation")
    meta["scan"] = {e.tag: _num(e.text) for e in si} if si is not None else {}

    ras = {}
    rh = root.find("RASHeader")
    if rh is not None:
        for pair in rh:
            s = pair.findall("string")
            if len(s) == 2:
                ras[s[0].text] = s[1].text
    meta["ras_header"] = ras
    return meta


def _parse_profile(txt: bytes) -> np.ndarray:
    text = txt.decode("utf-8-sig")
    arr = np.loadtxt(text.splitlines(), dtype=float, ndmin=2)
    if arr.shape[1] == 2:  # no attenuator column
        arr = np.column_stack([arr, np.ones(len(arr))])
    return arr


# --------------------------------------------------------------------------- data classes
class Frame:
    """One Data block: a single profile plus the instrument state it was taken in."""

    def __init__(self, index: int, x: np.ndarray, raw: np.ndarray, attenuation: np.ndarray, meta: dict):
        self.index = index
        self.x = x                    # scan-axis positions (deg)
        self.raw = raw                # column 2 as stored (counts)
        self.attenuation = attenuation  # column 3
        self.meta = meta

    @property
    def intensity(self) -> np.ndarray:
        return self.raw * self.attenuation

    def axis(self, name: str):
        return self.meta["axes"][name]["position"]


class RasxScan:
    def __init__(self, name: str, frames: List[Frame]):
        self.name = name
        self.frames = frames

    # ---- metadata shortcuts -------------------------------------------------
    @property
    def meta(self) -> dict:
        return self.frames[0].meta

    @property
    def scan(self) -> dict:
        return self.meta["scan"]

    @property
    def data_type(self) -> str:
        g = self.meta["general"]
        return g.get("DataType") or g.get("PackageName") or ""

    @property
    def is_map(self) -> bool:
        return len(self.frames) > 1

    @property
    def wavelength(self) -> float:
        """Wavelength in Angstrom, chosen from WaveType (Ka1, Ka, Kb)."""
        g = self.meta["hardware"].get("XrayGenerator", {})
        wt = str(g.get("WaveType", "Ka1")).lower()
        ka1 = g.get("WavelengthKalpha1", 1.540593)
        ka2 = g.get("WavelengthKalpha2", 1.544414)
        kb = g.get("WavelengthKbeta", 1.392246)
        if wt == "ka1":
            return ka1
        if wt in ("ka", "kalpha"):
            return (2 * ka1 + ka2) / 3
        if wt.startswith("kb"):
            return kb
        return ka1

    @property
    def time_per_point(self) -> Optional[float]:
        """Counting time per point (s). CONTINUOUS: step/speed; STEP: speed is in s."""
        s = self.scan
        try:
            if str(s.get("Mode")).upper() == "CONTINUOUS":
                return s["Step"] / s["Speed"] * 60.0  # deg / (deg/min) -> s
            return float(s["Speed"])
        except (KeyError, TypeError, ZeroDivisionError):
            return None

    def axis(self, name: str, frame: int = 0):
        return self.frames[frame].axis(name)

    # ---- 1D access ----------------------------------------------------------
    @property
    def x(self) -> np.ndarray:
        # For maps this is the inner-axis positions (identical in every frame).
        return self.frames[0].x

    @property
    def intensity(self) -> np.ndarray:
        """1D: (n,) array. Map: (n_frames, n_points) array."""
        if self.is_map:
            return np.vstack([f.intensity for f in self.frames])
        return self.frames[0].intensity

    @property
    def cps(self) -> np.ndarray:
        t = self.time_per_point
        return self.intensity / t if t else self.intensity

    # ---- reciprocal-space maps ---------------------------------------------
    def angles(self) -> Tuple[np.ndarray, np.ndarray]:
        """(omega, two_theta) arrays shaped like `intensity`, in degrees."""
        if not self.is_map:
            raise ValueError("angles() is for multi-frame maps")
        inner = self.scan["AxisName"]
        n, m = len(self.frames), len(self.x)
        om_f = np.array([f.axis("Omega") for f in self.frames], dtype=float)
        tt_f = np.array([f.axis("TwoTheta") for f in self.frames], dtype=float)
        X = np.broadcast_to(self.x, (n, m))
        if inner == "TwoTheta":            # 1D detector (3D-Explore) or 2theta scans at fixed omega
            return np.broadcast_to(om_f[:, None], (n, m)).copy(), X.copy()
        if inner in ("Omega", "OmegaTwoTheta"):  # rocking curves stepped in 2theta
            return X.copy(), np.broadcast_to(tt_f[:, None], (n, m)).copy()
        if inner in ("TwoThetaOmega", "TwoThetaTheta"):
            # 2theta/omega scans stepped in omega offset. Not yet checked against an export.
            rel = om_f - tt_f / 2
            return X / 2 + rel[:, None], X.copy()
        raise NotImplementedError("inner scan axis %r" % inner)

    def frame_omegas(self) -> np.ndarray:
        """ω of each frame (deg) for a 3D-Explore map (inner axis TwoTheta)."""
        return np.array([f.axis("Omega") for f in self.frames], dtype=float)

    @staticmethod
    def q_from_angles(om_deg, tt_deg, lam_nm):
        om, tt = np.deg2rad(om_deg), np.deg2rad(tt_deg)
        qx = (np.cos(tt - om) - np.cos(om)) / lam_nm
        qz = (np.sin(om) + np.sin(tt - om)) / lam_nm
        return qx, qz

    @property
    def qx(self) -> np.ndarray:
        return self.q_from_angles(*self.angles(), self.wavelength / 10)[0]

    @property
    def qz(self) -> np.ndarray:
        return self.q_from_angles(*self.angles(), self.wavelength / 10)[1]

    # ---- summary ------------------------------------------------------------
    def summary(self) -> dict:
        """JSON-serialisable metadata summary."""
        m, s = self.meta, self.scan
        g = m["hardware"].get("XrayGenerator", {})
        rh = m["ras_header"]

        def label(n):  # prefer the human-readable entry, e.g. "0.500mm" or "Open"
            recs = m["axes_all"].get(n, [])
            strs = [r["position"] for r in recs if isinstance(r["position"], str)]
            if strs:
                return strs[0]
            return m["axes"].get(n, {}).get("position")

        out = {
            "data_type":      self.data_type,
            "part":           m["general"].get("PartName"),
            "system":         m["general"].get("SystemName"),
            "sample_name":    m["general"].get("SampleName"),
            "operator":       m["general"].get("Operator"),
            "n_frames":       len(self.frames),
            "n_points":       int(len(self.x)),
            "scan_axis":      s.get("AxisName"),
            "scan_mode":      s.get("Mode"),
            "start":          s.get("Start"),
            "stop":           s.get("Stop"),
            "step":           s.get("Step"),
            "speed":          s.get("Speed"),
            "speed_unit":     s.get("SpeedUnit"),
            "time_per_point_s": self.time_per_point,
            "start_time":     s.get("StartTime"),
            "end_time":       self.frames[-1].meta["scan"].get("EndTime"),
            "wavelength_A":   self.wavelength,
            "wave_type":      g.get("WaveType"),
            "target":         g.get("TargetName"),
            "voltage_kV":     g.get("Voltage"),
            "current_mA":     g.get("Current"),
            "optics":         m["hardware"].get("Optics", {}).get("Attribute"),
            "detector":       m["hardware"].get("units", {}).get("Detector"),
            "count_mode":     rh.get("*MEAS_COND_COUNTER_COUNTMODE"),
            "slits": {k: label(k) for k in ("IS", "IL", "RS1", "RS2", "RS3", "LLS", "ULS") if k in m["axes_all"]},
            "sample_axes": {k: m["axes"].get(k, {}).get("position") for k in ("Chi", "Phi", "Z", "Omega", "TwoTheta") if k in m["axes"]},
            "attenuator_auto": s.get("AttenuatorAutoMode"),
        }
        if self.is_map:
            om = self.frame_omegas()
            out["omega_start"] = float(om.min())
            out["omega_stop"] = float(om.max())
        return out


# --------------------------------------------------------------------------- entry point
def read_rasx(source, name: Optional[str] = None) -> RasxScan:
    """Read a .rasx from a path or from raw bytes."""
    import io, os  # noqa: E401
    if isinstance(source, (bytes, bytearray)):
        fh = io.BytesIO(source)
        name = name or "upload.rasx"
    else:
        fh = source
        name = name or os.path.basename(str(source))
    with zipfile.ZipFile(fh) as z:
        names = z.namelist()
        idx = set()
        for n in names:
            m = re.match(r"Data(\d+)/", n)
            if m:
                idx.add(int(m.group(1)))
        if not idx:
            raise ValueError("No Data blocks found — not a SmartLab .rasx file")
        frames = []
        for i in sorted(idx):
            prof = next((n for n in names if re.fullmatch(r"Data%d/Profile\d*\.txt" % i, n)), None)
            cond = next((n for n in names if re.fullmatch(r"Data%d/Mes\w*Conditions\d*\.xml" % i, n)), None)
            if prof is None or cond is None:
                raise ValueError("Data%d block is missing its profile or conditions file" % i)
            arr = _parse_profile(z.read(prof))
            meta = _parse_conditions(z.read(cond))
            frames.append(Frame(i, arr[:, 0], arr[:, 1], arr[:, 2], meta))
    return RasxScan(name, frames)


# --------------------------------------------------------------------------- classification
SYMMETRIC_AXES = ("TwoThetaTheta", "TwoThetaOmega")


def classify(scan: RasxScan) -> Tuple[Optional[str], str]:
    """
    Decide which LabLog card a scan belongs on.
    Returns (kind, description) where kind is "rsm", "xrr", "xrd_ot" or None
    (unsupported). `description` is a short human-readable label either way.
    """
    axis = str(scan.scan.get("AxisName") or "")
    dtype = str(scan.data_type or "")
    if scan.is_map or "RSM" in dtype.upper():
        if scan.is_map and axis != "TwoTheta":
            # Multi-frame data we have not verified (e.g. 2θ/ω scans stepped in ω)
            return None, "a multi-frame %s scan (%d frames) — not supported yet" % (axis, len(scan.frames))
        return "rsm", "an RSM (%s, %d frames)" % ("3D-Explore" if "3DE" in dtype.upper() else dtype or "map", len(scan.frames))
    if axis in SYMMETRIC_AXES:
        start, stop = scan.scan.get("Start"), scan.scan.get("Stop")
        rng = "%g–%g°" % (start, stop) if isinstance(start, float) and isinstance(stop, float) else ""
        if isinstance(stop, float) and stop <= XRR_MAX_2THETA:
            return "xrr", "an XRR scan (2θ/θ %s)" % rng
        return "xrd_ot", "a 2θ/θ scan (%s)" % rng
    if axis in ("Omega", "Theta"):
        return None, "an ω rocking curve — not supported yet"
    return None, "a %s scan — not supported yet" % (axis or "unknown")


def to_payload(scan: RasxScan, kind: str) -> dict:
    """Plot-ready payload for the frontend. 1D: {x, y}. RSM: compact grid."""
    if kind == "rsm":
        om = scan.frame_omegas()
        return {
            "omega":        [float(v) for v in om],
            "two_theta":    [float(v) for v in scan.x],
            "intensity":    scan.intensity.tolist(),
            "wavelength_A": float(scan.wavelength),
        }
    return {"x": scan.x.tolist(), "y": scan.intensity.tolist()}


def inspect_bytes(data: bytes, filename: Optional[str] = None) -> dict:
    """Parse + classify + build payload. Raises ValueError for unreadable input."""
    try:
        scan = read_rasx(data, name=filename)
    except zipfile.BadZipFile:
        raise ValueError("Not a .rasx file (not a zip archive)")
    kind, desc = classify(scan)
    out = {"kind": kind, "description": desc, "meta": scan.summary()}
    if kind is None:
        out["reason"] = "This is %s." % desc
        out["payload"] = None
    else:
        out["payload"] = to_payload(scan, kind)
    return out
