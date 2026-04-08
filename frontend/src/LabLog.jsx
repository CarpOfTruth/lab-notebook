import { useState, useCallback, useRef, useEffect, useMemo, lazy, Suspense } from "react";
import { LineChart, ComposedChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ReferenceLine, ResponsiveContainer, Customized } from "recharts";
const Plot = lazy(() => import("react-plotly.js").then(m => {
  // Vite pre-bundles CJS modules; react-plotly.js default export may be
  // wrapped in a { default: Component, __esModule: true } shell.
  const component = m.default?.default ?? m.default ?? m;
  return { default: component };
}));

// ── API client ────────────────────────────────────────────────────────────────

const API_BASE = "http://localhost:8000/api";

async function api(method, path, body) {
  const opts = { method, headers: {} };
  if (body !== undefined) {
    opts.headers["Content-Type"] = "application/json";
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(`${API_BASE}${path}`, opts);
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status}`);
  return res.json();
}

async function uploadFile(sampleId, measType, file) {
  const fd = new FormData();
  fd.append("file", file);
  const res = await fetch(`${API_BASE}/samples/${sampleId}/files/${measType}`, { method: "POST", body: fd });
  if (!res.ok) throw new Error(`upload failed ${res.status}`);
  return res.json(); // { ok, filename }
}

async function fetchFile(sampleId, filename) {
  const res = await fetch(`${API_BASE}/samples/${sampleId}/files/${filename}`);
  if (!res.ok) return null;
  return res.text();
}

// ── Theme ─────────────────────────────────────────────────────────────────────

const DARK_T = {
  bg0: "#0d1117", bg1: "#161b22", bg2: "#1c2333", bg3: "#243044",
  border: "#2d3748", borderBright: "#4a5568",
  amber: "#f6ad55", amberDim: "#c47f2a", amberGlow: "rgba(246,173,85,0.15)",
  teal: "#4fd1c5", red: "#fc8181", green: "#68d391", blue: "#63b3ed", violet: "#a78bfa",
  textPrimary: "#e2e8f0", textSecondary: "#a0aec0", textDim: "#718096",
  accent: "#e2e8f0",
};
const LIGHT_T = {
  bg0: "#f0f2f5", bg1: "#ffffff", bg2: "#f8f9fa", bg3: "#e4e8ef",
  border: "#d0d7de", borderBright: "#8c959f",
  amber: "#d97706", amberDim: "#b45309", amberGlow: "rgba(217,119,6,0.08)",
  teal: "#0d9488", red: "#dc2626", green: "#16a34a", blue: "#2563eb", violet: "#7c3aed",
  textPrimary: "#1a202c", textSecondary: "#4a5568", textDim: "#6b7280",
  accent: "#2d3748",
};
let T = DARK_T;

// ── Measurement type definitions ──────────────────────────────────────────────

const MEAS_TYPES = {
  xrd_ot: { label: "XRD ω–2θ",                    xLabel: "2θ (°)",         yLabel: "Intensity (cts)", logY: true,  color: T.amber },
  xrr:    { label: "XRR",                          xLabel: "2θ (°)",         yLabel: "Intensity (cts)", logY: true,  color: T.teal  },
  rsm:    { label: "RSM",                          xLabel: "Qₓ (nm⁻¹)",     yLabel: "Qz (nm⁻¹)",      isRSM: true, color: T.blue  },
  pe:     { label: "P–E Hysteresis",               xLabel: "E (kV/cm)",      yLabel: "P (µC/cm²)",      logY: false, color: T.red, ySymRange: 30, symXTicks: true, zeroRefY: true },
  diel_f: { label: "Rel. Permittivity vs f",       xLabel: "Hz",             yLabel: "εᵣ",              logX: true,  color: T.green, clampYZero: true },
  diel_b: { label: "Rel. Permittivity vs E",       xLabel: "E (kV/cm)",      yLabel: "εᵣ",              logY: false, color: T.green, clampYZero: true, twoSweep: true, symXTicks: true },
};

// ── Material colour palette (hash-based for any string) ───────────────────────

const MAT_PALETTE_DARK = [
  { bg: "#1a3a5c", border: "#3182ce" },
  { bg: "#1a3d2b", border: "#38a169" },
  { bg: "#3d2e0a", border: "#d69e2e" },
  { bg: "#3a1a3d", border: "#9f7aea" },
  { bg: "#3d1a1a", border: "#fc8181" },
  { bg: "#1a3a3a", border: "#4fd1c5" },
  { bg: "#1a2a3d", border: "#63b3ed" },
  { bg: "#2a3d1a", border: "#68d391" },
];
const MAT_PALETTE_LIGHT = [
  { bg: "#dbeafe", border: "#2563eb" },
  { bg: "#dcfce7", border: "#16a34a" },
  { bg: "#fef3c7", border: "#d97706" },
  { bg: "#f3e8ff", border: "#7c3aed" },
  { bg: "#fee2e2", border: "#dc2626" },
  { bg: "#ccfbf1", border: "#0d9488" },
  { bg: "#eff6ff", border: "#3b82f6" },
  { bg: "#f0fdf4", border: "#15803d" },
];
let MAT_PALETTE = MAT_PALETTE_DARK;

function getMaterialStyle(material) {
  if (!material) return { ...MAT_PALETTE[0], label: "?" };
  let h = 0;
  for (const c of material) h = (h * 31 + c.charCodeAt(0)) & 0xffffffff;
  return { ...MAT_PALETTE[Math.abs(h) % MAT_PALETTE.length], label: material };
}

// ── Continuous color scales for analysis books ────────────────────────────────

const COLOR_SCALES = {
  viridis:  ["#440154","#482777","#3e4989","#30678d","#25838e","#1e9d89","#35b779","#6dce59","#b5dd2b","#fde725"],
  cividis:  ["#00204d","#18306f","#31588b","#49739c","#628fa7","#7dadb2","#9acac0","#bae4cd","#dcf0d8","#fee838"],
  inferno:  ["#000004","#1b0c42","#4a0c4e","#781c6d","#a52c60","#cf4446","#ed6925","#fb9b07","#f7d03c","#fcffa4"],
  magma:    ["#000004","#180c3c","#40074e","#6b1b62","#982d80","#c24490","#e8688c","#f9a9a3","#fddac7","#fcfdbf"],
  plasma:   ["#0d0887","#45039e","#7201a8","#9c179e","#bd3786","#d8576b","#ed7953","#fb9f3a","#fdcf18","#f0f921"],
  coolwarm: ["#3b4cc0","#6e8ef0","#9ebcd8","#d1dae9","#e8d0c6","#f0a880","#e36a53","#b40426"],
};

function hexToRgb(hex) {
  const h = hex.replace("#", "");
  return [parseInt(h.slice(0,2),16), parseInt(h.slice(2,4),16), parseInt(h.slice(4,6),16)];
}
function rgbToHex(r, g, b) {
  return "#" + [r,g,b].map(v => Math.round(Math.max(0,Math.min(255,v))).toString(16).padStart(2,"0")).join("");
}
// trim = % to cut from each end of the scale, e.g. 5 → use t ∈ [0.05, 0.95]
function sampleColorScale(scaleName, n, trim = 5) {
  const anchors = COLOR_SCALES[scaleName] || COLOR_SCALES.viridis;
  const tLo = Math.max(0, Math.min(0.49, (trim || 0) / 100));
  const tHi = 1 - tLo;
  if (n <= 0) return [];
  return Array.from({ length: n }, (_, i) => {
    const t = n === 1 ? (tLo + tHi) / 2 : tLo + (i / (n - 1)) * (tHi - tLo);
    const scaled = t * (anchors.length - 1);
    const lo = Math.floor(scaled), hi = Math.min(lo + 1, anchors.length - 1);
    const f = scaled - lo;
    const [r0,g0,b0] = hexToRgb(anchors[lo]), [r1,g1,b1] = hexToRgb(anchors[hi]);
    return rgbToHex(r0+(r1-r0)*f, g0+(g1-g0)*f, b0+(b1-b0)*f);
  });
}

// ── CSV + data utilities (unchanged from original) ────────────────────────────

function parseCSV(text) {
  const lines = text.trim().split(/\r?\n/).filter(l => {
    const t = l.trim();
    return t && !t.startsWith("#") && !t.startsWith(";") && !t.startsWith("!");
  });
  const rows = [];
  for (const line of lines) {
    const cols = line.trim().split(/[,;\t]/).map(c => c.trim().replace(/^["']|["']$/g, ""));
    const cells = cols.length >= 2 ? cols : line.trim().split(/\s+/);
    const nums = cells.map(Number);
    if (nums.length >= 2 && isFinite(nums[0]) && isFinite(nums[1])) rows.push(nums);
  }
  return rows;
}

function findPECols(text) {
  for (const line of text.split(/\r?\n/)) {
    const raw = line.trim().split(/[,;\t]/).map(c => c.trim().replace(/^["']|["']$/g, "").toLowerCase());
    const hasVolt = raw.some(c => c.includes("voltage"));
    const hasPol  = raw.some(c => c.includes("polariz"));
    if (hasVolt && hasPol) {
      const vCol = raw.findIndex(c => c.includes("voltage") && !c.includes("ref"));
      const pCol = raw.findIndex(c => c.includes("polariz") && !c.includes("ref"));
      return { vCol: vCol >= 0 ? vCol : 0, pCol: pCol >= 0 ? pCol : 1 };
    }
  }
  return { vCol: 0, pCol: 1 };
}

const EPS0 = 8.854187817e-12;
const DEFAULT_AREA_M2 = Math.PI * 1e-10;

function evalMathExpr(str) {
  if (!str || !str.trim()) return null;
  const sanitized = str.trim().replace(/\^/g, "**");
  if (!/^[\d\s+\-*/().]+$/.test(sanitized)) return null;
  try {
    // eslint-disable-next-line no-new-func
    const result = new Function("return " + sanitized)();
    return typeof result === "number" && isFinite(result) && result > 0 ? result : null;
  } catch { return null; }
}

function findAreaFromFile(text) {
  for (const line of text.split(/\r?\n/)) {
    const lower = line.toLowerCase();
    if (!lower.includes("area")) continue;
    const allMatches = [...line.matchAll(/([\d]*\.[\d]+(?:[eE][+-]?\d+)?|[\d]+[eE][+-]?\d+)/g)];
    if (!allMatches.length) continue;
    const val = parseFloat(allMatches[allMatches.length - 1][1]);
    if (!isFinite(val) || val <= 0) continue;
    if (lower.includes("sq. cm") || lower.includes("sq.cm") || lower.includes("cm^2") || lower.includes("cm2") || lower.includes("cm²")) return val * 1e-4;
    if (lower.includes("um^2") || lower.includes("µm^2") || lower.includes("μm^2") || lower.includes("um2") || lower.includes("µm2")) return val * 1e-12;
    if ((lower.match(/\bm\^?2\b/) || lower.includes(" m²")) && !lower.includes("cm")) return val;
    if (val >= 1e-9 && val <= 0.1) return val * 1e-4;
  }
  return null;
}


function hasPlotData(d) {
  if (!d) return false;
  if (Array.isArray(d)) return d.length > 0;
  return !!(d.up?.length || d.down?.length); // diel_b shape
}

// Split a double-bipolar PE sweep into its two loops.
// Snaps the split point to the nearest return to data[0].x (the starting voltage),
// so biased sweeps that don't start at 0 V are handled correctly.
function splitPELoops(data) {
  if (!data || data.length < 4) return { first: data || [], second: data || [] };
  const n = data.length;
  const startX = data[0].x; // effective loop origin — the voltage the waveform starts from
  const mid = Math.floor(n / 2);
  const win = Math.floor(n * 0.15); // search ±15% of length around midpoint
  let bestIdx = mid, bestDist = Infinity;
  for (let i = Math.max(1, mid - win); i <= Math.min(n - 2, mid + win); i++) {
    const dist = Math.abs(data[i].x - startX);
    if (dist < bestDist) { bestDist = dist; bestIdx = i; }
  }
  return { first: data.slice(0, bestIdx), second: data.slice(bestIdx) };
}

function csvToPlotData(text, type, thicknessNm) {
  const rows = parseCSV(text);
  if (!rows.length) return null;
  if (type === "rsm") return rows.map(r => ({ x: r[0], y: r[1], z: r[2] ?? 1 }));
  if (type === "diel_f") return rows.map(r => ({ x: r[0], y: r[1], y2: r[2] ?? null }));
  // XRD / XRR: some instruments export ω (half-angle) instead of 2θ.
  // Detect by scanning header lines for "ω" without "2θ" or "2T", then double x.
  if (type === "xrd_ot" || type === "xrr") {
    const isOmegaCol = text.split(/\r?\n/).slice(0, 8).some(l =>
      /\u03c9/i.test(l) && !/2\s*[\u03b8tT\u00b0]/.test(l) && !/2theta/i.test(l)
    );
    return rows.map(r => ({ x: isOmegaCol ? r[0] * 2 : r[0], y: r[1] }));
  }
  if (type === "pe") {
    const { vCol, pCol } = findPECols(text);
    let xs = rows.map(r => r[vCol] ?? r[0]);
    let ys = rows.map(r => r[pCol] ?? r[1]);
    const maxAbsX = xs.reduce((m, v) => Math.max(m, Math.abs(v)), 0);
    if (maxAbsX < 50 && thicknessNm > 0) xs = xs.map(v => v / (thicknessNm * 1e-4));
    const maxAbsY = ys.reduce((m, v) => Math.max(m, Math.abs(v)), 0);
    if (maxAbsY > 0 && maxAbsY < 1e-3) ys = ys.map(p => p * 1e6);
    return xs.map((x, i) => ({ x, y: ys[i] }));
  }
  if (type === "diel_b_up" || type === "diel_b_down") {
    let xs = rows.map(r => r[0]);
    const ys  = rows.map(r => r[1]);
    const y2s = rows.map(r => r[2] ?? null);
    const maxAbsX = xs.reduce((m, v) => Math.max(m, Math.abs(v)), 0);
    if (maxAbsX < 50 && thicknessNm > 0) xs = xs.map(v => v / (thicknessNm * 1e-4));
    return xs.map((x, i) => ({ x, y: ys[i], y2: y2s[i] }));
  }
  return rows.map(r => ({ x: r[0], y: r[1] }));
}

// ── UI primitives ─────────────────────────────────────────────────────────────

const Btn = ({ children, onClick, variant = "primary", small, disabled }) => {
  const base = { border: "none", cursor: disabled ? "not-allowed" : "pointer", borderRadius: 6, fontFamily: "'DM Mono', monospace", fontSize: small ? 11 : 13, fontWeight: 500, padding: small ? "4px 10px" : "8px 18px", transition: "all .15s", opacity: disabled ? 0.4 : 1 };
  const styles = {
    primary: { ...base, background: T.amber,  color: "#0d1117" },
    ghost:   { ...base, background: "transparent", color: T.textSecondary, border: `1px solid ${T.border}` },
    danger:  { ...base, background: "transparent", color: T.red,  border: `1px solid ${T.red}`  },
    teal:    { ...base, background: "transparent", color: T.teal, border: `1px solid ${T.teal}` },
  };
  return <button style={styles[variant]} onClick={onClick} disabled={disabled}>{children}</button>;
};

const Label = ({ children }) => (
  <label style={{ fontSize: 11, color: T.textDim, fontFamily: "'DM Mono', monospace", textTransform: "uppercase", letterSpacing: 1 }}>{children}</label>
);

const Input = ({ label, value, onChange, placeholder, type = "text", small }) => (
  <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
    {label && <Label>{label}</Label>}
    <input type={type} value={value ?? ""} placeholder={placeholder} onChange={e => onChange(e.target.value)}
      style={{ background: T.bg0, border: `1px solid ${T.border}`, borderRadius: 5, color: T.textPrimary, padding: small ? "5px 8px" : "8px 10px", fontFamily: "'DM Mono', monospace", fontSize: small ? 12 : 13, outline: "none", width: "100%", boxSizing: "border-box" }} />
  </div>
);

// Toggle between showing all PE loops or only the 2nd (cleaner) loop
const LoopToggle = ({ value, onChange }) => (
  <div style={{ display: "flex", alignItems: "center", gap: 5 }}>
    <span style={{ fontSize: 10, color: T.textDim, fontFamily: "'DM Mono', monospace" }}>loop</span>
    <div style={{ display: "flex", border: `1px solid ${T.border}`, borderRadius: 10, overflow: "hidden" }}>
      {[["all", "all"], ["second", "2nd"]].map(([val, lbl]) => (
        <button key={val} onClick={() => onChange(val)}
          style={{ background: value === val ? T.amber : "transparent", color: value === val ? "#0d1117" : T.textDim,
            border: "none", cursor: "pointer", fontFamily: "'DM Mono', monospace", fontSize: 10,
            padding: "2px 9px", transition: "all .15s", lineHeight: 1.6 }}>
          {lbl}
        </button>
      ))}
    </div>
  </div>
);

// Recharts Customized component: draws inside tick marks on all 4 sides and closes
// the plot box with top + right lines. Pass xTicks/yTicks as explicit arrays.
// Recharts sets xAxis.scale range to absolute SVG coordinates, so no offset needed.
function PlotBox({ offset, boxStyle = "solid" }) {
  if (!offset || boxStyle === "off") return null;
  const { left: ox, top: oy, width: ow, height: oh } = offset;
  if (!ow || !oh) return null;
  const solid = boxStyle === "solid";
  return <rect x={ox} y={oy} width={ow} height={oh} fill="none"
    stroke={solid ? T.textPrimary : T.borderBright}
    strokeWidth={solid ? 1.5 : 1}
    strokeDasharray={boxStyle === "dashed" ? "4 3" : ""} />;
}

// Inward tick marks on all 4 sides, driven by axis scale functions from recharts Customized props
function PlotTicks({ offset, xAxisMap, yAxisMap, xTicks = [], yTicks = [], tickLen = 4 }) {
  if (!offset) return null;
  const { left: ox, top: oy, width: ow, height: oh } = offset;
  if (!ow || !oh) return null;
  const xScale = xAxisMap && Object.values(xAxisMap)[0]?.scale;
  const yScale = yAxisMap && Object.values(yAxisMap)[0]?.scale;
  const stroke = T.textPrimary;
  const lines = [];
  if (xScale) {
    xTicks.forEach((v, i) => {
      const x = xScale(v);
      if (isNaN(x) || x < ox - 1 || x > ox + ow + 1) return;
      lines.push(<line key={`xb${i}`} x1={x} y1={oy + oh} x2={x} y2={oy + oh - tickLen} stroke={stroke} strokeWidth={1} />);
      lines.push(<line key={`xt${i}`} x1={x} y1={oy}      x2={x} y2={oy      + tickLen} stroke={stroke} strokeWidth={1} />);
    });
  }
  if (yScale) {
    yTicks.forEach((v, i) => {
      const y = yScale(v);
      if (isNaN(y) || y < oy - 1 || y > oy + oh + 1) return;
      lines.push(<line key={`yl${i}`} x1={ox}      y1={y} x2={ox      + tickLen} y2={y} stroke={stroke} strokeWidth={1} />);
      lines.push(<line key={`yr${i}`} x1={ox + ow} y1={y} x2={ox + ow - tickLen} y2={y} stroke={stroke} strokeWidth={1} />);
    });
  }
  return <g>{lines}</g>;
}

const FONT_OPTIONS = [
  { value: "'DM Mono', monospace",              label: "DM Mono"       },
  { value: "Arial, sans-serif",                  label: "Arial"         },
  { value: "'Helvetica Neue', sans-serif",        label: "Helvetica"     },
  { value: "Inter, sans-serif",                  label: "Inter"         },
  { value: "Georgia, serif",                     label: "Georgia"       },
  { value: "'Times New Roman', serif",            label: "Times New Roman" },
  { value: "'Courier New', monospace",            label: "Courier New"   },
];

const Sel = ({ label, value, onChange, options }) => (
  <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
    {label && <Label>{label}</Label>}
    <select value={value} onChange={e => onChange(e.target.value)}
      style={{ background: T.bg0, border: `1px solid ${T.border}`, borderRadius: 5, color: T.textPrimary, padding: "8px 10px", fontFamily: "'DM Mono', monospace", fontSize: 13, outline: "none", cursor: "pointer" }}>
      {options.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
    </select>
  </div>
);

// Renders a chemical-formula string with digit sequences as subscripts.
// e.g. "BaTiO3" → BaTiO₃, "Ba0.5Sr0.5TiO3" → Ba₀.₅Sr₀.₅TiO₃ (via <sub>)
function ChemName({ name }) {
  if (!name) return null;
  const parts = name.split(/(\d+(?:\.\d+)?)/);
  return (
    <>
      {parts.map((part, i) =>
        /^\d/.test(part)
          ? <sub key={i} style={{ fontSize: "0.8em", lineHeight: 0 }}>{part}</sub>
          : part
      )}
    </>
  );
}

function MaterialCombobox({ value, onChange, knownMaterials, small }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState(value || "");
  useEffect(() => { setQuery(value || ""); }, [value]);
  const filtered = (knownMaterials || []).filter(m => m.toLowerCase().includes(query.toLowerCase()) && m !== query);
  const inputStyle = { background: T.bg0, border: `1px solid ${T.borderBright}`, borderRadius: 4, color: T.textPrimary, padding: small ? "4px 7px" : "7px 9px", fontFamily: "'DM Mono', monospace", fontSize: small ? 12 : 13, outline: "none", width: "100%", boxSizing: "border-box" };
  return (
    <div style={{ position: "relative" }}>
      <input value={query} placeholder="BTO, SRO, …"
        onChange={e => { setQuery(e.target.value); onChange(e.target.value); setOpen(true); }}
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        style={inputStyle} />
      {open && filtered.length > 0 && (
        <div style={{ position: "absolute", top: "100%", left: 0, right: 0, background: T.bg2, border: `1px solid ${T.borderBright}`, borderRadius: 5, zIndex: 400, maxHeight: 130, overflowY: "auto", boxShadow: "0 4px 12px rgba(0,0,0,.5)" }}>
          {filtered.map(m => {
            const s = getMaterialStyle(m);
            return (
              <div key={m} onMouseDown={() => { onChange(m); setQuery(m); setOpen(false); }}
                style={{ padding: "6px 10px", cursor: "pointer", fontFamily: "'DM Mono', monospace", fontSize: 12, color: s.border, borderLeft: `3px solid ${s.border}` }}>
                <ChemName name={m} />
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ── Plot utilities ────────────────────────────────────────────────────────────

function arrMin(arr) { let m =  Infinity; for (const v of arr) if (v < m) m = v; return m; }
function arrMax(arr) { let m = -Infinity; for (const v of arr) if (v > m) m = v; return m; }

function padDomain(vals, pct = 0.1) {
  const mn = arrMin(vals), mx = arrMax(vals);
  const pad = (mx - mn || Math.abs(mn) || 1) * pct;
  return [mn - pad, mx + pad];
}

// Returns { ticks, domain } with nice steps and ~5-7 ticks.
// When the range straddles zero, ticks are symmetric about 0 and 0 is always included.
function niceLinTicks(lo, hi, target = 6) {
  if (!isFinite(lo) || !isFinite(hi) || lo === hi) return { ticks: [lo], domain: [lo, hi] };
  const mn = Math.min(lo, hi), mx = Math.max(lo, hi);
  if (mn < 0 && mx > 0) {
    // Bipolar range — symmetric about 0, 0 always a tick
    const absMax = Math.max(Math.abs(mn), Math.abs(mx));
    const rawStep = absMax / Math.floor(target / 2);
    const mag = Math.pow(10, Math.floor(Math.log10(rawStep)));
    const norm = rawStep / mag;
    const niceNorm = norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 2.5 ? 2.5 : norm <= 5 ? 5 : 10;
    const step = niceNorm * mag;
    const symMax = Math.ceil(absMax / step) * step;
    const n = Math.round(symMax / step);
    const ticks = Array.from({ length: 2 * n + 1 }, (_, i) => Math.round((-symMax + i * step) * 1e10) / 1e10);
    return { ticks, domain: [-symMax, symMax] };
  }
  // Unipolar range — standard nice ticks
  const span = mx - mn || 1;
  const base = Math.pow(10, Math.floor(Math.log10(span / target)));
  const candidates = [1, 2, 2.5, 5, 10].map(f => f * base);
  let step = candidates[candidates.length - 1];
  for (const s of candidates) {
    const n = Math.floor(mx / s) - Math.ceil(mn / s) + 1;
    if (n >= 4 && n <= 8) { step = s; break; }
  }
  const t0 = Math.ceil(mn / step) * step, t1 = Math.floor(mx / step) * step;
  const ticks = [];
  for (let i = 0; t0 + i * step <= t1 + step * 1e-9; i++)
    ticks.push(Math.round((t0 + i * step) * 1e10) / 1e10);
  return { ticks, domain: [ticks[0], ticks[ticks.length - 1]] };
}

// Returns { ticks, fmt } with nice decimal labels for canvas-drawn axes (e.g. RSM).
function niceCanvasTicks(lo, hi, target = 5) {
  const span = hi - lo || 1;
  const base = Math.pow(10, Math.floor(Math.log10(span / target)));
  const candidates = [1, 2, 2.5, 5, 10].map(f => f * base);
  let step = candidates[candidates.length - 1];
  for (const s of candidates) {
    const n = Math.floor(hi / s) - Math.ceil(lo / s) + 1;
    if (n >= 3 && n <= 8) { step = s; break; }
  }
  const t0 = Math.ceil(lo / step) * step, t1 = Math.floor(hi / step) * step;
  const ticks = [];
  for (let i = 0; t0 + i * step <= t1 + step * 1e-9; i++)
    ticks.push(Math.round((t0 + i * step) * 1e10) / 1e10);
  const dec = step < 1 ? Math.max(0, Math.ceil(-Math.log10(step))) : 0;
  const fmt = v => Number.isFinite(v) ? (v === 0 ? "0" : v.toFixed(dec)) : "";
  return { ticks, fmt };
}

function numFmt(v) {
  if (v === 0) return "0";
  const abs = Math.abs(v);
  if (abs >= 1e4 || abs < 1e-2) return v.toExponential(1);
  if (abs >= 100) return v.toFixed(0);
  if (abs >= 10)  return parseFloat(v.toFixed(1)).toString();
  return parseFloat(v.toPrecision(3)).toString();
}

// Returns { ref, tooltipPos, onMouseMove } — snaps tooltip to whichever
// horizontal half the cursor is NOT in, so it never overlaps the data.
function useTooltipSide() {
  const ref = useRef(null);
  const [tooltipX, setTooltipX] = useState(10);
  const onMouseMove = useCallback((state) => {
    if (!state?.activeCoordinate || !ref.current) return;
    const w = ref.current.clientWidth || 400;
    setTooltipX(state.activeCoordinate.x > w / 2 ? 10 : w - 145);
  }, []);
  return { ref, tooltipPos: { x: tooltipX, y: 10 }, onMouseMove };
}

function LinePlot({ data, cfg }) {
  const { xLabel, yLabel, logY, logX, color } = cfg;
  const { ref, tooltipPos, onMouseMove } = useTooltipSide();
  const plotData = logY
    ? data.filter(d => d.y > 0).map(d => ({ ...d, yp: +Math.log10(d.y).toFixed(4) }))
    : data.map(d => ({ ...d, yp: d.y }));
  const xVals = plotData.map(d => d.x);
  const yVals = plotData.map(d => d.yp);
  let xDomain, xTicks, xTickFmt;
  if (logX) {
    const lo = Math.floor(Math.log10(arrMin(xVals.filter(v => v > 0))));
    const hi = Math.floor(Math.log10(arrMax(xVals.filter(v => v > 0))));
    xDomain  = [Math.pow(10, lo), Math.pow(10, hi)];
    xTicks   = Array.from({ length: hi - lo + 1 }, (_, i) => Math.pow(10, lo + i));
    xTickFmt = v => { const e = Math.round(Math.log10(v)); return `10${String(e).replace(/./g, d => '⁰¹²³⁴⁵⁶⁷⁸⁹'[d] ?? d)}`; };
  } else {
    if (cfg.symXTicks) {
      const { ticks, domain } = niceLinTicks(arrMin(xVals), arrMax(xVals));
      xDomain = domain;
      xTicks  = ticks;
    } else {
      const { ticks: t, domain: d } = niceLinTicks(arrMin(xVals), arrMax(xVals));
      xDomain = d; xTicks = t;
    }
    xTickFmt = v => numFmt(v);
  }
  let yDomain, yTicks, yIntFmt = false;
  if (logY) {
    const lo = Math.floor(arrMin(yVals)), hi = Math.ceil(arrMax(yVals));
    yDomain = [lo, hi];
    yTicks  = Array.from({ length: hi - lo + 1 }, (_, i) => lo + i);
  } else if (cfg.ySymRange != null) {
    const absMax = yVals.reduce((m, v) => Math.max(m, Math.abs(v)), 0);
    const absYMax0 = Math.max(cfg.ySymRange, absMax * 1.1);
    const peStep = absYMax0 >= 500 ? 200 : absYMax0 >= 250 ? 100 : absYMax0 >= 100 ? 50 : absYMax0 >= 40 ? 10 : 5;
    const sym = Math.ceil(absYMax0 / peStep) * peStep;
    yDomain = [-sym, sym];
    yTicks  = Array.from({ length: 2 * (sym / peStep) + 1 }, (_, i) => -sym + i * peStep);
    yIntFmt = true;
  } else {
    const [domLo, domHi] = padDomain(yVals);
    yDomain = cfg.clampYZero ? [0, domHi] : [domLo, domHi];
    yTicks  = undefined;
  }
  const yTickFmt = logY
    ? v => { const n = Math.round(v); return n === 0 ? "1" : n === 1 ? "10" : `10^${n}`; }
    : yIntFmt ? v => Math.round(v).toString()
    : v => numFmt(v);
  const hasD = cfg.hasY2 && plotData.some(d => d.y2 != null);
  const dVals = hasD ? plotData.filter(d => d.y2 != null).map(d => d.y2) : [];
  const [dDomLo, dDomHi] = hasD ? padDomain(dVals) : [0, 1];
  const dDomain = hasD ? [dDomLo, dDomHi] : [0, 1];
  return (
    <div ref={ref}>
      <ResponsiveContainer width="100%" height={200}>
        <LineChart data={plotData} onMouseMove={onMouseMove} margin={{ top: 6, right: hasD ? 44 : 12, bottom: 28, left: 10 }}>
          <CartesianGrid strokeDasharray="3 3" stroke={T.border} />
          <XAxis dataKey="x" type="number" tick={{ fill: T.textDim, fontSize: 10, fontFamily: "'DM Mono', monospace" }}
            tickFormatter={xTickFmt} ticks={xTicks} tickLine={false}
            axisLine={{ stroke: T.borderBright }} label={{ value: xLabel, position: "insideBottom", offset: -14, fill: T.textSecondary, fontSize: 11 }}
            scale={logX ? "log" : "auto"} domain={xDomain} />
          <YAxis yAxisId="left" tick={{ fill: T.textDim, fontSize: 10, fontFamily: "'DM Mono', monospace" }}
            tickFormatter={yTickFmt} ticks={yTicks} tickLine={false}
            axisLine={{ stroke: T.borderBright }} label={{ value: yLabel, angle: -90, position: "insideLeft", offset: 14, fill: T.textSecondary, fontSize: 10 }}
            domain={yDomain} />
          {hasD && <YAxis yAxisId="right" orientation="right"
            tick={{ fill: T.amber, fontSize: 9, fontFamily: "'DM Mono', monospace" }} tickLine={false}
            tickFormatter={v => numFmt(v)} axisLine={false}
            label={{ value: "D (tan δ)", angle: 90, position: "insideRight", offset: -6, fill: T.amber, fontSize: 9 }}
            domain={dDomain} />}
          <Tooltip position={tooltipPos}
            contentStyle={{ background: T.bg2, border: `1px solid ${T.border}`, borderRadius: 6, fontFamily: "'DM Mono', monospace", fontSize: 11 }}
            formatter={(v, name) => name === "y2" ? [numFmt(+v), "D (tan δ)"] : [logY ? numFmt(Math.pow(10, +v)) : numFmt(+v), yLabel]}
            labelFormatter={v => `${xLabel}: ${numFmt(+v)}`} />
          {cfg.zeroRefY && <ReferenceLine yAxisId="left" y={0} stroke={T.borderBright} strokeWidth={1} />}
          <Line yAxisId="left" type="monotone" dataKey="yp" dot={false} stroke={color} strokeWidth={1.5} isAnimationActive={false} />
          {hasD && <Line yAxisId="right" type="monotone" dataKey="y2" dot={false} stroke={T.amber} strokeWidth={1.5} strokeDasharray="4 2" isAnimationActive={false} name="y2" />}
          <Customized component={PlotBox} xTicks={xTicks ?? []} yTicks={yTicks ?? []} />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

function RSMPlot({ data, cfg, forcedXDomain, forcedYDomain, plotStyle, showColorbar = false, points = [], hideXLabels = false, hideYLabels = false, overridePxW = null, overridePxH = null }) {
  const ps = plotStyle || DEFAULT_PLOT_STYLE;
  const bins = ps.rsmBins || 256;
  const logIntensity = ps.rsmLogIntensity ?? true;
  const bgMethod = ps.rsmBgMethod ?? null;
  const bgPct = ps.rsmBgPct ?? 5;
  const binned = useMemo(
    () => binRSM(data, bins, bins, forcedXDomain || null, forcedYDomain || null, logIntensity, bgMethod, bgPct),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [data, bins, forcedXDomain?.[0], forcedXDomain?.[1], forcedYDomain?.[0], forcedYDomain?.[1], logIntensity, bgMethod, bgPct]
  );
  if (!binned) return null;
  const xTicks = makeTicks(binned.xDomain[0], binned.xDomain[1], ps.xTick);
  const yTicks = makeTicks(binned.yDomain[0], binned.yDomain[1], ps.yTick);
  const q2pi = ps.rsmQ2pi ?? false;
  const qUnit = q2pi ? "Å⁻¹" : "nm⁻¹";
  const zLabel = logIntensity ? "log I" : "I";
  const colorscale = makeHeatmapColorscale(ps.colorScale || "viridis", ps.rsmWhiteFade ?? 0);
  const heatTrace = {
    type: "heatmap", x: binned.x, y: binned.y, z: binned.z,
    colorscale, showscale: showColorbar,
    connectgaps: false, zsmooth: false,
    zauto: false, zmin: binned.zmin, zmax: binned.zmax,
    hovertemplate: `Qₓ: %{x:.4f}<br>Qz: %{y:.4f}<br>${zLabel}: %{z:.2f}<extra></extra>`,
  };
  const pointTraces = points.map(pt => ({
    type: "scatter", mode: "markers",
    x: [pt.qx], y: [pt.qz],
    marker: { color: pt.color, size: pt.markerSize ?? 9, symbol: pt.symbol || "cross", line: { color: "rgba(0,0,0,0.65)", width: 1.5 } },
    showlegend: false,
    hovertemplate: `${pt.label ? pt.label + "<br>" : ""}Qₓ: ${pt.qx.toFixed(4)}<br>Qz: ${pt.qz.toFixed(4)}<extra></extra>`,
  }));
  const spikeProps = { showspikes: true, spikemode: "across", spikecolor: T.textDim, spikethickness: 1, spikedash: "dot", spikesnap: "cursor" };
  const tightMargin = (hideXLabels || hideYLabels) ? {
    margin: { t: 4, r: 4, b: hideXLabels ? 4 : 50, l: hideYLabels ? 4 : 58, pad: 0 }
  } : {};
  const layout = buildPlotLayout(ps,
    { showgrid: false, ...spikeProps,
      ...(xTicks ? { tickvals: xTicks, tickmode: "array" } : {}),
      ...(hideXLabels ? { showticklabels: false, ticklen: 0, title: { text: "" } }
        : { title: { text: `Qₓ (${qUnit})`, font: { size: ps.fontSize, family: ps.font, color: T.textSecondary }, standoff: 10 } }) },
    { showgrid: false, ...spikeProps,
      ...(yTicks ? { tickvals: yTicks, tickmode: "array" } : {}),
      ...(hideYLabels ? { showticklabels: false, ticklen: 0, title: { text: "" } }
        : { title: { text: `Qz (${qUnit})`, font: { size: ps.fontSize, family: ps.font, color: T.textSecondary }, standoff: 8 } }) },
    [],
    { uirevision: "rsm", hovermode: "closest", ...tightMargin }
  );
  const plotW = overridePxW != null ? `${overridePxW}px` : (ps.plotWidth ? `${Math.round(ps.plotWidth * 96)}px` : "100%");
  const plotH = overridePxH != null ? `${overridePxH}px` : (ps.plotHeight ? `${Math.round(ps.plotHeight * 96)}px` : "280px");
  return (
    <SciPlotWrap ps={ps} cursorLabel={c => `Qₓ=${c.x.toFixed(4)}, Qz=${c.y.toFixed(4)}`}>
      {setCursor => (
        <Plot data={[heatTrace, ...pointTraces]} layout={layout} config={buildPlotConfig("rsm", ps)}
          style={{ width: plotW, height: plotH }} useResizeHandler
          onHover={e => { const pt = e.points?.[0]; if (pt) setCursor({ x: pt.x, y: pt.y }); }} />
      )}
    </SciPlotWrap>
  );
}

function TwoLinePlot({ data, cfg }) {
  const { xLabel, yLabel, color, clampYZero } = cfg;
  const { ref, tooltipPos, onMouseMove } = useTooltipSide();
  const { up = [], down = [] } = data;
  const allPts = [...up, ...down];
  if (!allPts.length) return null;
  const xVals = allPts.map(d => d.x), yVals = allPts.map(d => d.y);
  let xDomain, xTicks;
  if (cfg.symXTicks) {
    const { ticks, domain } = niceLinTicks(arrMin(xVals), arrMax(xVals));
    xDomain = domain; xTicks = ticks;
  } else {
    xDomain = padDomain(xVals); xTicks = undefined;
  }
  let yDomain, yTicks, yIntFmt = false;
  if (cfg.ySymRange != null) {
    const absMax = yVals.reduce((m, v) => Math.max(m, Math.abs(v)), 0);
    const absYMax0 = Math.max(cfg.ySymRange, absMax * 1.1);
    const peStep = absYMax0 >= 500 ? 200 : absYMax0 >= 250 ? 100 : absYMax0 >= 100 ? 50 : absYMax0 >= 40 ? 10 : 5;
    const sym = Math.ceil(absYMax0 / peStep) * peStep;
    yDomain = [-sym, sym];
    yTicks = Array.from({ length: 2 * (sym / peStep) + 1 }, (_, i) => -sym + i * peStep);
    yIntFmt = true;
  } else {
    const [domLo, domHi] = padDomain(yVals);
    if (clampYZero) {
      const erStep = domHi >= 8000 ? 2000 : domHi >= 4000 ? 1000 : domHi >= 2000 ? 500 : domHi >= 800 ? 200 : domHi >= 300 ? 100 : 50;
      const erMax = Math.ceil(domHi / erStep) * erStep;
      yDomain = [0, erMax];
      yTicks = Array.from({ length: erMax / erStep + 1 }, (_, i) => i * erStep);
      yIntFmt = true;
    } else {
      const { ticks, domain } = niceLinTicks(domLo, domHi);
      yDomain = domain; yTicks = ticks;
    }
  }
  const yFmt = yIntFmt ? v => Math.round(v).toString() : v => numFmt(v);
  const hasD = allPts.some(d => d.y2 != null);
  const dVals = hasD ? allPts.filter(d => d.y2 != null).map(d => d.y2) : [];
  const [dDomLo, dDomHi] = hasD ? padDomain(dVals) : [0, 1];
  const dDomain = hasD ? [dDomLo, dDomHi] : [0, 1];
  return (
    <div ref={ref}>
      <ResponsiveContainer width="100%" height={200}>
        <ComposedChart onMouseMove={onMouseMove} margin={{ top: 6, right: hasD ? 44 : 12, bottom: 28, left: 10 }}>
          <CartesianGrid strokeDasharray="3 3" stroke={T.border} />
          <XAxis dataKey="x" type="number" domain={xDomain} ticks={xTicks} tickLine={false}
            axisLine={{ stroke: T.borderBright }}
            tick={{ fill: T.textDim, fontSize: 10, fontFamily: "'DM Mono', monospace" }} tickFormatter={v => numFmt(v)}
            label={{ value: xLabel, position: "insideBottom", offset: -14, fill: T.textSecondary, fontSize: 11 }} />
          <YAxis yAxisId="left" domain={yDomain} ticks={yTicks} tickLine={false}
            axisLine={{ stroke: T.borderBright }}
            tick={{ fill: T.textDim, fontSize: 10, fontFamily: "'DM Mono', monospace" }} tickFormatter={yFmt}
            label={{ value: yLabel, angle: -90, position: "insideLeft", offset: 14, fill: T.textSecondary, fontSize: 10 }} />
          {hasD && <YAxis yAxisId="right" orientation="right" domain={dDomain} tickLine={false} axisLine={false}
            tick={{ fill: T.amber, fontSize: 9, fontFamily: "'DM Mono', monospace" }} tickFormatter={v => numFmt(v)}
            label={{ value: "D (tan δ)", angle: 90, position: "insideRight", offset: -6, fill: T.amber, fontSize: 9 }} />}
          <Tooltip position={tooltipPos}
            contentStyle={{ background: T.bg2, border: `1px solid ${T.border}`, borderRadius: 6, fontFamily: "'DM Mono', monospace", fontSize: 11 }}
            formatter={(v, name) => {
              if (name === "up_d" || name === "down_d") return [numFmt(+v), `D (tan δ) ${name === "up_d" ? "↑" : "↓"}`];
              return [numFmt(+v), name === "up" ? `${yLabel} ↑` : `${yLabel} ↓`];
            }}
            labelFormatter={v => `${xLabel}: ${numFmt(+v)}`} />
          {up.length > 0   && <Line yAxisId="left"  data={up}   dataKey="y"  dot={false} stroke={color}      strokeWidth={1.5} isAnimationActive={false} name="up" />}
          {down.length > 0 && <Line yAxisId="left"  data={down} dataKey="y"  dot={false} stroke={T.teal}     strokeWidth={1.5} strokeDasharray="4 2" isAnimationActive={false} name="down" />}
          {hasD && up.length > 0   && <Line yAxisId="right" data={up}   dataKey="y2" dot={false} stroke={T.amber}    strokeWidth={1} isAnimationActive={false} name="up_d" />}
          {hasD && down.length > 0 && <Line yAxisId="right" data={down} dataKey="y2" dot={false} stroke={T.amberDim} strokeWidth={1} strokeDasharray="2 2" isAnimationActive={false} name="down_d" />}
          <Customized component={PlotBox} xTicks={xTicks ?? []} yTicks={yTicks ?? []} />
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}

// Canvas-based RSM renderer for the sample detail view — raw display, no processing.
function RsmCanvasPlot({ data, logIntensity = false }) {
  const wrapRef   = useRef(null);
  const canvasRef = useRef(null);
  const [plotW, setPlotW] = useState(300);

  const ML = 50, MR = 12, MT = 6, MB = 38, TOTAL_H = 200;
  const PH = TOTAL_H - MT - MB;

  const bins = 400;

  const binned = useMemo(
    () => binRSM(data, bins, bins, null, null, logIntensity, "percentile", 5),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [data, logIntensity]
  );

  // Track container width
  useEffect(() => {
    if (!wrapRef.current) return;
    const obs = new ResizeObserver(([e]) => setPlotW(Math.max(60, e.contentRect.width - ML - MR)));
    obs.observe(wrapRef.current);
    setPlotW(Math.max(60, wrapRef.current.offsetWidth - ML - MR));
    return () => obs.disconnect();
  }, []);

  // Draw heatmap pixels to canvas using same colorscale logic as RSMPlot
  useEffect(() => {
    if (!binned || !canvasRef.current) return;
    const canvas = canvasRef.current;
    const ctx = canvas.getContext("2d");
    const { z, zmin, zmax } = binned;
    const ny = z.length, nx = z[0].length;
    const zMin = zmin ?? 0, zMax = zmax ?? 1;
    const zRange = zMax - zMin || 1;

    const anchors = COLOR_SCALES.viridis;
    const getColor = t => {
      const s = Math.max(0, Math.min(1, t)) * (anchors.length - 1);
      const i = Math.min(Math.floor(s), anchors.length - 2);
      const [r1,g1,b1] = hexToRgb(anchors[i]);
      const [r2,g2,b2] = hexToRgb(anchors[i+1]);
      const f = s - i;
      return [r1+f*(r2-r1), g1+f*(g2-g1), b1+f*(b2-b1)];
    };
    const FADE = 0.15;
    canvas.width = nx; canvas.height = ny;
    const img = ctx.createImageData(nx, ny);
    for (let row = 0; row < ny; row++) {
      for (let col = 0; col < nx; col++) {
        const v = z[ny - 1 - row][col];
        if (v !== null) {
          const t = (v - zMin) / zRange;
          const ct = Math.max(0, (t - FADE) / (1 - FADE));
          const p = (row * nx + col) * 4;
          const [r,g,b] = getColor(ct);
          const a = t < FADE ? Math.round((t / FADE) * 255) : 255;
          img.data[p]=r; img.data[p+1]=g; img.data[p+2]=b; img.data[p+3]=a;
        }
      }
    }
    ctx.putImageData(img, 0, 0);
  }, [binned]);

  if (!binned) return null;
  const { xDomain, yDomain } = binned;
  const { ticks: xTicks } = niceLinTicks(xDomain[0], xDomain[1]);
  const { ticks: yTicks } = niceLinTicks(yDomain[0], yDomain[1]);
  const xFrac = v => (v - xDomain[0]) / (xDomain[1] - xDomain[0]);
  const yFrac = v => 1 - (v - yDomain[0]) / (yDomain[1] - yDomain[0]);
  const PW = plotW;

  return (
    <div ref={wrapRef} style={{ position: "relative", width: "100%", height: TOTAL_H, overflow: "hidden" }}>
      <canvas ref={canvasRef}
        style={{ position: "absolute", left: ML, top: MT, width: PW, height: PH, imageRendering: "pixelated" }} />
      <svg width={ML + PW + MR} height={TOTAL_H}
        style={{ position: "absolute", left: 0, top: 0, overflow: "visible", pointerEvents: "none" }}>
        {/* Tick marks + labels — X (no grid lines) */}
        {xTicks.filter(t => xFrac(t) >= 0 && xFrac(t) <= 1).map(t => {
          const px = ML + xFrac(t) * PW;
          return <g key={t}>
            <line x1={px} y1={MT+PH} x2={px} y2={MT+PH+4} stroke={T.borderBright} strokeWidth={1} />
            <text x={px} y={MT+PH+14} textAnchor="middle" fill={T.textDim} fontSize={10} fontFamily="'DM Mono',monospace">{numFmt(t)}</text>
          </g>;
        })}
        {/* Tick marks + labels — Y (no grid lines) */}
        {yTicks.filter(t => yFrac(t) >= 0 && yFrac(t) <= 1).map(t => {
          const py = MT + yFrac(t) * PH;
          return <g key={t}>
            <line x1={ML-4} y1={py} x2={ML} y2={py} stroke={T.borderBright} strokeWidth={1} />
            <text x={ML-8} y={py+3} textAnchor="end" fill={T.textDim} fontSize={10} fontFamily="'DM Mono',monospace">{numFmt(t)}</text>
          </g>;
        })}
        {/* Box border */}
        <rect x={ML} y={MT} width={PW} height={PH} fill="none" stroke={T.borderBright} strokeWidth={1} />
        {/* Axis labels */}
        <text x={ML+PW/2} y={TOTAL_H-4} textAnchor="middle" fill={T.textSecondary} fontSize={11} fontFamily="'DM Mono',monospace">Qₓ (nm⁻¹)</text>
        <text x={12} y={MT+PH/2} textAnchor="middle" fill={T.textSecondary} fontSize={10} fontFamily="'DM Mono',monospace"
          transform={`rotate(-90,12,${MT+PH/2})`}>Qz (nm⁻¹)</text>
      </svg>
    </div>
  );
}

function MeasPlot({ data, type, thicknessNm = 0, areaM2, areaCorrFactor = 1.0, logIntensity = false }) {
  const cfg = MEAS_TYPES[type];
  if (!hasPlotData(data)) return null;
  if (type === "rsm") return <RsmCanvasPlot data={data} logIntensity={logIntensity} />;
  let plotData = data;
  if (type === "diel_f" || type === "diel_b") {
    const d_m = (thicknessNm || 30) * 1e-9;
    const A   = (areaM2 || DEFAULT_AREA_M2) * (areaCorrFactor || 1.0);
    const convert = pts => {
      if (!pts || !pts.length) return pts;
      const maxY = pts.reduce((m, p) => Math.max(m, Math.abs(p.y)), 0);
      if (maxY > 0 && maxY < 1) return pts.map(p => ({ ...p, y: p.y * d_m / (A * EPS0) }));
      return pts;
    };
    plotData = Array.isArray(data)
      ? convert(data)
      : { up: convert(data.up || []), down: convert(data.down || []) };
  }
  if (type === "pe" && areaCorrFactor && areaCorrFactor !== 1.0) {
    const scale = 1.0 / (areaCorrFactor || 1.0);
    plotData = data.map(p => ({ ...p, y: p.y * scale }));
  }
  if (cfg.twoSweep) return <TwoLinePlot data={plotData} cfg={cfg} />;
  return <LinePlot data={plotData} cfg={{ ...cfg, hasY2: type === "diel_f" }} />;
}

// ── UploadZone ────────────────────────────────────────────────────────────────

function UploadZone({ type, onFile, hasData, thicknessNm = 0 }) {
  const ref = useRef();
  const [drag, setDrag] = useState(false);
  return (
    <div onClick={() => ref.current.click()}
      onDragOver={e => { e.preventDefault(); setDrag(true); }}
      onDragLeave={() => setDrag(false)}
      onDrop={e => { e.preventDefault(); setDrag(false); onFile(e.dataTransfer.files[0], type, thicknessNm); }}
      style={{ border: `1px dashed ${drag ? T.amber : T.borderBright}`, borderRadius: 6, padding: "8px 14px", cursor: "pointer", textAlign: "center", background: drag ? T.amberGlow : "transparent", transition: "all .15s", fontSize: 11, color: T.textDim, fontFamily: "'DM Mono', monospace" }}>
      <input ref={ref} type="file" accept=".csv,.txt,.dat" style={{ display: "none" }}
        onChange={e => onFile(e.target.files[0], type, thicknessNm)} />
      {hasData ? "↑ replace file" : "drop .csv/.txt or click"}
    </div>
  );
}

function fmtAreaMicron(m2) {
  if (!m2) return null;
  const um2 = m2 * 1e12;
  return um2 >= 1000 ? `${(um2 / 1000).toFixed(2)}×10³ µm²` : `${um2.toFixed(2)} µm²`;
}

// ── MeasCard ──────────────────────────────────────────────────────────────────

function MeasCard({ type, plotData, filename, filenames, onFile, thicknessNm = 0, areaM2, areaCorrFactor = 1.0, onAreaChange, onAnalyze }) {
  const cfg = MEAS_TYPES[type];
  const [corrExpr,      setCorrExpr]      = useState(String(areaCorrFactor ?? 1.0));
  const [peLoop,        setPeLoop]        = useState("all"); // "all" | "second"
  const [rsmLog,        setRsmLog]        = useState(false); // lin by default

  if (type === "diel_b") {
    const hasUp    = !!(plotData?.up?.length);
    const hasDown  = !!(plotData?.down?.length);
    const hasBoth  = hasUp && hasDown;
    return (
      <div style={{ background: T.bg2, border: `1px solid ${T.border}`, borderRadius: 8, overflow: "hidden" }}>
        <div style={{ padding: "8px 12px", borderBottom: `1px solid ${T.border}` }}>
          <span style={{ fontFamily: "'DM Mono', monospace", fontSize: 12, color: cfg.color, fontWeight: 600 }}>{cfg.label}</span>
        </div>
        <div style={{ padding: "10px 12px" }}>
          {hasBoth && <div style={{ marginBottom: 8 }}><MeasPlot data={plotData} type="diel_b" thicknessNm={thicknessNm} areaM2={areaM2} areaCorrFactor={areaCorrFactor} /></div>}
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
            {[["diel_b_up", "↑ up sweep", hasUp, filenames?.diel_b_up], ["diel_b_down", "↓ down sweep", hasDown, filenames?.diel_b_down]].map(([sub, label, hasSweep, fn]) => (
              <div key={sub}>
                <div style={{ fontFamily: "'DM Mono', monospace", fontSize: 10, color: T.textDim, marginBottom: 4 }}>{label}</div>
                <UploadZone type={sub} onFile={(file) => onFile(sub, file)} hasData={hasSweep} thicknessNm={thicknessNm} />
                {fn && <div style={{ fontSize: 9, color: T.textDim, fontFamily: "'DM Mono', monospace", marginTop: 3, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{fn}</div>}
              </div>
            ))}
          </div>
          {!areaM2 && <div style={{ marginTop: 6, fontSize: 10, color: T.amber, fontFamily: "'DM Mono', monospace" }}>⚠ area defaulted (20µm ⌀)</div>}
        </div>
      </div>
    );
  }

  const has  = hasPlotData(plotData);
  const isPE = type === "pe";
  const isDiel = type === "diel_f";
  const displayPEData = isPE && has ? (peLoop === "second" ? splitPELoops(plotData).second : plotData) : plotData;
  return (
    <div style={{ background: T.bg2, border: `1px solid ${T.border}`, borderRadius: 8, overflow: "hidden" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, justifyContent: "space-between", padding: "8px 12px", borderBottom: `1px solid ${T.border}` }}>
        <span style={{ fontFamily: "'DM Mono', monospace", fontSize: 12, color: cfg.color, fontWeight: 600 }}>{cfg.label}</span>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          {isPE && has && <LoopToggle value={peLoop} onChange={setPeLoop} />}
          {type === "rsm" && has && (
            <div style={{ display: "flex", alignItems: "center", gap: 5 }}>
              <span style={{ fontSize: 10, color: T.textDim, fontFamily: "'DM Mono', monospace" }}>intensity</span>
              <div style={{ display: "flex", border: `1px solid ${T.border}`, borderRadius: 10, overflow: "hidden" }}>
                {[["lin", false], ["log", true]].map(([label, val]) => (
                  <button key={label} onClick={() => setRsmLog(val)}
                    style={{ padding: "2px 8px", fontSize: 10, fontFamily: "'DM Mono', monospace", border: "none", cursor: "pointer", background: rsmLog === val ? T.blue : "transparent", color: rsmLog === val ? "#fff" : T.textDim, transition: "background 0.15s" }}>
                    {label}
                  </button>
                ))}
              </div>
            </div>
          )}
          {type === "xrd_ot" && has && onAnalyze && (
            <button onClick={onAnalyze}
              style={{ fontFamily: "'DM Mono', monospace", fontSize: 10, padding: "2px 8px", background: T.bg3, border: `1px solid ${T.border}`, borderRadius: 4, color: T.textPrimary, cursor: "pointer", letterSpacing: 0.5 }}>
              Analyze
            </button>
          )}
          {filename && <span style={{ fontSize: 10, color: T.textDim, fontFamily: "'DM Mono', monospace", maxWidth: 160, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{filename}</span>}
        </div>
      </div>
      <div style={{ padding: "10px 12px" }}>
        {has ? (
          <>
            <MeasPlot data={displayPEData} type={type} thicknessNm={thicknessNm} areaM2={areaM2} areaCorrFactor={areaCorrFactor} logIntensity={rsmLog} />
            <div style={{ marginTop: 8 }}><UploadZone type={type} onFile={(file) => onFile(type, file)} hasData={true} thicknessNm={thicknessNm} /></div>
          </>
        ) : (
          <div style={{ height: 80, display: "flex", alignItems: "center", justifyContent: "center" }}>
            <UploadZone type={type} onFile={(file) => onFile(type, file)} hasData={false} thicknessNm={thicknessNm} />
          </div>
        )}
        {isPE && (
          <div style={{ marginTop: 8, borderTop: `1px solid ${T.border}`, paddingTop: 8, display: "flex", flexWrap: "wrap", alignItems: "center", gap: 8 }}>
            <span style={{ fontSize: 10, color: areaM2 ? T.teal : T.amber, fontFamily: "'DM Mono', monospace" }}>
              {areaM2 ? `⌀ ${fmtAreaMicron(areaM2)} (file)` : "⚠ default 20µm ⌀"}
            </span>
            <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
              <span style={{ fontSize: 10, color: T.textDim, fontFamily: "'DM Mono', monospace" }}>× corr</span>
              <input type="text" value={corrExpr}
                onChange={e => {
                  const raw = e.target.value;
                  setCorrExpr(raw);
                  const val = evalMathExpr(raw);
                  if (val !== null) onAreaChange && onAreaChange(areaM2, val);
                }}
                style={{ width: 96, background: T.bg0, border: `1px solid ${evalMathExpr(corrExpr) !== null ? T.teal : T.red}`, borderRadius: 4, color: T.textPrimary, padding: "3px 6px", fontFamily: "'DM Mono', monospace", fontSize: 11, outline: "none" }} />
            </div>
            <span style={{ fontSize: 10, color: T.textSecondary, fontFamily: "'DM Mono', monospace" }}>
              eff: {fmtAreaMicron((areaM2 || DEFAULT_AREA_M2) * (evalMathExpr(corrExpr) || areaCorrFactor || 1.0))}
            </span>
          </div>
        )}
        {isDiel && !areaM2 && <div style={{ marginTop: 4, fontSize: 10, color: T.amber, fontFamily: "'DM Mono', monospace" }}>⚠ area defaulted (20µm ⌀)</div>}
      </div>
    </div>
  );
}

// ── AFM / Scanning Probe ──────────────────────────────────────────────────────

// NanoScope / Gwyddion "thermal" AFM colormap
// dark navy → deep purple → brownish-red → orange → yellow → near-white
const AFM_CM = [
  [0.00, [  0,   0,  15]],
  [0.10, [ 35,   0,  70]],
  [0.20, [ 78,   0, 102]],
  [0.30, [122,  15,  80]],
  [0.40, [158,  26,  26]],
  [0.50, [182,  56,   5]],
  [0.60, [212,  96,   5]],
  [0.70, [232, 142,  10]],
  [0.80, [241, 188,  20]],
  [0.90, [249, 228,  52]],
  [1.00, [255, 255, 188]],
];
function cmAfm(t) {
  t = Math.max(0, Math.min(1, t));
  let i = 0;
  while (i < AFM_CM.length - 2 && AFM_CM[i + 1][0] <= t) i++;
  const [t0, c0] = AFM_CM[i], [t1, c1] = AFM_CM[Math.min(i + 1, AFM_CM.length - 1)];
  const f = t1 > t0 ? (t - t0) / (t1 - t0) : 0;
  return c0.map((c, j) => Math.round(c + f * (c1[j] - c)));
}

function afmShortLabel(name) {
  const n = name.toLowerCase();
  if (n.includes("height"))    return "Ht";
  if (n.includes("amplitude")) return "Amp";
  if (n.includes("phase"))     return "Ph";
  if (n.includes("zsensor") || n.includes("z sensor")) return "Z";
  return name.replace(/Retrace|Trace/gi, "").trim().slice(0, 4);
}

function AfmChannelMap({ grid, scanSizeUm, vmin, vmax }) {
  const canvasRef = useRef();
  useEffect(() => {
    if (!grid?.length || !canvasRef.current) return;
    const H = grid.length, W = grid[0].length;
    const canvas = canvasRef.current;
    canvas.width = W; canvas.height = H;
    const ctx = canvas.getContext("2d");

    // Draw colormap — use backend percentile range when available, else fallback to data range
    const img = ctx.createImageData(W, H);
    let mn = vmin, mx = vmax;
    if (mn == null || mx == null) {
      mn = Infinity; mx = -Infinity;
      for (let r = 0; r < H; r++) for (let c = 0; c < W; c++) {
        const v = grid[r][c]; if (isFinite(v)) { mn = Math.min(mn, v); mx = Math.max(mx, v); }
      }
    }
    const rng = mx - mn || 1;
    for (let r = 0; r < H; r++) for (let c = 0; c < W; c++) {
      const t = Math.max(0, Math.min(1, (grid[r][c] - mn) / rng));
      const [rv, gv, bv] = cmAfm(t);
      const idx = (r * W + c) * 4;
      img.data[idx] = rv; img.data[idx+1] = gv; img.data[idx+2] = bv; img.data[idx+3] = 255;
    }
    ctx.putImageData(img, 0, 0);

    // Scale bar overlay
    if (scanSizeUm && scanSizeUm > 0) {
      const niceStops = [0.1, 0.2, 0.5, 1, 2, 5, 10, 20, 50, 100];
      const targetUm = scanSizeUm / 5;
      const barUm = niceStops.reduce((a, b) => Math.abs(b - targetUm) < Math.abs(a - targetUm) ? b : a);
      const barPx = Math.round(barUm / scanSizeUm * W);
      const marginX = Math.round(W * 0.04);
      const marginY = Math.round(H * 0.07);
      const barX = W - barPx - marginX;
      const barY = H - marginY;
      const barH = Math.max(3, Math.round(H * 0.025));
      const fontSize = Math.max(11, Math.round(W / 16));
      const label = barUm >= 1 ? `${barUm} µm` : `${barUm * 1000} nm`;

      // Bar
      ctx.fillStyle = "white";
      ctx.fillRect(barX, barY, barPx, barH);

      // Label — stroke for contrast against any background colour
      ctx.font = `bold ${fontSize}px monospace`;
      ctx.textAlign = "center";
      ctx.strokeStyle = "rgba(0,0,0,0.7)";
      ctx.lineWidth = 3;
      ctx.lineJoin = "round";
      ctx.strokeText(label, barX + barPx / 2, barY - Math.round(fontSize * 0.3));
      ctx.fillStyle = "white";
      ctx.fillText(label, barX + barPx / 2, barY - Math.round(fontSize * 0.3));
    }
  }, [grid, scanSizeUm, vmin, vmax]);
  return <canvas ref={canvasRef} style={{ width: "100%", height: "auto", imageRendering: "pixelated", display: "block", borderRadius: 4 }} />;
}

function AfmCard({ afmData, filename, onFile }) {
  const inputRef = useRef();
  const channels = afmData?.channel_names || [];
  const [channel, setChannel] = useState(null);
  const [drag, setDrag] = useState(false);

  useEffect(() => {
    if (channels.length && !channel) setChannel(channels[0]);
  }, [afmData]);

  const grid = afmData?.channels?.[channel] ?? null;
  const has = !!grid;
  const range = afmData?.channel_ranges?.[channel] ?? null;
  const [mn, mx] = range ?? [null, null];

  const isHeight = channel?.toLowerCase().includes("height");
  const unit = isHeight ? "nm" : channel?.toLowerCase().includes("phase") ? "°" : "V";
  const cmGrad = AFM_CM.map(([t,[r,g,b]]) => `rgb(${r},${g},${b}) ${(t*100).toFixed(0)}%`).join(", ");

  const dropZone = (children) => (
    <div onClick={() => inputRef.current?.click()}
      onDragOver={e => { e.preventDefault(); setDrag(true); }}
      onDragLeave={() => setDrag(false)}
      onDrop={e => { e.preventDefault(); setDrag(false); onFile(e.dataTransfer.files[0]); }}
      style={{ border: `1px dashed ${drag ? T.violet : T.borderBright}`, borderRadius: 6, padding: "8px 14px", cursor: "pointer", textAlign: "center", background: drag ? "rgba(167,139,250,0.08)" : "transparent", transition: "all .15s", fontSize: 11, color: T.textDim, fontFamily: "'DM Mono', monospace" }}>
      <input ref={inputRef} type="file" accept=".ibw" style={{ display: "none" }} onChange={e => onFile(e.target.files[0])} />
      {children}
    </div>
  );

  return (
    <div style={{ background: T.bg2, border: `1px solid ${T.border}`, borderRadius: 8, overflow: "hidden" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, justifyContent: "space-between", padding: "8px 12px", borderBottom: `1px solid ${T.border}` }}>
        <span style={{ fontFamily: "'DM Mono', monospace", fontSize: 12, color: T.violet, fontWeight: 600 }}>
          {channel ? afmShortLabel(channel) : "Scanning Probe"}
        </span>
        {has && (
          <div style={{ display: "flex", border: `1px solid ${T.border}`, borderRadius: 10, overflow: "hidden" }}>
            {channels.map((name, idx) => (
              <button key={name} onClick={() => setChannel(name)}
                style={{ padding: "2px 8px", fontSize: 10, fontFamily: "'DM Mono', monospace", border: "none",
                  borderRight: idx < channels.length - 1 ? `1px solid ${T.border}` : "none",
                  cursor: "pointer", background: channel === name ? T.violet : "transparent",
                  color: channel === name ? "#fff" : T.textDim, transition: "background .15s" }}>
                {afmShortLabel(name)}
              </button>
            ))}
          </div>
        )}
        {filename && <span style={{ fontSize: 10, color: T.textDim, fontFamily: "'DM Mono', monospace", maxWidth: 160, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{filename}</span>}
      </div>
      <div style={{ padding: "10px 12px" }}>
        {has ? (
          <>
            <AfmChannelMap grid={grid} scanSizeUm={afmData?.scan_size_um} vmin={mn} vmax={mx} />
            {mn !== null && (
              <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 4 }}>
                <span style={{ fontSize: 9, color: T.textDim, fontFamily: "'DM Mono', monospace", minWidth: 34, textAlign: "right" }}>{mn.toFixed(1)}</span>
                <div style={{ flex: 1, height: 5, borderRadius: 3, background: `linear-gradient(to right, ${cmGrad})` }} />
                <span style={{ fontSize: 9, color: T.textDim, fontFamily: "'DM Mono', monospace", minWidth: 50 }}>{mx.toFixed(1)} {unit}</span>
              </div>
            )}
            {afmData?.scan_size_um != null && (
              <div style={{ marginTop: 4, fontSize: 10, color: T.textDim, fontFamily: "'DM Mono', monospace" }}>
                {afmData.scan_size_um} µm · {afmData.pixels?.[0]}×{afmData.pixels?.[1]} px
              </div>
            )}
            <div style={{ marginTop: 8 }}>{dropZone("↑ replace file")}</div>
          </>
        ) : (
          <div style={{ height: 80, display: "flex", alignItems: "center", justifyContent: "center" }}>
            {dropZone("drop .ibw or click")}
          </div>
        )}
      </div>
    </div>
  );
}

// ── LayerEditor ───────────────────────────────────────────────────────────────
// Handles both sputter and PLD, with co-deposition (multiple targets per layer).
// Layer shape:
//   { id, temp, pressure,
//     targets: [{ material, ...targetFields }],
//     // sputter: targets have { material, oxygen_pct, power_W, time_s }
//     //          (time_s is shared → on first target; others inherit)
//     // PLD:     targets have { material, energy_mJ, pulses }
//     //          + layer-level: frequency_hz, focal_position
//   }

// ── Settings ──────────────────────────────────────────────────────────────────

const DEFAULT_SETTINGS = {
  defaultSubstrate: "STO (001)",
  defaultLot: "",
  defaultAreaCm2: "",
  sputter:    { temp: 600, pressure: 10, oxygen_pct: 20, time_s: 2000, power_W: 150 },
  pld:        { temp: 600, pressure: 2,  frequency_hz: 10, energy_mJ: 60, pulses: 10000 },
  materials:  { sputter: [], pld: [] },
  structures: [],
};

function mergeSettings(parsed) {
  return {
    ...DEFAULT_SETTINGS,
    ...parsed,
    sputter:    { ...DEFAULT_SETTINGS.sputter, ...parsed.sputter },
    pld:        { ...DEFAULT_SETTINGS.pld,     ...parsed.pld },
    materials: {
      sputter: parsed.materials?.sputter ?? [],
      pld:     parsed.materials?.pld     ?? [],
    },
    structures: parsed.structures ?? [],
  };
}

// Parse a CIF file text and return { name, a, b, c, alpha, beta, gamma }
function parseCIF(text) {
  const get = (key) => {
    const m = text.match(new RegExp(`^${key}\\s+([^\\s#]+)`, "mi"));
    return m ? m[1].replace(/'/g, "").trim() : null;
  };
  const num = (key) => { const v = get(key); return v != null ? parseFloat(v) : ""; };
  return {
    name:  get("_chemical_formula_structural") || get("_chemical_formula_sum") || "",
    a:     num("_cell_length_a"),
    b:     num("_cell_length_b"),
    c:     num("_cell_length_c"),
    alpha: num("_cell_angle_alpha"),
    beta:  num("_cell_angle_beta"),
    gamma: num("_cell_angle_gamma"),
  };
}

function saveSettings(s) {
  api("PUT", "/settings", s).catch(() => {});
}

const SPUTTER_DEFAULTS = { material: "", power_W: 150 };
const PLD_DEFAULTS     = { material: "", energy_mJ: 60, pulses: 10000 };

function newLayer(technique, settings) {
  const cfg = settings?.[technique] || {};
  return {
    id: crypto.randomUUID ? crypto.randomUUID() : String(Date.now()),
    temp:     cfg.temp     ?? (technique === "pld" ? 600 : 600),
    pressure: cfg.pressure ?? (technique === "pld" ? 2   : 10),
    ...(technique === "pld"
      ? { frequency_hz: cfg.frequency_hz ?? 10, focal_position: "" }
      : { oxygen_pct:   cfg.oxygen_pct   ?? 20, time_s: cfg.time_s ?? 2000 }),
    targets: [technique === "pld"
      ? { material: "", energy_mJ: cfg.energy_mJ ?? 60, pulses: cfg.pulses ?? 10000 }
      : { material: "", power_W:   cfg.power_W   ?? 150 }],
  };
}

function TargetRow({ target, technique, onChange, onRemove, canRemove, knownMaterials, settings }) {
  const s = getMaterialStyle(target.material);
  const tField = (k, label, unit, w = 70) => (
    <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
      <span style={{ fontSize: 9, color: T.textDim, fontFamily: "'DM Mono', monospace", textTransform: "uppercase" }}>{label}</span>
      <div style={{ display: "flex", alignItems: "center", gap: 2 }}>
        <input value={target[k] ?? ""} onChange={e => onChange({ ...target, [k]: e.target.value })}
          style={{ width: w, background: T.bg0, border: `1px solid ${T.borderBright}`, borderRadius: 4, color: T.textPrimary, padding: "4px 6px", fontFamily: "'DM Mono', monospace", fontSize: 12, outline: "none", boxSizing: "border-box", textAlign: "center" }} />
        {unit && <span style={{ fontSize: 10, color: T.textDim, fontFamily: "'DM Mono', monospace", whiteSpace: "nowrap" }}>{unit}</span>}
      </div>
    </div>
  );
  const handleMaterialChange = (v) => {
    const lib   = settings?.materials?.[technique] || [];
    const entry = lib.find(m => m.name === v);
    if (entry) {
      const merged = { ...target, material: v };
      const layerDefaults = {};
      if (technique === "sputter") {
        if (entry.power_W    != null && entry.power_W    !== "") merged.power_W          = entry.power_W;
        if (entry.temp       != null && entry.temp       !== "") layerDefaults.temp       = entry.temp;
        if (entry.pressure   != null && entry.pressure   !== "") layerDefaults.pressure   = entry.pressure;
        if (entry.oxygen_pct != null && entry.oxygen_pct !== "") layerDefaults.oxygen_pct = entry.oxygen_pct;
        if (entry.time_s     != null && entry.time_s     !== "") layerDefaults.time_s     = entry.time_s;
      } else {
        if (entry.energy_mJ    != null && entry.energy_mJ    !== "") merged.energy_mJ           = entry.energy_mJ;
        if (entry.pulses       != null && entry.pulses       !== "") merged.pulses               = entry.pulses;
        if (entry.temp         != null && entry.temp         !== "") layerDefaults.temp           = entry.temp;
        if (entry.pressure     != null && entry.pressure     !== "") layerDefaults.pressure       = entry.pressure;
        if (entry.frequency_hz != null && entry.frequency_hz !== "") layerDefaults.frequency_hz  = entry.frequency_hz;
      }
      onChange(merged, Object.keys(layerDefaults).length ? layerDefaults : null);
    } else {
      onChange({ ...target, material: v });
    }
  };
  return (
    <div style={{ display: "flex", alignItems: "flex-end", gap: 8, flexWrap: "wrap" }}>
      <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
        <span style={{ fontSize: 9, color: T.textDim, fontFamily: "'DM Mono', monospace", textTransform: "uppercase" }}>Material</span>
        <div style={{ width: 120 }}>
          <MaterialCombobox value={target.material} onChange={handleMaterialChange} knownMaterials={knownMaterials} small />
        </div>
      </div>
      {technique === "sputter" ? (
        <>
          {tField("power_W", "Power", "W", 56)}
        </>
      ) : (
        <>
          {tField("energy_mJ", "Energy", "mJ", 60)}
          {tField("pulses",    "Pulses",  "",  72)}
        </>
      )}
      {canRemove && (
        <button onClick={onRemove} style={{ background: "none", border: "none", color: T.red, cursor: "pointer", fontSize: 16, lineHeight: 1, padding: "0 2px", alignSelf: "flex-end", marginBottom: 1 }}>×</button>
      )}
    </div>
  );
}

function LayerEditor({ layer, technique, onRemove, onDuplicate, onUpdate, onDragStart, onDragOver, onDrop, onDragEnd, isDragOver, knownMaterials, settings, initialEditing = false }) {
  const [editing, setEditing] = useState(initialEditing);
  const [draft, setDraft]     = useState(initialEditing ? JSON.parse(JSON.stringify(layer)) : null);

  const startEdit = (e) => {
    e.stopPropagation();
    if (!editing) setDraft(JSON.parse(JSON.stringify(layer)));
    setEditing(true);
  };
  const saveEdit = (e) => { e.stopPropagation(); onUpdate(draft); setEditing(false); };
  const cancelEdit = (e) => { e.stopPropagation(); if (initialEditing) { onRemove(); } else { setEditing(false); } };
  const handleEditKeyDown = (e) => { if (e.key === "Enter") { e.preventDefault(); onUpdate(draft); setEditing(false); } };
  const setDraftField = (k, v) => setDraft(p => ({ ...p, [k]: v }));
  const updateTarget = (i, t, layerDefaults)  => setDraft(p => { const ts = [...p.targets]; ts[i] = t; const patch = { ...p, targets: ts }; if (i === 0 && layerDefaults) Object.assign(patch, layerDefaults); return patch; });
  const removeTarget = (i)     => setDraft(p => { const ts = p.targets.filter((_, j) => j !== i); return { ...p, targets: ts }; });
  const addTarget = () => {
    const cfg = settings?.[technique] || {};
    const newTarget = technique === "pld"
      ? { material: "", energy_mJ: cfg.energy_mJ ?? 60, pulses: cfg.pulses ?? 10000 }
      : { material: "", power_W: cfg.power_W ?? 150 };
    setDraft(p => ({ ...p, targets: [...p.targets, newTarget] }));
  };

  const materials = layer.targets.map(t => t.material).filter(Boolean);
  const sharedField = (k, label, unit) => (
    <div style={{ textAlign: "center" }}>
      <div style={{ fontSize: 10, color: T.textDim, fontFamily: "'DM Mono', monospace", marginBottom: 1 }}>{label}</div>
      <div style={{ fontSize: 12, color: T.textPrimary, fontFamily: "'DM Mono', monospace" }}>{layer[k] ?? "—"}<span style={{ fontSize: 10, color: T.textDim }}> {unit}</span></div>
    </div>
  );

  if (!editing) {
    return (
      <div draggable onDragStart={onDragStart} onDragOver={e => { e.preventDefault(); onDragOver(); }} onDrop={onDrop} onDragEnd={onDragEnd}
        style={{ background: T.bg3, border: `1px solid ${isDragOver ? T.amber : T.border}`, borderRadius: 7, padding: "10px 14px", display: "flex", alignItems: "center", gap: 10, cursor: "grab", transition: "border-color .12s", flexWrap: "wrap" }}>
        <span style={{ color: T.textDim, fontSize: 14, cursor: "grab", userSelect: "none", letterSpacing: "-1px" }}>⠿</span>
        <div style={{ display: "flex", gap: 5, flex: 1, flexWrap: "wrap", alignItems: "center" }}>
          {layer.targets.length && layer.targets.some(t => t.material) ? layer.targets.map((t, i) => {
            const s = getMaterialStyle(t.material || "?");
            const detail = technique === "pld"
              ? [t.energy_mJ != null ? `${t.energy_mJ} mJ` : null, t.pulses != null ? `${Number(t.pulses).toLocaleString()} pulses` : null].filter(Boolean).join(" · ")
              : t.power_W != null ? `${t.power_W} W` : null;
            return (
              <span key={i} style={{ display: "inline-flex", alignItems: "center", gap: 5, fontFamily: "'DM Mono', monospace", fontSize: 12, fontWeight: 700, color: s.border, background: s.bg, border: `1px solid ${s.border}`, borderRadius: 4, padding: "2px 8px" }}>
                <ChemName name={t.material || "?"} />
                {detail && <span style={{ fontWeight: 400, opacity: 0.7, fontSize: 11 }}>· {detail}</span>}
              </span>
            );
          }) : <span style={{ color: T.textDim, fontFamily: "'DM Mono', monospace", fontSize: 12 }}>no material</span>}
          {layer.role === "buffer" && (
            <span style={{ fontSize: 10, fontFamily: "'DM Mono', monospace", fontWeight: 600, color: T.teal, background: `${T.teal}22`, border: `1px solid ${T.teal}66`, borderRadius: 3, padding: "1px 5px", letterSpacing: 0.5 }}>BUF</span>
          )}
        </div>
        {layer.thickness_nm != null && (
          <div style={{ textAlign: "center" }}>
            <div style={{ fontSize: 10, color: T.textDim, fontFamily: "'DM Mono', monospace", marginBottom: 1 }}>Thick</div>
            <div style={{ fontSize: 12, color: T.textPrimary, fontFamily: "'DM Mono', monospace" }}>{layer.thickness_nm}<span style={{ fontSize: 10, color: T.textDim }}> nm</span></div>
          </div>
        )}
        {sharedField("temp", "Temp", "°C")}
        {sharedField("pressure", "Press", "mTorr")}
        {technique === "pld"
          ? <>{sharedField("frequency_hz", "Rep", "Hz")}</>
          : <>{sharedField("oxygen_pct", "O₂", "%")}{sharedField("time_s", "Time", "s")}</>}
        <button onClick={startEdit}   style={{ background: "none", border: "none", color: T.textDim, cursor: "pointer", fontSize: 13, padding: 0 }}>✎</button>
        <button onClick={onDuplicate} style={{ background: "none", border: "none", color: T.textDim, cursor: "pointer", fontSize: 15, padding: 0 }}>+</button>
        <button onClick={onRemove}    style={{ background: "none", border: "none", color: T.textDim, cursor: "pointer", fontSize: 18, padding: 0 }}>×</button>
      </div>
    );
  }

  const inputSm = { background: T.bg0, border: `1px solid ${T.borderBright}`, borderRadius: 4, color: T.textPrimary, padding: "4px 6px", fontFamily: "'DM Mono', monospace", fontSize: 12, outline: "none", boxSizing: "border-box", textAlign: "center" };

  return (
    <div onKeyDown={handleEditKeyDown} style={{ background: T.bg3, border: `1px solid ${T.borderBright}`, borderRadius: 7, padding: "12px 14px", display: "flex", flexDirection: "column", gap: 12 }}>
      {/* shared layer fields */}
      <div style={{ display: "flex", gap: 12, flexWrap: "wrap", alignItems: "flex-end" }}>
        <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
          <span style={{ fontSize: 9, color: T.textDim, fontFamily: "'DM Mono', monospace", textTransform: "uppercase" }}>Thickness</span>
          <div style={{ display: "flex", alignItems: "center", gap: 2 }}>
            <input type="number" value={draft.thickness_nm ?? ""} onChange={e => setDraftField("thickness_nm", e.target.value === "" ? null : Number(e.target.value))} placeholder="—" style={{ ...inputSm, width: 60 }} />
            <span style={{ fontSize: 10, color: T.textDim, fontFamily: "'DM Mono', monospace" }}>nm</span>
          </div>
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
          <span style={{ fontSize: 9, color: T.textDim, fontFamily: "'DM Mono', monospace", textTransform: "uppercase" }}>Temp</span>
          <div style={{ display: "flex", alignItems: "center", gap: 2 }}>
            <input value={draft.temp ?? ""} onChange={e => setDraftField("temp", e.target.value)} style={{ ...inputSm, width: 60 }} />
            <span style={{ fontSize: 10, color: T.textDim, fontFamily: "'DM Mono', monospace" }}>°C</span>
          </div>
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
          <span style={{ fontSize: 9, color: T.textDim, fontFamily: "'DM Mono', monospace", textTransform: "uppercase" }}>Pressure</span>
          <div style={{ display: "flex", alignItems: "center", gap: 2 }}>
            <input value={draft.pressure ?? ""} onChange={e => setDraftField("pressure", e.target.value)} style={{ ...inputSm, width: 60 }} />
            <span style={{ fontSize: 10, color: T.textDim, fontFamily: "'DM Mono', monospace" }}>mTorr</span>
          </div>
        </div>
        {technique === "sputter" && (
          <>
            <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
              <span style={{ fontSize: 9, color: T.textDim, fontFamily: "'DM Mono', monospace", textTransform: "uppercase" }}>O₂</span>
              <div style={{ display: "flex", alignItems: "center", gap: 2 }}>
                <input value={draft.oxygen_pct ?? ""} onChange={e => setDraftField("oxygen_pct", e.target.value)} style={{ ...inputSm, width: 50 }} />
                <span style={{ fontSize: 10, color: T.textDim, fontFamily: "'DM Mono', monospace" }}>%</span>
              </div>
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
              <span style={{ fontSize: 9, color: T.textDim, fontFamily: "'DM Mono', monospace", textTransform: "uppercase" }}>Time</span>
              <div style={{ display: "flex", alignItems: "center", gap: 2 }}>
                <input value={draft.time_s ?? ""} onChange={e => setDraftField("time_s", e.target.value)} style={{ ...inputSm, width: 60 }} />
                <span style={{ fontSize: 10, color: T.textDim, fontFamily: "'DM Mono', monospace" }}>s</span>
              </div>
            </div>
          </>
        )}
        {technique === "pld" && (
          <>
            <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
              <span style={{ fontSize: 9, color: T.textDim, fontFamily: "'DM Mono', monospace", textTransform: "uppercase" }}>Rep rate</span>
              <div style={{ display: "flex", alignItems: "center", gap: 2 }}>
                <input value={draft.frequency_hz ?? ""} onChange={e => setDraftField("frequency_hz", e.target.value)} style={{ ...inputSm, width: 56 }} />
                <span style={{ fontSize: 10, color: T.textDim, fontFamily: "'DM Mono', monospace" }}>Hz</span>
              </div>
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
              <span style={{ fontSize: 9, color: T.textDim, fontFamily: "'DM Mono', monospace", textTransform: "uppercase" }}>Focal pos.</span>
              <input value={draft.focal_position ?? ""} onChange={e => setDraftField("focal_position", e.target.value)} style={{ ...inputSm, width: 80 }} />
            </div>
          </>
        )}
      </div>
      {/* targets */}
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        <span style={{ fontSize: 10, color: T.textDim, fontFamily: "'DM Mono', monospace", textTransform: "uppercase", letterSpacing: 1 }}>Targets</span>
        {draft.targets.map((t, i) => (
          <TargetRow key={i} target={t} technique={technique} knownMaterials={knownMaterials} settings={settings}
            onChange={(t2, ld) => updateTarget(i, t2, ld)}
            onRemove={() => removeTarget(i)}
            canRemove={draft.targets.length > 1} />
        ))}
        <button onClick={addTarget} style={{ background: "none", border: `1px dashed ${T.border}`, borderRadius: 5, color: T.teal, fontFamily: "'DM Mono', monospace", fontSize: 11, padding: "4px 10px", cursor: "pointer", alignSelf: "flex-start" }}>+ co-dep target</button>
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
        <input type="checkbox" id={`buf-${draft.id}`} checked={draft.role === "buffer"} onChange={e => setDraftField("role", e.target.checked ? "buffer" : "")} style={{ accentColor: T.teal, cursor: "pointer" }} />
        <label htmlFor={`buf-${draft.id}`} style={{ fontSize: 11, color: T.textSecondary, fontFamily: "'DM Mono', monospace", cursor: "pointer", userSelect: "none" }}>Buffer layer</label>
      </div>
      <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
        <Btn variant="ghost" small onClick={cancelEdit}>Cancel</Btn>
        <Btn small onClick={saveEdit}>Save Layer</Btn>
      </div>
    </div>
  );
}

// ── Pulsed Measurement CSV parsers ────────────────────────────────────────────

// Parses a single CSV line respecting double-quoted fields (which may contain commas).
function splitCsvLine(line) {
  const out = []; let cur = ''; let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') { inQ = !inQ; }
    else if (ch === ',' && !inQ) { out.push(cur); cur = ''; }
    else { cur += ch; }
  }
  out.push(cur);
  return out;
}

function parse3PPCsv(text) {
  const lines = text.trim().split('\n');
  if (lines.length < 2) return null;
  const hdrs = splitCsvLine(lines[0]).map(h => h.trim());
  const gi = k => hdrs.indexOf(k);
  const [iWPA, iPs, iVoff] = [gi('writePA'), gi('Ps'), gi('voff')];
  if (iWPA < 0 || iPs < 0) return null;
  const rows = lines.slice(1)
    .map(l => { const c = splitCsvLine(l); return { wpa: parseFloat(c[iWPA]), ps: parseFloat(c[iPs]), voff: iVoff >= 0 ? parseFloat(c[iVoff]) : 0 }; })
    .filter(r => isFinite(r.wpa) && isFinite(r.ps))
    .sort((a, b) => a.wpa - b.wpa);
  if (!rows.length) return null;
  // Zero-correct: subtract Ps at the row closest to writePA = 0
  const zeroRow = rows.reduce((best, r) => Math.abs(r.wpa) < Math.abs(best.wpa) ? r : best, rows[0]);
  const psOffset = zeroRow.ps;
  return { wpas: rows.map(r => r.wpa), ps: rows.map(r => r.ps - psOffset), voff: rows[0].voff ?? 0 };
}

function parsePrCsv(text) {
  const lines = text.trim().split('\n');
  if (lines.length < 2) return null;
  const hdrs = splitCsvLine(lines[0]).map(h => h.trim());
  const gi = k => hdrs.indexOf(k);
  const [iWPD, iMW, iWPA, iTwin] = [gi('writePD'), gi('MW_pos_dPoff'), gi('writePA'), gi('twin')];
  if (iWPD < 0 || iMW < 0) return null;
  const rows = lines.slice(1)
    .map(l => { const c = splitCsvLine(l); return { wpd: parseFloat(c[iWPD]), mw: parseFloat(c[iMW]), wpa: iWPA >= 0 ? parseFloat(c[iWPA]) : null, twin: iTwin >= 0 ? c[iTwin]?.trim() : null }; })
    .filter(r => isFinite(r.wpd) && isFinite(r.mw))
    .sort((a, b) => a.wpd - b.wpd);
  if (!rows.length) return null;
  const wpa   = rows[0].wpa  != null && isFinite(rows[0].wpa)  ? Math.round(rows[0].wpa * 100) / 100 : null;
  const twin  = rows[0].twin || null;
  return { wpds: rows.map(r => r.wpd), mw: rows.map(r => r.mw), wpa, twin };
}

// ── PulsedAddModal ────────────────────────────────────────────────────────────

function PulsedAddModal({ onAdd, onClose }) {
  const mono = { fontFamily: "'DM Mono', monospace" };
  const opts = [
    { type: '3pp', label: '3PP Shmoo',    desc: 'ΔP vs write voltage — no offset + biased', color: T.teal },
    { type: 'pr',  label: 'Pr Retention', desc: 'Switched polarization vs delay time',       color: T.blue },
  ];
  return (
    <div onClick={e => { if (e.target === e.currentTarget) onClose(); }}
      style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }}>
      <div style={{ background: T.bg1, border: `1px solid ${T.border}`, borderRadius: 10, width: 340, overflow: 'hidden' }}>
        <div style={{ padding: '11px 16px', borderBottom: `1px solid ${T.border}`, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <span style={{ ...mono, fontSize: 13, color: T.textPrimary, fontWeight: 600 }}>Add Data</span>
          <button onClick={onClose} style={{ background: 'none', border: 'none', color: T.textDim, cursor: 'pointer', fontSize: 16, lineHeight: 1 }}>✕</button>
        </div>
        <div style={{ borderBottom: `1px solid ${T.border}` }}>
          <span style={{ display: 'inline-block', padding: '7px 16px', ...mono, fontSize: 11, color: T.teal, borderBottom: `2px solid ${T.teal}`, marginBottom: -1 }}>Pulsed Measurements</span>
        </div>
        <div style={{ padding: 14, display: 'flex', flexDirection: 'column', gap: 8 }}>
          {opts.map(o => (
            <button key={o.type} onClick={() => { onAdd(o.type); onClose(); }}
              style={{ background: T.bg2, border: `1px solid ${T.border}`, borderRadius: 8, padding: '11px 14px', cursor: 'pointer', textAlign: 'left', display: 'flex', flexDirection: 'column', gap: 3, transition: 'border-color .15s' }}
              onMouseEnter={e => e.currentTarget.style.borderColor = o.color}
              onMouseLeave={e => e.currentTarget.style.borderColor = T.border}>
              <span style={{ ...mono, fontSize: 12, color: o.color, fontWeight: 600 }}>{o.label}</span>
              <span style={{ ...mono, fontSize: 10, color: T.textDim }}>{o.desc}</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

// ── ThreePPCard ───────────────────────────────────────────────────────────────

function ThreePPCard({ data, onFileNo, onFileAt, onRemove }) {
  const mono = { fontFamily: "'DM Mono', monospace" };
  const hasNo  = !!(data?.no?.wpas?.length);
  const hasAt  = !!(data?.at?.wpas?.length);
  const hasAny = hasNo || hasAt;
  const refNo  = useRef();
  const refAt  = useRef();

  const plotTraces = [
    hasNo && { x: data.no.wpas, y: data.no.ps, name: 'No offset', line: { color: T.blue, width: 1.5 } },
    hasAt && { x: data.at.wpas, y: data.at.ps, name: `@ ${data.at.voff?.toFixed(2)} V`, line: { color: T.amber, width: 1.5 } },
  ].filter(Boolean).map(t => ({ ...t, type: 'scatter', mode: 'lines', showlegend: true, hovertemplate: '<extra></extra>' }));

  const miniLayout = {
    paper_bgcolor: 'transparent', plot_bgcolor: 'transparent',
    margin: { l: 42, r: 6, t: 6, b: 32 }, height: 150,
    xaxis: { title: { text: 'V_write (V)', font: { size: 10, color: T.textDim }, standoff: 4 }, tickfont: { size: 9, color: T.textDim }, gridcolor: T.border, zerolinecolor: T.border },
    yaxis: { title: { text: 'Ps (µC/cm²)', font: { size: 10, color: T.textDim }, standoff: 4 }, tickfont: { size: 9, color: T.textDim }, gridcolor: T.border, zerolinecolor: T.border },
    legend: { font: { size: 9, color: T.textDim }, bgcolor: 'transparent', x: 0, y: 1 },
  };

  const zones = [
    { label: 'No Offset', has: hasNo, ref: refNo, onFile: onFileNo },
    { label: '@ Offset',  has: hasAt, ref: refAt,  onFile: onFileAt },
  ];

  return (
    <div style={{ background: T.bg2, border: `1px solid ${T.border}`, borderRadius: 8, overflow: 'hidden' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '8px 12px', borderBottom: `1px solid ${T.border}` }}>
        <span style={{ ...mono, fontSize: 12, color: T.teal, fontWeight: 600 }}>3PP Shmoo</span>
        <button onClick={onRemove} style={{ background: 'none', border: 'none', color: T.textDim, cursor: 'pointer', fontSize: 13, lineHeight: 1 }}>✕</button>
      </div>
      <div style={{ padding: '10px 12px' }}>
        {hasAny && <Plot data={plotTraces} layout={miniLayout} config={{ displayModeBar: false }} style={{ width: '100%' }} useResizeHandler />}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginTop: hasAny ? 8 : 0 }}>
          {zones.map(({ label, has, ref, onFile }) => (
            <div key={label}>
              <div style={{ ...mono, fontSize: 10, color: T.textDim, marginBottom: 4 }}>{label}</div>
              <input ref={ref} type="file" accept=".csv" style={{ display: 'none' }} onChange={e => { if (e.target.files[0]) onFile(e.target.files[0]); e.target.value = ''; }} />
              <div
                onClick={() => ref.current.click()}
                onDragOver={e => e.preventDefault()}
                onDrop={e => { e.preventDefault(); if (e.dataTransfer.files[0]) onFile(e.dataTransfer.files[0]); }}
                style={{ border: `1px dashed ${T.borderBright}`, borderRadius: 6, padding: '7px 6px', cursor: 'pointer', textAlign: 'center', ...mono, fontSize: 10, color: T.textDim }}>
                {has ? '↑ replace' : 'drop / click'}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ── PrCard ────────────────────────────────────────────────────────────────────

const PR_CURVE_COLORS = [T.blue, T.amber, T.teal, T.red, '#a78bfa', '#f472b6'];

function PrCard({ data, onFile, onRemove }) {
  const mono = { fontFamily: "'DM Mono', monospace" };
  const curves = data?.curves || [];
  const fileRef = useRef();

  const curveLabel = (c, i) => c.wpa != null ? `${c.wpa} V` : `file ${i + 1}`;
  const plotTraces = curves.map((c, i) => ({
    x: c.wpds, y: c.mw,
    name: curveLabel(c, i),
    type: 'scatter', mode: 'lines+markers',
    line: { color: PR_CURVE_COLORS[i % PR_CURVE_COLORS.length], width: 1.5 },
    marker: { size: 3, color: PR_CURVE_COLORS[i % PR_CURVE_COLORS.length] },
    showlegend: true, hovertemplate: '<extra></extra>',
  }));

  const miniLayout = {
    paper_bgcolor: 'transparent', plot_bgcolor: 'transparent',
    margin: { l: 46, r: 6, t: 6, b: 32 }, height: 150,
    xaxis: { type: 'log', title: { text: 'Delay (s)', font: { size: 10, color: T.textDim }, standoff: 4 }, tickfont: { size: 9, color: T.textDim }, gridcolor: T.border },
    yaxis: { title: { text: '2Pr (µC/cm²)', font: { size: 10, color: T.textDim }, standoff: 4 }, tickfont: { size: 9, color: T.textDim }, gridcolor: T.border, zerolinecolor: T.border },
    legend: { font: { size: 9, color: T.textDim }, bgcolor: 'transparent', x: 0, y: 1 },
  };

  return (
    <div style={{ background: T.bg2, border: `1px solid ${T.border}`, borderRadius: 8, overflow: 'hidden' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '8px 12px', borderBottom: `1px solid ${T.border}` }}>
        <span style={{ ...mono, fontSize: 12, color: T.blue, fontWeight: 600 }}>Pr Retention</span>
        <button onClick={onRemove} style={{ background: 'none', border: 'none', color: T.textDim, cursor: 'pointer', fontSize: 13, lineHeight: 1 }}>✕</button>
      </div>
      <div style={{ padding: '10px 12px' }}>
        {curves.length > 0 && <Plot data={plotTraces} layout={miniLayout} config={{ displayModeBar: false }} style={{ width: '100%' }} useResizeHandler />}
        <input ref={fileRef} type="file" accept=".csv" multiple style={{ display: 'none' }}
          onChange={e => { [...e.target.files].forEach(onFile); e.target.value = ''; }} />
        <div
          onDragOver={e => e.preventDefault()}
          onDrop={e => { e.preventDefault(); [...e.dataTransfer.files].forEach(onFile); }}
          onClick={() => fileRef.current.click()}
          style={{ border: `1px dashed ${T.borderBright}`, borderRadius: 6, padding: '8px 14px', cursor: 'pointer', textAlign: 'center', ...mono, fontSize: 10, color: T.textDim, marginTop: curves.length > 0 ? 8 : 0 }}>
          {curves.length > 0 ? `↑ add more files  (${curves.length} loaded)` : 'drop one or more Pr .csv files'}
        </div>
        {curves.length > 0 && (
          <div style={{ marginTop: 6, display: 'flex', flexWrap: 'wrap', gap: 4 }}>
            {curves.map((c, i) => (
              <span key={i} style={{ ...mono, fontSize: 9, padding: '2px 6px', borderRadius: 4, background: PR_CURVE_COLORS[i % PR_CURVE_COLORS.length] + '22', color: PR_CURVE_COLORS[i % PR_CURVE_COLORS.length], border: `1px solid ${PR_CURVE_COLORS[i % PR_CURVE_COLORS.length]}44` }}>
                {curveLabel(c, i)} · {c.wpds.length} pts
              </span>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ── SampleDetail ──────────────────────────────────────────────────────────────

function SampleDetail({ sample, plotData, onUpdate, onUploadFile, onReparseFiles, onBack, onDelete, editingMeta, setEditingMeta, settings, onSaveSettings }) {
  const [addingLayer, setAddingLayer]   = useState(false);
  const [meta, setMeta]                 = useState({ date: sample.date, substrate: sample.substrate, notes: sample.notes, thickness_nm: sample.thickness_nm ?? "" });
  const [dragIdx, setDragIdx]           = useState(null);
  const [overIdx, setOverIdx]           = useState(null);
  const [knownMaterials, setKnownMaterials] = useState([]);
  const [xrdAnalysisOpen, setXrdAnalysisOpen] = useState(false);
  const [addPulsedOpen, setAddPulsedOpen]     = useState(false);
  const [pulsedData, setPulsedData]           = useState({});

  useEffect(() => {
    api("GET", "/materials").then(setKnownMaterials).catch(() => {});
  }, []);

  // Keep form values in sync with the sample prop (e.g. after an external update),
  // but only when the edit form is closed so we don't overwrite in-progress edits.
  useEffect(() => {
    if (!editingMeta) {
      setMeta({ date: sample.date, substrate: sample.substrate, notes: sample.notes, thickness_nm: sample.thickness_nm ?? "" });
    }
  }, [sample, editingMeta]);

  const addLayer       = l  => { onUpdate({ ...sample, layers: [...sample.layers, l] }); setAddingLayer(false); };
  const removeLayer    = id => onUpdate({ ...sample, layers: sample.layers.filter(l => l.id !== id) });
  const updateLayer    = l  => onUpdate({ ...sample, layers: sample.layers.map(x => x.id === l.id ? l : x) });
  const duplicateLayer = id => {
    const idx = sample.layers.findIndex(l => l.id === id);
    if (idx === -1) return;
    const copy = { ...JSON.parse(JSON.stringify(sample.layers[idx])), id: String(Date.now()) };
    const next = [...sample.layers];
    next.splice(idx + 1, 0, copy);
    onUpdate({ ...sample, layers: next });
  };
  const handleAreaChange = (area_m2, area_correction) => onUpdate({ ...sample, area_m2, area_correction });
  const saveMeta = () => { onUpdate({ ...sample, ...meta, thickness_nm: meta.thickness_nm === "" ? null : +meta.thickness_nm }); setEditingMeta(false); };

  const handleDrop = (toIdx) => {
    if (dragIdx === null || dragIdx === toIdx) return;
    const reordered = [...sample.layers];
    const [moved] = reordered.splice(dragIdx, 1);
    reordered.splice(toIdx, 0, moved);
    onUpdate({ ...sample, layers: reordered });
    setDragIdx(null); setOverIdx(null);
  };

  const handleFile = (measType, file) => {
    if (measType === "afm") { onUploadFile("afm", file, null, null); return; }
    const reader = new FileReader();
    reader.onload = e => {
      const text = e.target.result;
      const thick = sample.thickness_nm || 0;
      const parsed = csvToPlotData(text, measType, thick);
      if (!parsed || !hasPlotData(parsed)) return;
      const area = measType === "pe" ? findAreaFromFile(text) : null;
      onUploadFile(measType, file, parsed, area);
    };
    reader.readAsText(file);
  };

  const pulsedItems = sample.pulsed_items || [];

  const addPulsedItem = type => {
    const id = Math.random().toString(36).slice(2, 9);
    onUpdate({ ...sample, pulsed_items: [...pulsedItems, { type, id }] });
  };

  const removePulsedItem = id => {
    onUpdate({ ...sample, pulsed_items: pulsedItems.filter(i => i.id !== id) });
    setPulsedData(p => { const c = { ...p }; delete c[id]; return c; });
  };

  const handlePulsedFile3PP = (itemId, slot, file) => {
    const reader = new FileReader();
    reader.onload = e => {
      const parsed = parse3PPCsv(e.target.result);
      if (!parsed) return;
      setPulsedData(p => ({ ...p, [itemId]: { ...(p[itemId] || { type: '3pp' }), [slot]: parsed } }));
    };
    reader.readAsText(file);
  };

  const handlePulsedFilePr = (itemId, file) => {
    const reader = new FileReader();
    reader.onload = e => {
      const parsed = parsePrCsv(e.target.result);
      if (!parsed) return;
      setPulsedData(p => {
        const prev = p[itemId] || { type: 'pr', curves: [] };
        const curves = [...(prev.curves || [])];
        // Deduplicate by write voltage — replacing if same wpa dropped again
        const existingIdx = parsed.wpa != null ? curves.findIndex(c => c.wpa === parsed.wpa) : -1;
        if (existingIdx >= 0) curves[existingIdx] = parsed; else curves.push(parsed);
        return { ...p, [itemId]: { ...prev, curves } };
      });
    };
    reader.readAsText(file);
  };

  const pd = plotData || {};
  const hasFiles = Object.keys(sample.filenames || {}).length > 0;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 22 }}>
      {editingMeta ? (
        <div style={{ background: T.bg2, border: `1px solid ${T.border}`, borderRadius: 8, padding: 14, display: "grid", gridTemplateColumns: "1fr 1fr 1fr 2fr", gap: 12 }}>
          <Input label="Date"              value={meta.date}         onChange={v => setMeta(p => ({ ...p, date: v }))} />
          <Input label="Substrate"         value={meta.substrate}    onChange={v => setMeta(p => ({ ...p, substrate: v }))} />
          <Input label="Thickness (nm)" value={meta.thickness_nm} onChange={v => setMeta(p => ({ ...p, thickness_nm: v === "" ? "" : v }))} type="number" placeholder="e.g. 30" />
          <Input label="Notes"             value={meta.notes}        onChange={v => setMeta(p => ({ ...p, notes: v }))} />
          <div style={{ gridColumn: "1/-1", display: "flex", justifyContent: "flex-end" }}><Btn small onClick={saveMeta}>Save</Btn></div>
        </div>
      ) : (
        <div style={{ display: "flex", gap: 24, flexWrap: "wrap" }}>
          {[["Date", sample.date], ["Substrate", sample.substrate || "—"], ["Thickness", sample.thickness_nm ? `${sample.thickness_nm} nm` : "—"], ["Notes", sample.notes || "—"]].map(([k, v]) => (
            <span key={k} style={{ fontFamily: "'DM Mono', monospace", fontSize: 13 }}>
              <span style={{ color: T.textDim }}>{k}: </span><span style={{ color: T.textPrimary }}>{v}</span>
            </span>
          ))}
        </div>
      )}

      <section>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}>
          <span style={{ fontFamily: "'DM Mono', monospace", fontSize: 12, color: T.textSecondary, textTransform: "uppercase", letterSpacing: 2 }}>Deposition Layers</span>
          <Btn variant="teal" small onClick={() => setAddingLayer(true)}>+ Add Layer</Btn>
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {sample.layers.map((l, i) => (
            <LayerEditor key={l.id} layer={l} technique={sample.technique || "sputter"} knownMaterials={knownMaterials} settings={settings}
              onRemove={() => removeLayer(l.id)} onDuplicate={() => duplicateLayer(l.id)} onUpdate={updateLayer}
              isDragOver={overIdx === i && dragIdx !== i}
              onDragStart={() => setDragIdx(i)} onDragOver={() => setOverIdx(i)}
              onDrop={() => handleDrop(i)} onDragEnd={() => { setDragIdx(null); setOverIdx(null); }} />
          ))}
          {!sample.layers.length && <div style={{ color: T.textDim, fontFamily: "'DM Mono', monospace", fontSize: 12, padding: "10px 0" }}>No layers — add one above.</div>}
        </div>
        {addingLayer && (
          <AddLayerModal
            technique={sample.technique || "sputter"}
            knownMaterials={knownMaterials}
            settings={settings}
            onAdd={addLayer}
            onClose={() => setAddingLayer(false)} />
        )}
      </section>

      <section>
        <div style={{ fontFamily: "'DM Mono', monospace", fontSize: 12, color: T.textSecondary, textTransform: "uppercase", letterSpacing: 2, marginBottom: 10 }}>X-Ray Characterization</div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, 340px)", justifyContent: "center", gap: 12 }}>
          {["xrd_ot", "xrr", "rsm"].map(t => (
            <MeasCard key={t} type={t} plotData={pd[t]} filename={sample.filenames?.[t]}
              onFile={(measType, file) => handleFile(measType, file)}
              onAnalyze={t === "xrd_ot" ? () => setXrdAnalysisOpen(true) : undefined} />
          ))}
          {xrdAnalysisOpen && (
            <XRDAnalysisModal
              sample={sample}
              xrdData={pd?.xrd_ot || []}
              structures={settings?.structures || []}
              xrdConfigs={settings?.xrd_configs || []}
              onSaveXrdConfigs={configs => onSaveSettings?.({ ...settings, xrd_configs: configs })}
              onSave={peaks => onUpdate({ ...sample, xrd_peaks: peaks })}
              onClose={() => setXrdAnalysisOpen(false)} />
          )}
        </div>
      </section>

      <section>
        <div style={{ fontFamily: "'DM Mono', monospace", fontSize: 12, color: T.textSecondary, textTransform: "uppercase", letterSpacing: 2, marginBottom: 10 }}>Scanning Probe</div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, 340px)", justifyContent: "center", gap: 12 }}>
          <AfmCard afmData={pd.afm} filename={sample.filenames?.afm} onFile={file => handleFile("afm", file)} />
        </div>
      </section>

      <section>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}>
          <span style={{ fontFamily: "'DM Mono', monospace", fontSize: 12, color: T.textSecondary, textTransform: "uppercase", letterSpacing: 2 }}>Electrical Characterization</span>
          <Btn variant="teal" small onClick={() => setAddPulsedOpen(true)}>+ Add Data</Btn>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, 340px)", justifyContent: "center", gap: 12 }}>
          {["pe", "diel_b", "diel_f"].map(t => (
            <MeasCard key={t} type={t}
              plotData={t === "diel_b" ? { up: pd.diel_b_up || [], down: pd.diel_b_down || [] } : pd[t]}
              filename={sample.filenames?.[t]}
              filenames={sample.filenames}
              onFile={(measType, file) => handleFile(measType, file)}
              thicknessNm={sample.thickness_nm || 0}
              areaM2={sample.area_m2 ?? null}
              areaCorrFactor={sample.area_correction ?? 1.0}
              onAreaChange={handleAreaChange} />
          ))}
          {pulsedItems.map(item => {
            const d = pulsedData[item.id] || {};
            if (item.type === '3pp') return (
              <ThreePPCard key={item.id}
                data={{ no: d.no, at: d.at }}
                onFileNo={file => handlePulsedFile3PP(item.id, 'no', file)}
                onFileAt={file => handlePulsedFile3PP(item.id, 'at', file)}
                onRemove={() => removePulsedItem(item.id)} />
            );
            if (item.type === 'pr') return (
              <PrCard key={item.id}
                data={{ curves: d.curves || [] }}
                onFile={file => handlePulsedFilePr(item.id, file)}
                onRemove={() => removePulsedItem(item.id)} />
            );
            return null;
          })}
        </div>
        {addPulsedOpen && <PulsedAddModal onAdd={addPulsedItem} onClose={() => setAddPulsedOpen(false)} />}
      </section>
    </div>
  );
}

// ── AddLayerModal ─────────────────────────────────────────────────────────────

function AddLayerModal({ technique, knownMaterials, settings, onAdd, onClose }) {
  const [draft, setDraft] = useState(() => newLayer(technique, settings));
  const setDraftField = (k, v) => setDraft(p => ({ ...p, [k]: v }));
  const updateTarget  = (i, t, layerDefaults) => setDraft(p => { const ts = [...p.targets]; ts[i] = t; const patch = { ...p, targets: ts }; if (i === 0 && layerDefaults) Object.assign(patch, layerDefaults); return patch; });
  const removeTarget  = (i)    => setDraft(p => ({ ...p, targets: p.targets.filter((_, j) => j !== i) }));
  const addTarget = () => {
    const cfg = settings?.[technique] || {};
    const t = technique === "pld"
      ? { material: "", energy_mJ: cfg.energy_mJ ?? 60, pulses: cfg.pulses ?? 10000 }
      : { material: "", power_W: cfg.power_W ?? 150 };
    setDraft(p => ({ ...p, targets: [...p.targets, t] }));
  };

  const inputSm = { background: T.bg0, border: `1px solid ${T.borderBright}`, borderRadius: 4, color: T.textPrimary, padding: "4px 6px", fontFamily: "'DM Mono', monospace", fontSize: 12, outline: "none", boxSizing: "border-box", textAlign: "center" };
  const field = (k, label, unit, w) => (
    <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
      <span style={{ fontSize: 9, color: T.textDim, fontFamily: "'DM Mono', monospace", textTransform: "uppercase" }}>{label}</span>
      <div style={{ display: "flex", alignItems: "center", gap: 2 }}>
        <input value={draft[k] ?? ""} onChange={e => setDraftField(k, e.target.value)} style={{ ...inputSm, width: w }} />
        {unit && <span style={{ fontSize: 10, color: T.textDim, fontFamily: "'DM Mono', monospace" }}>{unit}</span>}
      </div>
    </div>
  );

  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.75)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 100 }}>
      <div style={{ background: T.bg1, border: `1px solid ${T.borderBright}`, borderRadius: 12, padding: 28, width: 500, display: "flex", flexDirection: "column", gap: 16 }}>
        <h2 style={{ margin: 0, fontFamily: "'Playfair Display', serif", color: T.amber, fontSize: 22 }}>New Layer</h2>

        <div style={{ display: "flex", gap: 12, flexWrap: "wrap", alignItems: "flex-end" }}>
          {field("temp",     "Temp",     "°C",    60)}
          {field("pressure", "Pressure", "mTorr", 60)}
          {technique === "sputter" && <>
            {field("oxygen_pct", "O₂",  "%", 50)}
            {field("time_s",     "Time", "s", 60)}
          </>}
          {technique === "pld" && <>
            {field("frequency_hz",   "Rep rate",  "Hz", 56)}
            {field("focal_position", "Focal pos.", "",   80)}
          </>}
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <span style={{ fontSize: 10, color: T.textDim, fontFamily: "'DM Mono', monospace", textTransform: "uppercase", letterSpacing: 1 }}>Targets</span>
          {draft.targets.map((t, i) => (
            <TargetRow key={i} target={t} technique={technique} knownMaterials={knownMaterials} settings={settings}
              onChange={(t2, ld) => updateTarget(i, t2, ld)}
              onRemove={() => removeTarget(i)}
              canRemove={draft.targets.length > 1} />
          ))}
          <button onClick={addTarget} style={{ background: "none", border: `1px dashed ${T.border}`, borderRadius: 5, color: T.teal, fontFamily: "'DM Mono', monospace", fontSize: 11, padding: "4px 10px", cursor: "pointer", alignSelf: "flex-start" }}>+ co-dep target</button>
        </div>

        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
          <Btn variant="ghost" onClick={onClose}>Cancel</Btn>
          <Btn onClick={() => onAdd(draft)}>Add Layer</Btn>
        </div>
      </div>
    </div>
  );
}

// ── AddSampleModal ────────────────────────────────────────────────────────────

function AddSampleModal({ onAdd, onClose, folders, template, settings }) {
  const [f, setF] = useState(() => template ? {
    id: "", date: template.date ?? new Date().toISOString().slice(0, 10),
    substrate: template.substrate ?? "", notes: template.notes ?? "",
    thickness_nm: template.thickness_nm ?? "",
    lot: template.lot ?? settings?.defaultLot ?? "",
    bin: template.bin ?? "",
    technique: template.technique ?? "sputter",
    folder_id: template.folder_id ?? "",
  } : {
    id: "", date: new Date().toISOString().slice(0, 10),
    substrate: settings?.defaultSubstrate ?? "STO (001)", notes: "", thickness_nm: "",
    lot: settings?.defaultLot ?? "",
    bin: "",
    technique: "sputter", folder_id: "",
  });
  const set = k => v => setF(p => ({ ...p, [k]: v }));

  const techniqueBtn = (v, label) => (
    <button onClick={() => set("technique")(v)}
      style={{ flex: 1, padding: "8px 0", fontFamily: "'DM Mono', monospace", fontSize: 12, fontWeight: 600, cursor: "pointer", borderRadius: 5, border: `1px solid ${f.technique === v ? T.amber : T.border}`, background: f.technique === v ? T.amberGlow : "transparent", color: f.technique === v ? T.amber : T.textSecondary, transition: "all .15s" }}>
      {label}
    </button>
  );

  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.75)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 100 }}>
      <div style={{ background: T.bg1, border: `1px solid ${T.borderBright}`, borderRadius: 12, padding: 28, width: 500, display: "flex", flexDirection: "column", gap: 16 }}>
        <div>
          <h2 style={{ margin: 0, fontFamily: "'Playfair Display', serif", color: T.amber, fontSize: 22 }}>{template ? "Duplicate Template" : "New Sample"}</h2>
          {template && <div style={{ marginTop: 4, fontFamily: "'DM Mono', monospace", fontSize: 11, color: T.textDim }}>From {template.id} — layers copied, data not included</div>}
        </div>

        <div style={{ display: "flex", gap: 6 }}>
          {techniqueBtn("sputter", "Sputter")}
          {techniqueBtn("pld",     "PLD")}
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 12 }}>
          <Input label="New Sample ID"  value={f.id}           onChange={set("id")}           placeholder="e.g. SP026" />
          <Input label="Date"           value={f.date}         onChange={set("date")}         type="date" />
          <Input label="Thickness (nm)" value={f.thickness_nm} onChange={v => setF(p => ({ ...p, thickness_nm: v === "" ? "" : v }))} type="number" placeholder="e.g. 30" />
        </div>
        <Input label="Substrate"  value={f.substrate} onChange={set("substrate")} placeholder="e.g. STO (001)" />
        <div style={{ display: "grid", gridTemplateColumns: "2fr 1fr", gap: 12 }}>
          <Input label="Lot"  value={f.lot} onChange={set("lot")} placeholder="e.g. W2024-01" />
          <Input label="Bin"  value={f.bin} onChange={set("bin")} placeholder="e.g. A3" />
        </div>
        <Input label="Notes"      value={f.notes}     onChange={set("notes")}     placeholder="Brief description…" />
        {folders && folders.length > 0 && (
          <Sel label="Folder (optional)" value={f.folder_id} onChange={set("folder_id")}
            options={[{ value: "", label: "— Ungrouped —" }, ...folders.map(fo => ({ value: fo.id, label: fo.name }))]} />
        )}
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
          <Btn variant="ghost" onClick={onClose}>Cancel</Btn>
          <Btn onClick={() => {
            if (!f.id.trim()) return;
            const layers = template ? JSON.parse(JSON.stringify(template.layers || [])).map(l => ({ ...l, id: crypto.randomUUID ? crypto.randomUUID() : String(Date.now() + Math.random()) })) : [];
            onAdd({ ...f, thickness_nm: f.thickness_nm === "" ? null : +f.thickness_nm, folder_id: f.folder_id || null, lot: f.lot || null, bin: f.bin || null, layers, filenames: {}, area_m2: null, area_correction: 1.0 });
          }} disabled={!f.id.trim()}>Create</Btn>
        </div>
      </div>
    </div>
  );
}

// ── XRD Peak Fitting ──────────────────────────────────────────────────────────

// Nelder-Mead simplex minimiser (no derivatives needed)
function nelderMead(fn, x0, { maxIter = 3000, tol = 1e-12 } = {}) {
  const n = x0.length;
  const α = 1, γ = 2, ρ = 0.5, σ = 0.5;
  let S = [x0.slice()];
  for (let i = 0; i < n; i++) {
    const v = x0.slice();
    v[i] += Math.abs(v[i]) > 1e-6 ? Math.abs(v[i]) * 0.15 : 0.15;
    S.push(v);
  }
  let fS = S.map(fn);
  for (let iter = 0; iter < maxIter; iter++) {
    const ord = [...Array(n + 1).keys()].sort((a, b) => fS[a] - fS[b]);
    S = ord.map(i => S[i]); fS = ord.map(i => fS[i]);
    if (fS[n] - fS[0] < tol) break;
    const c = Array(n).fill(0);
    for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) c[j] += S[i][j] / n;
    const xr = c.map((ci, j) => ci + α * (ci - S[n][j]));
    const fr = fn(xr);
    if (fr < fS[0]) {
      const xe = c.map((ci, j) => ci + γ * (xr[j] - ci));
      const fe = fn(xe);
      if (fe < fr) { S[n] = xe; fS[n] = fe; } else { S[n] = xr; fS[n] = fr; }
    } else if (fr < fS[n - 1]) {
      S[n] = xr; fS[n] = fr;
    } else {
      const xc = c.map((ci, j) => ci + ρ * (S[n][j] - ci));
      const fc = fn(xc);
      if (fc < fS[n]) { S[n] = xc; fS[n] = fc; }
      else { for (let i = 1; i <= n; i++) { S[i] = S[0].map((s, j) => s + σ * (S[i][j] - s)); fS[i] = fn(S[i]); } }
    }
  }
  return S[0];
}

// Thompson–Cox–Hastings pseudo-Voigt (J. Appl. Cryst. 1987).
// Takes SEPARATE Gaussian (fG) and Lorentzian (fL) FWHMs; total FWHM f and
// mixing ratio η are derived analytically — NOT fit as free parameters.
// Accurate to ~1% vs the true Voigt convolution integral.
//
//  f  = [fG⁵ + 2.69269 fG⁴fL + 2.42843 fG³fL² + 4.47163 fG²fL³
//             + 0.07842 fG fL⁴ + fL⁵]^(1/5)
//  η  = 1.36603(fL/f) − 0.47719(fL/f)² + 0.11116(fL/f)³
function pseudoVoigt(x, x0, fG, fL) {
  const f5 = fG**5 + 2.69269*fG**4*fL + 2.42843*fG**3*fL**2
           + 4.47163*fG**2*fL**3 + 0.07842*fG*fL**4 + fL**5;
  const f  = Math.pow(Math.max(f5, 1e-30), 0.2);
  const r  = fL / f;
  const eta = 1.36603*r - 0.47719*r*r + 0.11116*r*r*r;
  const dx = x - x0, f2 = f * f;
  const G = Math.exp(-4 * Math.LN2 * dx * dx / f2);
  const L = 1 / (1 + 4 * dx * dx / f2);
  return eta * L + (1 - eta) * G;
}

// Helper: derive total FWHM and η from TCH fG, fL
function tchParams(fG, fL) {
  const f5 = fG**5 + 2.69269*fG**4*fL + 2.42843*fG**3*fL**2
           + 4.47163*fG**2*fL**3 + 0.07842*fG*fL**4 + fL**5;
  const f = Math.pow(Math.max(f5, 1e-30), 0.2);
  const r = fL / f;
  return { f, eta: 1.36603*r - 0.47719*r*r + 0.11116*r*r*r };
}

// Evaluate a Chebyshev polynomial series at x ∈ [-1, 1].
// coeffs = [B_0, B_1, ..., B_{N-1}]; recurrence: t_0=1, t_1=x, t_{n+1}=2x·t_n − t_{n-1}
// Standard background model in FullProf, GSAS, Topas, BGMN.
function evalChebyshev(x, coeffs) {
  if (!coeffs.length) return 0;
  let t0 = 1, t1 = x, y = coeffs[0];
  if (coeffs.length > 1) y += coeffs[1] * x;
  for (let m = 2; m < coeffs.length; m++) {
    const t2 = 2 * x * t1 - t0;
    y += coeffs[m] * t2;
    t0 = t1; t1 = t2;
  }
  return y;
}

// Return the n Chebyshev basis values [T_0(x), T_1(x), ..., T_{n-1}(x)] at x ∈ [-1, 1].
function chebyshevBasis(x, n) {
  const t = new Array(n);
  if (n === 0) return t;
  t[0] = 1;
  if (n > 1) t[1] = x;
  for (let m = 2; m < n; m++) t[m] = 2 * x * t[m - 1] - t[m - 2];
  return t;
}

// Solve Ax = b (n×n) via Gaussian elimination with partial pivoting.
function solveLinear(A, b) {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let col = 0; col < n; col++) {
    let maxRow = col;
    for (let row = col + 1; row < n; row++)
      if (Math.abs(M[row][col]) > Math.abs(M[maxRow][col])) maxRow = row;
    [M[col], M[maxRow]] = [M[maxRow], M[col]];
    if (Math.abs(M[col][col]) < 1e-14) continue;
    for (let row = col + 1; row < n; row++) {
      const f = M[row][col] / M[col][col];
      for (let k = col; k <= n; k++) M[row][k] -= f * M[col][k];
    }
  }
  const x = new Array(n).fill(0);
  for (let i = n - 1; i >= 0; i--) {
    if (Math.abs(M[i][i]) < 1e-14) continue;
    x[i] = M[i][n];
    for (let j = i + 1; j < n; j++) x[i] -= M[i][j] * x[j];
    x[i] /= M[i][i];
  }
  return x;
}

// Fit a smooth Chebyshev polynomial background to the full XRD spectrum.
//
// Fitting is done in LOG-intensity space:
//   log(y) = Σ B_m T_m(x)   →   y_bg = exp(polynomial) — always positive.
// Log-space means a 10 000-count substrate peak is only ~2× noisier than a
// 100-count background point (vs 100× in linear), drastically reducing bias.
//
// Robustness via iterative upward sigma-clipping:
//   After each fit, residuals = log(data) − log(bg) are computed.
//   Negative residuals are pure noise → their RMS estimates the noise level σ.
//   Points more than 2.5σ above the fit are peak tails → excluded, re-fit.
//   5 iterations are enough for even broad peak tails to be fully rejected.
//
// peaks:    optional [{center, width}] — ±1.5×width hard-excluded first
// nBgTerms: Chebyshev terms (4–12; more terms = more flexible background shape)
// Returns { x, y, coeffs, xMin, xMax } or null
function fitBackground(xrdData, peaks = [], nBgTerms = 6) {
  const allPts = [...xrdData].sort((a, b) => a.x - b.x);
  if (allPts.length < nBgTerms + 1) return null;
  const xMin = allPts[0].x, xMax = allPts[allPts.length - 1].x;
  if (xMax === xMin) return null;
  const toCheb = x => 2 * (x - xMin) / (xMax - xMin) - 1;

  // Hard exclusion: ±1.5× tolerance around each peak centre (skip if width = 0)
  let bgPts = peaks.some(pk => pk.width > 0)
    ? allPts.filter(p => peaks.every(pk => pk.width <= 0 || Math.abs(p.x - pk.center) > pk.width * 1.5))
    : allPts;
  if (bgPts.length < nBgTerms) bgPts = allPts; // fallback

  // Solve normal equations X^T X β = X^T log(y) for a given point set
  const solveCoeffs = pts => {
    const XtX = Array.from({ length: nBgTerms }, () => new Array(nBgTerms).fill(0));
    const Xty = new Array(nBgTerms).fill(0);
    for (const pt of pts) {
      const basis = chebyshevBasis(toCheb(pt.x), nBgTerms);
      const logY  = Math.log(Math.max(pt.y, 1));
      for (let m = 0; m < nBgTerms; m++) {
        Xty[m] += basis[m] * logY;
        for (let k = 0; k < nBgTerms; k++) XtX[m][k] += basis[m] * basis[k];
      }
    }
    return solveLinear(XtX, Xty);
  };

  // Iterative upward sigma-clipping (up to 5 passes)
  let coeffs = solveCoeffs(bgPts);
  for (let iter = 0; iter < 5; iter++) {
    const residuals = bgPts.map(pt =>
      Math.log(Math.max(pt.y, 1)) - evalChebyshev(toCheb(pt.x), coeffs)
    );
    // Noise estimate from one-sided negative residuals (data below fit = noise only)
    const negRes = residuals.filter(r => r < 0);
    const sigma  = negRes.length > 3
      ? Math.sqrt(negRes.reduce((s, r) => s + r * r, 0) / negRes.length)
      : 0.5;
    const clipped = bgPts.filter((_, j) => residuals[j] < 2.5 * sigma);
    if (clipped.length < nBgTerms || clipped.length === bgPts.length) break;
    bgPts  = clipped;
    coeffs = solveCoeffs(bgPts);
  }

  const evalBg = x => Math.exp(evalChebyshev(toCheb(x), coeffs));
  const nFine  = 1000;
  const xs = Array.from({ length: nFine }, (_, k) => xMin + k * (xMax - xMin) / (nFine - 1));
  return { x: xs, y: xs.map(x => evalBg(x)), coeffs, xMin, xMax };
}

// Laue fringe (kinematical thin-film) fitting for a single peak.
//
// Model: I(θ) = A × sinc²(π t Δsinθ / λ) convolved with a narrow Gaussian (instrument broadening)
// where sinc²(x) = sin²(x)/x² and Δsinθ = sin(θ) - sin(θ_B).
//
// Parameters optimised: amplitude, Bragg center (constrained ±tol), film thickness t, instrument sigma.
// Seed thickness from layer.fringe_thickness_nm if provided, otherwise falls back to Voigt fit.
//
// Returns same shape as fitPeaksVoigt.results[id]: { center, dSpacing, dRef, strain, amplitude,
//   fwhm, thickness_nm, fwhmG (instrument), fwhmL: 0, eta: 0 }
function fitLaueFreeze(xrdData, peak, fitWindow, bgResult, thicknessNm, locked = false) {
  const LAMBDA = 0.15406; // nm  Cu Kα
  const allPts = [...xrdData].sort((a, b) => a.x - b.x);
  if (!allPts.length) return null;
  const bg = bgResult || fitBackground(xrdData, [peak]);
  if (!bg) return null;
  const bgToCheb = x => 2 * (x - bg.xMin) / (bg.xMax - bg.xMin) - 1;
  const evalBg   = x => Math.exp(evalChebyshev(bgToCheb(x), bg.coeffs));

  const tSeed  = (thicknessNm && thicknessNm > 0) ? thicknessNm : 20;
  // Estimate fringe period from seed thickness so the fit window covers ≥8 oscillations
  const cenRad     = peak.center * Math.PI / 360;
  const seedPeriod = LAMBDA / (tSeed * Math.cos(cenRad)) * (180 / Math.PI);
  const autoHalf   = Math.max(peak.width, seedPeriod * 8);

  const pts = fitWindow
    ? allPts.filter(p => p.x >= fitWindow[0] && p.x <= fitWindow[1])
    : allPts.filter(p => Math.abs(p.x - peak.center) <= autoHalf);
  if (pts.length < 4) return null;

  const xs = pts.map(p => p.x);
  const ys = pts.map(p => Math.max(p.y, 0));
  const bgAtPts = xs.map(x => Math.max(evalBg(x), 0));

  // sinc² Laue model × Gaussian envelope for finite-crystal / instrument damping.
  // sigInstr ≫ fringe_period → pure sinc² (undamped fringes).
  const laueProfile = (twoTheta, cen, t, sigInstr) => {
    const theta    = twoTheta * Math.PI / 360;
    const thetaCen = cen      * Math.PI / 360;
    const dSin     = Math.sin(theta) - Math.sin(thetaCen);
    const arg      = Math.PI * t * dSin / LAMBDA;
    const sinc2    = Math.abs(arg) < 1e-9 ? 1 : Math.pow(Math.sin(arg) / arg, 2);
    const gEnv     = sigInstr > 0 ? Math.exp(-0.5 * Math.pow((twoTheta - cen) / sigInstr, 2)) : 1;
    return sinc2 * gEnv;
  };

  const tol        = peak.width;   // center constrained ±tol via tanh
  const initLogAmp = Math.log(Math.max(...ys) - Math.min(...bgAtPts) || 10);

  let amp, cen, t, sig;
  if (locked && thicknessNm > 0) {
    // Locked: fit [logAmp, rawCen, logSig] — thickness fixed, envelope free
    // Start sigInstr = 3° (broad → nearly no damping); optimizer can narrow it
    t = thicknessNm;
    const pFit = nelderMead(params => {
      const a = Math.exp(params[0]), c = peak.center + tol * Math.tanh(params[1]);
      const _s = Math.exp(params[2]);
      let s = 0;
      for (let i = 0; i < xs.length; i++) {
        const m = Math.max(bgAtPts[i] + a * laueProfile(xs[i], c, t, _s), 1e-10);
        s += m - ys[i] * Math.log(m);
      }
      return s;
    }, [initLogAmp, 0, Math.log(3.0)], { maxIter: 6000, tol: 1e-9 });
    amp = Math.exp(pFit[0]); cen = peak.center + tol * Math.tanh(pFit[1]);
    sig = Math.exp(pFit[2]);
  } else {
    // Free fit: [logAmp, rawCen, logT, logSig]
    // Start sigInstr = 3° so the initial model shows real fringes, not a Gaussian blob
    const pFit = nelderMead(params => {
      const a = Math.exp(params[0]), c = peak.center + tol * Math.tanh(params[1]);
      const _t = Math.exp(params[2]), _s = Math.exp(params[3]);
      let s = 0;
      for (let i = 0; i < xs.length; i++) {
        const m = Math.max(bgAtPts[i] + a * laueProfile(xs[i], c, _t, _s), 1e-10);
        s += m - ys[i] * Math.log(m);
      }
      return s;
    }, [initLogAmp, 0, Math.log(tSeed), Math.log(3.0)], { maxIter: 8000, tol: 1e-10 });
    amp = Math.exp(pFit[0]); cen = peak.center + tol * Math.tanh(pFit[1]);
    t   = Math.exp(pFit[2]); sig = Math.exp(pFit[3]);
  }
  const fwhmG = 2 * Math.sqrt(2 * Math.log(2)) * sig;

  const theta   = cen * Math.PI / 360;
  const dSpacing = LAMBDA / (2 * Math.sin(theta));
  const dRef     = LAMBDA / (2 * Math.sin(peak.center * Math.PI / 360));
  return {
    amplitude: amp, center: cen, fwhmG, fwhmL: 0, fwhm: fwhmG, eta: 0,
    dSpacing, dRef, strain: (dSpacing - dRef) / dRef, thickness_nm: t,
  };
}

// Two-stage pseudo-Voigt peak fitting.
//
// Stage 1 — Background:
//   If a bgResult (from fitBackground / "Fit BG" button) is provided, use it
//   directly. Otherwise run fitBackground internally (log-space Chebyshev).
//
// Stage 2 — Peaks (Nelder-Mead, Poisson NLL):
//   Background fixed from Stage 1. Only peak parameters optimised inside the
//   fit window — smaller search space → faster, more reliable convergence.
//
// peaks:     [{ id, center, width }]
// fitWindow: [x0, x1] | null
// bgResult:  return value of fitBackground | null
// quick:     true → pure-Gaussian fit (3 params/peak, 3 000 iters) for fast preview
//            false → full TCH pseudo-Voigt (4 params/peak, 15 000 iters)
function fitPeaksVoigt(xrdData, peaks, fitWindow, bgResult = null, quick = false) {
  const LAMBDA = 0.15406; // nm  Cu Kα

  const allPts = [...xrdData].sort((a, b) => a.x - b.x);
  if (!allPts.length) return null;

  // ── Stage 1: background ───────────────────────────────────────────────────
  const bg = bgResult || fitBackground(xrdData, peaks);
  if (!bg) return null;
  const bgToCheb = x => 2 * (x - bg.xMin) / (bg.xMax - bg.xMin) - 1;
  const evalBg   = x => Math.exp(evalChebyshev(bgToCheb(x), bg.coeffs));

  // ── Stage 2: peak optimisation (background fixed) ─────────────────────────
  const pts = (fitWindow
    ? allPts.filter(p => p.x >= fitWindow[0] && p.x <= fitWindow[1])
    : allPts.filter(p => peaks.some(pk => p.x >= pk.center - pk.width && p.x <= pk.center + pk.width))
  );
  if (pts.length < peaks.length * 3 + 1) return null;

  const xs      = pts.map(p => p.x);
  const ys      = pts.map(p => Math.max(p.y, 0));
  const xMin    = xs[0], xMax = xs[xs.length - 1];
  const bgAtPts = xs.map(x => Math.max(evalBg(x), 0));
  const bgFloor = Math.max(bgAtPts.reduce((s, v) => s + v, 0) / bgAtPts.length, 1);

  // Per-peak initialisation using background as baseline
  const initLogAmps = peaks.map(pk => {
    const nearby = pts.filter(p => Math.abs(p.x - pk.center) <= pk.width);
    const bgHere = nearby.length
      ? nearby.reduce((s, p) => s + evalBg(p.x), 0) / nearby.length : bgFloor;
    return Math.log(Math.max(nearby.length ? Math.max(...nearby.map(p => p.y)) - bgHere : 100, 10));
  });
  const initLogFwhms = peaks.map(pk => {
    const nearby = pts.filter(p => Math.abs(p.x - pk.center) <= pk.width);
    if (nearby.length < 4) return Math.log(0.1);
    const bgHere = nearby.reduce((s, p) => s + evalBg(p.x), 0) / nearby.length;
    const half   = bgHere + (Math.max(...nearby.map(p => p.y)) - bgHere) * 0.5;
    const above  = nearby.filter(p => p.y >= half);
    return Math.log(Math.max(above.length >= 2 ? above[above.length - 1].x - above[0].x : 0.1, 0.03));
  });

  let peakP;
  if (quick) {
    // ── Quick fit: pure Gaussian, [logAmp, rawCen, logFwhmG] × nPeaks ────────
    // fL is fixed at ~0 so η ≈ 0 and the profile is purely Gaussian.
    // 3 params/peak → much smaller search space → converges in ~3 000 iters.
    const p0q = peaks.flatMap((_, i) => [initLogAmps[i], 0, initLogFwhms[i]]);
    const decodeQ = params => peaks.map((pk, i) => ({
      amp: Math.exp(params[i * 3]),
      cen: pk.center + pk.width * Math.tanh(params[i * 3 + 1]),
      fG:  Math.exp(params[i * 3 + 2]),
      fL:  1e-6,
    }));
    const lossQ = params => {
      const pp = decodeQ(params);
      let s = 0;
      for (let i = 0; i < xs.length; i++) {
        let model = bgAtPts[i];
        for (const pk of pp) model += pk.amp * pseudoVoigt(xs[i], pk.cen, pk.fG, pk.fL);
        model = Math.max(model, 1e-10);
        s += model - ys[i] * Math.log(model);
      }
      return s;
    };
    peakP = decodeQ(nelderMead(lossQ, p0q, { maxIter: 3000, tol: 1e-8 }));
  } else {
    // ── Full TCH fit: [logAmp, rawCen, logFwhmG, logFwhmL] × nPeaks ──────────
    // fG and fL fitted independently; total FWHM f and η derived via TCH.
    // Start mostly Gaussian (fL = fG/10) as expected for XRD instruments.
    const p0 = peaks.flatMap((_, i) => [
      initLogAmps[i], 0,
      initLogFwhms[i],
      initLogFwhms[i] - Math.log(10),
    ]);
    const decodeFull = params => peaks.map((pk, i) => ({
      amp: Math.exp(params[i * 4]),
      cen: pk.center + pk.width * Math.tanh(params[i * 4 + 1]),
      fG:  Math.exp(params[i * 4 + 2]),
      fL:  Math.exp(params[i * 4 + 3]),
    }));
    const lossFull = params => {
      const pp = decodeFull(params);
      let s = 0;
      for (let i = 0; i < xs.length; i++) {
        let model = bgAtPts[i];
        for (const pk of pp) model += pk.amp * pseudoVoigt(xs[i], pk.cen, pk.fG, pk.fL);
        model = Math.max(model, 1e-10);
        s += model - ys[i] * Math.log(model);
      }
      return s;
    };
    peakP = decodeFull(nelderMead(lossFull, p0, { maxIter: 15000, tol: 1e-14 }));
  }

  // ── Output ────────────────────────────────────────────────────────────────
  const results = {};
  peaks.forEach((pk, i) => {
    const p           = peakP[i];
    const { f, eta }  = tchParams(p.fG, p.fL);
    const theta       = p.cen * Math.PI / 360;
    const dSpacing    = LAMBDA / (2 * Math.sin(theta));
    const dRef        = LAMBDA / (2 * Math.sin(pk.center * Math.PI / 360));
    results[pk.id] = {
      amplitude: p.amp, center: p.cen, fwhmG: p.fG, fwhmL: p.fL, fwhm: f, eta,
      dSpacing, dRef, strain: (dSpacing - dRef) / dRef,
    };
  });

  const nFine   = 800;
  const fittedX = Array.from({ length: nFine }, (_, k) => xMin + k * (xMax - xMin) / (nFine - 1));
  const bgY     = fittedX.map(x => Math.max(evalBg(x), 0));
  const fittedY = fittedX.map((x, i) =>
    bgY[i] + peakP.reduce((s, pk) => s + pk.amp * pseudoVoigt(x, pk.cen, pk.fG, pk.fL), 0)
  );
  const peakCurves = peaks.map((pk, i) => ({
    id: pk.id,
    x:  fittedX,
    y:  fittedX.map(x => peakP[i].amp * pseudoVoigt(x, peakP[i].cen, peakP[i].fG, peakP[i].fL)),
  }));

  return { results, fittedX, fittedY, bgY, peakCurves };
}

const PEAK_COLORS = ["#4a9eff", "#ff6b6b", "#51cf66", "#ffd43b", "#cc5de8", "#ff922b", "#20c997"];

function XRDAnalysisModal({ sample, xrdData, structures, xrdConfigs = [], onSaveXrdConfigs, onSave, onClose }) {
  // xrd_peaks may be the old array format or the new { lines, fitWindow, fittedCurve, peakCurves } object
  const saved = sample.xrd_peaks;
  const isObj = saved && !Array.isArray(saved);
  const savedLines = isObj ? (saved.lines || []) : (saved || []);

  const [lines,       setLines]       = useState(() => savedLines.map(p => ({ ...p })));
  const [fitResults,  setFitResults]  = useState(() => {
    // Reconstruct fitResults map from saved lines that carry fitted_* fields
    const r = {};
    savedLines.forEach(ln => {
      if (ln.fitted_center != null) r[ln.id] = {
        center: ln.fitted_center, fwhmG: ln.fitted_fwhmG, fwhmL: ln.fitted_fwhmL,
        fwhm: ln.fitted_fwhm, eta: ln.fitted_eta,
        dSpacing: ln.fitted_d, dRef: ln.d_ref, strain: ln.strain, amplitude: ln.amplitude,
      };
    });
    return r;
  });
  const [fittedCurve, setFittedCurve] = useState(() => isObj ? (saved.fittedCurve || null) : null);
  const [peakCurves,  setPeakCurves]  = useState(() => isObj ? (saved.peakCurves  || [])  : []);
  const [bgCurve,     setBgCurve]     = useState(() => isObj ? (saved.bgCurve     || null) : null);
  const [fitting,     setFitting]     = useState(false); // false | "quick" | "full"
  const [fittingBg,   setFittingBg]   = useState(false);
  const [logScale,    setLogScale]    = useState(true);
  const [fitError,        setFitError]        = useState(null);
  const [bgError,         setBgError]         = useState(null);
  const [nBgTerms,        setNBgTerms]        = useState(() => isObj ? (saved.nBgTerms || 6) : 6);
  const [fitWindow,       setFitWindow]       = useState(() => isObj ? (saved.fitWindow || null) : null);  // [x0, x1] | null
  const [selectingWindow, setSelectingWindow] = useState(false);
  const [openPicker,      setOpenPicker]      = useState(null); // { id, type: "color"|"style"|"strainCfg" }
  const [dragLineIdx,     setDragLineIdx]     = useState(null);
  const [dragOverIdx,     setDragOverIdx]     = useState(null);
  const [configMenuOpen,  setConfigMenuOpen]  = useState(false);
  const [configName,      setConfigName]      = useState("");
  const configFileRef = useRef(null);

  const addLine = () => setLines(p => [...p, {
    id: String(Date.now()), material: structures[0]?.name || "__arbitrary__", hkl: "",
    style: "solid", color: PEAK_COLORS[p.length % PEAK_COLORS.length] || "#4a9eff",
    mode: "bulk", substrate: "", tolerance: 0.5, arbitrary_2theta: null, primary: true,
  }]);
  const updateLine = (id, patch) => setLines(p => p.map(l => l.id === id ? { ...l, ...patch } : l));
  const removeLine = id => { setLines(p => p.filter(l => l.id !== id)); setFitResults(r => { const n = { ...r }; delete n[id]; return n; }); };

  const reorderLines = (fromIdx, toIdx) => {
    if (fromIdx === toIdx) return;
    const order = [...Array(lines.length).keys()];
    const [moved] = order.splice(fromIdx, 1);
    order.splice(toIdx, 0, moved);
    const oldToNew = new Array(lines.length);
    order.forEach((oldIdx, newIdx) => { oldToNew[oldIdx] = newIdx; });
    setLines(order.map(oldIdx => {
      const ln = lines[oldIdx];
      if (!ln.substrate?.startsWith("entry:")) return ln;
      const newRef = oldToNew[parseInt(ln.substrate.slice(6))];
      return newRef != null ? { ...ln, substrate: `entry:${newRef}` } : ln;
    }));
  };

  // Effective structures (bulk or strained) — same logic as XRD comparison panel
  const lineEffStructs = useMemo(() => {
    const eff = new Array(lines.length).fill(null);
    const compute = (ln, i) => {
      const film = structures.find(s => s.name === ln.material);
      let sub;
      if (ln.substrate?.startsWith("entry:")) {
        const ref = parseInt(ln.substrate.slice(6));
        sub = (ref >= 0 && ref < lines.length && ref !== i) ? eff[ref] : null;
      } else {
        sub = structures.find(s => s.name === ln.substrate) || null;
      }
      return ln.mode === "strained" && film ? (calcStrainedStruct(film, sub, ln) || null) : (film || null);
    };
    lines.forEach((ln, i) => { eff[i] = compute(ln, i); });
    lines.forEach((ln, i) => { if (ln.substrate?.startsWith("entry:")) eff[i] = compute(ln, i); });
    return eff;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lines, structures]);

  // Shapes: fit window + tolerance window shading + fitted center (no reference line)
  const lineShapes = [
    ...(fitWindow ? [{ type: "rect", xref: "x", yref: "paper", x0: fitWindow[0], x1: fitWindow[1], y0: 0, y1: 1, fillcolor: T.teal + "18", line: { color: T.teal, width: 1, dash: "dot" }, layer: "below" }] : []),
    ...lines.flatMap((ln, i) => {
      const tt = ln.material === "__arbitrary__"
        ? (ln.arbitrary_2theta ?? null)
        : (lineEffStructs[i] ? calcTwoTheta(lineEffStructs[i], ln.hkl) : null);
      if (tt == null) return [];
      const tol  = ln.tolerance ?? 0.5;
      const dash = ln.style === "dashed" ? "dash" : ln.style === "dotted" ? "dot" : "solid";
      const res  = fitResults[ln.id];
      return [
        // Tolerance window shading — always shown
        { type: "rect", xref: "x", yref: "paper", x0: tt - tol, x1: tt + tol, y0: 0, y1: 1, fillcolor: ln.color + "22", line: { width: 0 }, layer: "below" },
        // Reference line — only shown when there is no fit result yet
        ...(!res ? [{ type: "line", xref: "x", yref: "paper", x0: tt, x1: tt, y0: 0, y1: 1, line: { color: ln.color, width: 1.5, dash }, layer: "above" }] : []),
        // Fitted center — shown after fitting
        ...(res ? [{ type: "line", xref: "x", yref: "paper", x0: res.center, x1: res.center, y0: 0, y1: 1, line: { color: ln.color, width: 2, dash }, layer: "above" }] : []),
      ];
    }),
  ];

  // Fields that are fit results, not config — stripped on export/save
  const FIT_RESULT_FIELDS = ['id', 'fitted_center', 'fitted_fwhm', 'fitted_fwhmG',
    'fitted_fwhmL', 'fitted_eta', 'fitted_d', 'd_ref', 'strain', 'amplitude'];

  const buildConfigPayload = () => ({
    fitWindow,
    nBgTerms,
    lines: lines.map(ln => {
      const clean = { ...ln };
      FIT_RESULT_FIELDS.forEach(f => delete clean[f]);
      return clean;
    }),
  });

  const saveConfigToLibrary = () => {
    const name = configName.trim();
    if (!name) return;
    const entry = { id: String(Date.now()), name, savedAt: new Date().toISOString(), ...buildConfigPayload() };
    // Replace any existing config with the same name, otherwise append
    onSaveXrdConfigs?.([...xrdConfigs.filter(c => c.name !== name), entry]);
    setConfigName("");
    setConfigMenuOpen(false);
  };

  const loadConfigFromLibrary = cfg => {
    const ts = Date.now();
    if (Array.isArray(cfg.lines))
      setLines(cfg.lines.map((ln, i) => ({ ...ln, id: `${ts}-${i}-${Math.random().toString(36).slice(2)}` })));
    if (cfg.fitWindow !== undefined) setFitWindow(cfg.fitWindow);
    if (cfg.nBgTerms) setNBgTerms(cfg.nBgTerms);
    setFitResults({}); setFittedCurve(null); setPeakCurves([]); setBgCurve(null);
    setConfigMenuOpen(false);
  };

  const deleteConfigFromLibrary = (id, e) => {
    e.stopPropagation();
    onSaveXrdConfigs?.(xrdConfigs.filter(c => c.id !== id));
  };

  const exportConfigFile = () => {
    const cfg = { version: 1, ...buildConfigPayload() };
    const blob = new Blob([JSON.stringify(cfg, null, 2)], { type: 'application/json' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href = url; a.download = `xrd_config_${sample.id}.json`;
    document.body.appendChild(a); a.click();
    document.body.removeChild(a); URL.revokeObjectURL(url);
    setConfigMenuOpen(false);
  };

  const importConfig = e => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = ev => {
      try {
        const cfg = JSON.parse(ev.target.result);
        if (!cfg.version) throw new Error('Not a valid XRD config file');
        loadConfigFromLibrary(cfg);
      } catch (err) {
        alert(`Could not load config: ${err.message}`);
      }
    };
    reader.readAsText(file);
    e.target.value = '';
  };

  // For each XRD line that has fringe_model enabled, find the matching layer's thickness
  const getLayerThickness = useCallback((ln) => {
    if (ln.fringe_thickness_nm != null) return ln.fringe_thickness_nm;
    if (!sample?.layers) return null;
    const mat = ln.material === "__arbitrary__" ? null : ln.material;
    if (!mat) return null;
    const layer = sample.layers.find(l => l.targets?.some(t => t.material === mat));
    return layer?.thickness_nm ?? null;
  }, [sample?.layers]);

  const getFittablePeaks = useCallback(() =>
    lines.map((ln, i) => {
      const tt = ln.material === "__arbitrary__"
        ? (ln.arbitrary_2theta ?? null)
        : (lineEffStructs[i] ? calcTwoTheta(lineEffStructs[i], ln.hkl) : null);
      if (tt == null) return null;
      return {
        id: ln.id, center: tt, width: ln.tolerance ?? 0.5,
        fringeModel: ln.fringe_model ?? false,
        fringeThicknessNm: ln.fringe_model ? (ln.fringe_thickness_nm ?? getLayerThickness(ln)) : null,
        fringeLock: ln.fringe_lock ?? false,
      };
    }).filter(Boolean),
  // eslint-disable-next-line react-hooks/exhaustive-deps
  [lines, lineEffStructs, getLayerThickness]);

  const runFitBg = useCallback(() => {
    if (!xrdData.length) return;
    setFittingBg(true); setBgError(null);
    setTimeout(() => {
      try {
        const peaks = getFittablePeaks();
        const res = fitBackground(xrdData, peaks, nBgTerms);
        if (res) setBgCurve(res);
        else setBgError("Background fit failed — check data.");
      } catch (e) { setBgError(String(e.message || e)); }
      setFittingBg(false);
    }, 20);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [xrdData, nBgTerms, getFittablePeaks]);

  const runFit = useCallback((quick = false) => {
    const fittable = getFittablePeaks();
    if (!fittable.length || !xrdData.length) return;
    setFitting(quick ? "quick" : "full"); setFitError(null);
    setTimeout(() => {
      try {
        const bg = bgCurve || undefined;
        const voigtPeaks  = fittable.filter(p => !p.fringeModel);
        const fringePeaks = fittable.filter(p => p.fringeModel);

        // Fit non-fringe peaks together with Voigt
        let mergedResults = {};
        let fittedCurveOut = null;
        let peakCurvesOut = [];

        if (voigtPeaks.length) {
          const res = fitPeaksVoigt(xrdData, voigtPeaks, fitWindow, bg, quick);
          if (res) {
            mergedResults = { ...res.results };
            fittedCurveOut = { x: res.fittedX, y: res.fittedY, bgY: res.bgY };
            peakCurvesOut = res.peakCurves || [];
          }
        }

        // Background evaluator (needed for total fit curve + peakCurve fills)
        const bgEvalFn = bg
          ? (x => Math.exp(evalChebyshev(2*(x - bg.xMin)/(bg.xMax - bg.xMin) - 1, bg.coeffs)))
          : null;

        // Fit each fringe peak independently and build display curves
        const allPtsSorted = [...xrdData].sort((a, b) => a.x - b.x);
        const fringeResultsList = []; // collected for total-fit-curve computation
        for (const fp of fringePeaks) {
          const res = fitLaueFreeze(xrdData, fp, fitWindow, bg, fp.fringeThicknessNm, fp.fringeLock);
          if (!res) continue;
          mergedResults[fp.id] = res;
          fringeResultsList.push(res);
          // Build peak curve for display — extend to ±8 fringe periods
          if (allPtsSorted.length >= 2) {
            const LAMBDA_D = 0.15406;
            const thetaCen = res.center * Math.PI / 360;
            const period = LAMBDA_D / (res.thickness_nm * Math.cos(thetaCen)) * (180 / Math.PI);
            const halfRange = Math.max(period * 8, 3);
            const xMin = Math.max(allPtsSorted[0].x, res.center - halfRange);
            const xMax = Math.min(allPtsSorted[allPtsSorted.length - 1].x, res.center + halfRange);
            const nFine = 800;
            const fxs = Array.from({ length: nFine }, (_, k) => xMin + k * (xMax - xMin) / (nFine - 1));
            const sigInstr = res.fwhmG / 2.355;
            const fys = fxs.map(x => {
              const theta = x * Math.PI / 360;
              const dSin  = Math.sin(theta) - Math.sin(thetaCen);
              const arg   = Math.PI * res.thickness_nm * dSin / LAMBDA_D;
              const sinc2 = Math.abs(arg) < 1e-9 ? 1 : Math.pow(Math.sin(arg) / arg, 2);
              const gEnv  = sigInstr > 0 ? Math.exp(-0.5 * Math.pow((x - res.center) / sigInstr, 2)) : 1;
              return res.amplitude * sinc2 * gEnv;
            });
            // Store bg at each x so the fill renders correctly (avoids index mismatch)
            const fBgAtX = bgEvalFn ? fxs.map(x => Math.max(bgEvalFn(x), 1)) : fxs.map(() => 1);
            peakCurvesOut.push({ id: fp.id, x: fxs, y: fys, bgAtX: fBgAtX });
          }
        }

        // Build a total fit curve (bg + sum of fringe contributions) when no Voigt fit ran
        if (fringeResultsList.length && !fittedCurveOut) {
          const LAMBDA_D = 0.15406;
          const totalX   = allPtsSorted.map(p => p.x);
          const totalBgY = bgEvalFn ? totalX.map(x => Math.max(bgEvalFn(x), 1)) : totalX.map(() => 1);
          const totalY   = totalX.map((x, xi) => {
            let y = totalBgY[xi];
            for (const res of fringeResultsList) {
              const theta    = x * Math.PI / 360;
              const thetaCen = res.center * Math.PI / 360;
              const dSin     = Math.sin(theta) - Math.sin(thetaCen);
              const arg      = Math.PI * res.thickness_nm * dSin / LAMBDA_D;
              const sinc2    = Math.abs(arg) < 1e-9 ? 1 : Math.pow(Math.sin(arg) / arg, 2);
              const sigInstr = res.fwhmG / 2.355;
              const gEnv     = sigInstr > 0 ? Math.exp(-0.5 * Math.pow((x - res.center) / sigInstr, 2)) : 1;
              y += res.amplitude * sinc2 * gEnv;
            }
            return y;
          });
          fittedCurveOut = { x: totalX, y: totalY, bgY: totalBgY };
        }

        if (Object.keys(mergedResults).length) {
          setFitResults(mergedResults);
          if (fittedCurveOut) setFittedCurve(fittedCurveOut);
          else if (fringePeaks.length && !fringeResultsList.length)
            setFitError("Fringe fit returned no result — check thickness seed and tolerance.");
          setPeakCurves(peakCurvesOut);
        } else {
          setFitError("Not enough data in window — try widening the tolerance or fit window.");
        }
      } catch (e) { setFitError(String(e.message || e)); console.error("runFit error:", e); }
      setFitting(false);
    }, 20);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [getFittablePeaks, xrdData, fitWindow, bgCurve]);

  const handleSave = () => {
    const savedLines = lines.map(ln => {
      const r = fitResults[ln.id];
      return r ? { ...ln, fitted_center: r.center,
                         fitted_fwhmG: r.fwhmG, fitted_fwhmL: r.fwhmL,
                         fitted_fwhm: r.fwhm, fitted_eta: r.eta,
                         fitted_d: r.dSpacing, d_ref: r.dRef, strain: r.strain, amplitude: r.amplitude,
                         ...(r.thickness_nm != null ? { fitted_thickness_nm: r.thickness_nm } : {}) } : ln;
    });
    onSave({ lines: savedLines, fitWindow, fittedCurve, peakCurves, bgCurve, nBgTerms });
    onClose();
  };

  const yRaw = xrdData.map(p => p.y).filter(y => y > 0);
  const yMin = yRaw.length ? Math.min(...yRaw) : 1;
  const yMax = yRaw.length ? Math.max(...yRaw) : 1e6;

  // Live sinc² preview — recomputes immediately when thickness input changes
  const fringePreviewTraces = useMemo(() => {
    const LAMBDA = 0.15406;
    const allXSorted = [...xrdData].sort((a, b) => a.x - b.x);
    const dataXMin = allXSorted[0]?.x ?? 0;
    const dataXMax = allXSorted[allXSorted.length - 1]?.x ?? 90;
    return lines.flatMap((ln, i) => {
      if (!ln.fringe_model) return [];
      const cen = ln.material === "__arbitrary__"
        ? (ln.arbitrary_2theta ?? null)
        : (lineEffStructs[i] ? calcTwoTheta(lineEffStructs[i], ln.hkl) : null);
      if (cen == null) return [];
      const t = ln.fringe_thickness_nm ?? getLayerThickness(ln);
      if (!t || t <= 0) return [];
      const cenRad = cen * Math.PI / 360;
      // Estimate amplitude from data within ±1° of center
      const nearby = xrdData.filter(p => Math.abs(p.x - cen) <= 1.0);
      const amp = nearby.length ? Math.max(...nearby.map(p => p.y)) : (yMax || 1000);
      // Cover ±6 fringe periods, clamped to data range
      const period = LAMBDA / (t * Math.cos(cenRad)) * (180 / Math.PI);
      const halfRange = Math.max(period * 6, 3);
      const xMin = Math.max(dataXMin, cen - halfRange);
      const xMax = Math.min(dataXMax, cen + halfRange);
      const nFine = 600;
      const fxs = Array.from({ length: nFine }, (_, k) => xMin + k * (xMax - xMin) / (nFine - 1));
      const fys = fxs.map(x => {
        const theta = x * Math.PI / 360;
        const dSin = Math.sin(theta) - Math.sin(cenRad);
        const arg = Math.PI * t * dSin / LAMBDA;
        const sinc2 = Math.abs(arg) < 1e-9 ? 1 : Math.pow(Math.sin(arg) / arg, 2);
        return Math.max(amp * sinc2, 1);
      });
      return [{ x: fxs, y: fys, type: "scatter", mode: "lines",
        line: { color: ln.color, width: 1.5, dash: "dot" },
        showlegend: false, hoverinfo: "skip", opacity: 0.55 }];
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lines, lineEffStructs, xrdData, yMax, getLayerThickness]);

  const traces = [
    { x: xrdData.map(p => p.x), y: xrdData.map(p => Math.max(p.y, 1)), type: "scatter", mode: "lines", line: { color: T.textSecondary, width: 1 }, showlegend: false, hovertemplate: "2θ=%{x:.3f}°<br>I=%{y:.0f}<extra></extra>" },
    // Background curve — bgCurve (standalone) takes priority over peak-fit bgY
    ...(bgCurve ? [{ x: bgCurve.x, y: bgCurve.y, type: "scatter", mode: "lines", line: { color: T.amber, width: 1.5, dash: "dash" }, showlegend: false, hoverinfo: "skip" }] :
        fittedCurve?.bgY ? [{ x: fittedCurve.x, y: fittedCurve.bgY, type: "scatter", mode: "lines", line: { color: T.textDim, width: 1, dash: "dot" }, showlegend: false, hoverinfo: "skip" }] : []),
    // Individual peak fills — closed polygon (toself) works on both log and linear axes.
    // Path: top edge (bg+peak) left→right, bottom edge (bg) right→left.
    ...peakCurves.map(pc => {
      const ln  = lines.find(l => l.id === pc.id);
      const col = ln?.color || "#888888";
      // bgAtX (fringe peaks) is pre-computed at the same x-grid as the curve;
      // fittedCurve.bgY is index-matched only for Voigt peaks (same fittedX).
      const bgY = pc.bgAtX || fittedCurve?.bgY || pc.x.map(() => 1);
      const topY = pc.y.map((v, i) => Math.max((bgY[i] ?? 1) + v, 1));
      const bgFloor = bgY.map(v => Math.max(v, 1));
      // Closed polygon: top L→R then bottom R→L
      const xPath = [...pc.x, ...pc.x.slice().reverse()];
      const yPath = [...topY, ...bgFloor.slice().reverse()];
      return { x: xPath, y: yPath, type: "scatter", mode: "lines", fill: "toself", fillcolor: col + "40", line: { color: col, width: 1 }, showlegend: false, hoverinfo: "skip" };
    }),
    // Live fringe preview (dotted) — shown whenever fringe_model is on + thickness set
    ...fringePreviewTraces,
    ...(fittedCurve ? [{ x: fittedCurve.x, y: fittedCurve.y, type: "scatter", mode: "lines", line: { color: T.accent, width: 2 }, showlegend: false, hoverinfo: "skip", opacity: 0.9 }] : []),
  ];

  const layout = {
    paper_bgcolor: T.bg1, plot_bgcolor: T.bg1,
    font: { family: "'DM Mono', monospace", size: 11, color: T.textPrimary },
    margin: { t: 12, r: 20, b: 52, l: 72, pad: 0 },
    xaxis: { title: { text: "2θ (°)", font: { size: 12, color: T.textSecondary }, standoff: 10 }, gridcolor: T.border, color: T.textSecondary },
    yaxis: { ...(logScale ? { type: "log", range: [Math.log10(Math.max(yMin * 0.8, 1)), Math.log10(yMax * 3)] } : { range: [0, yMax * 1.1] }), title: { text: "Intensity (arb.)", font: { size: 12, color: T.textSecondary }, standoff: 8 }, showticklabels: false, gridcolor: T.border, color: T.textSecondary },
    shapes: lineShapes, hovermode: "x", dragmode: selectingWindow ? "select" : "zoom",
    uirevision: selectingWindow ? "xrd-select" : "xrd-analysis",
    selectdirection: "h",
  };

  const rc = { fontFamily: "'DM Mono', monospace", fontSize: 11, borderRadius: 4, padding: "4px 8px", boxSizing: "border-box", outline: "none", cursor: "pointer" };
  const hasFittable = lines.some((ln, i) =>
    ln.material === "__arbitrary__"
      ? ln.arbitrary_2theta != null
      : (lineEffStructs[i] && calcTwoTheta(lineEffStructs[i], ln.hkl) != null)
  );

  return (
    <div style={{ position: "fixed", inset: 0, background: T.bg0, zIndex: 400, display: "flex", flexDirection: "column", overflowY: "auto" }}
      onClick={() => { setOpenPicker(null); setConfigMenuOpen(false); }}>
      {/* Header — matches main app navbar */}
      <div style={{ borderBottom: `1px solid ${T.border}`, background: T.bg1, position: "sticky", top: 0, zIndex: 10, flexShrink: 0 }}>
        <div style={{ maxWidth: 1600, margin: "0 auto", padding: "12px 20px", display: "flex", alignItems: "center", gap: 14 }}>
          <button onClick={handleSave} style={{ background: "none", border: "none", color: T.textDim, cursor: "pointer", fontSize: 20, lineHeight: 1, padding: 0 }}>←</button>
          <span style={{ fontFamily: "'Playfair Display', serif", fontSize: 22, color: T.amber }}>XRD Analysis</span>
          <span style={{ fontFamily: "'DM Mono', monospace", fontSize: 11, color: T.textDim, background: T.bg2, border: `1px solid ${T.border}`, borderRadius: 4, padding: "2px 8px" }}>{sample.id}</span>
          <div style={{ flex: 1 }} />
          <div style={{ display: "flex", borderRadius: 4, overflow: "hidden", border: `1px solid ${T.border}` }}>
            {["log", "linear"].map(opt => (
              <button key={opt} onClick={() => setLogScale(opt === "log")}
                style={{ fontFamily: "'DM Mono', monospace", fontSize: 10, padding: "3px 8px", border: "none", cursor: "pointer", background: (opt === "log") === logScale ? T.bg3 : T.bg1, color: (opt === "log") === logScale ? T.textPrimary : T.textDim }}>
                {opt}
              </button>
            ))}
          </div>
          <Btn variant="primary" onClick={handleSave}>Save & Close</Btn>
        </div>
      </div>

      {/* Body — constrained width, same as main content area */}
      <div style={{ maxWidth: 1600, margin: "0 auto", width: "100%", padding: "24px 20px", display: "flex", flexDirection: "column", flex: 1, boxSizing: "border-box" }}>
        {/* Plot */}
        <div style={{ height: "52vh", minHeight: 280 }}>
          <Plot data={traces} layout={layout} config={buildPlotConfig(`xrd_${sample.id}`)}
            style={{ width: "100%", height: "100%" }} useResizeHandler
            onSelected={e => {
              if (selectingWindow && e?.range?.x) {
                setFitWindow([e.range.x[0], e.range.x[1]]);
                setSelectingWindow(false);
              }
            }} />
        </div>

        {/* Line panel — same as analysis notebook */}
        <div style={{ marginTop: 20, borderTop: `1px solid ${T.border}`, paddingTop: 16, paddingBottom: 16 }}>
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {lines.map((ln, i) => {
              const effStruct  = lineEffStructs[i];
              const twoTheta   = ln.material === "__arbitrary__"
                ? (ln.arbitrary_2theta ?? null)
                : (effStruct ? calcTwoTheta(effStruct, ln.hkl) : null);
              const curStyle   = LINE_STYLES.find(s => s.id === ln.style) || LINE_STYLES[0];
              const colorOpen  = openPicker?.id === ln.id && openPicker?.type === "color";
              const styleOpen  = openPicker?.id === ln.id && openPicker?.type === "style";
              const cfgOpen    = openPicker?.id === ln.id && openPicker?.type === "strainCfg";
              const isStrained = ln.mode === "strained";
              const smode      = ln.strain_mode || "substrate";
              const anyOpen    = colorOpen || styleOpen || cfgOpen;
              const res        = fitResults[ln.id];
              return (
                <div key={ln.id}
                  draggable
                  onDragStart={e => { e.dataTransfer.effectAllowed = "move"; setDragLineIdx(i); }}
                  onDragOver={e => { e.preventDefault(); e.dataTransfer.dropEffect = "move"; setDragOverIdx(i); }}
                  onDragLeave={() => setDragOverIdx(null)}
                  onDrop={e => { e.preventDefault(); reorderLines(dragLineIdx, i); setDragLineIdx(null); setDragOverIdx(null); }}
                  onDragEnd={() => { setDragLineIdx(null); setDragOverIdx(null); }}
                  style={{ display: "flex", alignItems: "center", gap: 6, position: "relative", zIndex: anyOpen ? 100 : "auto",
                    opacity: dragLineIdx === i ? 0.4 : (ln.primary === false ? 0.55 : 1),
                    outline: dragOverIdx === i && dragLineIdx !== i ? `2px solid ${T.teal}` : "2px solid transparent",
                    borderRadius: 5 }}>
                  {/* Row number / drag handle */}
                  <span title="Drag to reorder" style={{ fontFamily: "'DM Mono', monospace", fontSize: 10, color: T.textDim, minWidth: 16, textAlign: "right", flexShrink: 0, cursor: "grab", userSelect: "none" }}>{i + 1}</span>
                  {/* Material */}
                  <select value={ln.material} onChange={e => updateLine(ln.id, { material: e.target.value })} onClick={e => e.stopPropagation()}
                    style={{ ...rc, background: T.bg0, border: `1px solid ${T.border}`, color: T.textSecondary }}>
                    <option value="__arbitrary__">— arbitrary —</option>
                    <option value="">— material —</option>
                    {structures.map(s => <option key={s.name} value={s.name}>{s.name}</option>)}
                  </select>
                  {/* HKL or direct 2θ for arbitrary */}
                  {ln.material === "__arbitrary__" ? (
                    <DeferredInput type="number" value={ln.arbitrary_2theta ?? ""} placeholder="2θ (°)"
                      onChange={v => updateLine(ln.id, { arbitrary_2theta: v === "" ? null : Number(v) })}
                      style={{ ...rc, width: 80, background: T.bg0, border: `1px solid ${T.border}`, color: T.teal, textAlign: "center", cursor: "text" }} />
                  ) : (
                    <DeferredInput value={ln.hkl} onChange={v => updateLine(ln.id, { hkl: v })} placeholder="hkl"
                      style={{ ...rc, width: 64, background: T.bg0, border: `1px solid ${T.border}`, color: T.textPrimary, textAlign: "center" }} />
                  )}
                  {/* Configure (only for non-arbitrary) */}
                  <div style={{ position: "relative", zIndex: 50 }}>
                    {ln.material !== "__arbitrary__" && <>
                    <button onClick={e => { e.stopPropagation(); setOpenPicker(cfgOpen ? null : { id: ln.id, type: "strainCfg" }); }}
                      style={{ ...rc, background: cfgOpen ? T.bg3 : T.bg0, border: `1px solid ${cfgOpen ? T.borderBright : isStrained ? T.teal : T.border}`, color: isStrained ? T.teal : T.textSecondary }}>
                      Configure
                    </button>
                    {cfgOpen && (
                      <div onClick={e => e.stopPropagation()}
                        style={{ position: "absolute", left: 0, top: "calc(100% + 4px)", background: T.bg3, border: `1px solid ${T.borderBright}`, borderRadius: 8, padding: "12px 14px", zIndex: 500, boxShadow: "0 4px 20px rgba(0,0,0,.3), 0 1px 4px rgba(0,0,0,.15)", minWidth: 280, display: "flex", flexDirection: "column", gap: 12 }}>
                        <div style={{ display: "flex", borderRadius: 4, overflow: "hidden", border: `1px solid ${T.border}`, alignSelf: "flex-start" }}>
                          {["bulk", "strained"].map(m => (
                            <button key={m} onClick={() => updateLine(ln.id, { mode: m })}
                              style={{ ...rc, background: ln.mode === m ? T.bg3 : T.bg0, border: "none", borderRight: m === "bulk" ? `1px solid ${T.border}` : "none", color: ln.mode === m ? T.textPrimary : T.textDim, textTransform: "uppercase", letterSpacing: 0.5 }}>
                              {m}
                            </button>
                          ))}
                        </div>
                        {isStrained && [
                          { id: "substrate",         label: "Strain based on substrate" },
                          { id: "arbitrary_strain",  label: "Arbitrary strain (biaxial)" },
                          { id: "arbitrary_lattice", label: "Arbitrary lattice parameter" },
                        ].map(opt => (
                          <div key={opt.id} style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                            <div onClick={() => updateLine(ln.id, { strain_mode: opt.id })} style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer" }}>
                              <div style={{ width: 14, height: 14, borderRadius: "50%", border: `2px solid ${smode === opt.id ? T.teal : T.border}`, background: smode === opt.id ? T.teal : "transparent", flexShrink: 0 }} />
                              <span style={{ fontFamily: "'DM Mono', monospace", fontSize: 11, color: smode === opt.id ? T.textPrimary : T.textDim }}>{opt.label}</span>
                            </div>
                            {smode === opt.id && opt.id === "substrate" && (
                              <select value={ln.substrate} onChange={e => updateLine(ln.id, { substrate: e.target.value })}
                                style={{ ...rc, marginLeft: 22, background: T.bg0, border: `1px solid ${T.border}`, color: T.textSecondary }}>
                                <option value="">— substrate —</option>
                                {structures.filter(s => s.name !== ln.material).map(s => <option key={s.name} value={s.name}>{s.name}</option>)}
                                {lines.map((other, j) => j !== i && <option key={`entry:${j}`} value={`entry:${j}`}>Entry {j + 1}</option>)}
                              </select>
                            )}
                            {smode === opt.id && opt.id === "arbitrary_strain" && (
                              <div style={{ display: "flex", gap: 10, marginLeft: 22 }}>
                                {[["strain_eps_xx","ε_xx"],["strain_eps_yy","ε_yy"]].map(([k,lbl]) => (
                                  <div key={k} style={{ display: "flex", flexDirection: "column", gap: 3 }}>
                                    <span style={{ fontSize: 10, color: T.textDim, fontFamily: "'DM Mono', monospace" }}>{lbl}</span>
                                    <DeferredInput type="number" value={ln[k] ?? ""} placeholder="0.000" onChange={v => updateLine(ln.id, { [k]: v })}
                                      style={{ ...rc, width: 88, background: T.bg0, border: `1px solid ${T.border}`, color: T.textPrimary, textAlign: "center", cursor: "text" }} />
                                  </div>
                                ))}
                              </div>
                            )}
                            {smode === opt.id && opt.id === "arbitrary_lattice" && (
                              <div style={{ display: "flex", gap: 10, marginLeft: 22 }}>
                                {[["strain_a","a (Å)"],["strain_b","b (Å)"]].map(([k,lbl]) => (
                                  <div key={k} style={{ display: "flex", flexDirection: "column", gap: 3 }}>
                                    <span style={{ fontSize: 10, color: T.textDim, fontFamily: "'DM Mono', monospace" }}>{lbl}</span>
                                    <DeferredInput type="number" value={ln[k] ?? ""} placeholder="—" onChange={v => updateLine(ln.id, { [k]: v })}
                                      style={{ ...rc, width: 88, background: T.bg0, border: `1px solid ${T.border}`, color: T.textPrimary, textAlign: "center", cursor: "text" }} />
                                  </div>
                                ))}
                              </div>
                            )}
                          </div>
                        ))}
                      </div>
                    )}
                    </>}
                  </div>
                  {/* Calculated 2θ — only shown for non-arbitrary (arbitrary shows it via the input) */}
                  {ln.material !== "__arbitrary__" && (
                  <span style={{ fontFamily: "'DM Mono', monospace", fontSize: 11, color: twoTheta != null ? T.teal : T.textDim, minWidth: 62 }}>
                    {twoTheta != null ? `${twoTheta.toFixed(3)}°` : "—"}
                  </span>
                  )}
                  {/* Tolerance (±) */}
                  <span style={{ fontFamily: "'DM Mono', monospace", fontSize: 10, color: T.textDim, flexShrink: 0 }}>±</span>
                  <DeferredInput type="number" value={ln.tolerance ?? 0.5} step={0.1} min={0}
                    onChange={v => updateLine(ln.id, { tolerance: Math.max(0, Number(v)) })}
                    style={{ ...rc, width: 52, background: T.bg0, border: `1px solid ${T.border}`, color: T.textPrimary, textAlign: "center", cursor: "text", padding: "4px 4px" }} />
                  {/* Fringe model toggle + thickness seed + lock */}
                  <button
                    title={ln.fringe_model ? "Laue fringe model active — click to disable" : "Enable Laue fringe model for this peak"}
                    onClick={e => { e.stopPropagation(); updateLine(ln.id, { fringe_model: !ln.fringe_model }); }}
                    style={{ ...rc, background: ln.fringe_model ? `${T.teal}22` : T.bg0, border: `1px solid ${ln.fringe_model ? T.teal : T.border}`, color: ln.fringe_model ? T.teal : T.textDim, fontSize: 10, padding: "3px 7px", flexShrink: 0 }}>
                    ~fringe
                  </button>
                  {ln.fringe_model && (() => {
                    const layerT = getLayerThickness(ln);
                    const tVal = ln.fringe_thickness_nm ?? layerT ?? "";
                    return (
                      <div style={{ display: "flex", alignItems: "center", gap: 3 }}>
                        <input type="number" value={tVal} placeholder={layerT != null ? String(layerT) : "nm"} min={0}
                          onChange={e => updateLine(ln.id, { fringe_thickness_nm: e.target.value === "" ? null : Number(e.target.value) })}
                          onClick={e => e.stopPropagation()}
                          style={{ ...rc, width: 60, background: T.bg0, border: `1px solid ${T.teal}66`, color: T.teal, textAlign: "center", cursor: "text", padding: "4px 4px" }} />
                        <span style={{ fontFamily: "'DM Mono', monospace", fontSize: 10, color: T.textDim }}>nm</span>
                        <button
                          title={ln.fringe_lock ? "Thickness locked — click to allow fitting" : "Click to lock thickness (won't be fitted)"}
                          onClick={e => { e.stopPropagation(); updateLine(ln.id, { fringe_lock: !ln.fringe_lock }); }}
                          style={{ ...rc, background: ln.fringe_lock ? `${T.amber}22` : T.bg0, border: `1px solid ${ln.fringe_lock ? T.amber : T.border}`, color: ln.fringe_lock ? T.amber : T.textDim, fontSize: 11, padding: "3px 5px" }}>
                          {ln.fringe_lock ? "🔒" : "🔓"}
                        </button>
                      </div>
                    );
                  })()}
                  {/* Fit result — strain badge */}
                  {res && !ln.fringe_model && (
                    <span style={{ fontFamily: "'DM Mono', monospace", fontSize: 11, color: res.strain >= 0 ? "#51cf66" : "#ff6b6b", minWidth: 72 }}>
                      {res.strain >= 0 ? "+" : ""}{(res.strain * 100).toFixed(3)}%
                    </span>
                  )}
                  {res && !ln.fringe_model && (
                    <span style={{ fontFamily: "'DM Mono', monospace", fontSize: 10, color: T.textDim }}>
                      {res.center.toFixed(4)}° · {(res.dSpacing * 10).toFixed(4)} Å · f {res.fwhm.toFixed(4)}° (fG {res.fwhmG?.toFixed(4)}° fL {res.fwhmL?.toFixed(4)}°) · η {res.eta?.toFixed(3)}
                    </span>
                  )}
                  {res && ln.fringe_model && (
                    <span style={{ fontFamily: "'DM Mono', monospace", fontSize: 10, color: T.teal }}>
                      {res.center.toFixed(4)}° · {(res.dSpacing * 10).toFixed(4)} Å · t {res.thickness_nm != null ? `${res.thickness_nm.toFixed(1)} nm` : "—"}
                    </span>
                  )}
                  <div style={{ flex: 1 }} />
                  {/* Primary / secondary toggle */}
                  <button
                    title={ln.primary === false ? "Secondary layer — click to mark as primary" : "Primary layer (used in analysis) — click to mark as secondary"}
                    onClick={e => { e.stopPropagation(); updateLine(ln.id, { primary: ln.primary === false ? true : false }); }}
                    style={{ background: "none", border: "none", cursor: "pointer", fontSize: 16, lineHeight: 1, padding: "0 2px",
                      color: ln.primary === false ? T.textDim : T.amber }}>
                    {ln.primary === false ? "☆" : "★"}
                  </button>
                  {/* Color picker */}
                  <div style={{ position: "relative", zIndex: 50 }}>
                    <div onClick={e => { e.stopPropagation(); setOpenPicker(colorOpen ? null : { id: ln.id, type: "color" }); }}
                      style={{ width: 28, height: 28, borderRadius: 4, background: ln.color, border: `2px solid ${colorOpen ? T.amber : T.border}`, cursor: "pointer", flexShrink: 0 }} />
                    {colorOpen && (
                      <div onClick={e => e.stopPropagation()}
                        style={{ position: "absolute", right: 0, top: "calc(100% + 4px)", background: T.bg2, border: `1px solid ${T.borderBright}`, borderRadius: 6, padding: 6, display: "flex", gap: 4, zIndex: 500, boxShadow: "0 4px 12px rgba(0,0,0,.5)" }}>
                        {PEAK_COLORS.map(c => (
                          <div key={c} onClick={() => { updateLine(ln.id, { color: c }); setOpenPicker(null); }}
                            style={{ width: 22, height: 22, borderRadius: 3, background: c, border: `2px solid ${ln.color === c ? T.amber : "transparent"}`, cursor: "pointer" }} />
                        ))}
                      </div>
                    )}
                  </div>
                  {/* Style picker */}
                  <div style={{ position: "relative", zIndex: 50 }}>
                    <button onClick={e => { e.stopPropagation(); setOpenPicker(styleOpen ? null : { id: ln.id, type: "style" }); }}
                      style={{ ...rc, background: T.bg0, border: `1px solid ${styleOpen ? T.borderBright : T.border}`, color: T.textPrimary, minWidth: 40 }}>
                      {curStyle.label}
                    </button>
                    {styleOpen && (
                      <div onClick={e => e.stopPropagation()}
                        style={{ position: "absolute", right: 0, top: "calc(100% + 4px)", background: T.bg2, border: `1px solid ${T.borderBright}`, borderRadius: 6, padding: 4, display: "flex", flexDirection: "column", gap: 2, zIndex: 500, boxShadow: "0 4px 12px rgba(0,0,0,.5)" }}>
                        {LINE_STYLES.map(s => (
                          <button key={s.id} onClick={() => { updateLine(ln.id, { style: s.id }); setOpenPicker(null); }}
                            style={{ ...rc, background: ln.style === s.id ? T.bg3 : "none", border: "none", color: ln.style === s.id ? T.textPrimary : T.textDim, textAlign: "left", whiteSpace: "nowrap" }}>
                            {s.label}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                  {/* Remove */}
                  <button onClick={() => removeLine(ln.id)}
                    style={{ background: "none", border: "none", color: T.textDim, cursor: "pointer", fontSize: 16, lineHeight: 1, padding: "0 2px" }}>×</button>
                </div>
              );
            })}
            {/* Hidden file input for config import */}
            <input ref={configFileRef} type="file" accept=".json" style={{ display: "none" }} onChange={importConfig} />
            <div style={{ display: "flex", alignItems: "center", gap: 12, marginTop: lines.length ? 2 : 0, flexWrap: "wrap" }}>
              <button onClick={e => { e.stopPropagation(); addLine(); }}
                style={{ background: "none", border: `1px dashed ${T.border}`, borderRadius: 5, color: T.teal, fontFamily: "'DM Mono', monospace", fontSize: 11, padding: "3px 10px", cursor: "pointer" }}>
                + Add line
              </button>
              {/* Config library */}
              <div style={{ position: "relative" }} onClick={e => e.stopPropagation()}>
                <button onClick={() => setConfigMenuOpen(v => !v)}
                  style={{ background: configMenuOpen ? T.bg3 : "none", border: `1px solid ${configMenuOpen ? T.borderBright : T.border}`, borderRadius: 5, color: T.textDim, fontFamily: "'DM Mono', monospace", fontSize: 11, padding: "3px 10px", cursor: "pointer" }}>
                  Config ▾
                </button>
                {configMenuOpen && (
                  <div style={{ position: "absolute", left: 0, top: "calc(100% + 4px)", background: T.bg2, border: `1px solid ${T.borderBright}`, borderRadius: 8, padding: "10px 12px", zIndex: 500, boxShadow: "0 4px 16px rgba(0,0,0,.55)", minWidth: 260, display: "flex", flexDirection: "column", gap: 8 }}>
                    {/* Save current config */}
                    <div style={{ display: "flex", gap: 6 }}>
                      <input value={configName} onChange={e => setConfigName(e.target.value)}
                        onKeyDown={e => { if (e.key === "Enter") saveConfigToLibrary(); e.stopPropagation(); }}
                        placeholder="Config name…"
                        style={{ flex: 1, fontFamily: "'DM Mono', monospace", fontSize: 11, padding: "4px 8px", borderRadius: 4, border: `1px solid ${T.border}`, background: T.bg0, color: T.textPrimary, outline: "none" }} />
                      <button onClick={saveConfigToLibrary} disabled={!configName.trim()}
                        style={{ fontFamily: "'DM Mono', monospace", fontSize: 11, padding: "4px 10px", borderRadius: 4, border: "none", background: configName.trim() ? T.amber : T.bg3, color: configName.trim() ? T.bg0 : T.textDim, cursor: configName.trim() ? "pointer" : "default" }}>
                        Save
                      </button>
                    </div>
                    {/* Saved configs list */}
                    {xrdConfigs.length > 0 && (
                      <>
                        <div style={{ borderTop: `1px solid ${T.border}`, margin: "2px 0" }} />
                        <div style={{ display: "flex", flexDirection: "column", gap: 2, maxHeight: 220, overflowY: "auto" }}>
                          {xrdConfigs.map(cfg => (
                            <div key={cfg.id} onClick={() => loadConfigFromLibrary(cfg)}
                              style={{ display: "flex", alignItems: "center", gap: 6, padding: "5px 8px", borderRadius: 5, cursor: "pointer", background: "transparent" }}
                              onMouseEnter={e => e.currentTarget.style.background = T.bg3}
                              onMouseLeave={e => e.currentTarget.style.background = "transparent"}>
                              <span style={{ flex: 1, fontFamily: "'DM Mono', monospace", fontSize: 11, color: T.textPrimary }}>{cfg.name}</span>
                              <span style={{ fontFamily: "'DM Mono', monospace", fontSize: 9, color: T.textDim }}>{cfg.lines?.length ?? 0} lines</span>
                              <button onClick={e => deleteConfigFromLibrary(cfg.id, e)}
                                style={{ background: "none", border: "none", color: T.textDim, cursor: "pointer", fontSize: 13, lineHeight: 1, padding: "0 2px" }}>×</button>
                            </div>
                          ))}
                        </div>
                      </>
                    )}
                    {/* JSON export / import */}
                    <div style={{ borderTop: `1px solid ${T.border}`, paddingTop: 6, display: "flex", gap: 8 }}>
                      <button onClick={exportConfigFile}
                        style={{ background: "none", border: "none", color: T.textDim, fontFamily: "'DM Mono', monospace", fontSize: 10, padding: "2px 0", cursor: "pointer" }}>
                        ↓ Export JSON
                      </button>
                      <button onClick={() => configFileRef.current?.click()}
                        style={{ background: "none", border: "none", color: T.textDim, fontFamily: "'DM Mono', monospace", fontSize: 10, padding: "2px 0", cursor: "pointer" }}>
                        ↑ Import JSON
                      </button>
                    </div>
                  </div>
                )}
              </div>
              <button onClick={e => { e.stopPropagation(); setSelectingWindow(v => !v); }}
                style={{ background: selectingWindow ? T.teal + "33" : "none", border: `1px solid ${selectingWindow ? T.teal : T.border}`, borderRadius: 5, color: selectingWindow ? T.teal : T.textDim, fontFamily: "'DM Mono', monospace", fontSize: 11, padding: "3px 10px", cursor: "pointer" }}>
                {selectingWindow ? "drag on plot…" : "Select fit window"}
              </button>
              {fitWindow && (
                <span style={{ fontFamily: "'DM Mono', monospace", fontSize: 11, color: T.teal }}>
                  window: {fitWindow[0].toFixed(3)}° – {fitWindow[1].toFixed(3)}°
                  <button onClick={() => setFitWindow(null)} style={{ background: "none", border: "none", color: T.textDim, cursor: "pointer", marginLeft: 4, fontSize: 13, lineHeight: 1, padding: 0 }}>×</button>
                </span>
              )}
              {xrdData.length > 0 && (
                <>
                  <select value={nBgTerms} onChange={e => setNBgTerms(Number(e.target.value))} onClick={e => e.stopPropagation()}
                    title="Chebyshev background terms"
                    style={{ fontFamily: "'DM Mono', monospace", fontSize: 10, padding: "3px 6px", borderRadius: 4, border: `1px solid ${T.border}`, background: T.bg0, color: T.textSecondary, cursor: "pointer" }}>
                    {[4, 6, 8, 10, 12].map(n => <option key={n} value={n}>{n} bg terms</option>)}
                  </select>
                  <Btn onClick={runFitBg} disabled={fittingBg}>{fittingBg ? "Fitting…" : "Fit BG"}</Btn>
                  {bgError && <span style={{ fontFamily: "'DM Mono', monospace", fontSize: 10, color: "#ff6b6b" }}>{bgError}</span>}
                </>
              )}
              {hasFittable && (
                <>
                  <Btn onClick={() => runFit(true)} disabled={!!fitting || fittingBg}>
                    {fitting === "quick" ? "Fitting…" : "Quick Fit"}
                  </Btn>
                  <Btn variant="primary" onClick={() => runFit(false)} disabled={!!fitting || fittingBg}>
                    {fitting === "full" ? "Fitting…" : "Fit TCH"}
                  </Btn>
                  {fitError && <span style={{ fontFamily: "'DM Mono', monospace", fontSize: 10, color: "#ff6b6b" }}>{fitError}</span>}
                </>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── ViewDataModal ──────────────────────────────────────────────────────────────

function ViewDataModal({ sampleId, files, loading, onClose }) {
  const T = useTheme();

  const fmt = (bytes) => {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
  };

  const fmtDate = (ts) => {
    const d = new Date(ts * 1000);
    return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" })
      + "  " + d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  };

  // Strip the leading "{meas_type}_" prefix for a cleaner display label
  const label = (filename) => {
    const m = filename.match(/^[^_]+_(.*)/);
    return m ? m[1] : filename;
  };

  const measType = (filename) => filename.split("_")[0] ?? "";

  const MEAS_LABELS = {
    pe: "PE Loop", diel_b: "Dielectric", diel_b_up: "Dielectric ↑", diel_b_down: "Dielectric ↓",
    iv: "IV", pulsed: "Pulsed", xrd_ot: "XRD θ/2θ", xrr: "XRR", rsm: "RSM", afm: "AFM",
  };

  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1000 }}
      onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div style={{ background: T.bg1, border: `1px solid ${T.border}`, borderRadius: 10, width: 580, maxWidth: "92vw", maxHeight: "80vh", display: "flex", flexDirection: "column", boxShadow: "0 8px 40px rgba(0,0,0,0.45)" }}>
        {/* Header */}
        <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "14px 18px", borderBottom: `1px solid ${T.border}` }}>
          <span style={{ fontFamily: "'DM Mono', monospace", fontSize: 13, color: T.textPrimary, flex: 1 }}>
            Data files — <span style={{ color: T.amber }}>{sampleId}</span>
          </span>
          <span style={{ fontFamily: "'DM Mono', monospace", fontSize: 10, color: T.textDim }}>
            {loading ? "…" : `${files.length} file${files.length !== 1 ? "s" : ""}`}
          </span>
          <button onClick={onClose} style={{ background: "none", border: "none", color: T.textDim, cursor: "pointer", fontSize: 18, lineHeight: 1, padding: 0 }}>✕</button>
        </div>

        {/* File list */}
        <div style={{ overflowY: "auto", flex: 1, padding: "10px 0" }}>
          {loading ? (
            <div style={{ padding: "24px 20px", textAlign: "center", fontFamily: "'DM Mono', monospace", fontSize: 12, color: T.textDim }}>Loading…</div>
          ) : files.length === 0 ? (
            <div style={{ padding: "24px 20px", textAlign: "center", fontFamily: "'DM Mono', monospace", fontSize: 12, color: T.textDim }}>No files found on disk for this sample.</div>
          ) : files.map((f, i) => {
            const mt = measType(f.filename);
            const mtLabel = MEAS_LABELS[mt] ?? mt;
            return (
              <div key={i} style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 18px", borderBottom: `1px solid ${T.border}33`, background: i % 2 === 0 ? "transparent" : T.bg2 + "55" }}>
                {/* Type badge */}
                <span style={{ fontFamily: "'DM Mono', monospace", fontSize: 9, color: T.teal, background: T.teal + "18", border: `1px solid ${T.teal}44`, borderRadius: 4, padding: "2px 6px", minWidth: 64, textAlign: "center", flexShrink: 0 }}>
                  {mtLabel}
                </span>
                {/* Filename */}
                <span style={{ fontFamily: "'DM Mono', monospace", fontSize: 11, color: T.textPrimary, flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={f.filename}>
                  {label(f.filename)}
                </span>
                {/* Size */}
                <span style={{ fontFamily: "'DM Mono', monospace", fontSize: 10, color: T.textDim, flexShrink: 0 }}>
                  {fmt(f.size_bytes)}
                </span>
                {/* Date */}
                <span style={{ fontFamily: "'DM Mono', monospace", fontSize: 10, color: T.textDim, flexShrink: 0, minWidth: 150, textAlign: "right" }}>
                  {fmtDate(f.modified)}
                </span>
                {/* Download link */}
                <a href={`${API_BASE}/samples/${sampleId}/files/${encodeURIComponent(f.filename)}`}
                  download={f.filename}
                  title="Download"
                  style={{ color: T.textDim, textDecoration: "none", fontSize: 14, flexShrink: 0, opacity: 0.7 }}
                  onMouseEnter={e => e.currentTarget.style.opacity = 1}
                  onMouseLeave={e => e.currentTarget.style.opacity = 0.7}>
                  ↓
                </a>
              </div>
            );
          })}
        </div>

        {/* Footer */}
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, padding: "12px 18px", borderTop: `1px solid ${T.border}` }}>
          <button onClick={onClose}
            style={{ fontFamily: "'DM Mono', monospace", fontSize: 11, padding: "5px 16px", borderRadius: 5, border: `1px solid ${T.border}`, background: T.bg2, color: T.textSecondary, cursor: "pointer" }}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}

// ── ExportModal ────────────────────────────────────────────────────────────────

function ExportModal({ samples, onClose }) {
  const sampleTechnique = s => s.technique || "";

  const allSubstrates = [...new Set(samples.map(s => s.substrate).filter(Boolean))].sort();

  const [technique,  setTechnique]  = useState("all");   // "all" | "sputter" | "pld"
  const [dateFrom,   setDateFrom]   = useState("");
  const [dateTo,     setDateTo]     = useState("");
  const [substrate,  setSubstrate]  = useState("");

  const filtered = samples
    .filter(s => technique === "all" || sampleTechnique(s) === technique)
    .filter(s => !dateFrom  || (s.date && s.date >= dateFrom))
    .filter(s => !dateTo    || (s.date && s.date <= dateTo))
    .filter(s => !substrate || s.substrate === substrate)
    .slice()
    .sort((a, b) => (a.date || "").localeCompare(b.date || ""));

  const doExport = () => {
    const esc = v => {
      const s = v == null ? "" : String(v);
      return s.includes(",") || s.includes('"') || s.includes("\n")
        ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const MAX_LAYERS = 5;

    const layerInfo = (s, li) => {
      const l = (s.layers || [])[li];
      if (!l) return { mats:"", temp:"", pressure:"", o2:"", power:"", energy:"", freq:"", time:"", pulses:"" };
      const t0 = l.targets?.[0] || {};
      return {
        mats:     (l.targets||[]).map(t => t.material).filter(Boolean).join(" + "),
        temp:     l.temp     ?? "",
        pressure: l.pressure ?? "",
        o2:       l.oxygen_pct  ?? "",
        power:    (l.targets||[]).map(t => t.power_W).filter(v => v != null).join(" + "),
        energy:   t0.energy_mJ  ?? "",
        freq:     l.frequency_hz ?? "",
        time:     l.time_s      ?? "",
        pulses:   (l.targets||[]).map(t => t.pulses).filter(v => v != null).join(" + "),
      };
    };

    const isSputter = technique === "sputter" || technique === "all";
    const isPld     = technique === "pld"     || technique === "all";

    const fieldRows = [
      ["Sample ID",      s => s.id],
      ["Date",           s => s.date || ""],
      ["Substrate",      s => s.substrate || ""],
      ["Thickness (nm)", s => s.thickness_nm ?? ""],
      ["Notes",          s => s.notes || ""],
      ...(technique === "all" ? [["Technique", s => sampleTechnique(s)]] : []),
      ["", () => ""],
    ];

    for (let li = 0; li < MAX_LAYERS; li++) {
      const n = `Layer ${li + 1}`;
      fieldRows.push(
        [`${n} — Material(s)`,      s => layerInfo(s, li).mats],
        [`${n} — Temp (°C)`,        s => layerInfo(s, li).temp],
        [`${n} — Pressure (mTorr)`, s => layerInfo(s, li).pressure],
        ...(isSputter ? [
          [`${n} — O2 (%)`,   s => layerInfo(s, li).o2],
          [`${n} — Power (W)`,s => layerInfo(s, li).power],
          [`${n} — Time (s)`, s => layerInfo(s, li).time],
        ] : []),
        ...(isPld ? [
          [`${n} — Energy (mJ)`,    s => layerInfo(s, li).energy],
          [`${n} — Frequency (Hz)`, s => layerInfo(s, li).freq],
          [`${n} — Pulses`,         s => layerInfo(s, li).pulses],
        ] : []),
        ["", () => ""],
      );
    }

    const csvRows = [["", ...filtered.map(s => s.id)].map(esc).join(",")];
    for (const [label, getter] of fieldRows) {
      csvRows.push([label, ...filtered.map(getter)].map(esc).join(","));
    }

    const blob = new Blob([csvRows.join("\n")], { type: "text/csv" });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement("a");
    const ts   = new Date().toISOString().replace(/[T:]/g, "-").slice(0, 16);
    a.href = url; a.download = `samples_${ts}.csv`; a.click();
    URL.revokeObjectURL(url);
    onClose();
  };

  const labelSm = txt => (
    <span style={{ fontFamily: "'DM Mono', monospace", fontSize: 10, color: T.textDim, textTransform: "uppercase", letterSpacing: 1.5, width: 80, flexShrink: 0 }}>{txt}</span>
  );
  const segBtn = (val, current, set, label) => (
    <button key={val} onClick={() => set(val)}
      style={{ fontFamily: "'DM Mono', monospace", fontSize: 10, padding: "4px 12px",
        background: current === val ? T.bg3 : T.bg0,
        border: "none", color: current === val ? T.textPrimary : T.textDim,
        cursor: "pointer", textTransform: "uppercase", letterSpacing: 0.5 }}>
      {label}
    </button>
  );

  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.65)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 100 }}
      onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div style={{ background: T.bg1, border: `1px solid ${T.borderBright}`, borderRadius: 12, padding: "24px 28px", width: 440, display: "flex", flexDirection: "column", gap: 16 }}>
        <h2 style={{ margin: 0, fontFamily: "'Playfair Display', serif", color: T.amber, fontSize: 20 }}>Export Samples</h2>

        {/* Technique */}
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          {labelSm("Technique")}
          <div style={{ display: "flex", borderRadius: 4, overflow: "hidden", border: `1px solid ${T.border}` }}>
            {[["all","All"],["sputter","Sputter"],["pld","PLD"]].map(([v,l], i, arr) => (
              <button key={v} onClick={() => setTechnique(v)}
                style={{ fontFamily: "'DM Mono', monospace", fontSize: 10, padding: "4px 14px",
                  background: technique === v ? T.bg3 : T.bg0, border: "none",
                  borderRight: i < arr.length-1 ? `1px solid ${T.border}` : "none",
                  color: technique === v ? T.textPrimary : T.textDim,
                  cursor: "pointer", textTransform: "uppercase", letterSpacing: 0.5 }}>
                {l}
              </button>
            ))}
          </div>
        </div>

        {/* Date range */}
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          {labelSm("Date")}
          <input type="date" value={dateFrom} onChange={e => setDateFrom(e.target.value)}
            style={{ background: T.bg0, border: `1px solid ${T.border}`, borderRadius: 4, color: T.textPrimary, fontFamily: "'DM Mono', monospace", fontSize: 11, padding: "4px 8px", outline: "none" }} />
          <span style={{ fontFamily: "'DM Mono', monospace", fontSize: 10, color: T.textDim }}>–</span>
          <input type="date" value={dateTo} onChange={e => setDateTo(e.target.value)}
            style={{ background: T.bg0, border: `1px solid ${T.border}`, borderRadius: 4, color: T.textPrimary, fontFamily: "'DM Mono', monospace", fontSize: 11, padding: "4px 8px", outline: "none" }} />
        </div>

        {/* Substrate */}
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          {labelSm("Substrate")}
          <select value={substrate} onChange={e => setSubstrate(e.target.value)}
            style={{ background: T.bg0, border: `1px solid ${T.border}`, borderRadius: 4, color: substrate ? T.textPrimary : T.textDim, fontFamily: "'DM Mono', monospace", fontSize: 11, padding: "4px 8px", outline: "none" }}>
            <option value="">All</option>
            {allSubstrates.map(s => <option key={s} value={s}>{s}</option>)}
          </select>
        </div>

        {/* Count */}
        <div style={{ fontFamily: "'DM Mono', monospace", fontSize: 11, color: T.textDim, borderTop: `1px solid ${T.border}`, paddingTop: 12 }}>
          {filtered.length} sample{filtered.length !== 1 ? "s" : ""} will be exported
        </div>

        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
          <Btn variant="ghost" onClick={onClose}>Cancel</Btn>
          <Btn variant="primary" onClick={doExport} disabled={filtered.length === 0}>Export CSV</Btn>
        </div>
      </div>
    </div>
  );
}

// ── SettingsModal ─────────────────────────────────────────────────────────────

function SettingsModal({ settings, onSave, onClose }) {
  const [draft, setDraft] = useState(() => JSON.parse(JSON.stringify(settings)));
  const [knownMaterials, setKnownMaterials] = useState([]);
  const [libOpen, setLibOpen] = useState({ matSputter: false, matPld: false, struct: false });
  useEffect(() => { api("GET", "/materials").then(setKnownMaterials).catch(() => {}); }, []);
  const set = (path, v) => setDraft(p => {
    const d = JSON.parse(JSON.stringify(p));
    const keys = path.split(".");
    let cur = d;
    for (let i = 0; i < keys.length - 1; i++) cur = cur[keys[i]];
    cur[keys[keys.length - 1]] = v;
    return d;
  });

  const sectionHdr = (label) => (
    <div style={{ fontFamily: "'DM Mono', monospace", fontSize: 10, color: T.textDim, textTransform: "uppercase", letterSpacing: 2, borderBottom: `1px solid ${T.border}`, paddingBottom: 4, marginBottom: 0, marginTop: 6 }}>{label}</div>
  );
  const fieldSm = (path, label, unit, w = 64, type = "text") => (
    <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
      <span style={{ fontSize: 9, color: T.textDim, fontFamily: "'DM Mono', monospace", textTransform: "uppercase" }}>{label}</span>
      <div style={{ display: "flex", alignItems: "center", gap: 3 }}>
        <input type={type} value={path.split(".").reduce((o, k) => o?.[k] ?? "", draft) ?? ""}
          onChange={e => set(path, e.target.value)}
          style={{ width: w, background: T.bg0, border: `1px solid ${T.borderBright}`, borderRadius: 4, color: T.textPrimary, padding: "4px 6px", fontFamily: "'DM Mono', monospace", fontSize: 12, outline: "none", boxSizing: "border-box", textAlign: "center" }} />
        {unit && <span style={{ fontSize: 10, color: T.textDim, fontFamily: "'DM Mono', monospace", whiteSpace: "nowrap" }}>{unit}</span>}
      </div>
    </div>
  );

  // Material library helpers
  const addMat = (tech) => setDraft(p => {
    const d = JSON.parse(JSON.stringify(p));
    d.materials[tech].push(tech === "sputter"
      ? { name: "", power_W: "", temp: "", pressure: "", oxygen_pct: "", time_s: "" }
      : { name: "", energy_mJ: "", pulses: "", temp: "", pressure: "", frequency_hz: "" });
    return d;
  });
  const removeMat = (tech, i) => setDraft(p => {
    const d = JSON.parse(JSON.stringify(p));
    d.materials[tech].splice(i, 1);
    return d;
  });
  const setMat = (tech, i, k, v) => setDraft(p => {
    const d = JSON.parse(JSON.stringify(p));
    d.materials[tech][i][k] = v;
    return d;
  });

  const matInput = (tech, i, k, label, unit, w = 52) => (
    <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
      <span style={{ fontSize: 9, color: T.textDim, fontFamily: "'DM Mono', monospace", textTransform: "uppercase" }}>{label}</span>
      <div style={{ display: "flex", alignItems: "center", gap: 2 }}>
        <input value={draft.materials[tech][i][k] ?? ""}
          onChange={e => setMat(tech, i, k, e.target.value)}
          placeholder="—"
          style={{ width: w, background: T.bg0, border: `1px solid ${T.border}`, borderRadius: 4, color: T.textPrimary, padding: "3px 5px", fontFamily: "'DM Mono', monospace", fontSize: 11, outline: "none", boxSizing: "border-box", textAlign: "center" }} />
        {unit && <span style={{ fontSize: 9, color: T.textDim, fontFamily: "'DM Mono', monospace" }}>{unit}</span>}
      </div>
    </div>
  );

  // Structure library helpers
  const [cifDragIdx, setCifDragIdx] = useState(null);
  const addStruct = () => setDraft(p => ({
    ...p, structures: [...(p.structures || []), { name: "", a: "", b: "", c: "", alpha: "", beta: "", gamma: "", poisson: "", cif_filename: "", cif_text: "" }]
  }));
  const removeStruct = (i) => setDraft(p => ({ ...p, structures: p.structures.filter((_, j) => j !== i) }));
  const setStruct = (i, k, v) => setDraft(p => {
    const structs = [...p.structures];
    structs[i] = { ...structs[i], [k]: v };
    return { ...p, structures: structs };
  });
  const importCIF = (i, file) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      const text = e.target.result;
      const parsed = parseCIF(text);
      setDraft(p => {
        const structs = [...p.structures];
        structs[i] = { ...structs[i], ...parsed, name: structs[i].name || parsed.name, cif_filename: file.name, cif_text: text };
        return { ...p, structures: structs };
      });
    };
    reader.readAsText(file);
  };

  const structInput = (i, k, label, unit, w = 62) => (
    <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
      <span style={{ fontSize: 11, color: T.textDim, fontFamily: "'DM Mono', monospace", textAlign: "center" }}>{label}</span>
      <div style={{ display: "flex", alignItems: "center", gap: 3 }}>
        <input type="number" className="no-spin" value={draft.structures[i][k] ?? ""}
          onChange={e => setStruct(i, k, e.target.value)}
          placeholder="—"
          style={{ width: w, background: T.bg0, border: `1px solid ${T.border}`, borderRadius: 4, color: T.textPrimary, padding: "3px 5px", fontFamily: "'DM Mono', monospace", fontSize: 12, outline: "none", boxSizing: "border-box", textAlign: "center" }} />
        {unit && <span style={{ fontSize: 10, color: T.textDim, fontFamily: "'DM Mono', monospace" }}>{unit}</span>}
      </div>
    </div>
  );

  const renderStructLib = () => (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      {(draft.structures || []).map((s, i) => (
        <div key={i} style={{ background: T.bg3, border: `1px solid ${T.border}`, borderRadius: 6, padding: "8px 10px", display: "flex", flexDirection: "column", gap: 8 }}>
          {/* Row 1: name + CIF drop zone + delete */}
          <div style={{ display: "flex", alignItems: "flex-end", gap: 8 }}>
            <div style={{ display: "flex", flexDirection: "column", gap: 2, flex: 1 }}>
              <span style={{ fontSize: 9, color: T.textDim, fontFamily: "'DM Mono', monospace", textTransform: "uppercase" }}>Name</span>
              <input value={s.name ?? ""}
                onChange={e => setStruct(i, "name", e.target.value)}
                placeholder="e.g. BaTiO3"
                style={{ width: "100%", background: T.bg0, border: `1px solid ${T.border}`, borderRadius: 4, color: T.textPrimary, padding: "3px 6px", fontFamily: "'DM Mono', monospace", fontSize: 12, outline: "none", boxSizing: "border-box" }} />
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
              <span style={{ fontSize: 9, color: T.textDim, fontFamily: "'DM Mono', monospace", textTransform: "uppercase" }}>CIF</span>
              <label
                onDragOver={e => { e.preventDefault(); setCifDragIdx(i); }}
                onDragLeave={() => setCifDragIdx(null)}
                onDrop={e => { e.preventDefault(); setCifDragIdx(null); const f = e.dataTransfer.files[0]; if (f) importCIF(i, f); }}
                style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 2, background: cifDragIdx === i ? T.amberGlow : T.bg0, border: `1px dashed ${cifDragIdx === i ? T.amber : s.cif_filename ? T.teal : T.border}`, borderRadius: 4, color: cifDragIdx === i ? T.amber : s.cif_filename ? T.teal : T.textDim, fontFamily: "'DM Mono', monospace", fontSize: 10, padding: "3px 10px", cursor: "pointer", whiteSpace: "nowrap", transition: "all .15s", textAlign: "center" }}>
                {s.cif_filename
                  ? <span style={{ maxWidth: 140, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>↑ {s.cif_filename}</span>
                  : "drop .cif or click"}
                <input type="file" accept=".cif" style={{ display: "none" }} onChange={e => { if (e.target.files[0]) importCIF(i, e.target.files[0]); e.target.value = ""; }} />
              </label>
            </div>
            <button onClick={() => removeStruct(i)}
              style={{ background: "none", border: "none", color: T.red, cursor: "pointer", fontSize: 18, lineHeight: 1, padding: "0 2px", marginBottom: 1 }}>×</button>
          </div>
          {/* Row 2: lattice params + Poisson */}
          <div style={{ display: "flex", alignItems: "flex-end", gap: 8 }}>
            {structInput(i, "a",       "a",  "Å", 54)}
            {structInput(i, "b",       "b",  "Å", 54)}
            {structInput(i, "c",       "c",  "Å", 54)}
            <div style={{ width: 1, alignSelf: "stretch", background: T.border, margin: "0 2px" }} />
            {structInput(i, "alpha",   "α",  "°", 50)}
            {structInput(i, "beta",    "β",  "°", 50)}
            {structInput(i, "gamma",   "γ",  "°", 50)}
            <div style={{ width: 1, alignSelf: "stretch", background: T.border, margin: "0 2px" }} />
            {structInput(i, "poisson", "ν",  "",  50)}
          </div>
        </div>
      ))}
      <button onClick={addStruct}
        style={{ background: "none", border: `1px dashed ${T.border}`, borderRadius: 5, color: T.teal, fontFamily: "'DM Mono', monospace", fontSize: 11, padding: "4px 10px", cursor: "pointer", alignSelf: "flex-start" }}>
        + Add structure
      </button>
    </div>
  );

  const renderMatLib = (tech) => (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      {draft.materials[tech].map((m, i) => (
        <div key={i} style={{ background: T.bg3, border: `1px solid ${T.border}`, borderRadius: 6, padding: "8px 10px", display: "flex", alignItems: "flex-end", gap: 8, flexWrap: "wrap" }}>
          <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
            <span style={{ fontSize: 9, color: T.textDim, fontFamily: "'DM Mono', monospace", textTransform: "uppercase" }}>Material</span>
            <div style={{ width: 100 }}>
              <MaterialCombobox value={m.name} onChange={v => setMat(tech, i, "name", v)} knownMaterials={knownMaterials} small />
            </div>
          </div>
          {tech === "sputter" ? (<>
            {matInput(tech, i, "power_W",    "Power",  "W",    52)}
            {matInput(tech, i, "temp",       "Temp",   "°C",   52)}
            {matInput(tech, i, "pressure",   "Press",  "mT",   52)}
            {matInput(tech, i, "oxygen_pct", "O₂",     "%",    44)}
            {matInput(tech, i, "time_s",     "Time",   "s",    52)}
          </>) : (<>
            {matInput(tech, i, "energy_mJ",   "Energy", "mJ",   52)}
            {matInput(tech, i, "pulses",      "Pulses", "",     64)}
            {matInput(tech, i, "temp",        "Temp",   "°C",   52)}
            {matInput(tech, i, "pressure",    "Press",  "mT",   52)}
            {matInput(tech, i, "frequency_hz","Rep",    "Hz",   48)}
          </>)}
          <button onClick={() => removeMat(tech, i)}
            style={{ background: "none", border: "none", color: T.red, cursor: "pointer", fontSize: 18, lineHeight: 1, padding: "0 2px", alignSelf: "flex-end", marginBottom: 1 }}>×</button>
        </div>
      ))}
      <button onClick={() => addMat(tech)}
        style={{ background: "none", border: `1px dashed ${T.border}`, borderRadius: 5, color: T.teal, fontFamily: "'DM Mono', monospace", fontSize: 11, padding: "4px 10px", cursor: "pointer", alignSelf: "flex-start" }}>
        + Add material
      </button>
    </div>
  );

  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.75)", display: "flex", alignItems: "flex-start", justifyContent: "center", zIndex: 100, overflowY: "auto", padding: "80px 20px 40px" }}>
      <style>{`.no-spin::-webkit-inner-spin-button,.no-spin::-webkit-outer-spin-button{-webkit-appearance:none;margin:0}.no-spin{-moz-appearance:textfield}`}</style>
      <div style={{ background: T.bg1, border: `1px solid ${T.borderBright}`, borderRadius: 12, padding: "20px 24px", width: 640, display: "flex", flexDirection: "column", gap: 10, marginBottom: 40 }}>
        <h2 style={{ margin: 0, fontFamily: "'Playfair Display', serif", color: T.amber, fontSize: 22 }}>Settings</h2>

        {/* General */}
        {sectionHdr("General")}
        <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
          <div style={{ flex: 2, minWidth: 180 }}>
            <div style={{ fontSize: 9, color: T.textDim, fontFamily: "'DM Mono', monospace", textTransform: "uppercase", marginBottom: 4 }}>Default Substrate</div>
            <input value={draft.defaultSubstrate}
              onChange={e => set("defaultSubstrate", e.target.value)}
              placeholder="e.g. STO (001)"
              style={{ width: "100%", background: T.bg0, border: `1px solid ${T.borderBright}`, borderRadius: 4, color: T.textPrimary, padding: "5px 8px", fontFamily: "'DM Mono', monospace", fontSize: 12, outline: "none", boxSizing: "border-box" }} />
          </div>
          <div style={{ flex: 1, minWidth: 120 }}>
            <div style={{ fontSize: 9, color: T.textDim, fontFamily: "'DM Mono', monospace", textTransform: "uppercase", marginBottom: 4 }}>Default Lot</div>
            <input value={draft.defaultLot ?? ""}
              onChange={e => set("defaultLot", e.target.value)}
              placeholder="e.g. W2024-01"
              style={{ width: "100%", background: T.bg0, border: `1px solid ${T.borderBright}`, borderRadius: 4, color: T.textPrimary, padding: "5px 8px", fontFamily: "'DM Mono', monospace", fontSize: 12, outline: "none", boxSizing: "border-box" }} />
          </div>
          <div>
            {fieldSm("defaultAreaCm2", "Default Cap. Area", "cm²", 80)}
          </div>
        </div>

        {/* Sputter defaults */}
        {sectionHdr("Sputter Defaults")}
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
          {fieldSm("sputter.temp",       "Temp",    "°C")}
          {fieldSm("sputter.pressure",   "Pressure","mTorr")}
          {fieldSm("sputter.oxygen_pct", "O₂",      "%",  52)}
          {fieldSm("sputter.time_s",     "Time",    "s",  72)}
          {fieldSm("sputter.power_W",    "Power",   "W",  60)}
        </div>

        {/* PLD defaults */}
        {sectionHdr("PLD Defaults")}
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
          {fieldSm("pld.temp",         "Temp",     "°C")}
          {fieldSm("pld.pressure",     "Pressure", "mTorr")}
          {fieldSm("pld.frequency_hz", "Rep rate", "Hz",  60)}
          {fieldSm("pld.energy_mJ",    "Energy",   "mJ",  60)}
          {fieldSm("pld.pulses",       "Pulses",   "",    72)}
        </div>

        {/* Material library — Sputter (collapsible) */}
        <button onClick={() => setLibOpen(s => ({ ...s, matSputter: !s.matSputter }))}
          style={{ display: "flex", alignItems: "center", justifyContent: "space-between", background: "none", border: "none", borderBottom: `1px solid ${T.border}`, paddingBottom: 4, marginBottom: 0, marginTop: 6, cursor: "pointer", width: "100%", textAlign: "left" }}>
          <span style={{ fontFamily: "'DM Mono', monospace", fontSize: 10, color: T.textDim, textTransform: "uppercase", letterSpacing: 2 }}>Material Library — Sputter</span>
          <span style={{ fontFamily: "'DM Mono', monospace", fontSize: 12, color: T.textDim, lineHeight: 1 }}>{libOpen.matSputter ? "▴" : "▾"}</span>
        </button>
        {libOpen.matSputter && <>
          <div style={{ fontSize: 11, color: T.textDim, fontFamily: "'DM Mono', monospace", marginTop: -2, marginBottom: 2 }}>Leave fields blank to use global sputter defaults for that material.</div>
          {renderMatLib("sputter")}
        </>}

        {/* Material library — PLD (collapsible) */}
        <button onClick={() => setLibOpen(s => ({ ...s, matPld: !s.matPld }))}
          style={{ display: "flex", alignItems: "center", justifyContent: "space-between", background: "none", border: "none", borderBottom: `1px solid ${T.border}`, paddingBottom: 4, marginBottom: 0, marginTop: 6, cursor: "pointer", width: "100%", textAlign: "left" }}>
          <span style={{ fontFamily: "'DM Mono', monospace", fontSize: 10, color: T.textDim, textTransform: "uppercase", letterSpacing: 2 }}>Material Library — PLD</span>
          <span style={{ fontFamily: "'DM Mono', monospace", fontSize: 12, color: T.textDim, lineHeight: 1 }}>{libOpen.matPld ? "▴" : "▾"}</span>
        </button>
        {libOpen.matPld && <>
          <div style={{ fontSize: 11, color: T.textDim, fontFamily: "'DM Mono', monospace", marginTop: -2, marginBottom: 2 }}>Leave fields blank to use global PLD defaults for that material.</div>
          {renderMatLib("pld")}
        </>}

        {/* Structure library (collapsible) */}
        <button onClick={() => setLibOpen(s => ({ ...s, struct: !s.struct }))}
          style={{ display: "flex", alignItems: "center", justifyContent: "space-between", background: "none", border: "none", borderBottom: `1px solid ${T.border}`, paddingBottom: 4, marginBottom: 0, marginTop: 6, cursor: "pointer", width: "100%", textAlign: "left" }}>
          <span style={{ fontFamily: "'DM Mono', monospace", fontSize: 10, color: T.textDim, textTransform: "uppercase", letterSpacing: 2 }}>Structure Library</span>
          <span style={{ fontFamily: "'DM Mono', monospace", fontSize: 12, color: T.textDim, lineHeight: 1 }}>{libOpen.struct ? "▴" : "▾"}</span>
        </button>
        {libOpen.struct && <>
          <div style={{ fontSize: 11, color: T.textDim, fontFamily: "'DM Mono', monospace", marginTop: -2, marginBottom: 2 }}>Lattice parameters for peak prediction and strain calculations. Drop a .cif onto an entry to auto-fill.</div>
          {renderStructLib()}
        </>}

        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 4 }}>
          <Btn variant="ghost" onClick={onClose}>Cancel</Btn>
          <Btn onClick={() => { onSave(draft); onClose(); }}>Save Settings</Btn>
        </div>
      </div>
    </div>
  );
}

// ── SampleCard ────────────────────────────────────────────────────────────────

function SampleCard({ sample, onClick, onDelete, onDuplicateTemplate, plotData, onDragStart }) {
  const [menuOpen, setMenuOpen] = useState(false);
  const wasDragged = useRef(false);
  const materials = [...new Set((sample.layers || []).flatMap(l => (l.targets || []).map(t => t.material).filter(Boolean)))];
  const dataCount = Object.values(sample.filenames || {}).filter(Boolean).length;

  return (
    <div
      draggable
      onDragStart={e => { wasDragged.current = true; e.dataTransfer.effectAllowed = "move"; e.dataTransfer.setData("text/x-sample", sample.id); onDragStart?.(sample.id); }}
      onDragEnd={() => { setTimeout(() => { wasDragged.current = false; }, 50); }}
      onClick={() => { if (wasDragged.current) return; onClick(); }}
      style={{ position: "relative", background: T.bg1, border: `1px solid ${T.border}`, borderRadius: 10, padding: "14px 18px", cursor: "grab", transition: "all .15s", display: "flex", flexDirection: "column", gap: 9 }}
      onMouseEnter={e => { e.currentTarget.style.borderColor = T.amberDim; e.currentTarget.style.background = T.bg2; }}
      onMouseLeave={e => { e.currentTarget.style.borderColor = T.border;   e.currentTarget.style.background = T.bg1; }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{ fontFamily: "'Playfair Display', serif", fontSize: 20, color: T.amber }}>{sample.id}</span>
          {sample.technique && <span style={{ fontFamily: "'DM Mono', monospace", fontSize: 10, color: T.textDim, background: T.bg2, border: `1px solid ${T.border}`, borderRadius: 3, padding: "1px 5px" }}>{sample.technique}</span>}
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{ fontFamily: "'DM Mono', monospace", fontSize: 11, color: T.textDim }}>{sample.date}</span>
          <div style={{ position: "relative" }}>
            <button onClick={e => { e.stopPropagation(); setMenuOpen(v => !v); }}
              onBlur={() => setTimeout(() => setMenuOpen(false), 120)}
              style={{ background: "none", border: "none", color: T.textDim, cursor: "pointer", fontSize: 16, lineHeight: 1, padding: "0 2px", borderRadius: 4, letterSpacing: 1 }}>⋯</button>
            {menuOpen && (
              <div style={{ position: "absolute", top: "100%", right: 0, marginTop: 4, background: T.bg2, border: `1px solid ${T.borderBright}`, borderRadius: 6, boxShadow: "0 4px 16px rgba(0,0,0,.5)", zIndex: 200, minWidth: 150, overflow: "hidden" }}>
                <button onClick={e => { e.stopPropagation(); setMenuOpen(false); onDuplicateTemplate?.(sample); }}
                  style={{ display: "block", width: "100%", background: "none", border: "none", color: T.textSecondary, fontFamily: "'DM Mono', monospace", fontSize: 12, padding: "9px 14px", textAlign: "left", cursor: "pointer" }}>
                  Duplicate Template
                </button>
                <div style={{ height: 1, background: T.border, margin: "0 8px" }} />
                <button onClick={e => { e.stopPropagation(); setMenuOpen(false); if (window.confirm(`Delete ${sample.id}?`)) onDelete(sample.id); }}
                  style={{ display: "block", width: "100%", background: "none", border: "none", color: T.red, fontFamily: "'DM Mono', monospace", fontSize: 12, padding: "9px 14px", textAlign: "left", cursor: "pointer" }}>
                  Delete
                </button>
              </div>
            )}
          </div>
        </div>
      </div>
      {sample.substrate && <div style={{ fontFamily: "'DM Mono', monospace", fontSize: 11, color: T.textSecondary }}>{sample.substrate}</div>}
      {materials.length > 0 && (
        <div style={{ display: "flex", gap: 5, flexWrap: "wrap", alignItems: "center" }}>
          {materials.map(m => { const s = getMaterialStyle(m); return (
            <span key={m} style={{ fontFamily: "'DM Mono', monospace", fontSize: 11, color: s.border, background: s.bg, border: `1px solid ${s.border}`, borderRadius: 4, padding: "2px 7px" }}><ChemName name={m} /></span>
          );})}
          {(sample.layers || []).some(l => l.role === "buffer") && (
            <span style={{ fontSize: 10, fontFamily: "'DM Mono', monospace", fontWeight: 600, color: T.teal, background: `${T.teal}22`, border: `1px solid ${T.teal}66`, borderRadius: 3, padding: "1px 5px", letterSpacing: 0.5 }}>BUF</span>
          )}
        </div>
      )}
      {sample.notes && <div style={{ fontFamily: "'DM Mono', monospace", fontSize: 11, color: T.textDim, fontStyle: "italic" }}>{sample.notes}</div>}
      <div style={{ fontFamily: "'DM Mono', monospace", fontSize: 11, color: dataCount > 0 ? T.teal : T.textDim }}>
        {dataCount > 0 ? `${dataCount} dataset${dataCount > 1 ? "s" : ""} attached` : "no data yet"}
      </div>
    </div>
  );
}

// ── FolderTile ────────────────────────────────────────────────────────────────

const COLOR_OPTIONS = ["#4a5568", "#3182ce", "#38a169", "#d69e2e", "#9f7aea", "#ed64a6", "#fc8181", "#4fd1c5"];

function FolderTile({ folder, samples, childContent = null, plotCache, depth = 0,
  onSelectSample, onDeleteSample, onDuplicateTemplate, onEdit, onDelete,
  onDropSample, onDragStartSample, onDragStartFolder, onDropFolder }) {
  const lsKey = `folder-open-${folder.id}`;
  const [open, setOpen] = useState(() => { try { const v = localStorage.getItem(lsKey); return v === null ? false : v === "1"; } catch { return false; } });
  const toggleOpen = () => setOpen(v => { const next = !v; try { localStorage.setItem(lsKey, next ? "1" : "0"); } catch {} return next; });
  const [sampleDragOver, setSampleDragOver] = useState(false);
  const [insertPos, setInsertPos] = useState(null);
  const folderBoxRef = useRef(null);
  const color = folder.color || T.borderBright;
  const isFolderDrag = e => e.dataTransfer.types.includes("text/x-folder");

  const handleDragOver = e => {
    e.preventDefault();
    if (isFolderDrag(e)) {
      const rect = folderBoxRef.current?.getBoundingClientRect();
      if (rect) {
        const pct = (e.clientY - rect.top) / rect.height;
        setInsertPos(pct < 0.25 ? "above" : pct > 0.75 ? "below" : "inside");
      }
      e.dataTransfer.dropEffect = "move";
    } else {
      e.dataTransfer.dropEffect = "move";
      setSampleDragOver(true);
    }
  };
  const handleDragLeave = e => {
    if (!e.currentTarget.contains(e.relatedTarget)) {
      setSampleDragOver(false);
      setInsertPos(null);
    }
  };
  const handleDrop = e => {
    e.preventDefault();
    if (isFolderDrag(e)) {
      const fid = e.dataTransfer.getData("text/x-folder");
      onDropFolder?.(fid, folder.id, insertPos ?? "inside");
    } else {
      onDropSample?.();
    }
    setSampleDragOver(false);
    setInsertPos(null);
  };
  const folderDragInside = insertPos === "inside";

  return (
    <div onDragOver={handleDragOver} onDragLeave={handleDragLeave} onDrop={handleDrop}
      style={{ marginLeft: depth > 0 ? 10 : 0, marginBottom: 8 }}>
      {insertPos === "above" && <div style={{ height: 3, background: T.amber, borderRadius: 2, marginBottom: 4 }} />}
      <div ref={folderBoxRef}
        style={{ border: `2px solid ${sampleDragOver || folderDragInside ? T.amber : color}`, borderRadius: 10, overflow: "hidden", boxShadow: sampleDragOver || folderDragInside ? `0 0 0 3px ${T.amberGlow}` : "none", transition: "border-color .12s, box-shadow .12s" }}>
        <div style={{ padding: "10px 16px", display: "flex", alignItems: "center", gap: 10, background: sampleDragOver || folderDragInside ? T.bg3 : T.bg2, cursor: "pointer", userSelect: "none", transition: "background .12s" }}
          onClick={toggleOpen}>
          <span
            draggable
            onDragStart={e => {
              e.stopPropagation();
              e.dataTransfer.effectAllowed = "move";
              e.dataTransfer.setData("text/x-folder", folder.id);
              const ghost = document.createElement("div");
              ghost.style.cssText = `position:fixed;top:-1000px;left:-1000px;background:${T.bg2};border:2px solid ${color};border-radius:8px;padding:7px 14px;display:flex;align-items:center;gap:8px;font-family:'Playfair Display',serif;font-size:14px;color:${T.textPrimary};white-space:nowrap;pointer-events:none;box-shadow:0 4px 16px rgba(0,0,0,.4)`;
              ghost.innerHTML = `<span style="color:${T.textDim};font-size:14px;margin-right:2px">⠿</span><span style="width:10px;height:10px;border-radius:50%;background:${color};display:inline-block;flex-shrink:0"></span><span style="margin-left:4px">${folder.name}</span>`;
              document.body.appendChild(ghost);
              e.dataTransfer.setDragImage(ghost, 20, 18);
              setTimeout(() => document.body.removeChild(ghost), 0);
              onDragStartFolder?.(folder.id);
            }}
            onClick={e => e.stopPropagation()}
            style={{ cursor: "grab", color: T.textDim, fontSize: 16, lineHeight: 1, padding: "0 2px", flexShrink: 0, userSelect: "none" }}>⠿</span>
          <div style={{ width: 12, height: 12, borderRadius: "50%", background: color, flexShrink: 0 }} />
          <span style={{ fontFamily: "'Playfair Display', serif", fontSize: 16, color: T.textPrimary, flex: 1 }}>{folder.name}</span>
          <span style={{ fontFamily: "'DM Mono', monospace", fontSize: 11, color: T.textDim }}>{samples.length}</span>
          <span style={{ color: T.textDim, fontSize: 11 }}>{open ? "▾" : "▸"}</span>
          <button onClick={e => { e.stopPropagation(); onEdit(); }} style={{ background: "none", border: "none", color: T.textDim, cursor: "pointer", fontSize: 13, padding: "0 3px" }}>✎</button>
          <button onClick={e => { e.stopPropagation(); if (window.confirm(`Delete folder "${folder.name}"? Samples will become ungrouped.`)) onDelete(); }} style={{ background: "none", border: "none", color: T.red, cursor: "pointer", fontSize: 16, padding: "0 3px" }}>×</button>
        </div>
        {open && (
          <div style={{ padding: 12, background: T.bg0 }}>
            {childContent}
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(310px,1fr))", gap: 12, marginTop: childContent ? 8 : 0 }}>
              {samples.map(s => <SampleCard key={s.id} sample={s} plotData={plotCache[s.id]} onClick={() => onSelectSample(s.id)} onDelete={onDeleteSample} onDuplicateTemplate={onDuplicateTemplate} onDragStart={onDragStartSample} />)}
              {!samples.length && !childContent && (
                <div style={{ fontFamily: "'DM Mono', monospace", fontSize: 12, color: sampleDragOver ? T.amber : T.textDim, padding: "8px 4px", transition: "color .12s" }}>
                  {sampleDragOver ? "Drop to add to this folder" : "Empty folder"}
                </div>
              )}
            </div>
          </div>
        )}
      </div>
      {insertPos === "below" && <div style={{ height: 3, background: T.amber, borderRadius: 2, marginTop: 4 }} />}
    </div>
  );
}

function AddFolderModal({ onSave, onClose, existing, allFolders = [] }) {
  const [name,     setName]     = useState(existing?.name || "");
  const [color,    setColor]    = useState(existing?.color || COLOR_OPTIONS[0]);
  const [forBooks, setForBooks] = useState(existing?.book_folder ?? false);
  const [parentId, setParentId] = useState(existing?.parent_id || "");

  // Prevent nesting a folder into itself or its descendants
  const getDescendantIds = (id, set = new Set()) => {
    set.add(id);
    allFolders.filter(f => f.parent_id === id).forEach(c => getDescendantIds(c.id, set));
    return set;
  };
  const excludeIds = existing ? getDescendantIds(existing.id) : new Set();
  const parentOptions = allFolders.filter(f => !!f.book_folder === forBooks && !excludeIds.has(f.id));

  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.75)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 100 }}>
      <div style={{ background: T.bg1, border: `1px solid ${T.borderBright}`, borderRadius: 12, padding: 28, width: 360, display: "flex", flexDirection: "column", gap: 16 }}>
        <h2 style={{ margin: 0, fontFamily: "'Playfair Display', serif", color: T.amber, fontSize: 20 }}>{existing ? "Edit Folder" : "New Folder"}</h2>
        <Input label="Name" value={name} onChange={setName} placeholder="e.g. BTO Series" />
        {/* Samples / Analysis Books segmented toggle */}
        <div style={{ display: "flex", background: T.bg2, borderRadius: 8, padding: 3, gap: 2 }}>
          {[{ label: "Samples", value: false }, { label: "Analysis Books", value: true }].map(opt => (
            <button key={String(opt.value)} onClick={() => { setForBooks(opt.value); setParentId(""); }}
              style={{ flex: 1, padding: "6px 0", border: "none", borderRadius: 6, cursor: "pointer", fontFamily: "'DM Mono', monospace", fontSize: 11, letterSpacing: 0.3, transition: "background .15s, color .15s",
                background: forBooks === opt.value ? T.bg0 : "transparent",
                color: forBooks === opt.value ? (opt.value ? T.blue : T.amber) : T.textDim,
                fontWeight: forBooks === opt.value ? 600 : 400,
                boxShadow: forBooks === opt.value ? "0 1px 3px rgba(0,0,0,.25)" : "none" }}>
              {opt.label}
            </button>
          ))}
        </div>
        {/* Parent folder selector */}
        {parentOptions.length > 0 && (
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            <Label>Parent Folder</Label>
            <select value={parentId} onChange={e => setParentId(e.target.value)}
              style={{ background: T.bg0, border: `1px solid ${T.border}`, borderRadius: 6, color: T.textPrimary, fontFamily: "'DM Mono', monospace", fontSize: 12, padding: "7px 10px", outline: "none" }}>
              <option value="">— None (root level) —</option>
              {parentOptions.map(f => <option key={f.id} value={f.id}>{f.name}</option>)}
            </select>
          </div>
        )}
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <Label>Color</Label>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            {COLOR_OPTIONS.map(c => (
              <div key={c} onClick={() => setColor(c)}
                style={{ width: 24, height: 24, borderRadius: "50%", background: c, cursor: "pointer", border: color === c ? `3px solid ${T.textPrimary}` : `2px solid transparent`, transition: "border .1s", boxSizing: "border-box" }} />
            ))}
          </div>
        </div>
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
          <Btn variant="ghost" onClick={onClose}>Cancel</Btn>
          <Btn onClick={() => { if (name.trim()) onSave({ name: name.trim(), color, book_folder: forBooks, parent_id: parentId || null }); }} disabled={!name.trim()}>
            {existing ? "Save" : "Create"}
          </Btn>
        </div>
      </div>
    </div>
  );
}

// ── Analysis Books ────────────────────────────────────────────────────────────

const SCALE_OPTIONS = [
  { value: "viridis",  label: "Viridis"  },
  { value: "cividis",  label: "Cividis"  },
  { value: "inferno",  label: "Inferno"  },
  { value: "magma",    label: "Magma"    },
  { value: "plasma",   label: "Plasma"   },
  { value: "coolwarm", label: "Coolwarm" },
];

// Keys that are data/instance-specific and should never be saved as defaults
const PANEL_DEFAULT_EXCLUDE = new Set([
  "rsm_points",
  "x_min", "x_max", "y_min", "y_max", "y2_min", "y2_max",
  "theta_min", "theta_max",
  "rsm_x_min", "rsm_x_max", "rsm_y_min", "rsm_y_max",
  "x_param", "y_param", "y2_param",
  "afm_ranges",
]);

function saveDefaultPanelConfig(type, config) {
  try {
    const stored = JSON.parse(localStorage.getItem("lablog_panel_defaults") || "{}");
    stored[type] = Object.fromEntries(Object.entries(config).filter(([k]) => !PANEL_DEFAULT_EXCLUDE.has(k)));
    localStorage.setItem("lablog_panel_defaults", JSON.stringify(stored));
  } catch {}
}

function loadDefaultPanelConfig(type) {
  try {
    const stored = JSON.parse(localStorage.getItem("lablog_panel_defaults") || "{}");
    return stored[type] || null;
  } catch { return null; }
}

function defaultPanelConfig(type) {
  const saved = loadDefaultPanelConfig(type);
  const base =
    type === "xrd"  ? { offset_decades: 2, theta_min: null, theta_max: null, pad_above: 2, pad_below: 1 } :
    type === "meta" ? { x_param: "", y_param: "" } :
    {};
  return saved ? { ...base, ...saved } : base;
}

// Inline sample picker shown inside SampleRoster
function SamplePicker({ samples, alreadySelected, onAdd, onClose }) {
  const [sel, setSel] = useState(new Set());
  const available = samples
    .filter(s => !alreadySelected.includes(s.id))
    .sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true, sensitivity: "base" }));
  const toggle = id => setSel(p => { const s = new Set(p); s.has(id) ? s.delete(id) : s.add(id); return s; });
  return (
    <div style={{ marginTop: 8, border: `1px solid ${T.borderBright}`, borderRadius: 8, padding: 10, background: T.bg3, display: "flex", flexDirection: "column", gap: 6 }}>
      <div style={{ maxHeight: 160, overflowY: "auto", display: "flex", flexDirection: "column", gap: 3 }}>
        {available.length === 0 ? (
          <span style={{ color: T.textDim, fontSize: 12, fontFamily: "'DM Mono', monospace" }}>All samples already added.</span>
        ) : available.map(s => (
          <label key={s.id} style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer", fontFamily: "'DM Mono', monospace", fontSize: 12, color: sel.has(s.id) ? T.blue : T.textSecondary, padding: "2px 4px", borderRadius: 4, background: sel.has(s.id) ? "rgba(99,179,237,.1)" : "transparent" }}>
            <input type="checkbox" checked={sel.has(s.id)} onChange={() => toggle(s.id)} style={{ accentColor: T.blue }} />
            <span style={{ fontWeight: 600 }}>{s.id}</span>
            {s.date  && <span style={{ color: T.textDim, fontSize: 10 }}>{s.date}</span>}
            {s.notes && <span style={{ color: T.textDim, fontSize: 10, flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{s.notes}</span>}
          </label>
        ))}
      </div>
      <div style={{ display: "flex", gap: 6, justifyContent: "flex-end" }}>
        <Btn variant="ghost" small onClick={onClose}>Cancel</Btn>
        <Btn small disabled={!sel.size} onClick={() => onAdd([...sel])}>
          Add{sel.size > 0 ? ` ${sel.size}` : ""}
        </Btn>
      </div>
    </div>
  );
}

function SampleRosterRow({ sid, s, color, label, dragOver, onDragStart, onDragOver, onDrop, onDragEnd, onRemove, onLabelChange }) {
  const [localLabel, setLocalLabel] = useState(label || "");
  useEffect(() => { setLocalLabel(label || ""); }, [label]);
  const commit = () => onLabelChange?.(sid, localLabel);
  return (
    <div
      draggable
      onDragStart={onDragStart}
      onDragOver={onDragOver}
      onDrop={onDrop}
      onDragEnd={onDragEnd}
      style={{ display: "flex", alignItems: "center", gap: 8, padding: "5px 4px", borderRadius: 5, background: dragOver ? T.bg3 : "transparent", cursor: "grab", userSelect: "none" }}>
      <span style={{ color: T.textDim, fontSize: 11 }}>⠿</span>
      <div style={{ width: 11, height: 11, borderRadius: "50%", background: color, flexShrink: 0, border: `1px solid ${color}88` }} />
      <span style={{ fontFamily: "'DM Mono', monospace", fontSize: 13, color: T.amber, fontWeight: 600, minWidth: 56 }}>{sid}</span>
      {s?.date  && <span style={{ fontFamily: "'DM Mono', monospace", fontSize: 10, color: T.textDim }}>{s.date}</span>}
      {!s       && <span style={{ fontFamily: "'DM Mono', monospace", fontSize: 10, color: T.red }}>not found</span>}
      <input
        type="text"
        value={localLabel}
        placeholder="legend label…"
        onMouseDown={e => e.stopPropagation()}
        onChange={e => setLocalLabel(e.target.value)}
        onBlur={commit}
        onKeyDown={e => e.key === "Enter" && commit()}
        style={{ width: 120, background: "transparent", border: "none", borderBottom: `1px solid ${T.border}`, borderRadius: 0, color: T.textSecondary, fontFamily: "'DM Mono', monospace", fontSize: 10, outline: "none", padding: "1px 2px" }} />
      <div style={{ flex: 1 }} />
      {s?.notes && <span style={{ fontFamily: "'DM Mono', monospace", fontSize: 10, color: T.textDim, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{s.notes}</span>}
      <button onClick={() => onRemove(sid)}
        style={{ background: "none", border: "none", color: T.textDim, cursor: "pointer", fontSize: 15, lineHeight: 1, marginLeft: "auto", padding: "0 2px" }}>×</button>
    </div>
  );
}

function SampleRoster({ sampleOrder, samples, colors, colorScale, colorTrim, labels = {}, activeMaterial, onChangeActiveMaterial, onReorder, onRemove, onAddSamples, onChangeScale, onChangeTrim, onLabelChange }) {
  const [dragIdx,       setDragIdx]       = useState(null);
  const [dragOverIdx,   setDragOverIdx]   = useState(null);
  const [showPicker,    setShowPicker]    = useState(false);
  const [scaleDropOpen, setScaleDropOpen] = useState(false);
  const [localTrim,     setLocalTrim]     = useState(colorTrim ?? 5);
  useEffect(() => { setLocalTrim(colorTrim ?? 5); }, [colorTrim]);
  const commitTrim = () => onChangeTrim(Math.max(0, Math.min(49, Number(localTrim) || 0)));
  const sampleMap = Object.fromEntries(samples.map(s => [s.id, s]));

  // Collect unique non-co-deposited materials across selected samples
  const availableMaterials = useMemo(() => {
    const seen = new Set();
    for (const sid of sampleOrder) {
      const s = sampleMap[sid];
      if (!s?.layers) continue;
      for (const layer of s.layers) {
        if (layer.targets?.length === 1 && layer.targets[0].material)
          seen.add(layer.targets[0].material);
      }
    }
    return [...seen].sort();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sampleOrder, samples]);
  return (
    <div style={{ background: T.bg1, border: `1px solid ${T.border}`, borderRadius: 10, padding: "14px 16px" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: sampleOrder.length ? 10 : 0, flexWrap: "wrap" }}>
        <span style={{ fontFamily: "'DM Mono', monospace", fontSize: 11, color: T.textDim, textTransform: "uppercase", letterSpacing: 1 }}>Samples</span>
        <div style={{ flex: 1 }} />
        <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
          <span style={{ fontFamily: "'DM Mono', monospace", fontSize: 10, color: T.textDim }}>Trim %</span>
          <input type="number" value={localTrim} min={0} max={49} step={1}
            onChange={e => setLocalTrim(e.target.value)}
            onBlur={commitTrim}
            onKeyDown={e => e.key === "Enter" && commitTrim()}
            style={{ width: 44, background: T.bg0, border: `1px solid ${T.border}`, borderRadius: 4, color: T.textPrimary, padding: "4px 6px", fontFamily: "'DM Mono', monospace", fontSize: 11, outline: "none", textAlign: "center" }} />
        </div>
        {scaleDropOpen && <div onClick={() => setScaleDropOpen(false)} style={{ position: "fixed", inset: 0, zIndex: 90 }} />}
        <div style={{ position: "relative" }}>
          <button onClick={() => setScaleDropOpen(v => !v)}
            style={{ display: "flex", alignItems: "center", gap: 5, background: T.bg0, border: `1px solid ${scaleDropOpen ? T.borderBright : T.border}`, borderRadius: 4, padding: "4px 8px", cursor: "pointer", outline: "none" }}>
            <div style={{ width: 84, height: 14, borderRadius: 2, background: `linear-gradient(to right, ${sampleColorScale(colorScale, 20, colorTrim).join(",")})` }} />
            <span style={{ fontFamily: "'DM Mono', monospace", fontSize: 10, color: T.textDim, lineHeight: 1 }}>▾</span>
          </button>
          {scaleDropOpen && (
            <div onClick={e => e.stopPropagation()}
              style={{ position: "absolute", right: 0, top: "calc(100% + 4px)", background: T.bg2, border: `1px solid ${T.borderBright}`, borderRadius: 6, padding: 6, zIndex: 200, boxShadow: "0 4px 12px rgba(0,0,0,.5)", display: "flex", flexDirection: "column", gap: 3, minWidth: 140 }}>
              {SCALE_OPTIONS.map(o => (
                <button key={o.value} onClick={() => { onChangeScale(o.value); setScaleDropOpen(false); }}
                  style={{ display: "flex", flexDirection: "column", gap: 4, background: colorScale === o.value ? T.bg3 : "none", border: `1px solid ${colorScale === o.value ? T.borderBright : "transparent"}`, borderRadius: 4, padding: "5px 8px", cursor: "pointer", alignItems: "stretch" }}>
                  <span style={{ fontFamily: "'DM Mono', monospace", fontSize: 10, color: colorScale === o.value ? T.textPrimary : T.textDim, textAlign: "left" }}>{o.label}</span>
                  <div style={{ height: 10, borderRadius: 2, background: `linear-gradient(to right, ${sampleColorScale(o.value, 20, colorTrim).join(",")})` }} />
                </button>
              ))}
            </div>
          )}
        </div>
        <Btn variant="ghost" small onClick={() => setShowPicker(v => !v)}>+ Add</Btn>
      </div>
      {sampleOrder.length === 0 && !showPicker && (
        <div style={{ fontFamily: "'DM Mono', monospace", fontSize: 12, color: T.textDim, padding: "4px 0" }}>No samples — click + Add to begin.</div>
      )}
      {sampleOrder.map((sid, i) => (
        <SampleRosterRow
          key={sid}
          sid={sid}
          s={sampleMap[sid]}
          color={colors[i] || T.textDim}
          label={labels[sid] || ""}
          dragOver={dragOverIdx === i}
          onDragStart={() => setDragIdx(i)}
          onDragOver={e => { e.preventDefault(); setDragOverIdx(i); }}
          onDrop={e => { e.preventDefault(); if (dragIdx !== null && dragIdx !== i) onReorder(dragIdx, i); setDragIdx(null); setDragOverIdx(null); }}
          onDragEnd={() => { setDragIdx(null); setDragOverIdx(null); }}
          onRemove={onRemove}
          onLabelChange={onLabelChange} />
      ))}
      {showPicker && (
        <SamplePicker
          samples={samples}
          alreadySelected={sampleOrder}
          onAdd={ids => { onAddSamples(ids); setShowPicker(false); }}
          onClose={() => setShowPicker(false)} />
      )}
      {/* Active layer selector */}
      {availableMaterials.length > 0 && (
        <div style={{ marginTop: 10, paddingTop: 10, borderTop: `1px solid ${T.border}`, display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          <span style={{ fontFamily: "'DM Mono', monospace", fontSize: 10, color: T.textDim, textTransform: "uppercase", letterSpacing: 1, flexShrink: 0 }}>Active layer</span>
          {availableMaterials.map(m => {
            const ms = getMaterialStyle(m);
            const active = activeMaterial === m;
            return (
              <span key={m} onClick={() => onChangeActiveMaterial?.(active ? null : m)}
                style={{ fontFamily: "'DM Mono', monospace", fontSize: 11, color: active ? ms.border : T.textDim,
                  background: active ? ms.bg : T.bg0, border: `1px solid ${active ? ms.border : T.border}`,
                  borderRadius: 4, padding: "2px 8px", cursor: "pointer", transition: "all .12s", userSelect: "none" }}>
                <ChemName name={m} />
              </span>
            );
          })}
          {activeMaterial && !availableMaterials.includes(activeMaterial) && (
            <span style={{ fontFamily: "'DM Mono', monospace", fontSize: 10, color: T.textDim, fontStyle: "italic" }}>{activeMaterial} (not in selection)</span>
          )}
        </div>
      )}
    </div>
  );
}

// Color legend strip shown under each comparison chart
// Map Plotly symbol name → a compact SVG marker rendered inline
function MarkerGlyph({ symbol = "circle", size = 10, color = "currentColor" }) {
  const r = size / 2;
  const paths = {
    circle:   <circle cx={r} cy={r} r={r * 0.7} fill={color} />,
    diamond:  <polygon points={`${r},${r*0.15} ${r*1.85},${r} ${r},${r*1.85} ${r*0.15},${r}`} fill={color} />,
    square:   <rect x={r*0.2} y={r*0.2} width={r*1.6} height={r*1.6} fill={color} />,
    cross:    <><rect x={r*0.42} y={r*0.05} width={r*0.16} height={r*1.9} fill={color} /><rect x={r*0.05} y={r*0.42} width={r*1.9} height={r*0.16} fill={color} /></>,
    x:        <><line x1={r*0.2} y1={r*0.2} x2={r*1.8} y2={r*1.8} stroke={color} strokeWidth={r*0.3} strokeLinecap="round"/><line x1={r*1.8} y1={r*0.2} x2={r*0.2} y2={r*1.8} stroke={color} strokeWidth={r*0.3} strokeLinecap="round"/></>,
    triangle: <polygon points={`${r},${r*0.1} ${r*1.9},${r*1.9} ${r*0.1},${r*1.9}`} fill={color} />,
  };
  const glyph = paths[symbol] || paths.circle;
  return <svg width={size} height={size} style={{ display: "inline-block", verticalAlign: "middle", flexShrink: 0 }}>{glyph}</svg>;
}

function BookColorLegend({ sampleOrder, colors, labels = {}, ps }) {
  const fs = ps ? ps.fontSize - 2 : 10;
  return (
    <div style={{ display: "flex", gap: 14, flexWrap: "wrap", marginTop: 6, justifyContent: "center" }}>
      {sampleOrder.map((sid, i) => (
        <div key={sid} style={{ display: "flex", alignItems: "center", gap: 5 }}>
          <div style={{ width: 18, height: 2.5, background: colors[i], borderRadius: 2 }} />
          <span style={{ fontFamily: ps?.font || "'DM Mono', monospace", fontSize: fs, color: T.textDim }}>{labels[sid] || sid}</span>
        </div>
      ))}
    </div>
  );
}

// Compact numeric input used inside panel control rows — commits on blur or Enter
function PanelInput({ label, value, onChange, placeholder = "auto", width = 72, step }) {
  const [local, setLocal] = useState(value ?? "");
  useEffect(() => { setLocal(value ?? ""); }, [value]);
  const commit = () => onChange({ target: { value: local } });
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
      <span style={{ fontSize: 9, color: T.textDim, fontFamily: "'DM Mono', monospace", textTransform: "uppercase", letterSpacing: 1 }}>{label}</span>
      <input type="number" step={step} value={local} placeholder={placeholder}
        onChange={e => setLocal(e.target.value)}
        onBlur={commit}
        onKeyDown={e => e.key === "Enter" && commit()}
        style={{ width, background: T.bg0, border: `1px solid ${T.border}`, borderRadius: 4, color: T.textPrimary, padding: "4px 6px", fontFamily: "'DM Mono', monospace", fontSize: 12, outline: "none", textAlign: "center", boxSizing: "border-box" }} />
    </div>
  );
}

// Generic input that only calls onChange when committed (blur or Enter).
// Pass style, placeholder, type, className etc. as extra props.
function DeferredInput({ value, onChange, ...props }) {
  const [local, setLocal] = useState(value ?? "");
  useEffect(() => { setLocal(value ?? ""); }, [value]);
  const commit = () => { if (String(local) !== String(value)) onChange(local); };
  return (
    <input value={local}
      onChange={e => setLocal(e.target.value)}
      onBlur={commit}
      onKeyDown={e => e.key === "Enter" && commit()}
      {...props} />
  );
}

// ── XRD peak-line helpers ─────────────────────────────────────────────────────

const CU_KALPHA = 1.5406; // Å

function parseHKL(str) {
  if (str == null) return null;
  const s = str.trim();
  // Space/comma-separated (handles negatives): "1 0 0", "-1,0,1"
  const parts = s.match(/-?\d+/g);
  if (parts && parts.length >= 3) return { h: parseInt(parts[0]), k: parseInt(parts[1]), l: parseInt(parts[2]) };
  // Compact single-digit: "002", "110", "100"
  if (/^[0-9]{3}$/.test(s)) return { h: parseInt(s[0]), k: parseInt(s[1]), l: parseInt(s[2]) };
  return null;
}

// Resolve strained lattice params from a line config entry.
// strain_mode: "substrate" | "arbitrary_strain" | "arbitrary_lattice"
function calcStrainedStruct(filmStruct, subStruct, ln) {
  const a_f = parseFloat(filmStruct.a), b_f = parseFloat(filmStruct.b), c_f = parseFloat(filmStruct.c);
  const nu  = parseFloat(filmStruct.poisson);
  if (!a_f || !b_f || !c_f || isNaN(nu) || nu >= 1) return null;
  const applyBiaxial = (a_in, b_in) => {
    const eps_zz = -nu / (1 - nu) * ((a_in - a_f) / a_f + (b_in - b_f) / b_f);
    return { ...filmStruct, a: a_in, b: b_in, c: c_f * (1 + eps_zz) };
  };
  const smode = ln.strain_mode || "substrate";
  if (smode === "substrate") {
    if (!subStruct) return null;
    const a_s = parseFloat(subStruct.a), b_s = parseFloat(subStruct.b);
    if (!a_s || !b_s) return null;
    return applyBiaxial(a_s, b_s);
  }
  if (smode === "arbitrary_strain") {
    const exx = parseFloat(ln.strain_eps_xx);
    const eyy = parseFloat(ln.strain_eps_yy ?? ln.strain_eps_xx);
    const ex = isNaN(exx) ? 0 : exx;           // blank → 0 (no strain)
    const ey = isNaN(eyy) ? ex : eyy;
    const eps_zz = -nu / (1 - nu) * (ex + ey);
    return { ...filmStruct, a: a_f * (1 + ex), b: b_f * (1 + ey), c: c_f * (1 + eps_zz) };
  }
  if (smode === "arbitrary_lattice") {
    const a_in = parseFloat(ln.strain_a), b_in = parseFloat(ln.strain_b || ln.strain_a);
    if (!a_in) return null;
    return applyBiaxial(a_in, b_in || a_in);
  }
  return null;
}

function calcTwoTheta(structure, hklStr) {
  const hkl = parseHKL(hklStr);
  if (!hkl) return null;
  const { h, k, l } = hkl;
  const a = parseFloat(structure.a), b = parseFloat(structure.b), c = parseFloat(structure.c);
  const deg = Math.PI / 180;
  const al = (parseFloat(structure.alpha) || 90) * deg;
  const be = (parseFloat(structure.beta)  || 90) * deg;
  const ga = (parseFloat(structure.gamma) || 90) * deg;
  if (!a || !b || !c) return null;
  const ca = Math.cos(al), cb = Math.cos(be), cg = Math.cos(ga);
  const sa = Math.sin(al), sb = Math.sin(be), sg = Math.sin(ga);
  const V2 = a*a*b*b*c*c * (1 - ca*ca - cb*cb - cg*cg + 2*ca*cb*cg);
  if (V2 <= 0) return null;
  const S11 = b*b*c*c*sa*sa, S22 = a*a*c*c*sb*sb, S33 = a*a*b*b*sg*sg;
  const S12 = a*b*c*c*(ca*cb - cg);
  const S13 = a*b*b*c*(ca*cg - cb);
  const S23 = a*a*b*c*(cb*cg - ca);
  const inv_d2 = (S11*h*h + S22*k*k + S33*l*l + 2*S12*h*k + 2*S13*h*l + 2*S23*k*l) / V2;
  if (inv_d2 <= 0) return null;
  const d = 1 / Math.sqrt(inv_d2);
  const sinTheta = CU_KALPHA / (2 * d);
  if (sinTheta > 1) return null;
  return 2 * Math.asin(sinTheta) / deg;
}

// Calculate (Qx, Qz) for a reflection hkl, assuming [001] surface normal.
// q2pi=false (default): Q = h/a in nm⁻¹  (factor=10 since a is in Å → 10/a_Å = 1/a_nm)
// q2pi=true:            Q = 2π·h/a in Å⁻¹ (standard physics convention)
function calcQxQz(structure, hklStr, q2pi = false) {
  const hkl = parseHKL(hklStr);
  if (!hkl) return null;
  const { h, k, l } = hkl;
  const a = parseFloat(structure.a);
  const b = parseFloat(structure.b) || a;
  const c = parseFloat(structure.c);
  if (!a || !c) return null;
  const factor = q2pi ? 2 * Math.PI : 10; // 10/a_Å = 1/a_nm
  const qx = h !== 0 ? factor * h / a : factor * k / b;
  const qz = factor * l / c;
  return { qx, qz };
}

const LINE_COLORS = [
  "#f0f0f0", "#bbbbbb", "#888888", "#555555", "#1a1a1a",
  "#c8b89a", "#8aa8b4",
];

// Bright primary/secondary palette for RSM peak markers
const RSM_POINT_COLORS = [
  "#ff3333", "#3399ff", "#ffee33", "#33ff66",
  "#ff33cc", "#33ffee", "#ff8833", "#cc33ff", "#ffffff",
];

const RSM_POINT_SYMBOLS = [
  { id: "cross",         glyph: "✚" },
  { id: "circle",        glyph: "●" },
  { id: "square",        glyph: "■" },
  { id: "diamond",       glyph: "◆" },
  { id: "x",             glyph: "✕" },
  { id: "triangle-up",   glyph: "▲" },
  { id: "triangle-down", glyph: "▼" },
  { id: "star",          glyph: "★" },
];

// Palette for meta-scatter marker overrides. null = use sample colorscale colour.
const META_MARKER_COLORS = [
  null,       // auto (sample colour)
  "#000000",  // black
  "#888888",  // grey
  "#ffffff",  // white
  "#e05252",  // red
  "#4d9de0",  // blue
  "#3dba6a",  // green
  "#e0b84d",  // amber/yellow
  "#e08c3d",  // orange
  "#9b59cc",  // purple
  "#3dbdbd",  // teal/cyan
  "#e05fa0",  // pink
];

const LINE_STYLES = [
  { id: "solid",  label: "—",   dash: ""      },
  { id: "dashed", label: "- -", dash: "6 3"   },
  { id: "dotted", label: "···", dash: "2 3"   },
];

// ── Shared Plotly helpers ─────────────────────────────────────────────────────

const DEFAULT_PLOT_STYLE = {
  font: "'DM Mono', monospace", fontSize: 11, box: "solid",
  grid: "dashed", lineWidth: 1.5, ticks: false, tickLen: 4,
  plotWidth: null, plotHeight: null,
  rsmBins: 256, rsmColorbar: false, rsmLogIntensity: true,
  rsmXMin: null, rsmXMax: null, rsmYMin: null, rsmYMax: null,
  rsmBgMethod: "percentile", rsmBgPct: 5, rsmWhiteFade: 0.15, rsmQ2pi: false,
  rsmMaxCols: null, rsmTight: false, rsmLabelColor: "sample",
  colorScale: "viridis", colorTrim: 5,
};

// Convert a named colour scale to a Plotly [[t, hex], …] colorscale array.
// bgFade (0–1): fraction of the scale used for a bg-color → colorscale ramp at the bottom;
// the original colorscale is then compressed into [bgFade, 1].
function makeHeatmapColorscale(scaleName, bgFade = 0) {
  const anchors = COLOR_SCALES[scaleName] || COLOR_SCALES.viridis;
  const base = anchors.map((color, i) => [i / (anchors.length - 1), color]);
  if (!bgFade || bgFade <= 0) return base;
  const compressed = base.map(([t, color]) => [bgFade + t * (1 - bgFade), color]);
  return [[0, T.bg0], ...compressed];
}

// Bin raw RSM points into an nx×ny grid using average intensity per cell.
// bgMethod: null | "percentile" | "median" | "plane"
//   percentile — subtract bgPct-th percentile of occupied cells
//   median     — subtract median (bgPct ignored)
//   plane      — subtract a least-squares linear plane fit
// Returns { x, y, z, zmin, zmax, xDomain, yDomain } where zmin/zmax are
// robust 2nd–99.5th percentile bounds for colorscale clipping.
function binRSM(data, nx, ny, xRange = null, yRange = null, logIntensity = true, bgMethod = null, bgPct = 5) {
  if (!data.length) return null;
  let xMin, xMax, yMin, yMax;
  if (xRange) { [xMin, xMax] = xRange; } else {
    xMin = Infinity; xMax = -Infinity;
    for (const d of data) { if (d.x < xMin) xMin = d.x; if (d.x > xMax) xMax = d.x; }
    const xp = (xMax - xMin) * 0.05; xMin -= xp; xMax += xp;
  }
  if (yRange) { [yMin, yMax] = yRange; } else {
    yMin = Infinity; yMax = -Infinity;
    for (const d of data) { if (d.y < yMin) yMin = d.y; if (d.y > yMax) yMax = d.y; }
    const yp = (yMax - yMin) * 0.05; yMin -= yp; yMax += yp;
  }
  const xStep = (xMax - xMin) / nx, yStep = (yMax - yMin) / ny;

  // Accumulate sum + count per cell (average-per-cell, not max)
  const sumG = new Float64Array(nx * ny);
  const cntG = new Int32Array(nx * ny);
  for (const d of data) {
    if (d.x < xMin || d.x > xMax || d.y < yMin || d.y > yMax) continue;
    const xi = Math.min(nx - 1, Math.floor((d.x - xMin) / xStep));
    const yi = Math.min(ny - 1, Math.floor((d.y - yMin) / yStep));
    const idx = yi * nx + xi;
    sumG[idx] += d.z; cntG[idx]++;
  }
  const grid = new Float64Array(nx * ny);
  for (let i = 0; i < nx * ny; i++) grid[i] = cntG[i] > 0 ? sumG[i] / cntG[i] : 0;

  // Background subtraction
  if (bgMethod === "percentile" || bgMethod === "median") {
    const pct = bgMethod === "median" ? 50 : bgPct;
    const occ = [];
    for (let i = 0; i < grid.length; i++) { if (cntG[i] > 0) occ.push(grid[i]); }
    if (occ.length) {
      occ.sort((a, b) => a - b);
      const bg = occ[Math.min(Math.floor(occ.length * pct / 100), occ.length - 1)];
      for (let i = 0; i < grid.length; i++) { if (cntG[i] > 0) grid[i] = Math.max(0, grid[i] - bg); }
    }
  } else if (bgMethod === "plane") {
    // Least-squares linear plane fit on occupied cells (normalized coords 0..1)
    let sx = 0, sy = 0, sz = 0, sxx = 0, sxy = 0, syy = 0, sxz = 0, syz = 0, n = 0;
    for (let i = 0; i < nx * ny; i++) {
      if (!cntG[i]) continue;
      const xn = (i % nx) / nx, yn = Math.floor(i / nx) / ny, z = grid[i];
      sx += xn; sy += yn; sz += z; sxx += xn*xn; sxy += xn*yn; syy += yn*yn;
      sxz += xn*z; syz += yn*z; n++;
    }
    if (n >= 3) {
      // Solve [n,sx,sy; sx,sxx,sxy; sy,sxy,syy] * [a,b,c] = [sz,sxz,syz]
      const A = [[n,sx,sy],[sx,sxx,sxy],[sy,sxy,syy]];
      const B = [sz, sxz, syz];
      for (let c = 0; c < 3; c++) {
        let maxR = c;
        for (let r = c+1; r < 3; r++) if (Math.abs(A[r][c]) > Math.abs(A[maxR][c])) maxR = r;
        [A[c], A[maxR]] = [A[maxR], A[c]]; [B[c], B[maxR]] = [B[maxR], B[c]];
        for (let r = c+1; r < 3; r++) {
          const f = A[r][c] / (A[c][c] || 1e-30);
          B[r] -= f * B[c];
          for (let k = c; k < 3; k++) A[r][k] -= f * A[c][k];
        }
      }
      const coef = [0,0,0];
      for (let i = 2; i >= 0; i--) {
        coef[i] = B[i];
        for (let j = i+1; j < 3; j++) coef[i] -= A[i][j] * coef[j];
        coef[i] /= A[i][i] || 1e-30;
      }
      const [a, b, c] = coef;
      for (let i = 0; i < nx * ny; i++) {
        if (!cntG[i]) continue;
        const bg = a + b * (i % nx) / nx + c * Math.floor(i / nx) / ny;
        grid[i] = Math.max(0, grid[i] - bg);
      }
    }
  }

  // Build z array; collect occupied values for robust range
  const occVals = [];
  const z = Array.from({ length: ny }, (_, j) =>
    Array.from({ length: nx }, (_, i) => {
      if (!cntG[j * nx + i]) return null;
      const v = grid[j * nx + i];
      if (v <= 0) return null;
      const out = logIntensity ? Math.log10(v) : v;
      occVals.push(out);
      return out;
    })
  );

  // Robust 2nd–99.5th percentile range for colorscale
  let zmin = null, zmax = null;
  if (occVals.length) {
    occVals.sort((a, b) => a - b);
    zmin = occVals[Math.max(0, Math.floor(occVals.length * 0.02))];
    zmax = occVals[Math.min(occVals.length - 1, Math.floor(occVals.length * 0.995))];
  }

  const x = Array.from({ length: nx }, (_, i) => xMin + (i + 0.5) * xStep);
  const y = Array.from({ length: ny }, (_, j) => yMin + (j + 0.5) * yStep);
  return { x, y, z, zmin, zmax, xDomain: [xMin, xMax], yDomain: [yMin, yMax] };
}

// Generate evenly-spaced ticks at a given interval across [lo, hi].
// Returns null if interval is falsy (caller uses auto ticks).
function makeTicks(lo, hi, interval) {
  if (!interval || interval <= 0) return null;
  const start = Math.ceil(lo / interval - 1e-9) * interval;
  const ticks = [];
  for (let v = start; v <= hi + 1e-9; v += interval)
    ticks.push(parseFloat(v.toFixed(10)));
  return ticks.length ? ticks : null;
}

function buildPlotLayout(ps, xaxisExtra = {}, yaxisExtra = {}, extraShapes = [], layoutOverrides = {}) {
  const gridDash = { dotted: "dot", dashed: "dash", solid: "solid" }[ps.grid] || "dash";
  const axisBase = {
    showgrid: false, showline: false,
    zeroline: ps.zeroLines ?? false,
    zerolinecolor: T.borderBright, zerolinewidth: 1,
    ticks: ps.ticks ? "inside" : "", ticklen: ps.ticks ? ps.tickLen : 0,
    mirror: ps.ticks ? "ticks" : false,
  };
  const spikeProps = {
    showspikes: true, spikemode: "across", spikecolor: T.textDim,
    spikethickness: 1, spikedash: "dot", spikesnap: "cursor",
  };
  const boxShapes = ps.box !== "off" ? [{
    type: "rect", xref: "paper", yref: "paper",
    x0: 0, y0: 0, x1: 1, y1: 1, layer: "above",
    line: {
      color: ps.box === "solid" ? T.textPrimary : T.borderBright,
      width: ps.box === "solid" ? 1.5 : 1,
      dash: ps.box === "dashed" ? "dash" : "solid",
    },
  }] : [];
  const w = ps.plotWidth  ? Math.round(ps.plotWidth  * 96) : null;
  const h = ps.plotHeight ? Math.round(ps.plotHeight * 96) : null;
  return {
    ...(w || h ? { autosize: false, ...(w ? { width: w } : {}), ...(h ? { height: h } : {}) } : { autosize: true }),
    uirevision: "plot",
    margin: { t: 12, r: 20, b: 52, l: 72, pad: 0 },
    paper_bgcolor: T.bg1, plot_bgcolor: T.bg1,
    modebar: { bgcolor: "transparent", color: T.textDim, activecolor: T.textPrimary },
    font: { family: ps.font, size: ps.fontSize, color: T.textPrimary },
    hovermode: "x", hoverdistance: 40,
    hoverlabel: { bgcolor: "rgba(0,0,0,0)", bordercolor: "rgba(0,0,0,0)", font: { color: "rgba(0,0,0,0)" } },
    xaxis: {
      ...axisBase, ...spikeProps,
      showgrid: ps.grid !== "off", gridcolor: T.border, griddash: gridDash, color: T.textDim,
      tickfont: { size: ps.fontSize - 1, family: ps.font, color: T.textDim },
      ...(xaxisExtra.tickvals ? { tickmode: "array" } : {}),
      ...xaxisExtra,
    },
    yaxis: {
      ...axisBase,
      showgrid: ps.grid !== "off", gridcolor: T.border, griddash: gridDash, color: T.textDim,
      tickfont: { size: ps.fontSize - 1, family: ps.font, color: T.textDim },
      ticklabelstandoff: 4,
      ...(yaxisExtra.tickvals ? { tickmode: "array" } : {}),
      ...yaxisExtra,
    },
    shapes: [...boxShapes, ...extraShapes],
    ...layoutOverrides,
  };
}

function buildPlotConfig(filename = "plot", ps = null) {
  const hasSizeOverride = !!(ps?.plotWidth || ps?.plotHeight);
  // Export helper: temporarily clears background colours for transparent output, then restores.
  const exportTransparent = async (gd, format) => {
    const { paper_bgcolor, plot_bgcolor } = gd.layout;
    await window.Plotly.relayout(gd, { paper_bgcolor: "rgba(0,0,0,0)", plot_bgcolor: "rgba(0,0,0,0)" });
    try {
      return await window.Plotly.toImage(gd, { format });
    } finally {
      await window.Plotly.relayout(gd, { paper_bgcolor, plot_bgcolor });
    }
  };
  return {
    responsive: !hasSizeOverride, displayModeBar: true, displaylogo: false,
    modeBarButtonsToRemove: ["lasso2d", "select2d", "autoScale2d", "toImage"],
    modeBarButtonsToAdd: [
      {
        name: "downloadSVG", title: "Download as SVG",
        icon: { width: 24, height: 24, path: "M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z" },
        click: async (gd) => {
          try {
            const dataUrl = await exportTransparent(gd, "svg");
            const a = document.createElement("a");
            a.href = dataUrl; a.download = `${filename}.svg`;
            document.body.appendChild(a); a.click(); document.body.removeChild(a);
          } catch (err) { console.error("Download failed:", err); }
        },
      },
      {
        name: "copyImage", title: "Copy to clipboard",
        icon: { width: 24, height: 24, path: "M16 1H4C2.9 1 2 1.9 2 3v14h2V3h12V1zm3 4H8C6.9 5 6 5.9 6 7v14c0 1.1.9 2 2 2h11c1.1 0 2-.9 2-2V7c0-1.1-.9-2-2-2zm0 16H8V7h11v14z" },
        click: async (gd) => {
          try {
            const dataUrl = await exportTransparent(gd, "png");
            const blob = await fetch(dataUrl).then(r => r.blob());
            await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
          } catch (err) { console.error("Copy to clipboard failed:", err); }
        },
      },
    ],
  };
}

function SciPlotWrap({ ps, cursorLabel, children, noSpacer = false }) {
  const [cursor, setCursor] = useState(null);
  // Memoize the Plot element so cursor state updates don't re-render Plotly
  // (which would cause zoom/pan to snap back). Only rebuilds when parent data changes.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const child = useMemo(() => typeof children === "function" ? children(setCursor) : children, [children]);
  return (
    <div className="sci-plot-wrap">
      {!noSpacer && <div style={{ height: 30 }} />}
      <div style={{ display: "flex", justifyContent: "center" }} onMouseLeave={() => setCursor(null)}>
        <div style={{ position: "relative", width: ps.plotWidth ? Math.round(ps.plotWidth * 96) : "100%", flexShrink: 0 }}>
          <Suspense fallback={<div style={{ height: 320, display: "flex", alignItems: "center", justifyContent: "center", fontFamily: "'DM Mono', monospace", fontSize: 12, color: T.textDim }}>Loading chart…</div>}>
            {child}
          </Suspense>
          {cursor != null && (
            <div style={{ position: "absolute", top: 20, left: 80, fontFamily: ps.font, fontSize: ps.fontSize, color: T.textSecondary, pointerEvents: "none", userSelect: "none", letterSpacing: "0.02em" }}>
              {cursorLabel(cursor)}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ── XRD ω–2θ comparison ───────────────────────────────────────────────────────

function XRDComparisonPanel({ sampleOrder, plotCache, colors, labels = {}, config, plotStyle, structures = [], onUpdate }) {
  const ps = plotStyle || DEFAULT_PLOT_STYLE;
  const offsetDecades   = config.offset_decades ?? 2;
  const thetaMin        = config.theta_min  != null ? Number(config.theta_min)  : null;
  const thetaMax        = config.theta_max  != null ? Number(config.theta_max)  : null;
  const padAbove        = config.pad_above  ?? 2;
  const padBelow        = config.pad_below  ?? 1;
  const normalizeBase   = config.normalize_baseline ?? true;

  const { traces, yDomMin, yDomMax, xTicks, xDomain } = useMemo(() => {
    const traces = sampleOrder.map((sid, i) => {
      let pts = plotCache[sid]?.xrd_ot || [];
      if (thetaMin != null && !isNaN(thetaMin)) pts = pts.filter(p => p.x >= thetaMin);
      if (thetaMax != null && !isNaN(thetaMax)) pts = pts.filter(p => p.x <= thetaMax);
      const pos = pts.filter(p => p.y > 0);
      if (pos.length === 0) return null;
      const sorted = [...pos.map(p => p.y)].sort((a, b) => a - b);
      const floor  = sorted[Math.max(0, Math.floor(sorted.length * 0.05))];
      // Median is a robust background estimator for XRD (most of the scan is background)
      const median = sorted[Math.floor(sorted.length * 0.5)] || floor;
      const norm   = normalizeBase && median > 0 ? median : 1;
      const scale  = Math.pow(10, i * offsetDecades);
      const data   = pos.map(p => ({ x: p.x, y: Math.max(p.y, floor) / norm * scale }));
      return { sid, color: colors[i], data };
    }).filter(Boolean);
    const posY    = traces.flatMap(t => t.data.map(p => p.y));
    const yDomMin = posY.length ? Math.pow(10, Math.floor(Math.log10(Math.min(...posY))) - padBelow) : 1e-1;
    const yDomMax = posY.length ? Math.pow(10, Math.ceil(Math.log10(Math.max(...posY)))  + padAbove) : 1e8;
    const allX    = traces.flatMap(t => t.data.map(p => p.x));
    const { ticks: xTicksAuto, domain: xDomainAuto } = allX.length
      ? niceLinTicks(Math.min(...allX), Math.max(...allX))
      : { ticks: [], domain: ["auto", "auto"] };
    const xDomLo = thetaMin != null ? thetaMin : xDomainAuto[0];
    const xDomHi = thetaMax != null ? thetaMax : xDomainAuto[1];
    const xDomain = (xDomLo === "auto" || xDomHi === "auto") ? xDomainAuto : [xDomLo, xDomHi];
    const { ticks: xTicks } = (xDomain[0] !== "auto")
      ? niceLinTicks(xDomain[0], xDomain[1])
      : { ticks: xTicksAuto };
    return { traces, yDomMin, yDomMax, xTicks, xDomain };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sampleOrder.join(","), plotCache, thetaMin, thetaMax, offsetDecades, padAbove, padBelow, normalizeBase, colors.join(",")]);

  const lines = config.lines || [];
  const addLine    = () => onUpdate({ lines: [...lines, { id: String(Date.now()), material: structures[0]?.name || "", hkl: "", style: "solid", color: "#888888", mode: "bulk", substrate: "" }] });
  const updateLine = (id, patch) => onUpdate({ lines: lines.map(l => l.id === id ? { ...l, ...patch } : l) });
  const removeLine = (id) => onUpdate({ lines: lines.filter(l => l.id !== id) });
  const [openPicker, setOpenPicker] = useState(null); // { id, type: "color"|"style" }
  const [dragLineIdx, setDragLineIdx] = useState(null);
  const [dragOverIdx, setDragOverIdx] = useState(null);

  const reorderLines = (fromIdx, toIdx) => {
    if (fromIdx === toIdx) return;
    // Build old→new index mapping
    const order = [...Array(lines.length).keys()];
    const [moved] = order.splice(fromIdx, 1);
    order.splice(toIdx, 0, moved);
    const oldToNew = new Array(lines.length);
    order.forEach((oldIdx, newIdx) => { oldToNew[oldIdx] = newIdx; });
    // Reorder lines and remap entry: substrate references
    const reordered = order.map(oldIdx => {
      const ln = lines[oldIdx];
      if (!ln.substrate?.startsWith("entry:")) return ln;
      const oldRef = parseInt(ln.substrate.slice(6));
      const newRef = oldToNew[oldRef];
      return newRef != null ? { ...ln, substrate: `entry:${newRef}` } : ln;
    });
    onUpdate({ lines: reordered });
  };

  // Pre-compute effective structures for all lines (two passes for forward/backward entry refs)
  const lineEffStructs = useMemo(() => {
    const eff = new Array(lines.length).fill(null);
    const compute = (ln, i) => {
      const film = structures.find(s => s.name === ln.material);
      let sub;
      if (ln.substrate?.startsWith("entry:")) {
        const ref = parseInt(ln.substrate.slice(6));
        sub = (ref >= 0 && ref < lines.length && ref !== i) ? eff[ref] : null;
      } else {
        sub = structures.find(s => s.name === ln.substrate) || null;
      }
      return ln.mode === "strained" && film
        ? (calcStrainedStruct(film, sub, ln) || null)
        : (film || null);
    };
    lines.forEach((ln, i) => { eff[i] = compute(ln, i); });
    lines.forEach((ln, i) => { if (ln.substrate?.startsWith("entry:")) eff[i] = compute(ln, i); });
    return eff;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lines, structures]);

  const lineShapes = lines.map((ln, i) => {
    const tt = lineEffStructs[i] ? calcTwoTheta(lineEffStructs[i], ln.hkl) : null;
    if (tt == null) return null;
    return {
      type: "line", xref: "x", yref: "paper",
      x0: tt, x1: tt, y0: 0, y1: 1, layer: "above",
      line: { color: ln.color, width: ps.lineWidth, dash: ln.style === "dashed" ? "dash" : ln.style === "dotted" ? "dot" : "solid" },
    };
  }).filter(Boolean);

  const plotlyTraces = traces.map(t => ({
    x: t.data.map(p => p.x), y: t.data.map(p => p.y),
    type: "scatter", mode: "lines",
    line: { color: t.color, width: ps.lineWidth },
    showlegend: false, hovertemplate: "<extra></extra>",
  }));

  const layout = buildPlotLayout(ps,
    { range: xDomain[0] === "auto" ? undefined : xDomain, tickvals: xTicks.length ? xTicks : undefined,
      tickformat: "~d",
      title: { text: "2θ (°)", font: { size: ps.fontSize, family: ps.font, color: T.textSecondary }, standoff: 10 } },
    { type: "log", range: [Math.log10(yDomMin), Math.log10(yDomMax)],
      showticklabels: false, showgrid: false,
      title: { text: "Intensity (arb.)", font: { size: ps.fontSize, family: ps.font, color: T.textSecondary }, standoff: 8 } },
    lineShapes,
    { uirevision: `xrd-${thetaMin ?? "a"}-${thetaMax ?? "a"}`, dragmode: "zoom", margin: { t: 12, r: 20, b: 52, l: 65, pad: 0 } }
  );

  return (
    <div>
      {traces.length === 0 ? (
        <div style={{ fontFamily: "'DM Mono', monospace", fontSize: 12, color: T.textDim, padding: "20px 0" }}>No XRD ω–2θ data loaded for selected samples.</div>
      ) : (
        <>
          <SciPlotWrap ps={ps} cursorLabel={x => `2θ = ${x.toFixed(3)}°`}>
            {setCursor => (
              <Plot data={plotlyTraces} layout={layout} config={buildPlotConfig("xrd", ps)}
                style={{ width: ps.plotWidth ? `${Math.round(ps.plotWidth * 96)}px` : "100%", height: ps.plotHeight ? `${Math.round(ps.plotHeight * 96)}px` : "320px" }} useResizeHandler
                onHover={e => { const x = e.xvals?.[0] ?? e.points?.[0]?.x; if (x != null) setCursor(x); }} />
            )}
          </SciPlotWrap>
          <BookColorLegend sampleOrder={sampleOrder} colors={colors} labels={labels} ps={ps} />
        </>
      )}

      {/* Peak lines */}
      {openPicker && <div onClick={() => setOpenPicker(null)} style={{ position: "fixed", inset: 0, zIndex: 90 }} />}
      <div style={{ marginTop: 14, display: "flex", flexDirection: "column", gap: 6 }}>
        {(() => {
          return lines.map((ln, i) => {
          const effStruct  = lineEffStructs[i];
          const twoTheta   = effStruct ? calcTwoTheta(effStruct, ln.hkl) : null;
          const curStyle   = LINE_STYLES.find(s => s.id === ln.style) || LINE_STYLES[0];
          const colorOpen  = openPicker?.id === ln.id && openPicker?.type === "color";
          const styleOpen  = openPicker?.id === ln.id && openPicker?.type === "style";
          const cfgOpen    = openPicker?.id === ln.id && openPicker?.type === "strainCfg";
          const isStrained = ln.mode === "strained";
          const smode      = ln.strain_mode || "substrate";
          // Shared style for all row controls
          const rc = { fontFamily: "'DM Mono', monospace", fontSize: 11, borderRadius: 4, padding: "4px 8px", boxSizing: "border-box", outline: "none", cursor: "pointer" };
          const anyOpen = colorOpen || styleOpen || cfgOpen;
          const isDragging  = dragLineIdx === i;
          const isDropTarget = dragOverIdx === i && dragLineIdx !== i;
          return (
            <div key={ln.id}
              draggable
              onDragStart={e => { e.dataTransfer.effectAllowed = "move"; setDragLineIdx(i); }}
              onDragOver={e => { e.preventDefault(); e.dataTransfer.dropEffect = "move"; setDragOverIdx(i); }}
              onDragLeave={() => setDragOverIdx(null)}
              onDrop={e => { e.preventDefault(); reorderLines(dragLineIdx, i); setDragLineIdx(null); setDragOverIdx(null); }}
              onDragEnd={() => { setDragLineIdx(null); setDragOverIdx(null); }}
              style={{ display: "flex", alignItems: "center", gap: 6, position: "relative", zIndex: anyOpen ? 100 : "auto",
                opacity: isDragging ? 0.4 : 1,
                borderRadius: 5,
                outline: isDropTarget ? `2px solid ${T.teal}` : "2px solid transparent",
                transition: "opacity .15s, outline-color .1s" }}>
              {/* Drag handle / row number */}
              <span title="Drag to reorder" style={{ fontFamily: "'DM Mono', monospace", fontSize: 10, color: T.textDim, minWidth: 16, textAlign: "right", flexShrink: 0, cursor: "grab", userSelect: "none" }}>{i + 1}</span>
              {/* Material */}
              <select value={ln.material} onChange={e => updateLine(ln.id, { material: e.target.value })}
                style={{ ...rc, background: T.bg0, border: `1px solid ${T.border}`, color: T.textSecondary }}>
                <option value="">— material —</option>
                {structures.map(s => <option key={s.name} value={s.name}>{s.name}</option>)}
              </select>
              {/* hkl */}
              <DeferredInput value={ln.hkl} onChange={v => updateLine(ln.id, { hkl: v })}
                placeholder="hkl"
                style={{ ...rc, width: 64, background: T.bg0, border: `1px solid ${T.border}`, color: T.textPrimary, textAlign: "center" }} />
              {/* Configure (bulk/strained + strain settings) */}
              <div style={{ position: "relative", zIndex: 50 }}>
                <button onClick={e => { e.stopPropagation(); setOpenPicker(cfgOpen ? null : { id: ln.id, type: "strainCfg" }); }}
                  style={{ ...rc, background: cfgOpen ? T.bg3 : T.bg0, border: `1px solid ${cfgOpen ? T.borderBright : isStrained ? T.teal : T.border}`, color: isStrained ? T.teal : T.textSecondary }}>
                  Configure
                </button>
                {cfgOpen && (
                  <div onClick={e => e.stopPropagation()}
                    style={{ position: "absolute", left: 0, top: "calc(100% + 4px)", background: T.bg3, border: `1px solid ${T.borderBright}`, borderRadius: 8, padding: "12px 14px", zIndex: 200, boxShadow: "0 4px 20px rgba(0,0,0,.3), 0 1px 4px rgba(0,0,0,.15)", minWidth: 280, display: "flex", flexDirection: "column", gap: 12 }}>
                    {/* Bulk / Strained toggle */}
                    <div style={{ display: "flex", borderRadius: 4, overflow: "hidden", border: `1px solid ${T.border}`, alignSelf: "flex-start" }}>
                      {["bulk", "strained"].map(m => (
                        <button key={m} onClick={() => updateLine(ln.id, { mode: m })}
                          style={{ ...rc, background: ln.mode === m ? T.bg3 : T.bg0, border: "none", borderRight: m === "bulk" ? `1px solid ${T.border}` : "none", color: ln.mode === m ? T.textPrimary : T.textDim, textTransform: "uppercase", letterSpacing: 0.5 }}>
                          {m}
                        </button>
                      ))}
                    </div>
                    {/* Strain options (only when strained) */}
                    {isStrained && [
                      { id: "substrate",         label: "Strain based on substrate" },
                      { id: "arbitrary_strain",  label: "Arbitrary strain (biaxial)" },
                      { id: "arbitrary_lattice", label: "Arbitrary lattice parameter" },
                    ].map(opt => (
                      <div key={opt.id} style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                        <div onClick={() => updateLine(ln.id, { strain_mode: opt.id })}
                          style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer" }}>
                          <div style={{ width: 14, height: 14, borderRadius: "50%", border: `2px solid ${smode === opt.id ? T.teal : T.border}`, background: smode === opt.id ? T.teal : "transparent", flexShrink: 0, transition: "all .12s" }} />
                          <span style={{ fontFamily: "'DM Mono', monospace", fontSize: 11, color: smode === opt.id ? T.textPrimary : T.textDim }}>{opt.label}</span>
                        </div>
                        {smode === opt.id && opt.id === "substrate" && (
                          <select value={ln.substrate} onChange={e => updateLine(ln.id, { substrate: e.target.value })}
                            style={{ ...rc, marginLeft: 22, background: T.bg0, border: `1px solid ${T.border}`, color: T.textSecondary }}>
                            <option value="">— substrate —</option>
                            {structures.filter(s => s.name !== ln.material).map(s => <option key={s.name} value={s.name}>{s.name}</option>)}
                            {lines.map((other, j) => j !== i && (
                              <option key={`entry:${j}`} value={`entry:${j}`}>Entry {j + 1}</option>
                            ))}
                          </select>
                        )}
                        {smode === opt.id && opt.id === "arbitrary_strain" && (
                          <div style={{ display: "flex", gap: 10, marginLeft: 22 }}>
                            {[["strain_eps_xx", "ε_xx"], ["strain_eps_yy", "ε_yy"]].map(([k, lbl]) => (
                              <div key={k} style={{ display: "flex", flexDirection: "column", gap: 3 }}>
                                <span style={{ fontSize: 10, color: T.textDim, fontFamily: "'DM Mono', monospace" }}>{lbl}</span>
                                <DeferredInput type="number" value={ln[k] ?? ""} placeholder="0.000"
                                  onChange={v => updateLine(ln.id, { [k]: v })}
                                  style={{ ...rc, width: 88, background: T.bg0, border: `1px solid ${T.border}`, color: T.textPrimary, textAlign: "center", cursor: "text" }} />
                              </div>
                            ))}
                          </div>
                        )}
                        {smode === opt.id && opt.id === "arbitrary_lattice" && (
                          <div style={{ display: "flex", gap: 10, marginLeft: 22 }}>
                            {[["strain_a", "a (Å)"], ["strain_b", "b (Å)"]].map(([k, lbl]) => (
                              <div key={k} style={{ display: "flex", flexDirection: "column", gap: 3 }}>
                                <span style={{ fontSize: 10, color: T.textDim, fontFamily: "'DM Mono', monospace" }}>{lbl}</span>
                                <DeferredInput type="number" value={ln[k] ?? ""} placeholder="—"
                                  onChange={v => updateLine(ln.id, { [k]: v })}
                                  style={{ ...rc, width: 88, background: T.bg0, border: `1px solid ${T.border}`, color: T.textPrimary, textAlign: "center", cursor: "text" }} />
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </div>
              {/* calculated 2θ */}
              <span style={{ fontFamily: "'DM Mono', monospace", fontSize: 11, color: twoTheta != null ? T.teal : T.textDim, minWidth: 60 }}>
                {twoTheta != null ? `${twoTheta.toFixed(3)}°` : "—"}
              </span>
              <div style={{ flex: 1 }} />
              {/* color picker */}
              <div style={{ position: "relative", zIndex: 50 }}>
                <div onClick={e => { e.stopPropagation(); setOpenPicker(colorOpen ? null : { id: ln.id, type: "color" }); }}
                  style={{ width: 28, height: 28, borderRadius: 4, background: ln.color, border: `2px solid ${colorOpen ? T.amber : T.border}`, cursor: "pointer", flexShrink: 0 }} />
                {colorOpen && (
                  <div onClick={e => e.stopPropagation()}
                    style={{ position: "absolute", right: 0, top: "calc(100% + 4px)", background: T.bg2, border: `1px solid ${T.borderBright}`, borderRadius: 6, padding: 6, display: "flex", gap: 4, zIndex: 200, boxShadow: "0 4px 12px rgba(0,0,0,.5)" }}>
                    {LINE_COLORS.map(c => (
                      <div key={c} onClick={() => { updateLine(ln.id, { color: c }); setOpenPicker(null); }}
                        style={{ width: 22, height: 22, borderRadius: 3, background: c, border: `2px solid ${ln.color === c ? T.amber : "transparent"}`, cursor: "pointer", flexShrink: 0 }} />
                    ))}
                  </div>
                )}
              </div>
              {/* style picker */}
              <div style={{ position: "relative", zIndex: 50 }}>
                <button onClick={e => { e.stopPropagation(); setOpenPicker(styleOpen ? null : { id: ln.id, type: "style" }); }}
                  style={{ ...rc, background: T.bg0, border: `1px solid ${styleOpen ? T.borderBright : T.border}`, color: T.textPrimary, minWidth: 40 }}>
                  {curStyle.label}
                </button>
                {styleOpen && (
                  <div onClick={e => e.stopPropagation()}
                    style={{ position: "absolute", right: 0, top: "calc(100% + 4px)", background: T.bg2, border: `1px solid ${T.borderBright}`, borderRadius: 6, padding: 4, display: "flex", flexDirection: "column", gap: 2, zIndex: 200, boxShadow: "0 4px 12px rgba(0,0,0,.5)" }}>
                    {LINE_STYLES.map(s => (
                      <button key={s.id} onClick={() => { updateLine(ln.id, { style: s.id }); setOpenPicker(null); }}
                        style={{ ...rc, background: ln.style === s.id ? T.bg3 : "none", border: "none", color: ln.style === s.id ? T.textPrimary : T.textDim, textAlign: "left", whiteSpace: "nowrap" }}>
                        {s.label}
                      </button>
                    ))}
                  </div>
                )}
              </div>
              {/* remove */}
              <button onClick={() => removeLine(ln.id)}
                style={{ background: "none", border: "none", color: T.textDim, cursor: "pointer", fontSize: 16, lineHeight: 1, padding: "0 2px" }}>×</button>
            </div>
          );
        });
        })()}
        <button onClick={addLine}
          style={{ background: "none", border: `1px dashed ${T.border}`, borderRadius: 5, color: T.teal, fontFamily: "'DM Mono', monospace", fontSize: 11, padding: "3px 10px", cursor: "pointer", alignSelf: "flex-start", marginTop: lines.length ? 2 : 0 }}>
          + Add line
        </button>
      </div>
    </div>
  );
}

// ── P–E Hysteresis comparison ─────────────────────────────────────────────────

function PEComparisonPanel({ sampleOrder, samples, plotCache, colors, labels = {}, plotStyle, config: panelConfig = {}, onUpdate }) {
  const ps = plotStyle || DEFAULT_PLOT_STYLE;
  const [peLoop, setPeLoop] = useState("all");
  const xAxisMode = ps.peXAxis || "field"; // "field" (kV/cm) | "voltage" (V)

  const traces = sampleOrder.map((sid, i) => {
    const sample = samples.find(s => s.id === sid);
    const corr   = sample?.area_correction ?? 1.0;
    const thick  = sample?.thickness_nm || 0;
    const raw    = plotCache[sid]?.pe || [];
    const looped = peLoop === "second" ? splitPELoops(raw).second : raw;
    const data0  = (corr && corr !== 1.0) ? looped.map(p => ({ ...p, y: p.y / corr })) : looped;
    // Convert x from field (kV/cm) → voltage (V): V = E × d_nm × 1e-4
    const data   = (xAxisMode === "voltage" && thick > 0)
      ? data0.map(p => ({ ...p, x: p.x * thick * 1e-4 }))
      : data0;
    return { sid, color: colors[i], data };
  }).filter(t => t.data.length > 0);

  if (!traces.length) return (
    <div style={{ fontFamily: "'DM Mono', monospace", fontSize: 12, color: T.textDim, padding: "20px 0" }}>No P–E data loaded for selected samples.</div>
  );

  const allX    = traces.flatMap(t => t.data.map(p => p.x));
  const allY    = traces.flatMap(t => t.data.map(p => p.y));
  const { ticks: autoXTicks, domain: autoXDomain } = niceLinTicks(Math.min(...allX), Math.max(...allX));
  const xDomain = [ps.xMin ?? autoXDomain[0], ps.xMax ?? autoXDomain[1]];
  const rawAbsY  = Math.max(...allY.map(Math.abs)) * 1.05;
  const absYMax0 = Math.max(rawAbsY, 30);
  const peStep   = absYMax0 >= 500 ? 200 : absYMax0 >= 250 ? 100 : absYMax0 >= 100 ? 50 : absYMax0 >= 40 ? 10 : 5;
  const absYMax  = Math.ceil(absYMax0 / peStep) * peStep;
  const yMin = ps.yMin ?? -absYMax;
  const yMax = ps.yMax ??  absYMax;
  const autoYTicks = Array.from({ length: 2 * (absYMax / peStep) + 1 }, (_, i) => -absYMax + i * peStep);
  const xTicks = makeTicks(xDomain[0], xDomain[1], ps.xTick) || autoXTicks;
  const peTicks = makeTicks(yMin, yMax, ps.yTick) || autoYTicks;

  const plotlyTraces = traces.map(t => ({
    x: t.data.map(p => p.x), y: t.data.map(p => p.y),
    type: "scatter", mode: "lines",
    line: { color: t.color, width: ps.lineWidth },
    showlegend: false, hovertemplate: "<extra></extra>",
  }));
  const xLabel = xAxisMode === "voltage" ? "V (V)" : "E (kV/cm)";
  const layout = buildPlotLayout(ps,
    { tickvals: xTicks, range: xDomain,
      title: { text: xLabel, font: { size: ps.fontSize, family: ps.font, color: T.textSecondary }, standoff: 10 } },
    { range: [yMin, yMax], tickvals: peTicks, tickformat: "d",
      title: { text: "P (µC/cm²)", font: { size: ps.fontSize, family: ps.font, color: T.textSecondary }, standoff: 8 } }
  );

  return (
    <>
      <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: 6 }}>
        <LoopToggle value={peLoop} onChange={setPeLoop} />
      </div>
      <SciPlotWrap ps={ps} cursorLabel={x => `E = ${x.toFixed(3)} kV/cm`}>
        {setCursor => (
          <Plot data={plotlyTraces} layout={layout} config={buildPlotConfig("pe-hysteresis", ps)}
            style={{ width: ps.plotWidth ? `${Math.round(ps.plotWidth * 96)}px` : "100%", height: ps.plotHeight ? `${Math.round(ps.plotHeight * 96)}px` : "320px" }} useResizeHandler
            onHover={e => { const x = e.xvals?.[0] ?? e.points?.[0]?.x; if (x != null) setCursor(x); }} />
        )}
      </SciPlotWrap>
      <BookColorLegend sampleOrder={sampleOrder} colors={colors} labels={labels} ps={ps} />
    </>
  );
}

// ── RSM comparison ────────────────────────────────────────────────────────────

function RSMComparisonPanel({ sampleOrder, plotCache, colors, labels = {}, plotStyle, config = {}, onUpdate, structures = [] }) {
  const ps = plotStyle || DEFAULT_PLOT_STYLE;
  const rsmCfg = MEAS_TYPES.rsm;
  const entries = sampleOrder.map((sid, i) => ({
    sid, color: colors[i], data: plotCache[sid]?.rsm || [],
  })).filter(e => e.data.length > 0);

  // Migrate old-format points: (1) pre-XRD schema had raw qx/qz, no hkl;
  // (2) old qxqz mode → now "__arbitrary__" material
  const points = (config.rsm_points || []).map(p => {
    if (p.hkl === undefined) return { id: p.id, material: p.material || "", hkl: "", mode: "bulk", substrate: "", color: p.color || RSM_POINT_COLORS[0] };
    if (p.mode === "qxqz") return { ...p, material: "__arbitrary__", mode: "bulk" };
    return p;
  });
  const addPoint    = () => onUpdate({ rsm_points: [...points, { id: String(Date.now()), material: structures[0]?.name || "", hkl: "", mode: "bulk", substrate: "", color: RSM_POINT_COLORS[points.length % RSM_POINT_COLORS.length], symbol: "cross", markerSize: 9 }] });
  const updatePoint = (id, patch) => onUpdate({ rsm_points: points.map(p => p.id === id ? { ...p, ...patch } : p) });
  const removePoint = (id) => onUpdate({ rsm_points: points.filter(p => p.id !== id) });

  const [openPicker, setOpenPicker] = useState(null);
  const [dragIdx, setDragIdx] = useState(null);
  const [dragOverIdx, setDragOverIdx] = useState(null);

  const reorderPoints = (fromIdx, toIdx) => {
    if (fromIdx === toIdx) return;
    const order = [...Array(points.length).keys()];
    const [moved] = order.splice(fromIdx, 1);
    order.splice(toIdx, 0, moved);
    const oldToNew = new Array(points.length);
    order.forEach((oldIdx, newIdx) => { oldToNew[oldIdx] = newIdx; });
    const reordered = order.map(oldIdx => {
      const pt = points[oldIdx];
      if (!pt.substrate?.startsWith("entry:")) return pt;
      const oldRef = parseInt(pt.substrate.slice(6));
      const newRef = oldToNew[oldRef];
      return newRef != null ? { ...pt, substrate: `entry:${newRef}` } : pt;
    });
    onUpdate({ rsm_points: reordered });
  };

  const pointEffStructs = useMemo(() => {
    const q2pi = ps.rsmQ2pi ?? false;
    const eff = new Array(points.length).fill(null);
    const compute = (pt, i) => {
      if (pt.material === "__arbitrary__") return null;
      const film = structures.find(s => s.name === pt.material);
      if (!film) return null;
      if (pt.mode !== "strained") return film;
      // arbitrary_q: derive in-plane a/b from measured Qx/Qy and h/k of the reflection
      if (pt.strain_mode === "arbitrary_q") {
        const qx = parseFloat(pt.strain_qx);
        if (isNaN(qx) || qx === 0) return calcStrainedStruct(film, null, { ...pt, strain_mode: "arbitrary_strain" }) || film;
        const hkl = parseHKL(pt.hkl);
        const h = Math.abs(hkl?.h ?? 1) || Math.abs(hkl?.k ?? 1) || 1;
        const k = Math.abs(hkl?.k ?? h) || h;
        const factor = q2pi ? 2 * Math.PI : 10;
        const a_in = factor * h / qx;
        const qy = parseFloat(pt.strain_qy);
        const b_in = (!isNaN(qy) && qy !== 0) ? factor * k / qy : a_in;
        return calcStrainedStruct(film, null, { ...pt, strain_mode: "arbitrary_lattice", strain_a: String(a_in), strain_b: String(b_in) }) || null;
      }
      let sub;
      if (pt.substrate?.startsWith("entry:")) {
        const ref = parseInt(pt.substrate.slice(6));
        sub = (ref >= 0 && ref < points.length && ref !== i) ? eff[ref] : null;
      } else {
        sub = structures.find(s => s.name === pt.substrate) || null;
      }
      return calcStrainedStruct(film, sub, pt) || null;
    };
    points.forEach((pt, i) => { eff[i] = compute(pt, i); });
    points.forEach((pt, i) => { if (pt.substrate?.startsWith("entry:")) eff[i] = compute(pt, i); });
    return eff;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [points, structures, ps.rsmQ2pi]);

  // Compute (qx, qz) for each point to pass to RSMPlot
  const q2pi = ps.rsmQ2pi ?? false;
  const resolvedPoints = points.map((pt, i) => {
    let pos;
    if (pt.material === "__arbitrary__") {
      const qx = parseFloat(pt.manual_qx), qz = parseFloat(pt.manual_qz);
      pos = (!isNaN(qx) && !isNaN(qz)) ? { qx, qz } : null;
    } else {
      pos = pointEffStructs[i] ? calcQxQz(pointEffStructs[i], pt.hkl, q2pi) : null;
    }
    const label = pt.material === "__arbitrary__" ? "Arbitrary" : (pt.material && pt.hkl ? `${pt.material} ${pt.hkl}` : "");
    return pos ? { id: pt.id, qx: pos.qx, qz: pos.qz, color: pt.color, symbol: pt.symbol || "cross", markerSize: pt.markerSize ?? 9, label } : null;
  }).filter(Boolean);

  let forcedXDomain = null, forcedYDomain = null;
  if (entries.length) {
    let xMin = Infinity, xMax = -Infinity, yMin = Infinity, yMax = -Infinity;
    for (const e of entries) for (const p of e.data) {
      if (p.x < xMin) xMin = p.x; if (p.x > xMax) xMax = p.x;
      if (p.y < yMin) yMin = p.y; if (p.y > yMax) yMax = p.y;
    }
    const xp = (xMax - xMin) * 0.05, yp = (yMax - yMin) * 0.05;
    forcedXDomain = [ps.rsmXMin != null ? ps.rsmXMin : xMin - xp, ps.rsmXMax != null ? ps.rsmXMax : xMax + xp];
    forcedYDomain = [ps.rsmYMin != null ? ps.rsmYMin : yMin - yp, ps.rsmYMax != null ? ps.rsmYMax : yMax + yp];
  }

  const rc = { fontFamily: "'DM Mono', monospace", fontSize: 11, borderRadius: 4, padding: "4px 8px", boxSizing: "border-box", outline: "none", cursor: "pointer" };
  const pointRows = (
    <div style={{ marginTop: 14, display: "flex", flexDirection: "column", gap: 6 }}>
        {openPicker && <div onClick={() => setOpenPicker(null)} style={{ position: "fixed", inset: 0, zIndex: 90 }} />}
        {points.map((pt, i) => {
          const effStruct   = pointEffStructs[i];
          const isArbitrary = pt.material === "__arbitrary__";
          const pos         = isArbitrary
            ? (() => { const qx = parseFloat(pt.manual_qx), qz = parseFloat(pt.manual_qz); return (!isNaN(qx) && !isNaN(qz)) ? { qx, qz } : null; })()
            : (effStruct ? calcQxQz(effStruct, pt.hkl, q2pi) : null);
          const colorOpen   = openPicker?.id === pt.id && openPicker?.type === "color";
          const cfgOpen     = openPicker?.id === pt.id && openPicker?.type === "strainCfg";
          const shapeOpen   = openPicker?.id === pt.id && openPicker?.type === "shape";
          const isStrained  = pt.mode === "strained";
          const smode       = pt.strain_mode || "substrate";
          const anyOpen     = colorOpen || cfgOpen || shapeOpen;
          const isDragging  = dragIdx === i;
          const isDropTarget = dragOverIdx === i && dragIdx !== i;
          return (
            <div key={pt.id}
              draggable
              onDragStart={e => { e.dataTransfer.effectAllowed = "move"; setDragIdx(i); }}
              onDragOver={e => { e.preventDefault(); e.dataTransfer.dropEffect = "move"; setDragOverIdx(i); }}
              onDragLeave={() => setDragOverIdx(null)}
              onDrop={e => { e.preventDefault(); reorderPoints(dragIdx, i); setDragIdx(null); setDragOverIdx(null); }}
              onDragEnd={() => { setDragIdx(null); setDragOverIdx(null); }}
              style={{ display: "flex", alignItems: "center", gap: 6, position: "relative", zIndex: anyOpen ? 100 : "auto",
                opacity: isDragging ? 0.4 : 1, borderRadius: 5,
                outline: isDropTarget ? `2px solid ${T.teal}` : "2px solid transparent",
                transition: "opacity .15s, outline-color .1s" }}>
              <span title="Drag to reorder" style={{ fontFamily: "'DM Mono', monospace", fontSize: 10, color: T.textDim, minWidth: 16, textAlign: "right", flexShrink: 0, cursor: "grab", userSelect: "none" }}>{i + 1}</span>
              {/* Material */}
              <select value={pt.material} onChange={e => updatePoint(pt.id, { material: e.target.value })}
                style={{ ...rc, background: T.bg0, border: `1px solid ${T.border}`, color: T.textSecondary }}>
                <option value="__arbitrary__">— arbitrary —</option>
                <option value="">— material —</option>
                {structures.map(s => <option key={s.name} value={s.name}>{s.name}</option>)}
              </select>
              {/* hkl OR inline Qx/Qz for arbitrary */}
              {isArbitrary ? (
                <div style={{ display: "flex", gap: 4 }}>
                  {[["manual_qx", "Qx"], ["manual_qz", "Qz"]].map(([k, lbl]) => (
                    <DeferredInput key={k} type="number" value={pt[k] ?? ""} step="any" placeholder={lbl}
                      onChange={v => updatePoint(pt.id, { [k]: v === "" ? "" : Number(v) })}
                      style={{ ...rc, width: 72, background: T.bg0, border: `1px solid ${T.border}`, color: T.textPrimary, textAlign: "center", cursor: "text" }} />
                  ))}
                </div>
              ) : (
                <DeferredInput value={pt.hkl} onChange={v => updatePoint(pt.id, { hkl: v })}
                  placeholder="hkl"
                  style={{ ...rc, width: 64, background: T.bg0, border: `1px solid ${T.border}`, color: T.textPrimary, textAlign: "center", cursor: "text" }} />
              )}
              {/* Configure (bulk/strained + strain settings) — hidden for arbitrary */}
              {!isArbitrary && <div style={{ position: "relative", zIndex: 50 }}>
                <button onClick={e => { e.stopPropagation(); setOpenPicker(cfgOpen ? null : { id: pt.id, type: "strainCfg" }); }}
                  style={{ ...rc, background: cfgOpen ? T.bg3 : T.bg0, border: `1px solid ${cfgOpen ? T.borderBright : pt.mode !== "bulk" ? T.teal : T.border}`, color: pt.mode !== "bulk" ? T.teal : T.textSecondary }}>
                  Configure
                </button>
                {cfgOpen && (
                  <div onClick={e => e.stopPropagation()}
                    style={{ position: "absolute", left: 0, top: "calc(100% + 4px)", background: T.bg3, border: `1px solid ${T.borderBright}`, borderRadius: 8, padding: "12px 14px", zIndex: 200, boxShadow: "0 4px 20px rgba(0,0,0,.3), 0 1px 4px rgba(0,0,0,.15)", minWidth: 280, display: "flex", flexDirection: "column", gap: 12 }}>
                    {/* Mode toggle: BULK / STRAINED */}
                    <div style={{ display: "flex", borderRadius: 4, overflow: "hidden", border: `1px solid ${T.border}`, alignSelf: "flex-start" }}>
                      {[["bulk", "BULK"], ["strained", "STRAINED"]].map(([m, label], idx, arr) => (
                        <button key={m} onClick={() => updatePoint(pt.id, { mode: m })}
                          style={{ ...rc, background: pt.mode === m ? T.bg3 : T.bg0, border: "none", borderRight: idx < arr.length - 1 ? `1px solid ${T.border}` : "none", color: pt.mode === m ? T.textPrimary : T.textDim, textTransform: "uppercase", letterSpacing: 0.5 }}>
                          {label}
                        </button>
                      ))}
                    </div>
                    {/* Strain options (only when strained) */}
                    {isStrained && [
                      { id: "substrate",         label: "Strain based on substrate" },
                      { id: "arbitrary_strain",  label: "Arbitrary strain (biaxial)" },
                      { id: "arbitrary_lattice", label: "Arbitrary lattice parameter" },
                      { id: "arbitrary_q",       label: "Measured Qx / Qy" },
                    ].map(opt => (
                      <div key={opt.id} style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                        <div onClick={() => updatePoint(pt.id, { strain_mode: opt.id })}
                          style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer" }}>
                          <div style={{ width: 14, height: 14, borderRadius: "50%", border: `2px solid ${smode === opt.id ? T.teal : T.border}`, background: smode === opt.id ? T.teal : "transparent", flexShrink: 0, transition: "all .12s" }} />
                          <span style={{ fontFamily: "'DM Mono', monospace", fontSize: 11, color: smode === opt.id ? T.textPrimary : T.textDim }}>{opt.label}</span>
                        </div>
                        {smode === opt.id && opt.id === "arbitrary_q" && (
                          <div style={{ display: "flex", gap: 10, marginLeft: 22 }}>
                            {[["strain_qx", "Qx"], ["strain_qy", "Qy (opt)"]].map(([k, lbl]) => (
                              <div key={k} style={{ display: "flex", flexDirection: "column", gap: 3 }}>
                                <span style={{ fontSize: 10, color: T.textDim, fontFamily: "'DM Mono', monospace" }}>{lbl}</span>
                                <DeferredInput type="number" value={pt[k] ?? ""} step="any" placeholder="—"
                                  onChange={v => updatePoint(pt.id, { [k]: v === "" ? "" : Number(v) })}
                                  style={{ ...rc, width: 80, background: T.bg0, border: `1px solid ${T.border}`, color: T.textPrimary, textAlign: "center", cursor: "text" }} />
                              </div>
                            ))}
                          </div>
                        )}
                        {smode === opt.id && opt.id === "substrate" && (
                          <select value={pt.substrate} onChange={e => updatePoint(pt.id, { substrate: e.target.value })}
                            style={{ ...rc, marginLeft: 22, background: T.bg0, border: `1px solid ${T.border}`, color: T.textSecondary }}>
                            <option value="">— substrate —</option>
                            {structures.filter(s => s.name !== pt.material).map(s => <option key={s.name} value={s.name}>{s.name}</option>)}
                            {points.map((other, j) => j !== i && (
                              <option key={`entry:${j}`} value={`entry:${j}`}>Entry {j + 1}</option>
                            ))}
                          </select>
                        )}
                        {smode === opt.id && opt.id === "arbitrary_strain" && (
                          <div style={{ display: "flex", gap: 10, marginLeft: 22 }}>
                            {[["strain_eps_xx", "ε_xx"], ["strain_eps_yy", "ε_yy"]].map(([k, lbl]) => (
                              <div key={k} style={{ display: "flex", flexDirection: "column", gap: 3 }}>
                                <span style={{ fontSize: 10, color: T.textDim, fontFamily: "'DM Mono', monospace" }}>{lbl}</span>
                                <DeferredInput type="number" value={pt[k] ?? ""} placeholder="0.000"
                                  onChange={v => updatePoint(pt.id, { [k]: v })}
                                  style={{ ...rc, width: 88, background: T.bg0, border: `1px solid ${T.border}`, color: T.textPrimary, textAlign: "center", cursor: "text" }} />
                              </div>
                            ))}
                          </div>
                        )}
                        {smode === opt.id && opt.id === "arbitrary_lattice" && (
                          <div style={{ display: "flex", gap: 10, marginLeft: 22 }}>
                            {[["strain_a", "a (Å)"], ["strain_b", "b (Å)"]].map(([k, lbl]) => (
                              <div key={k} style={{ display: "flex", flexDirection: "column", gap: 3 }}>
                                <span style={{ fontSize: 10, color: T.textDim, fontFamily: "'DM Mono', monospace" }}>{lbl}</span>
                                <DeferredInput type="number" value={pt[k] ?? ""} placeholder="—"
                                  onChange={v => updatePoint(pt.id, { [k]: v })}
                                  style={{ ...rc, width: 88, background: T.bg0, border: `1px solid ${T.border}`, color: T.textPrimary, textAlign: "center", cursor: "text" }} />
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </div>}
              {/* Calculated Qx / Qz */}
              <span style={{ fontFamily: "'DM Mono', monospace", fontSize: 11, color: pos ? T.teal : T.textDim, minWidth: 148, whiteSpace: "nowrap" }}>
                {pos ? `Qx=${pos.qx.toFixed(4)} Qz=${pos.qz.toFixed(4)}` : "—"}
              </span>
              <div style={{ flex: 1 }} />
              {/* Color picker */}
              <div style={{ position: "relative", zIndex: 50 }}>
                <div onClick={e => { e.stopPropagation(); setOpenPicker(colorOpen ? null : { id: pt.id, type: "color" }); }}
                  style={{ width: 26, height: 26, borderRadius: 4, background: pt.color, border: `2px solid ${colorOpen ? T.amber : T.border}`, outline: "1px solid rgba(0,0,0,0.5)", cursor: "pointer", flexShrink: 0 }} />
                {colorOpen && (
                  <div onClick={e => e.stopPropagation()}
                    style={{ position: "absolute", right: 0, top: "calc(100% + 4px)", background: T.bg2, border: `1px solid ${T.borderBright}`, borderRadius: 6, padding: 6, display: "flex", gap: 4, zIndex: 200, boxShadow: "0 4px 12px rgba(0,0,0,.5)" }}>
                    {RSM_POINT_COLORS.map(c => (
                      <div key={c} onClick={() => { updatePoint(pt.id, { color: c }); setOpenPicker(null); }}
                        style={{ width: 22, height: 22, borderRadius: 3, background: c, border: `2px solid ${pt.color === c ? T.amber : "transparent"}`, outline: "1px solid rgba(0,0,0,0.5)", cursor: "pointer", flexShrink: 0 }} />
                    ))}
                  </div>
                )}
              </div>
              {/* Shape picker */}
              <div style={{ position: "relative", zIndex: 50 }}>
                <button onClick={e => { e.stopPropagation(); setOpenPicker(shapeOpen ? null : { id: pt.id, type: "shape" }); }}
                  style={{ width: 26, height: 26, borderRadius: 4, background: T.bg0, border: `2px solid ${shapeOpen ? T.amber : T.border}`, cursor: "pointer", flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "center", color: pt.color, fontSize: 13, padding: 0 }}>
                  {RSM_POINT_SYMBOLS.find(s => s.id === (pt.symbol || "cross"))?.glyph || "✚"}
                </button>
                {shapeOpen && (
                  <div onClick={e => e.stopPropagation()}
                    style={{ position: "absolute", right: 0, top: "calc(100% + 4px)", background: T.bg2, border: `1px solid ${T.borderBright}`, borderRadius: 6, padding: 6, display: "flex", gap: 4, zIndex: 200, boxShadow: "0 4px 12px rgba(0,0,0,.5)" }}>
                    {RSM_POINT_SYMBOLS.map(s => (
                      <button key={s.id} onClick={() => { updatePoint(pt.id, { symbol: s.id }); setOpenPicker(null); }}
                        style={{ width: 26, height: 26, borderRadius: 3, background: (pt.symbol || "cross") === s.id ? T.bg3 : T.bg0, border: `2px solid ${(pt.symbol || "cross") === s.id ? T.amber : T.border}`, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", color: pt.color, fontSize: 14, padding: 0 }}>
                        {s.glyph}
                      </button>
                    ))}
                  </div>
                )}
              </div>
              {/* Marker size */}
              <DeferredInput type="number" value={pt.markerSize ?? 9}
                onChange={v => updatePoint(pt.id, { markerSize: Math.max(4, Math.min(30, Number(v) || 9)) })}
                className="no-spin" min="4" max="30" step="1" title="Marker size"
                style={{ ...rc, width: 38, background: T.bg0, border: `1px solid ${T.border}`, color: T.textPrimary, textAlign: "center", cursor: "text" }} />
              {/* Remove */}
              <button onClick={() => removePoint(pt.id)}
                style={{ background: "none", border: "none", color: T.textDim, cursor: "pointer", fontSize: 16, lineHeight: 1, padding: "0 2px" }}>×</button>
            </div>
          );
        })}
        <button onClick={addPoint}
          style={{ background: "none", border: `1px dashed ${T.border}`, borderRadius: 5, color: T.teal, fontFamily: "'DM Mono', monospace", fontSize: 11, padding: "3px 10px", cursor: "pointer", alignSelf: "flex-start", marginTop: points.length ? 2 : 0 }}>
          + Add point
        </button>
      </div>
    );

  // Memoize binning for all entries together so a single Plot can be built.
  const entryKey = entries.map(e => `${e.sid}:${e.data.length}`).join(",");
  const allBinned = useMemo(() => {
    const bins = ps.rsmBins || 256;
    const logIntensity = ps.rsmLogIntensity ?? true;
    const bgMethod = ps.rsmBgMethod ?? null;
    const bgPct = ps.rsmBgPct ?? 5;
    return entries.map(e =>
      binRSM(e.data, bins, bins, forcedXDomain || null, forcedYDomain || null, logIntensity, bgMethod, bgPct)
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entryKey, ps.rsmBins, forcedXDomain?.[0], forcedXDomain?.[1], forcedYDomain?.[0], forcedYDomain?.[1], ps.rsmLogIntensity, ps.rsmBgMethod, ps.rsmBgPct]);

  return (
    <div>
      {entries.length === 0 ? (
        <div style={{ fontFamily: "'DM Mono', monospace", fontSize: 12, color: T.textDim, padding: "20px 0" }}>No RSM data loaded for selected samples.</div>
      ) : (() => {
        const tight      = ps.rsmTight ?? false;
        const maxCols    = ps.rsmMaxCols > 0 ? ps.rsmMaxCols : entries.length;
        const cols       = Math.min(maxCols, entries.length);
        const rows       = Math.ceil(entries.length / cols);
        const labelStyle = ps.rsmLabelColor ?? "sample";

        // ── non-tight: individual RSMPlot components (original layout) ────────
        if (!tight) {
          const panelW = ps.plotWidth ? Math.round(ps.plotWidth * 96) : 280;
          return (
            <div style={{ display: "flex", gap: 14, flexWrap: "wrap", justifyContent: "center" }}>
              {entries.map(e => (
                <div key={e.sid} style={{ flex: "0 0 auto", width: panelW }}>
                  {labelStyle !== "off" && <div style={{ fontFamily: "'DM Mono', monospace", fontSize: 11, color: labelStyle === "sample" ? e.color : T.textPrimary, marginBottom: 4, textAlign: "center" }}>{labels[e.sid] || e.sid}</div>}
                  <RSMPlot data={e.data} cfg={rsmCfg} forcedXDomain={forcedXDomain} forcedYDomain={forcedYDomain} plotStyle={ps} showColorbar={ps.rsmColorbar} points={resolvedPoints} />
                </div>
              ))}
            </div>
          );
        }

        // ── tight: single Plotly figure with subplots ─────────────────────────
        const logIntensity = ps.rsmLogIntensity ?? true;
        const q2pi     = ps.rsmQ2pi ?? false;
        const qUnit    = q2pi ? "Å⁻¹" : "nm⁻¹";
        const zLabel   = logIntensity ? "log I" : "I";
        const colorscale = makeHeatmapColorscale(ps.colorScale || "viridis", ps.rsmWhiteFade ?? 0);

        // Global robust color range — shared across all panels for direct comparison
        const validBinned = allBinned.filter(Boolean);
        const globalZmin = validBinned.length ? Math.min(...validBinned.map(b => b.zmin).filter(v => v != null)) : null;
        const globalZmax = validBinned.length ? Math.max(...validBinned.map(b => b.zmax).filter(v => v != null)) : null;

        // Figure pixel dimensions (W × H = whole collection)
        const defPW = 280, defPH = 280;
        const figW = ps.plotWidth  ? Math.round(ps.plotWidth  * 96) : defPW * cols;
        const figH = ps.plotHeight ? Math.round(ps.plotHeight * 96) : defPH * rows;

        const gridDash = { dotted: "dot", dashed: "dash", solid: "solid" }[ps.grid] || "dash";
        const axisBase = {
          showgrid: ps.grid !== "off", gridcolor: T.border, griddash: gridDash,
          color: T.textDim, tickfont: { size: (ps.fontSize || 12) - 1, family: ps.font, color: T.textDim },
          zeroline: false, showline: false,
          ticks: "inside", ticklen: 4, mirror: "ticks",
        };
        const spikeProps = { showspikes: true, spikemode: "across", spikecolor: T.textDim, spikethickness: 1, spikedash: "dot", spikesnap: "cursor" };

        const plotlyTraces = [];
        const axesLayout   = {};
        const annotations  = [];
        const shapes       = [];

        entries.forEach((e, idx) => {
          const binned = allBinned[idx];
          if (!binned) return;
          const n        = idx + 1;
          const xRef     = n === 1 ? "x"  : `x${n}`;
          const yRef     = n === 1 ? "y"  : `y${n}`;
          const xAxisKey = n === 1 ? "xaxis"  : `xaxis${n}`;
          const yAxisKey = n === 1 ? "yaxis"  : `yaxis${n}`;
          const col      = idx % cols;
          const row      = Math.floor(idx / cols);
          const isLeft   = col === 0;
          const isBottom = row === rows - 1 || idx >= entries.length - ((entries.length % cols) || cols);
          const xTicks   = makeTicks(binned.xDomain[0], binned.xDomain[1], ps.xTick);
          const yTicks   = makeTicks(binned.yDomain[0], binned.yDomain[1], ps.yTick);

          // Heatmap
          plotlyTraces.push({
            type: "heatmap", x: binned.x, y: binned.y, z: binned.z,
            xaxis: xRef, yaxis: yRef,
            colorscale, showscale: !!(ps.rsmColorbar && idx === entries.length - 1),
            connectgaps: false, zsmooth: false,
            zauto: false,
            zmin: globalZmin != null ? globalZmin : binned.zmin,
            zmax: globalZmax != null ? globalZmax : binned.zmax,
            hovertemplate: `Qₓ: %{x:.4f}<br>Qz: %{y:.4f}<br>${zLabel}: %{z:.2f}<extra></extra>`,
          });

          // Reference point markers
          resolvedPoints.forEach(pt => {
            plotlyTraces.push({
              type: "scatter", mode: "markers",
              x: [pt.qx], y: [pt.qz], xaxis: xRef, yaxis: yRef,
              marker: { color: pt.color, size: pt.markerSize ?? 9, symbol: pt.symbol || "cross", line: { color: "rgba(0,0,0,0.65)", width: 1.5 } },
              showlegend: false,
              hovertemplate: `${pt.label ? pt.label + "<br>" : ""}Qₓ: ${pt.qx.toFixed(4)}<br>Qz: ${pt.qz.toFixed(4)}<extra></extra>`,
            });
          });

          // Axes — labels only on outer edges
          axesLayout[xAxisKey] = {
            ...axisBase, ...spikeProps,
            range: [binned.xDomain[0], binned.xDomain[1]],
            ...(xTicks ? { tickvals: xTicks, tickmode: "array" } : {}),
            showticklabels: isBottom,
            ...(isBottom ? { title: { text: `Qₓ (${qUnit})`, font: { size: ps.fontSize, family: ps.font, color: T.textSecondary }, standoff: 8 } } : { title: { text: "" } }),
          };
          axesLayout[yAxisKey] = {
            ...axisBase, ...spikeProps,
            range: [binned.yDomain[0], binned.yDomain[1]],
            ...(yTicks ? { tickvals: yTicks, tickmode: "array" } : {}),
            showticklabels: isLeft, ticklabelstandoff: 4,
            ...(isLeft ? { title: { text: `Qz (${qUnit})`, font: { size: ps.fontSize, family: ps.font, color: T.textSecondary }, standoff: 6 } } : { title: { text: "" } }),
          };

          // Sample label — inside, top-left of each panel
          if (labelStyle !== "off") {
            annotations.push({
              text: `<b>${labels[e.sid] || e.sid}</b>`,
              xref: `${xRef} domain`, yref: `${yRef} domain`,
              x: 0.03, y: 0.97, xanchor: "left", yanchor: "top",
              showarrow: false,
              font: { size: ps.fontSize || 12, color: labelStyle === "sample" ? e.color : T.textPrimary, family: ps.font },
            });
          }

          // Box outline per subplot
          if (ps.box !== "off") {
            shapes.push({
              type: "rect",
              xref: `${xRef} domain`, yref: `${yRef} domain`,
              x0: 0, y0: 0, x1: 1, y1: 1, layer: "above",
              line: {
                color: ps.box === "solid" ? T.textPrimary : T.borderBright,
                width: ps.box === "solid" ? 1.5 : 1,
                dash:  ps.box === "dashed" ? "dash" : "solid",
              },
            });
          }
        });

        const plotLayout = {
          autosize: false, width: figW, height: figH,
          paper_bgcolor: T.bg1, plot_bgcolor: T.bg1,
          font: { family: ps.font, size: ps.fontSize, color: T.textPrimary },
          margin: { t: 40, r: 14, b: 58, l: 68, pad: 0 },
          grid: {
            rows, columns: cols,
            pattern: "independent",
            roworder: "top to bottom",
            xgap: 0, ygap: 0,
          },
          annotations, shapes,
          uirevision: "rsm-grid",
          hovermode: "closest",
          ...axesLayout,
        };

        return (
          <div style={{ display: "flex", justifyContent: "center" }}>
            <Plot
              data={plotlyTraces}
              layout={plotLayout}
              config={{ ...buildPlotConfig("rsm-comparison", ps), responsive: false }}
              style={{ width: `${figW}px`, height: `${figH}px` }}
            />
          </div>
        );
      })()}
      {pointRows}
    </div>
  );
}

// ── εr vs E comparison ────────────────────────────────────────────────────────

function DEComparisonPanel({ sampleOrder, samples, plotCache, colors, labels = {}, plotStyle, config: panelConfig = {}, onUpdate }) {
  const ps = plotStyle || DEFAULT_PLOT_STYLE;
  const xAxisMode = ps.deXAxis || "field";
  const traces = sampleOrder.flatMap((sid, i) => {
    const sample    = samples.find(s => s.id === sid);
    const thickNm   = sample?.thickness_nm || 30;
    const thick     = thickNm * 1e-9;
    const area      = (sample?.area_m2 || DEFAULT_AREA_M2) * (sample?.area_correction || 1.0);
    const convertXY = pts => {
      if (!pts?.length) return [];
      const maxY = pts.reduce((m, p) => Math.max(m, Math.abs(p.y)), 0);
      const ys = (maxY > 0 && maxY < 1)
        ? pts.map(p => p.y * thick / (area * EPS0))
        : pts.map(p => p.y);
      // Convert x field→voltage if needed: V = E(kV/cm) × d_nm × 1e-4
      const xs = xAxisMode === "voltage"
        ? pts.map(p => p.x * thickNm * 1e-4)
        : pts.map(p => p.x);
      return xs.map((x, j) => ({ x, y: ys[j] }));
    };
    const up   = convertXY(plotCache[sid]?.diel_b_up   || []);
    const down = convertXY(plotCache[sid]?.diel_b_down || []);
    const color = colors[i];
    return [
      ...(up.length   ? [{ key: `${sid}_u`, sid, color, data: up   }] : []),
      ...(down.length ? [{ key: `${sid}_d`, sid, color, data: down }] : []),
    ];
  });

  if (!traces.length) return (
    <div style={{ fontFamily: "'DM Mono', monospace", fontSize: 12, color: T.textDim, padding: "20px 0" }}>No εᵣ vs E data loaded for selected samples.</div>
  );

  const allX    = traces.flatMap(t => t.data.map(p => p.x));
  const allY    = traces.flatMap(t => t.data.map(p => p.y)).filter(v => isFinite(v) && v > 0);
  const { ticks: autoXTicks, domain: autoXDomain } = niceLinTicks(Math.min(...allX), Math.max(...allX));
  const xDomain = [ps.xMin ?? autoXDomain[0], ps.xMax ?? autoXDomain[1]];
  const rawYMax = allY.length ? Math.max(...allY) * 1.05 : 1000;
  const erStep  = rawYMax >= 8000 ? 2000 : rawYMax >= 4000 ? 1000 : rawYMax >= 2000 ? 500 : rawYMax >= 800 ? 200 : rawYMax >= 300 ? 100 : 50;
  const erMax   = ps.yMax ?? Math.ceil(rawYMax / erStep) * erStep;
  const erMin   = ps.yMin ?? 0;
  const autoYTicks = Array.from({ length: Math.ceil((erMax - erMin) / erStep) + 1 }, (_, i) => erMin + i * erStep);
  const xTicks = makeTicks(xDomain[0], xDomain[1], ps.xTick) || autoXTicks;
  const erTicks = makeTicks(erMin, erMax, ps.yTick) || autoYTicks;
  const xLabel = xAxisMode === "voltage" ? "V (V)" : "E (kV/cm)";
  const cursorFmt = xAxisMode === "voltage" ? x => `V = ${x.toFixed(3)} V` : x => `E = ${x.toFixed(3)} kV/cm`;

  const plotlyTraces = traces.map(t => ({
    x: t.data.map(p => p.x), y: t.data.map(p => p.y),
    type: "scatter", mode: "lines",
    line: { color: t.color, width: ps.lineWidth },
    showlegend: false, hovertemplate: "<extra></extra>",
  }));
  const layout = buildPlotLayout(ps,
    { tickvals: xTicks, range: xDomain,
      title: { text: xLabel, font: { size: ps.fontSize, family: ps.font, color: T.textSecondary }, standoff: 10 } },
    { range: [erMin, erMax], tickvals: erTicks, tickformat: "d",
      title: { text: "εᵣ", font: { size: ps.fontSize, family: ps.font, color: T.textSecondary }, standoff: 8 } }
  );

  return (
    <>
      <SciPlotWrap ps={ps} cursorLabel={cursorFmt}>
        {setCursor => (
          <Plot data={plotlyTraces} layout={layout} config={buildPlotConfig("er-vs-E", ps)}
            style={{ width: ps.plotWidth ? `${Math.round(ps.plotWidth * 96)}px` : "100%", height: ps.plotHeight ? `${Math.round(ps.plotHeight * 96)}px` : "320px" }} useResizeHandler
            onHover={e => { const x = e.xvals?.[0] ?? e.points?.[0]?.x; if (x != null) setCursor(x); }} />
        )}
      </SciPlotWrap>
      <BookColorLegend sampleOrder={sampleOrder} colors={colors} labels={labels} ps={ps} />
    </>
  );
}

// ── εr vs f comparison ────────────────────────────────────────────────────────

function DfComparisonPanel({ sampleOrder, samples, plotCache, colors, labels = {}, plotStyle }) {
  const ps = plotStyle || DEFAULT_PLOT_STYLE;
  const traces = sampleOrder.map((sid, i) => {
    const sample = samples.find(s => s.id === sid);
    const thick  = (sample?.thickness_nm || 30) * 1e-9;
    const area   = (sample?.area_m2 || DEFAULT_AREA_M2) * (sample?.area_correction || 1.0);
    const raw    = plotCache[sid]?.diel_f || [];
    const maxY   = raw.reduce((m, p) => Math.max(m, Math.abs(p.y)), 0);
    const data   = (maxY > 0 && maxY < 1)
      ? raw.map(p => ({ x: p.x, y: p.y * thick / (area * EPS0) }))
      : raw.map(p => ({ x: p.x, y: p.y }));
    return { sid, color: colors[i], data: data.filter(p => p.x > 0 && p.y > 0) };
  }).filter(t => t.data.length > 0);

  if (!traces.length) return (
    <div style={{ fontFamily: "'DM Mono', monospace", fontSize: 12, color: T.textDim, padding: "20px 0" }}>No εᵣ vs f data loaded for selected samples.</div>
  );

  const allX    = traces.flatMap(t => t.data.map(p => p.x)).filter(v => v > 0);
  const allY    = traces.flatMap(t => t.data.map(p => p.y)).filter(v => v > 0);
  const xLo = ps.xMin != null ? Math.log10(ps.xMin) : Math.floor(Math.log10(Math.min(...allX)));
  const xHi = ps.xMax != null ? Math.log10(ps.xMax) : Math.ceil(Math.log10(Math.max(...allX)));
  const decadeVals = Array.from({ length: Math.floor(xHi) - Math.ceil(xLo) + 1 }, (_, i) => Math.pow(10, Math.ceil(xLo) + i));
  const decadeText = decadeVals.map(v => { const e = Math.round(Math.log10(v)); return `10${String(e).replace(/\d/g, d => '⁰¹²³⁴⁵⁶⁷⁸⁹'[d])}`; });
  const rawYMax = allY.length ? Math.max(...allY) * 1.05 : 1000;
  const erStep  = rawYMax >= 8000 ? 2000 : rawYMax >= 4000 ? 1000 : rawYMax >= 2000 ? 500 : rawYMax >= 800 ? 200 : rawYMax >= 300 ? 100 : 50;
  const erMax   = Math.ceil(rawYMax / erStep) * erStep;
  const autoYTicks = Array.from({ length: erMax / erStep + 1 }, (_, i) => i * erStep);
  const erTicks = makeTicks(0, erMax, ps.yTick) || autoYTicks;

  const plotlyTraces = traces.map(t => ({
    x: t.data.map(p => p.x), y: t.data.map(p => p.y),
    type: "scatter", mode: "lines",
    line: { color: t.color, width: ps.lineWidth },
    showlegend: false, hovertemplate: "<extra></extra>",
  }));
  const layout = buildPlotLayout(ps,
    { type: "log", range: [xLo, xHi], tickvals: decadeVals, ticktext: decadeText,
      title: { text: "Hz", font: { size: ps.fontSize, family: ps.font, color: T.textSecondary }, standoff: 10 } },
    { range: [0, erMax], tickvals: erTicks, tickformat: "d",
      title: { text: "εᵣ", font: { size: ps.fontSize, family: ps.font, color: T.textSecondary }, standoff: 8 } }
  );

  return (
    <>
      <SciPlotWrap ps={ps} cursorLabel={x => `log f = ${Math.log10(x).toFixed(3)}`}>
        {setCursor => (
          <Plot data={plotlyTraces} layout={layout} config={buildPlotConfig("er-vs-f", ps)}
            style={{ width: ps.plotWidth ? `${Math.round(ps.plotWidth * 96)}px` : "100%", height: ps.plotHeight ? `${Math.round(ps.plotHeight * 96)}px` : "320px" }} useResizeHandler
            onHover={e => { const x = e.xvals?.[0] ?? e.points?.[0]?.x; if (x != null) setCursor(x); }} />
        )}
      </SciPlotWrap>
      <BookColorLegend sampleOrder={sampleOrder} colors={colors} labels={labels} ps={ps} />
    </>
  );
}

// ── AFM Comparison Panel ───────────────────────────────────────────────────────

function AfmComparisonPanel({ sampleOrder, plotCache, labels = {}, plotStyle, config = {}, onUpdate }) {
  const ps = plotStyle || DEFAULT_PLOT_STYLE;

  // Collect all entries; find available channel names from first sample with data
  const entries = sampleOrder.map(sid => ({
    sid,
    label: labels[sid] || sid,
    afmData: plotCache[sid]?.afm ?? null,
  }));
  const firstData = entries.find(e => e.afmData?.channel_names?.length)?.afmData;
  const channelNames = firstData?.channel_names || [];
  const activeChannel = config.afm_channel || channelNames[0] || null;

  if (!entries.some(e => e.afmData)) {
    return (
      <div style={{ color: T.textDim, fontFamily: "'DM Mono', monospace", fontSize: 12, textAlign: "center", padding: 20 }}>
        No AFM data — upload .ibw files to the samples in this book.
      </div>
    );
  }

  const mapPx = ps.plotWidth ? Math.round(ps.plotWidth * 96) : 220;

  return (
    <div>
      <div style={{ display: "flex", gap: 14, flexWrap: "wrap", justifyContent: "center" }}>
        {entries.map(({ sid, label, afmData }) => {
          const grid = afmData?.channels?.[activeChannel] ?? null;
          const perSample = afmData?.channel_ranges?.[activeChannel] ?? [null, null];
          // Per-channel config override takes priority; fall back to per-sample backend range
          const chOverride = config.afm_ranges?.[activeChannel] ?? [null, null];
          const vmin = chOverride[0] != null ? chOverride[0] : perSample[0];
          const vmax = chOverride[1] != null ? chOverride[1] : perSample[1];
          return (
            <div key={sid} style={{ display: "flex", flexDirection: "column", alignItems: "center" }}>
              <div style={{ width: mapPx }}>
                {grid ? (
                  <AfmChannelMap grid={grid} scanSizeUm={afmData.scan_size_um} vmin={vmin} vmax={vmax} />
                ) : (
                  <div style={{ width: mapPx, height: mapPx, background: T.bg3, borderRadius: 4, display: "flex", alignItems: "center", justifyContent: "center" }}>
                    <span style={{ fontSize: 10, color: T.textDim, fontFamily: "'DM Mono', monospace" }}>no data</span>
                  </div>
                )}
              </div>
              <div style={{ marginTop: 5, fontSize: (ps.fontSize || 11) - 1, color: T.textDim, fontFamily: ps.font || "'DM Mono', monospace" }}>
                {label}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── Panel wrapper + add panel row ─────────────────────────────────────────────

const PANEL_LABELS = { xrd: "XRD ω–2θ", pe: "P–E Hysteresis", rsm: "RSM", afm: "Scanning Probe", de: "εᵣ vs E", df: "εᵣ vs f", meta: "Meta-analysis", stats: "Statistical Analysis", parcoords: "Parallel Coordinates" };

// ── Meta-analysis parameter definitions ───────────────────────────────────────

function metaLayerField(sample, activeMaterial, field) {
  if (!sample?.layers || !activeMaterial) return null;
  for (const layer of sample.layers) {
    if (layer.targets?.length === 1 && layer.targets[0].material === activeMaterial) {
      const v = layer[field] ?? layer.targets[0][field];
      return v != null ? Number(v) : null;
    }
  }
  return null;
}

// Split a PE trace into monotonic E segments (ascending / descending branches).
// Returns the widest ascending and descending segments as the main loop branches.
function peSplitBranches(data) {
  const pts = data.filter(p => isFinite(p.x) && isFinite(p.y));
  if (pts.length < 4) return null;

  // Detect direction reversals with a small dead-band to ignore noise
  const segments = [];
  let seg = [pts[0]], dir = 0;
  for (let i = 1; i < pts.length; i++) {
    const dx = pts[i].x - pts[i - 1].x;
    const d = Math.abs(dx) < 1e-10 ? 0 : Math.sign(dx);
    if (d === 0) { seg.push(pts[i]); continue; }
    if (dir === 0) { dir = d; seg.push(pts[i]); continue; }
    if (d === dir) { seg.push(pts[i]); continue; }
    // Direction reversed — commit current segment (keep even if 2 points)
    if (seg.length >= 2) segments.push({ dir, pts: seg });
    seg = [pts[i - 1], pts[i]]; dir = d;
  }
  if (seg.length >= 2) segments.push({ dir, pts: seg });
  if (segments.length < 2) return null;

  const eSpan = s => Math.max(...s.pts.map(p => p.x)) - Math.min(...s.pts.map(p => p.x));
  // Pick the widest ascending and descending segments (main loop branches)
  const asc  = segments.filter(s => s.dir ===  1).sort((a, b) => eSpan(b) - eSpan(a))[0];
  const desc = segments.filter(s => s.dir === -1).sort((a, b) => eSpan(b) - eSpan(a))[0];
  return (asc && desc) ? { asc: asc.pts, desc: desc.pts } : null;
}

// Interpolate P at a given E value within a (roughly monotonic) branch.
function peInterpP(branchPts, eTarget) {
  for (let i = 0; i < branchPts.length - 1; i++) {
    const a = branchPts[i], b = branchPts[i + 1];
    const lo = Math.min(a.x, b.x), hi = Math.max(a.x, b.x);
    if (lo <= eTarget && eTarget <= hi) {
      const t = (b.x - a.x) !== 0 ? (eTarget - a.x) / (b.x - a.x) : 0;
      return a.y + t * (b.y - a.y);
    }
  }
  return null;
}

// Find the E where P crosses zero in a branch; returns the interpolated E value.
function peFindZeroCrossing(branchPts) {
  for (let i = 0; i < branchPts.length - 1; i++) {
    const a = branchPts[i], b = branchPts[i + 1];
    if ((a.y <= 0 && b.y > 0) || (a.y > 0 && b.y <= 0)) {
      const t = Math.abs(a.y) / (Math.abs(a.y) + Math.abs(b.y) || 1);
      return a.x + t * (b.x - a.x);
    }
  }
  return null;
}

function extractPEProps(data) {
  if (!data?.length) return null;
  const pts = data.filter(p => isFinite(p.x) && isFinite(p.y));
  if (pts.length < 4) return null;

  // Collect ALL zero-crossings of P (gives coercive fields)
  // and ALL zero-crossings of E (gives remnant polarizations).
  // No branch assumption — works regardless of sweep start/direction.
  const pCrossings = [];
  const eCrossings = [];
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i], b = pts[i + 1];
    if ((a.y < 0 && b.y >= 0) || (a.y >= 0 && b.y < 0)) {
      const t = Math.abs(a.y) / (Math.abs(a.y) + Math.abs(b.y) || 1);
      pCrossings.push(a.x + t * (b.x - a.x));
    }
    if ((a.x < 0 && b.x >= 0) || (a.x >= 0 && b.x < 0)) {
      const t = Math.abs(a.x) / (Math.abs(a.x) + Math.abs(b.x) || 1);
      eCrossings.push(a.y + t * (b.y - a.y));
    }
  }
  if (pCrossings.length < 2) return null;
  pCrossings.sort((a, b) => a - b);

  // Rightmost P=0 crossing = positive Ec (switching on descending branch)
  // Leftmost  P=0 crossing = negative Ec (switching on ascending branch)
  const ec_pos = pCrossings[pCrossings.length - 1];
  const ec_neg = pCrossings[0];

  // Ec = half the span between zero-crossings (always positive); imprint = midpoint
  const ec      = (ec_pos - ec_neg) / 2;
  const imprint = (ec_pos + ec_neg) / 2;

  const pmax = Math.max(...pts.map(p => Math.abs(p.y)));

  // +Pr = highest P at E = 0 (descending branch); −Pr = lowest (ascending branch)
  const pr_pos = eCrossings.length ? Math.max(...eCrossings) : null;
  const pr_neg = eCrossings.length ? Math.min(...eCrossings) : null;

  // Pr at imprint: collect all P values where E passes through the imprint field,
  // same all-crossings approach as Pr at E=0 — no branch assumption needed.
  const impCrossings = [];
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i], b = pts[i + 1];
    if ((a.x - imprint) * (b.x - imprint) < 0) {
      const t = (imprint - a.x) / (b.x - a.x);
      impCrossings.push(a.y + t * (b.y - a.y));
    }
  }
  const pr_imp_pos = impCrossings.length ? Math.max(...impCrossings) : null;
  const pr_imp_neg = impCrossings.length ? Math.min(...impCrossings) : null;

  return { ec, imprint, pmax, pr_pos, pr_neg, pr_imp_pos, pr_imp_neg };
}

// Mirrors the capacitance→permittivity conversion used in the comparison panel renderer.
// Applied before all meta-analysis dielectric extractions so values are always in ε_r.
function dielConvertPts(pts, sample) {
  if (!pts?.length) return [];
  const thick = (sample?.thickness_nm || 30) * 1e-9;
  const area  = (sample?.area_m2 || DEFAULT_AREA_M2) * (sample?.area_correction || 1.0);
  const maxY  = pts.reduce((m, p) => Math.max(m, Math.abs(p.y)), 0);
  return (maxY > 0 && maxY < 1)
    ? pts.map(p => ({ ...p, y: p.y * thick / (area * EPS0) }))
    : pts;
}

function extractDielFVal(data, logFreqTarget) {
  if (!data?.length) return null;
  // x may be raw Hz (e.g. 1000 for 1 kHz) or already log10 (e.g. 3.0).
  // Detect by checking whether max(x) > 100 — raw Hz values will always exceed that.
  const maxX = Math.max(...data.map(p => p.x));
  const toLog = maxX > 100;
  let best = null, bestDist = Infinity;
  for (const p of data) {
    if (!isFinite(p.x) || p.x <= 0) continue;
    const logX = toLog ? Math.log10(p.x) : p.x;
    const d = Math.abs(logX - logFreqTarget);
    if (d < bestDist) { bestDist = d; best = p.y; }
  }
  // Tolerance: 0.15 decades (~1.4×) — tight enough to reject the next log-spaced point.
  return bestDist < 0.15 ? best : null;
}

function extractDielBiasProps(up, down) {
  const validUp   = (up   || []).filter(p => isFinite(p.x) && isFinite(p.y) && p.y > 0);
  const validDown = (down || []).filter(p => isFinite(p.x) && isFinite(p.y) && p.y > 0);
  if (!validUp.length && !validDown.length) return null;

  // Interpolate ε at an arbitrary E within a (possibly non-monotonic) point array.
  const interpY = (pts, xTarget) => {
    for (let i = 0; i < pts.length - 1; i++) {
      const a = pts[i], b = pts[i + 1];
      const lo = Math.min(a.x, b.x), hi = Math.max(a.x, b.x);
      if (lo <= xTarget && xTarget <= hi && b.x !== a.x)
        return a.y + (xTarget - a.x) / (b.x - a.x) * (b.y - a.y);
    }
    return null;
  };

  // Crossing: find all E values where ε_up(E) = ε_down(E).
  // There are typically multiple crossings — at the saturation edges (low ε) and
  // within the butterfly peak region (high ε). The physically meaningful crossing
  // is the one at maximum ε, i.e. the crossing between the two switching peaks.
  const crossEpsValues = [];
  if (validUp.length && validDown.length) {
    for (let i = 0; i < validUp.length - 1; i++) {
      const e1 = validUp[i].x, e2 = validUp[i + 1].x;
      const u1 = validUp[i].y, u2 = validUp[i + 1].y;
      const d1 = interpY(validDown, e1), d2 = interpY(validDown, e2);
      if (d1 == null || d2 == null) continue;
      const diff1 = u1 - d1, diff2 = u2 - d2;
      if (diff1 * diff2 < 0) {
        const t = diff1 / (diff1 - diff2);
        crossEpsValues.push(((u1 + t * (u2 - u1)) + (d1 + t * (d2 - d1))) / 2);
      }
    }
  }
  // Take the highest-ε crossing — that's the one between the butterfly peaks.
  const crossEps = crossEpsValues.length ? Math.max(...crossEpsValues) : null;

  const upMin   = validUp.length   ? Math.min(...validUp.map(p => p.y))   : null;
  const upMax   = validUp.length   ? Math.max(...validUp.map(p => p.y))   : null;
  const downMin = validDown.length ? Math.min(...validDown.map(p => p.y)) : null;
  const downMax = validDown.length ? Math.max(...validDown.map(p => p.y)) : null;

  return { crossEps, upMin, upMax, downMin, downMax };
}

// ── X-ray extraction helpers (used by META_PARAM_GROUPS X-ray group) ─────────

function xrdPrimaryLine(sample, material) {
  if (!material) return null;
  const saved = sample.xrd_peaks;
  const lines = saved && !Array.isArray(saved) ? (saved.lines || []) : (Array.isArray(saved) ? saved : []);
  const matLines = lines.filter(l => l.material === material);
  if (!matLines.length) return null;
  return matLines.find(l => l.primary !== false) ?? matLines[0];
}

// d-spacing (Å) from 2θ (°) using Cu Kα1
function dFromTwoTheta(twoTheta) {
  const sinT = Math.sin(twoTheta * Math.PI / 360);
  return sinT > 0 ? CU_KALPHA / (2 * sinT) : null;
}

// Lattice parameter (Å) from d-spacing and HKL {h,k,l} object (from existing parseHKL).
// For c-axis (00l): c = d * l. For a-axis (h00)/(0k0): a = d * n.
// For general pseudocubic (cubic): a = d * sqrt(h²+k²+l²).
function latticeParamFromDAndHKL(d, hklStr) {
  if (!d || !hklStr) return null;
  const idx = parseHKL(hklStr);
  if (!idx) return null;
  const { h, k, l } = idx;
  if (h === 0 && k === 0 && l !== 0) return d * l;
  if (h === 0 && l === 0 && k !== 0) return d * k;
  if (k === 0 && l === 0 && h !== 0) return d * h;
  return d * Math.sqrt(h * h + k * k + l * l);
}

function extractXRDPeakPos(s, am) {
  const line = xrdPrimaryLine(s, am);
  return line?.fitted_center ?? null;
}

function extractXRDLatticeParam(s, am) {
  const line = xrdPrimaryLine(s, am);
  if (!line?.fitted_center || !line?.hkl) return null;
  const d = dFromTwoTheta(line.fitted_center);
  return latticeParamFromDAndHKL(d, line.hkl);
}

function extractXRDStrainPct(s, am) {
  // The XRD modal saves `strain = (d_measured - d_ref) / d_ref` at fit time,
  // where d_ref is derived from the theoretical reference 2θ (strained or bulk,
  // depending on how the line was configured). This is identical to the % shown
  // in the XRD fit row, so we read it directly rather than recomputing.
  const line = xrdPrimaryLine(s, am);
  if (line?.strain == null || !isFinite(line.strain)) return null;
  return line.strain * 100;
}

const META_PARAM_GROUPS = [
  { group: "Growth", isInput: true, params: [
    { id: "growth_temp",      label: "Temperature",    unit: "°C",    needsLayer: true, extract: (s, _pc, am) => metaLayerField(s, am, "temp") },
    { id: "growth_pressure",  label: "Pressure",       unit: "mTorr", needsLayer: true, extract: (s, _pc, am) => metaLayerField(s, am, "pressure") },
    { id: "growth_o2_pct",    label: "O₂ %",           unit: "%",     needsLayer: true, extract: (s, _pc, am) => metaLayerField(s, am, "oxygen_pct") },
    { id: "growth_power_w",   label: "Target power",   unit: "W",     needsLayer: true, extract: (s, _pc, am) => metaLayerField(s, am, "power_W") },
    { id: "growth_time_s",    label: "Dep. time",      unit: "s",     needsLayer: true, extract: (s, _pc, am) => metaLayerField(s, am, "time_s") },
    { id: "growth_pulses",    label: "Pulses",         unit: "",      needsLayer: true, extract: (s, _pc, am) => metaLayerField(s, am, "pulses") },
    { id: "growth_energy_mj", label: "Laser energy",   unit: "mJ",    needsLayer: true, extract: (s, _pc, am) => metaLayerField(s, am, "energy_mJ") },
    { id: "growth_freq_hz",   label: "Rep. rate",      unit: "Hz",    needsLayer: true, extract: (s, _pc, am) => metaLayerField(s, am, "frequency_hz") },
  ]},
  { group: "Sample", isInput: true, params: [
    { id: "thickness_nm",     label: "Thickness",      unit: "nm",    needsLayer: true, extract: (s, _pc, am) => metaLayerField(s, am, "thickness_nm") },
  ]},
  { group: "P–E Hysteresis", params: [
    { id: "pe_ec",         label: "Coercive field E<sub>c</sub>", corrLabel: "Ec",       unit: "kV/cm",  extract: (s, pc) => extractPEProps(pc[s.id]?.pe)?.ec         ?? null },
    { id: "pe_imprint",    label: "Imprint field",                corrLabel: "Imprint",  unit: "kV/cm",  extract: (s, pc) => extractPEProps(pc[s.id]?.pe)?.imprint    ?? null },
    { id: "pe_pr",     label: "Pᵣ at E = 0",       unit: "µC/cm²", paired: true, extract: (s, pc) => { const r = extractPEProps(pc[s.id]?.pe); return r ? { pos: r.pr_pos,     neg: r.pr_neg     } : null; } },
    { id: "pe_pr_imp", label: "Pᵣ at imprint field", unit: "µC/cm²", paired: true, extract: (s, pc) => { const r = extractPEProps(pc[s.id]?.pe); return r ? { pos: r.pr_imp_pos, neg: r.pr_imp_neg } : null; } },
    { id: "pe_pmax",       label: "Max polarization",       unit: "µC/cm²", extract: (s, pc) => extractPEProps(pc[s.id]?.pe)?.pmax       ?? null },
  ]},
  { group: "Dielectric — freq sweep", params: [
    { id: "diel_eps_1khz",  label: "ε @ 1 kHz",  unit: "", extract: (s, pc) => extractDielFVal(dielConvertPts(pc[s.id]?.diel_f, s), 3.0) },
    { id: "diel_eps_10khz", label: "ε @ 10 kHz", unit: "", extract: (s, pc) => extractDielFVal(dielConvertPts(pc[s.id]?.diel_f, s), 4.0) },
  ]},
  { group: "Dielectric — bias sweep", params: [
    { id: "diel_eps_cross",   label: "ε at up/down crossing", unit: "",
      extract: (s, pc) => extractDielBiasProps(dielConvertPts(pc[s.id]?.diel_b_up, s), dielConvertPts(pc[s.id]?.diel_b_down, s))?.crossEps ?? null },
    { id: "diel_eps_min_b",   label: "Min ε (↑/↓ sweeps)",   unit: "", paired: true,
      extract: (s, pc) => { const r = extractDielBiasProps(dielConvertPts(pc[s.id]?.diel_b_up, s), dielConvertPts(pc[s.id]?.diel_b_down, s)); return r ? { pos: r.upMin, neg: r.downMin } : null; } },
    { id: "diel_eps_max_b",   label: "Max ε (↑/↓ sweeps)",   unit: "", paired: true,
      extract: (s, pc) => { const r = extractDielBiasProps(dielConvertPts(pc[s.id]?.diel_b_up, s), dielConvertPts(pc[s.id]?.diel_b_down, s)); return r ? { pos: r.upMax, neg: r.downMax } : null; } },
  ]},
  { group: "X-ray", params: [
    { id: "xrd_peak_pos",   label: "Peak position",    unit: "°", needsXRD: true,
      extract: (s, _pc, am)         => extractXRDPeakPos(s, am) },
    { id: "xrd_lattice",    label: "<i>c</i> Parameter", corrLabel: "<i>c</i> Parameter", unit: "Å", needsXRD: true,
      extract: (s, _pc, am)         => extractXRDLatticeParam(s, am) },
    { id: "xrd_strain_pct", label: "Δc/c",              unit: "%", needsXRD: true,
      extract: (s, _pc, am) => extractXRDStrainPct(s, am) },
  ]},
];
const META_PARAMS_FLAT = META_PARAM_GROUPS.flatMap(g => g.params.map(p => ({ ...p, group: g.group })));

// Generate nice round axis ticks spanning at least [dataMin, dataMax].
// Does NOT force zero into the range.
function niceAxisTicks(dataMin, dataMax, targetN = 5) {
  const rawRange = dataMax - dataMin;
  if (rawRange < 1e-10) {
    // All values equal — build a symmetric range around the value
    const v = dataMin;
    const mag = v !== 0 ? Math.pow(10, Math.floor(Math.log10(Math.abs(v)))) * 0.5 : 1;
    return Array.from({ length: targetN }, (_, i) => v + mag * (i - Math.floor(targetN / 2)));
  }
  const rawStep = rawRange / (targetN - 1);
  const mag = Math.pow(10, Math.floor(Math.log10(rawStep)));
  const f = rawStep / mag;
  const step = f < 1.5 ? mag : f < 3.5 ? 2 * mag : f < 7.5 ? 5 * mag : 10 * mag;
  const start = Math.floor(dataMin / step) * step;
  const ticks = [];
  for (let v = start; v < dataMax + step * 0.5; v = parseFloat((v + step).toPrecision(12))) {
    ticks.push(parseFloat(v.toPrecision(12)));
    if (ticks.length > 20) break;
  }
  return ticks;
}

// Compute a padded auto-range for a set of Y values, matching the meta scatter axis logic.
function metaYRange(allY, isPaired) {
  const lo = allY.length ? Math.min(...allY) : 0, hi = allY.length ? Math.max(...allY) : 1;
  if (isPaired && lo < 0 && hi > 0) {
    const absMax = Math.max(Math.abs(lo), Math.abs(hi)) || 1;
    return niceLinTicks(-absMax * 1.20, absMax * 1.20).domain;
  }
  const span = (hi - lo) || Math.abs(hi) * 0.5 || 1;
  const pad  = span * 0.20;
  return [lo >= 0 ? 0 : lo - pad, hi + pad];
}

function MetaScatterPlot({ points, y2Points = [], xLabel, yLabel, y2Label = "", ps = DEFAULT_PLOT_STYLE, pairedY = false, pairedY2 = false, xCategorical = false, sampleOrder = [], colors = [], labels = {}, yMarker = {}, y2Marker = {} }) {
  const allY  = points.map(p => p.y);
  const allY2 = y2Points.map(p => p.y);

  // Numeric X range/ticks (skipped for categorical axis)
  const allX = xCategorical ? [] : points.map(p => p.x);
  const dataXLo = allX.length ? Math.min(...allX) : 0, dataXHi = allX.length ? Math.max(...allX) : 1;
  const xSpan = (dataXHi - dataXLo) || Math.abs(dataXHi) * 0.5 || 1;
  const xRangeAuto = [dataXLo - xSpan * 0.20, dataXHi + xSpan * 0.20];

  const yRangeAuto  = metaYRange(allY,  pairedY);
  const y2RangeAuto = metaYRange(allY2, pairedY2);

  const xRange  = xCategorical ? undefined : [ps.xMin  ?? xRangeAuto[0],  ps.xMax  ?? xRangeAuto[1]];
  const yRange  = [ps.yMin  ?? yRangeAuto[0],   ps.yMax  ?? yRangeAuto[1]];
  const y2Range = [ps.y2Min ?? y2RangeAuto[0],  ps.y2Max ?? y2RangeAuto[1]];

  const xTickExtra  = (!xCategorical && ps.xTick)  ? { tickmode: "linear", tick0: 0, dtick: ps.xTick  } : {};
  const yTickExtra  = ps.yTick  ? { tickmode: "linear", tick0: 0, dtick: ps.yTick  } : {};
  const y2TickExtra = ps.y2Tick ? { tickmode: "linear", tick0: 0, dtick: ps.y2Tick } : {};

  const hasY2 = y2Points.length > 0 && !!y2Label;

  const plotlyTraces = [
    ...points.map(pt => ({
      x: [pt.x], y: [pt.y], yaxis: "y",
      type: "scatter", mode: ps.metaLabels ? "markers+text" : "markers",
      marker: { color: yMarker.color ?? pt.color, size: yMarker.size ?? 9, symbol: yMarker.symbol ?? "circle", line: { color: T.bg0, width: 1.5 } },
      text: ps.metaLabels ? [pt.label] : undefined,
      textposition: "top center",
      textfont: { size: (ps.fontSize || 11) - 1, family: ps.font, color: yMarker.color ?? pt.color },
      showlegend: false,
      hovertemplate: xCategorical
        ? `<b>${pt.label}</b><br>${yLabel}: %{y}<extra></extra>`
        : `<b>${pt.label}</b><br>${xLabel}: %{x}<br>${yLabel}: %{y}<extra></extra>`,
    })),
    ...(hasY2 ? y2Points.map(pt => ({
      x: [pt.x], y: [pt.y], yaxis: "y2",
      type: "scatter", mode: ps.metaLabels ? "markers+text" : "markers",
      marker: { color: y2Marker.color ?? pt.color, size: y2Marker.size ?? 9, symbol: y2Marker.symbol ?? "diamond", line: { color: T.bg0, width: 1.5 } },
      text: ps.metaLabels ? [pt.label] : undefined,
      textposition: "top center",
      textfont: { size: (ps.fontSize || 11) - 1, family: ps.font, color: y2Marker.color ?? pt.color },
      showlegend: false,
      hovertemplate: xCategorical
        ? `<b>${pt.label}</b><br>${y2Label}: %{y}<extra></extra>`
        : `<b>${pt.label}</b><br>${xLabel}: %{x}<br>${y2Label}: %{y}<extra></extra>`,
    })) : []),
  ];

  const xAxisExtra = xCategorical
    ? { type: "category", tickangle: -35, automargin: true }
    : { range: xRange, ...xTickExtra, hoverformat: ".4g" };

  const layout = buildPlotLayout(ps,
    { ...xAxisExtra,
      title: { text: xLabel, font: { size: ps.fontSize, family: ps.font, color: T.textSecondary }, standoff: 10 } },
    { range: yRange, ...yTickExtra,
      ...(hasY2 ? { showgrid: false, mirror: ps.box !== "off" ? true : false } : {}),
      title: { text: yLabel, font: { size: ps.fontSize, family: ps.font, color: T.textSecondary }, standoff: 8 } },
    [],
    {
      uirevision: `meta-${xLabel}-${yLabel}-${y2Label}`,
      ...(hasY2 ? { margin: { t: 12, r: 100, b: 52, l: 72, pad: 0 } } : {}),
      ...(xCategorical && !hasY2 ? { margin: { t: 12, r: 24, b: 72, l: 72, pad: 0 } } : {}),
      ...(hasY2 ? { yaxis2: {
        overlaying: "y", side: "right", showgrid: false,
        zeroline: false, showline: false, automargin: true,
        ticks: ps.ticks ? "inside" : "", ticklen: ps.ticks ? (ps.tickLen || 5) : 0,
        ticklabelstandoff: 6,
        color: T.textDim,
        tickfont: { size: (ps.fontSize || 11) - 1, family: ps.font, color: T.textDim },
        title: { text: y2Label, font: { size: ps.fontSize, family: ps.font, color: T.textSecondary }, standoff: 12 },
        range: y2Range, ...y2TickExtra,
      }} : {}),
    },
  );

  return (
    <>
      <SciPlotWrap ps={ps} cursorLabel={xCategorical ? null : (x => `${xLabel} = ${x}`)}>
        {setCursor => (
          <Plot data={plotlyTraces} layout={layout} config={buildPlotConfig("meta-scatter", ps)}
            style={{ width: ps.plotWidth ? `${Math.round(ps.plotWidth * 96)}px` : "100%", height: ps.plotHeight ? `${Math.round(ps.plotHeight * 96)}px` : "320px" }}
            useResizeHandler
            onHover={e => { if (!xCategorical) { const x = e.xvals?.[0] ?? e.points?.[0]?.x; if (x != null) setCursor(x); } }} />
        )}
      </SciPlotWrap>
      <BookColorLegend sampleOrder={sampleOrder} colors={colors} labels={labels} ps={ps} />
      {hasY2 && (
        <div style={{ display: "flex", justifyContent: "center", gap: 20, marginTop: 4 }}>
          {[
            { symbol: yMarker.symbol ?? "circle",   label: yLabel  },
            { symbol: y2Marker.symbol ?? "diamond",  label: y2Label },
          ].map(({ symbol, label }) => {
            const shortLabel = label.replace(/\s*\(.*?\)\s*$/, "");
            const glyphSize = Math.max(7, ps.fontSize - 4);
            return (
              <div key={label} style={{ display: "flex", alignItems: "center", gap: 4 }}>
                <MarkerGlyph symbol={symbol} size={glyphSize} color={T.textDim} />
                <span style={{ fontFamily: ps.font || "'DM Mono', monospace", fontSize: glyphSize, color: T.textDim }}
                  dangerouslySetInnerHTML={{ __html: shortLabel }} />
              </div>
            );
          })}
        </div>
      )}
    </>
  );
}

function CollapsibleParamSelect({ axis, value, onChange, groups, extra, rightSlot }) {
  const [open, setOpen] = useState(false);
  const [expanded, setExpanded] = useState({});
  const [dropUp, setDropUp] = useState(false);
  const btnRef = useRef(null);

  const handleOpen = () => {
    if (!open) {
      if (value) {
        // Auto-expand whichever group holds the current selection
        const g = groups.find(g => g.params.some(p => p.id === value));
        if (g) setExpanded(prev => ({ ...prev, [g.group]: true }));
      }
      if (btnRef.current) {
        const rect = btnRef.current.getBoundingClientRect();
        setDropUp(window.innerHeight - rect.bottom < 340);
      }
    }
    setOpen(v => !v);
  };

  const allParams = groups.flatMap(g => g.params);
  const selectedParam = allParams.find(p => p.id === value);
  const triggerLabel = selectedParam
    ? `${selectedParam.label}${selectedParam.unit ? ` (${selectedParam.unit})` : ""}`
    : "— select —";
  const select = (id) => { onChange(id); setOpen(false); };

  return (
    <div style={{ display: "flex", alignItems: "center", gap: axis ? 6 : 0 }}>
      {!!axis && <span style={{ fontFamily: "'DM Mono', monospace", fontSize: 10, color: T.textDim, textTransform: "uppercase", letterSpacing: 1, minWidth: 12, flexShrink: 0 }}>{axis}</span>}
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <div style={{ position: "relative" }}>
          {open && <div onClick={() => setOpen(false)} style={{ position: "fixed", inset: 0, zIndex: 90 }} />}
          <button ref={btnRef} onClick={handleOpen}
            style={{ background: T.bg0, border: `1px solid ${T.border}`, borderRadius: 4, color: selectedParam ? T.textPrimary : T.textDim, fontFamily: "'DM Mono', monospace", fontSize: 11, padding: "5px 8px", outline: "none", cursor: "pointer", minWidth: 200, textAlign: "left", display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
            <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} dangerouslySetInnerHTML={{ __html: triggerLabel }} />
            <span style={{ fontSize: 8, opacity: 0.5, flexShrink: 0 }}>▼</span>
          </button>
          {open && (
            <div onClick={e => e.stopPropagation()}
              style={{ position: "absolute", left: 0, ...(dropUp ? { bottom: "calc(100% + 4px)" } : { top: "calc(100% + 4px)" }), background: T.bg2, border: `1px solid ${T.borderBright}`, borderRadius: 6, zIndex: 200, minWidth: 240, maxHeight: 320, overflowY: "auto", boxShadow: "0 4px 16px rgba(0,0,0,.5)" }}>
              <div onClick={() => select("")}
                style={{ padding: "6px 12px", fontFamily: "'DM Mono', monospace", fontSize: 11, color: T.textDim, cursor: "pointer", borderBottom: `1px solid ${T.border}` }}>
                — select —
              </div>
              {groups.map(g => (
                <div key={g.group}>
                  <div onClick={() => setExpanded(prev => ({ ...prev, [g.group]: !prev[g.group] }))}
                    style={{ padding: "5px 12px", fontFamily: "'DM Mono', monospace", fontSize: 10, color: T.textDim, textTransform: "uppercase", letterSpacing: 0.5, background: T.bg3, cursor: "pointer", display: "flex", justifyContent: "space-between", alignItems: "center", userSelect: "none", borderTop: `1px solid ${T.border}` }}>
                    <span>{g.group}</span>
                    <span style={{ fontSize: 9, opacity: 0.6 }}>{expanded[g.group] ? "▲" : "▼"}</span>
                  </div>
                  {expanded[g.group] && g.params.map(p => (
                    <div key={p.id} onClick={() => select(p.id)}
                      style={{ padding: "5px 12px 5px 20px", fontFamily: "'DM Mono', monospace", fontSize: 11, color: p.id === value ? T.textPrimary : T.textSecondary, background: p.id === value ? T.bg3 : "transparent", cursor: "pointer" }}
                      dangerouslySetInnerHTML={{ __html: `${p.label}${p.unit ? ` (${p.unit})` : ""}` }} />
                  ))}
                </div>
              ))}
            </div>
          )}
        </div>
        {rightSlot}
        </div>
        {extra}
      </div>
    </div>
  );
}

function MetaMarkerPicker({ prefix, config, onUpdate, defaultSymbol = "circle" }) {
  const [open, setOpen] = useState(null); // "color" | "symbol" | null
  const color  = config[`${prefix}_color`]  ?? null;
  const symbol = config[`${prefix}_symbol`] ?? defaultSymbol;
  const size   = config[`${prefix}_size`]   ?? 9;
  const currentGlyph = RSM_POINT_SYMBOLS.find(s => s.id === symbol)?.glyph || "●";
  const swatchBg = color ?? "linear-gradient(135deg,#e05252 0%,#4d9de0 50%,#3dba6a 100%)";
  const btnBase = { border: `1px solid ${T.border}`, borderRadius: 4, cursor: "pointer", flexShrink: 0, padding: 0, display: "flex", alignItems: "center", justifyContent: "center" };
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 4, flexShrink: 0 }}>
      {/* Color swatch */}
      <div style={{ position: "relative" }}>
        <div onClick={e => { e.stopPropagation(); setOpen(open === "color" ? null : "color"); }}
          style={{ ...btnBase, width: 22, height: 22, background: swatchBg, border: `2px solid ${open === "color" ? T.amber : T.border}`, borderRadius: 4, outline: "1px solid rgba(0,0,0,0.4)", cursor: "pointer" }} />
        {open === "color" && (
          <>
            <div onClick={() => setOpen(null)} style={{ position: "fixed", inset: 0, zIndex: 90 }} />
            <div onClick={e => e.stopPropagation()}
              style={{ position: "absolute", right: 0, top: "calc(100% + 4px)", background: T.bg2, border: `1px solid ${T.borderBright}`, borderRadius: 6, padding: 6, display: "flex", flexWrap: "wrap", gap: 4, zIndex: 200, boxShadow: "0 4px 12px rgba(0,0,0,.5)", width: 176 }}>
              {META_MARKER_COLORS.map((c, i) => (
                <div key={i} onClick={() => { onUpdate({ [`${prefix}_color`]: c }); setOpen(null); }}
                  title={c ?? "Auto (sample colour)"}
                  style={{ width: 22, height: 22, borderRadius: 3, cursor: "pointer", flexShrink: 0, outline: "1px solid rgba(0,0,0,0.4)",
                    border: `2px solid ${color === c ? T.amber : "transparent"}`,
                    background: c ?? "linear-gradient(135deg,#e05252 0%,#4d9de0 50%,#3dba6a 100%)",
                    display: "flex", alignItems: "center", justifyContent: "center" }}>
                  {c === null && <span style={{ fontFamily: "'DM Mono', monospace", fontSize: 8, color: "#fff", fontWeight: 700, textShadow: "0 1px 2px rgba(0,0,0,.8)" }}>A</span>}
                </div>
              ))}
            </div>
          </>
        )}
      </div>
      {/* Symbol picker */}
      <div style={{ position: "relative" }}>
        <button onClick={e => { e.stopPropagation(); setOpen(open === "symbol" ? null : "symbol"); }}
          style={{ ...btnBase, width: 22, height: 22, background: T.bg0, border: `2px solid ${open === "symbol" ? T.amber : T.border}`, color: color ?? T.textSecondary, fontSize: 12 }}>
          {currentGlyph}
        </button>
        {open === "symbol" && (
          <>
            <div onClick={() => setOpen(null)} style={{ position: "fixed", inset: 0, zIndex: 90 }} />
            <div onClick={e => e.stopPropagation()}
              style={{ position: "absolute", right: 0, top: "calc(100% + 4px)", background: T.bg2, border: `1px solid ${T.borderBright}`, borderRadius: 6, padding: 6, display: "flex", gap: 4, zIndex: 200, boxShadow: "0 4px 12px rgba(0,0,0,.5)" }}>
              {RSM_POINT_SYMBOLS.map(s => (
                <button key={s.id} onClick={() => { onUpdate({ [`${prefix}_symbol`]: s.id }); setOpen(null); }}
                  style={{ ...btnBase, width: 26, height: 26, background: symbol === s.id ? T.bg3 : T.bg0, border: `2px solid ${symbol === s.id ? T.amber : T.border}`, color: color ?? T.textSecondary, fontSize: 14 }}>
                  {s.glyph}
                </button>
              ))}
            </div>
          </>
        )}
      </div>
      {/* Size */}
      <DeferredInput type="number" value={size}
        onChange={v => onUpdate({ [`${prefix}_size`]: Math.max(3, Math.min(30, Number(v) || 9)) })}
        className="no-spin" min="3" max="30" step="1" title="Marker size"
        style={{ width: 34, background: T.bg0, border: `1px solid ${T.border}`, borderRadius: 4, color: T.textPrimary, fontFamily: "'DM Mono', monospace", fontSize: 11, textAlign: "center", padding: "3px 0" }} />
    </div>
  );
}

function MetaAnalysisPanel({ sampleOrder, samples, plotCache, colors, labels = {}, config = {}, plotStyle, activeMaterial, structures = [], onUpdate }) {
  const ps = plotStyle || DEFAULT_PLOT_STYLE;
  const xParamId  = config.x_param  || "";
  const yParamId  = config.y_param  || "";
  const y2ParamId = config.y2_param || "";
  const xParam  = META_PARAMS_FLAT.find(p => p.id === xParamId)  || null;
  const yParam  = META_PARAMS_FLAT.find(p => p.id === yParamId)  || null;
  const y2Param = META_PARAMS_FLAT.find(p => p.id === y2ParamId) || null;
  const [showY2, setShowY2] = useState(!!config.y2_param);
  const sampleMap = useMemo(() => Object.fromEntries(samples.map(s => [s.id, s])), [samples]);

  // Per-panel X-ray material: used when any selected param is an X-ray param.
  // Falls back to activeMaterial (sheet-level) if not set in config.
  const anyXRD = yParam?.needsXRD || y2Param?.needsXRD || xParam?.needsXRD;
  const xrdMaterial = config.xrd_material || activeMaterial || "";
  // Collect all materials that appear in any sample's xrd_peaks
  const xrdMaterials = useMemo(() => {
    const seen = new Set();
    for (const sid of sampleOrder) {
      const s = sampleMap[sid];
      if (!s) continue;
      const saved = s.xrd_peaks;
      const lines = saved && !Array.isArray(saved) ? (saved.lines || []) : (Array.isArray(saved) ? saved : []);
      for (const ln of lines) { if (ln.material) seen.add(ln.material); }
    }
    return [...seen].sort();
  }, [sampleOrder, sampleMap]);

  const extractPoints = (param) => {
    if (!param) return [];
    return sampleOrder.flatMap((sid, i) => {
      const s = sampleMap[sid];
      if (!s) return [];
      // When no X param, use the sample label as a categorical x value
      // X-ray params use xrdMaterial (panel-level); others use activeMaterial (sheet-level)
      const xMat = xParam?.needsXRD ? xrdMaterial : activeMaterial;
      const yMat = param.needsXRD ? xrdMaterial : activeMaterial;
      const x = xParam ? xParam.extract(s, plotCache, xMat, structures) : (labels[sid] || sid);
      const yRaw = param.extract(s, plotCache, yMat, structures);
      if (x == null || yRaw == null) return [];
      if (xParam && !isFinite(x)) return [];
      const base = { sid, x, color: colors[i], label: labels[sid] || sid };
      if (param.paired) {
        const pts = [];
        if (yRaw.pos != null && isFinite(yRaw.pos)) pts.push({ ...base, y: yRaw.pos });
        if (yRaw.neg != null && isFinite(yRaw.neg)) pts.push({ ...base, y: yRaw.neg });
        return pts;
      }
      if (!isFinite(yRaw)) return [];
      return [{ ...base, y: yRaw }];
    });
  };

  // eslint-disable-next-line react-hooks/exhaustive-deps
  const points  = useMemo(() => extractPoints(yParam),  [sampleOrder, xParamId, yParamId,  plotCache, activeMaterial, xrdMaterial, structures, colors.join(","), sampleMap]);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const y2Points = useMemo(() => extractPoints(y2Param), [sampleOrder, xParamId, y2ParamId, plotCache, activeMaterial, xrdMaterial, structures, colors.join(","), sampleMap]);

  const needsLayer = xParam?.needsLayer || yParam?.needsLayer || y2Param?.needsLayer;
  const needsXRD   = xParam?.needsXRD   || yParam?.needsXRD   || y2Param?.needsXRD;

  // Build filtered groups: hide groups with no data, filter growth/sample params
  // to only those with a non-null value for at least one selected sample.
  const displayGroups = useMemo(() => {
    const hasPE    = sampleOrder.some(sid => plotCache[sid]?.pe?.length > 0);
    const hasDielF = sampleOrder.some(sid => plotCache[sid]?.diel_f?.length > 0);
    const hasDielB = sampleOrder.some(sid => (plotCache[sid]?.diel_b_up?.length || 0) + (plotCache[sid]?.diel_b_down?.length || 0) > 0);
    return META_PARAM_GROUPS.map(g => {
      let params;
      if (g.group === "Growth" || g.group === "Sample") {
        // Include only params where at least one sample has a non-null value
        params = g.params.filter(p =>
          sampleOrder.some(sid => { const s = sampleMap[sid]; return s && p.extract(s, {}, activeMaterial) != null; })
        );
      } else if (g.group === "P–E Hysteresis") {
        params = hasPE ? g.params : [];
      } else if (g.group === "Dielectric — freq sweep") {
        params = hasDielF ? g.params : [];
      } else if (g.group === "Dielectric — bias sweep") {
        params = hasDielB ? g.params : [];
      } else if (g.group === "X-ray") {
        // Show whenever any sample has any fitted XRD line
        // (active material selects which one to use at extract time)
        const hasXRD = sampleOrder.some(sid => {
          const s = sampleMap[sid];
          if (!s) return false;
          const saved = s.xrd_peaks;
          const lines = saved && !Array.isArray(saved) ? (saved.lines || []) : (Array.isArray(saved) ? saved : []);
          return lines.some(l => l.fitted_center != null);
        });
        params = hasXRD ? g.params : [];
      } else {
        params = g.params;
      }
      return { ...g, params };
    }).filter(g => g.params.length > 0);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sampleOrder, sampleMap, plotCache, activeMaterial, structures]);

  const addY2BtnStyle = { background: "transparent", border: `1px solid ${T.border}`, borderRadius: 4, color: T.textDim, fontFamily: "'DM Mono', monospace", fontSize: 10, padding: "3px 8px", cursor: "pointer", letterSpacing: 0.5, textTransform: "uppercase" };

  const axisLabelStyle = { fontFamily: "'DM Mono', monospace", fontSize: 10, color: T.textDim, textTransform: "uppercase", letterSpacing: 1, minWidth: 20, flexShrink: 0 };

  return (
    <div>
      <div style={{ display: "flex", flexDirection: "column", gap: 6, marginBottom: 16 }}>
        {/* Row 1: Y vs X */}
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <span style={axisLabelStyle}>Y</span>
          <CollapsibleParamSelect axis={null} value={yParamId} onChange={v => onUpdate({ y_param: v })} groups={displayGroups} />
          <span style={{ fontFamily: "'DM Mono', monospace", fontSize: 11, color: T.textDim }}>vs</span>
          <CollapsibleParamSelect axis="X" value={xParamId} onChange={v => onUpdate({ x_param: v })} groups={displayGroups} />
          {needsLayer && !activeMaterial && (
            <span style={{ fontFamily: "'DM Mono', monospace", fontSize: 10, color: T.amber }}>⚠ Set an active layer above to extract growth data</span>
          )}
          <div style={{ marginLeft: "auto", flexShrink: 0 }}>
            <MetaMarkerPicker prefix="y" config={config} onUpdate={onUpdate} defaultSymbol="circle" />
          </div>
        </div>
        {/* Row 1b: X-ray material selector — shown when any param is an X-ray param */}
        {anyXRD && (
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <span style={axisLabelStyle}>MAT</span>
            <select
              value={xrdMaterial}
              onChange={e => onUpdate({ xrd_material: e.target.value })}
              style={{ background: T.bg0, border: `1px solid ${xrdMaterial ? T.amber : T.border}`, borderRadius: 4, color: xrdMaterial ? T.amber : T.textDim, fontFamily: "'DM Mono', monospace", fontSize: 11, padding: "3px 8px", cursor: "pointer" }}>
              <option value="">— material —</option>
              {xrdMaterials.map(m => <option key={m} value={m}>{m}</option>)}
            </select>
            {!xrdMaterial && (
              <span style={{ fontFamily: "'DM Mono', monospace", fontSize: 10, color: T.amber }}>⚠ Select a material to plot X-ray data</span>
            )}
          </div>
        )}
        {/* Row 2: Y₂ */}
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <span style={axisLabelStyle}>Y₂</span>
          {showY2 ? (
            <>
              <CollapsibleParamSelect axis={null} value={y2ParamId} onChange={v => onUpdate({ y2_param: v })} groups={displayGroups} />
              <button onClick={() => { setShowY2(false); onUpdate({ y2_param: null }); }}
                style={{ background: "transparent", border: "none", color: T.textDim, fontFamily: "'DM Mono', monospace", fontSize: 16, lineHeight: 1, padding: "0 4px", cursor: "pointer", flexShrink: 0 }}>×</button>
              <div style={{ marginLeft: "auto", flexShrink: 0 }}>
                <MetaMarkerPicker prefix="y2" config={config} onUpdate={onUpdate} defaultSymbol="diamond" />
              </div>
            </>
          ) : (
            <button style={addY2BtnStyle} onClick={() => setShowY2(true)}>+ right axis</button>
          )}
        </div>
      </div>
      {!yParam ? (
        <div style={{ fontFamily: "'DM Mono', monospace", fontSize: 12, color: T.textDim, padding: "24px 0" }}>Select a Y parameter above to plot.</div>
      ) : points.length === 0 ? (
        <div style={{ fontFamily: "'DM Mono', monospace", fontSize: 12, color: T.textDim, padding: "24px 0" }}>No data found for the selected parameters{needsLayer && !activeMaterial ? " — active layer not set" : ""}.</div>
      ) : (
        <MetaScatterPlot
          points={points}
          y2Points={y2Points}
          xLabel={xParam ? `${xParam.label}${xParam.unit ? ` (${xParam.unit})` : ""}` : ""}
          yLabel={`${yParam.label}${yParam.unit ? ` (${yParam.unit})` : ""}`}
          y2Label={y2Param ? `${y2Param.label}${y2Param.unit ? ` (${y2Param.unit})` : ""}` : ""}
          ps={ps}
          pairedY={yParam.paired ?? false}
          pairedY2={y2Param?.paired ?? false}
          xCategorical={!xParam}
          sampleOrder={sampleOrder}
          colors={colors}
          labels={labels}
          yMarker={{ color: config.y_color ?? null, symbol: config.y_symbol ?? "circle", size: config.y_size ?? 9 }}
          y2Marker={{ color: config.y2_color ?? null, symbol: config.y2_symbol ?? "diamond", size: config.y2_size ?? 9 }}
        />
      )}
    </div>
  );
}

// ── XRD Peak Position panel ────────────────────────────────────────────────────

const XRD_POS_PARAMS = [
  { value: "pressure",   label: "Pressure (mTorr)" },
  { value: "temp",       label: "Temperature (°C)" },
  { value: "oxygen_pct", label: "O₂ (%)"           },
  { value: "time_s",     label: "Time (s)"          },
  { value: "power_W",    label: "Power (W)"         },
];

const XRD_POS_Y_MODES = [
  { value: "2theta",  label: "2θ (°)"    },
  { value: "d",       label: "d (Å)"     },
  { value: "strain",  label: "Strain (%)" },
];

function getXRDPosPoint(sample, material, param, yMode, hkl, structures) {
  if (!material || !param) return null;
  const saved = sample.xrd_peaks;
  const lines = saved && !Array.isArray(saved) ? (saved.lines || []) : (Array.isArray(saved) ? saved : []);
  const matLines = lines.filter(l => l.material === material);
  if (!matLines.length) return null;
  // Prefer primary line; fall back to first
  const line = matLines.find(l => l.primary !== false) ?? matLines[0];
  let twoTheta = line.fitted_center ?? null;
  if (twoTheta == null && hkl) {
    const struct = structures?.find(s => s.name === material);
    if (struct) twoTheta = calcTwoTheta(struct, hkl);
  }
  if (twoTheta == null) return null;
  // Growth parameter — look in whichever layer has this material as a target
  let paramValue = null;
  for (const layer of (sample.layers || [])) {
    const target = layer.targets?.find(t => t.material === material);
    if (target) {
      paramValue = param === "power_W"
        ? (target.power_W != null ? Number(target.power_W) : null)
        : (layer[param]   != null ? Number(layer[param])   : null);
      break;
    }
  }
  if (paramValue == null || !isFinite(paramValue)) return null;
  const LAMBDA = 1.5406;
  let y;
  if (yMode === "d") {
    const sinT = Math.sin(twoTheta * Math.PI / 360);
    y = sinT > 0 ? LAMBDA / (2 * sinT) : null;
  } else if (yMode === "strain") {
    const sinT = Math.sin(twoTheta * Math.PI / 360);
    const d    = sinT > 0 ? LAMBDA / (2 * sinT) : null;
    if (!d || !hkl) return null;
    const struct = structures?.find(s => s.name === material);
    if (!struct) return null;
    const refTT = calcTwoTheta(struct, hkl);
    if (!refTT) return null;
    const dRef = LAMBDA / (2 * Math.sin(refTT * Math.PI / 360));
    y = (d - dRef) / dRef * 100;
  } else {
    y = twoTheta;
  }
  if (y == null || !isFinite(y)) return null;
  return { x: paramValue, y };
}

function XRDPeakPositionPanel({ sampleOrder, samples, colors, labels = {}, config = {}, plotStyle, structures = [], onUpdate }) {
  const ps       = plotStyle || DEFAULT_PLOT_STYLE;
  const material = config.material  || "";
  const param    = config.param     || "";
  const yMode    = config.y_mode    || "2theta";
  const hkl      = config.hkl      || "";

  const sampleMap  = useMemo(() => Object.fromEntries(samples.map(s => [s.id, s])), [samples]);
  const paramInfo  = XRD_POS_PARAMS.find(p => p.value === param);
  const yModeInfo  = XRD_POS_Y_MODES.find(m => m.value === yMode);

  const points = useMemo(() => {
    if (!material || !param) return [];
    return sampleOrder.flatMap((sid, i) => {
      const s = sampleMap[sid];
      if (!s) return [];
      const pt = getXRDPosPoint(s, material, param, yMode, hkl, structures);
      if (!pt) return [];
      return [{ ...pt, sid, color: colors[i], label: labels[sid] || sid }];
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sampleOrder, material, param, yMode, hkl, JSON.stringify(structures), sampleMap, colors.join(",")]);

  const rc2 = { fontFamily: "'DM Mono', monospace", fontSize: 11, borderRadius: 4, padding: "4px 8px", outline: "none", cursor: "pointer", boxSizing: "border-box" };
  const W  = ps.plotWidth  ? ps.plotWidth  * 96 : undefined;
  const H  = ps.plotHeight ? ps.plotHeight * 96 : 320;

  // Reference line (bulk position) for 2θ and d modes
  const refShapes = [];
  if (hkl && material && (yMode === "2theta" || yMode === "d")) {
    const struct = structures.find(s => s.name === material);
    if (struct) {
      const refTT = calcTwoTheta(struct, hkl);
      if (refTT != null) {
        const LAMBDA = 1.5406;
        const refY = yMode === "d" ? LAMBDA / (2 * Math.sin(refTT * Math.PI / 360)) : refTT;
        refShapes.push({ type: "line", xref: "paper", yref: "y", x0: 0, x1: 1, y0: refY, y1: refY, line: { color: T.textDim, width: 1, dash: "dot" } });
      }
    }
  }

  const plotEl = (() => {
    if (!material || !param) return (
      <div style={{ height: 80, display: "flex", alignItems: "center", justifyContent: "center", fontFamily: "'DM Mono', monospace", fontSize: 12, color: T.textDim }}>
        Select material and growth parameter below.
      </div>
    );
    if (!points.length) return (
      <div style={{ height: 80, display: "flex", alignItems: "center", justifyContent: "center", fontFamily: "'DM Mono', monospace", fontSize: 12, color: T.textDim }}>
        No fitted XRD peaks found for <em style={{ marginLeft: 4 }}>{material}</em>.
      </div>
    );
    const traces = [{
      x: points.map(p => p.x),
      y: points.map(p => p.y),
      mode: ps.metaLabels ? "markers+text" : "markers",
      type: "scatter",
      text:         ps.metaLabels ? points.map(p => p.label) : undefined,
      textposition: "top center",
      textfont:     { family: ps.font, size: ps.fontSize - 1, color: T.textSecondary },
      marker: {
        color:  points.map(p => p.color),
        size:   config.marker_size   ?? 9,
        symbol: config.marker_symbol ?? "circle",
        line:   { color: T.bg0, width: 1 },
      },
      customdata: points.map(p => p.label),
      hovertemplate: `%{customdata}<br>${paramInfo?.label ?? param}: %{x}<br>${yModeInfo?.label ?? yMode}: %{y:.4f}<extra></extra>`,
      showlegend: false,
    }];
    const layout = {
      paper_bgcolor: T.bg1, plot_bgcolor: T.bg1,
      font:   { family: ps.font, size: ps.fontSize, color: T.textPrimary },
      margin: { t: 16, r: 20, b: 52, l: 64, pad: 0 },
      xaxis:  {
        title:     { text: paramInfo?.label ?? param, font: { size: 12, color: T.textSecondary }, standoff: 10 },
        gridcolor: T.border, color: T.textSecondary, zeroline: false,
        ...(ps.xMin != null || ps.xMax != null ? { range: [ps.xMin ?? null, ps.xMax ?? null] } : {}),
        ...(ps.xTick ? { dtick: ps.xTick } : {}),
      },
      yaxis:  {
        title:     { text: `${material}${hkl ? " " + hkl : ""} — ${yModeInfo?.label ?? yMode}`, font: { size: 12, color: T.textSecondary }, standoff: 8 },
        gridcolor: T.border, color: T.textSecondary,
        zeroline:  ps.zeroLines || yMode === "strain",
        zerolinecolor: T.border,
        ...(ps.yMin != null || ps.yMax != null ? { range: [ps.yMin ?? null, ps.yMax ?? null] } : {}),
        ...(ps.yTick ? { dtick: ps.yTick } : {}),
      },
      shapes:    refShapes,
      hovermode: "closest",
      width: W, height: H,
    };
    return (
      <Suspense fallback={<div style={{ height: H, background: T.bg1 }} />}>
        <Plot data={traces} layout={layout} config={{ displayModeBar: false, responsive: !W }} style={{ width: "100%" }} />
      </Suspense>
    );
  })();

  return (
    <div>
      {plotEl}
      {/* Inline config row */}
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "flex-end", marginTop: 10, paddingTop: 10, borderTop: `1px solid ${T.border}` }}>
        <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
          <span style={{ fontSize: 9, color: T.textDim, fontFamily: "'DM Mono', monospace", textTransform: "uppercase", letterSpacing: 1 }}>Material</span>
          <select value={material} onChange={e => onUpdate({ material: e.target.value })}
            style={{ ...rc2, background: T.bg0, border: `1px solid ${material ? T.amber : T.border}`, color: material ? T.amber : T.textDim, minWidth: 110 }}>
            <option value="">— select —</option>
            {structures.map(s => <option key={s.name} value={s.name}>{s.name}</option>)}
          </select>
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
          <span style={{ fontSize: 9, color: T.textDim, fontFamily: "'DM Mono', monospace", textTransform: "uppercase", letterSpacing: 1 }}>hkl</span>
          <DeferredInput value={hkl} onChange={v => onUpdate({ hkl: v })} placeholder="e.g. 002"
            style={{ ...rc2, width: 72, background: T.bg0, border: `1px solid ${T.border}`, color: T.textPrimary, textAlign: "center" }} />
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
          <span style={{ fontSize: 9, color: T.textDim, fontFamily: "'DM Mono', monospace", textTransform: "uppercase", letterSpacing: 1 }}>Y axis</span>
          <select value={yMode} onChange={e => onUpdate({ y_mode: e.target.value })}
            style={{ ...rc2, background: T.bg0, border: `1px solid ${T.border}`, color: T.textSecondary }}>
            {XRD_POS_Y_MODES.map(m => <option key={m.value} value={m.value}>{m.label}</option>)}
          </select>
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
          <span style={{ fontSize: 9, color: T.textDim, fontFamily: "'DM Mono', monospace", textTransform: "uppercase", letterSpacing: 1 }}>X axis — growth param</span>
          <select value={param} onChange={e => onUpdate({ param: e.target.value })}
            style={{ ...rc2, background: T.bg0, border: `1px solid ${param ? T.border : T.border}`, color: T.textSecondary, minWidth: 150 }}>
            <option value="">— select parameter —</option>
            {XRD_POS_PARAMS.map(p => <option key={p.value} value={p.value}>{p.label}</option>)}
          </select>
        </div>
      </div>
    </div>
  );
}

// ── Statistical Analysis panel ────────────────────────────────────────────────

function pearsonR(xs, ys) {
  const n = xs.length;
  if (n < 2) return null;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let num = 0, sx = 0, sy = 0;
  for (let i = 0; i < n; i++) {
    num += (xs[i] - mx) * (ys[i] - my);
    sx  += (xs[i] - mx) ** 2;
    sy  += (ys[i] - my) ** 2;
  }
  if (sx === 0 || sy === 0) return null;
  return num / Math.sqrt(sx * sy);
}

function rankArray(arr) {
  const sorted = arr.map((v, i) => ({ v, i })).sort((a, b) => a.v - b.v);
  const ranks = new Array(arr.length);
  // Handle ties by averaging ranks
  let i = 0;
  while (i < sorted.length) {
    let j = i;
    while (j < sorted.length - 1 && sorted[j + 1].v === sorted[j].v) j++;
    const avgRank = (i + j) / 2 + 1;
    for (let k = i; k <= j; k++) ranks[sorted[k].i] = avgRank;
    i = j + 1;
  }
  return ranks;
}

// Spearman ρ — Pearson applied to ranks (handles monotonic non-linear relationships)
function spearmanRho(xs, ys) {
  if (xs.length < 2) return null;
  return pearsonR(rankArray(xs), rankArray(ys));
}

// OLS linear regression: returns { slope, intercept, r2 } or null
function linearReg(xs, ys) {
  const n = xs.length;
  if (n < 2) return null;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let sxy = 0, sxx = 0;
  for (let i = 0; i < n; i++) { sxy += (xs[i] - mx) * (ys[i] - my); sxx += (xs[i] - mx) ** 2; }
  if (sxx === 0) return null;
  const slope = sxy / sxx;
  const intercept = my - slope * mx;
  const r = pearsonR(xs, ys);
  return { slope, intercept, r2: r != null ? r * r : null };
}

// Coolwarm diverging colorscale matching matplotlib's coolwarm (gray center at r=0)
const COOLWARM_SCALE = () => [
  [0,    "#3b4cc0"],
  [0.25, "#7aadfa"],
  [0.5,  "#c8c8c8"],   // neutral gray at zero
  [0.75, "#e87565"],
  [1,    "#b40426"],
];

// Expand paired META params into two scalar entries (pos / neg)
function buildStatParams(groups) {
  return groups.map(g => ({
    ...g,
    params: g.params.flatMap(p => {
      if (!p.paired) return [p];
      return [
        { ...p, id: p.id + "_pos", label: p.label + " (+)", paired: false,
          extract: (s, pc, am, st) => { const r = p.extract(s, pc, am, st); return r?.pos ?? null; } },
        { ...p, id: p.id + "_neg", label: p.label + " (−)", paired: false,
          extract: (s, pc, am, st) => { const r = p.extract(s, pc, am, st); return r?.neg ?? null; } },
      ];
    }),
  }));
}

// Multi-select param picker: dropdown with checkboxes, same visual style as CollapsibleParamSelect
function StatParamPicker({ selectedIds, groups, onChange }) {
  const [open, setOpen]         = useState(false);
  const [expanded, setExpanded] = useState({});
  const [dropUp, setDropUp]     = useState(false);
  const btnRef                  = useRef(null);

  const toggle = (id) => {
    onChange(selectedIds.includes(id) ? selectedIds.filter(x => x !== id) : [...selectedIds, id]);
  };
  const count = selectedIds.length;

  const handleOpen = () => {
    if (!open && btnRef.current) {
      const rect = btnRef.current.getBoundingClientRect();
      setDropUp(window.innerHeight - rect.bottom < 360);
    }
    setOpen(v => !v);
  };

  return (
    <div style={{ position: "relative" }}>
      {open && <div onClick={() => setOpen(false)} style={{ position: "fixed", inset: 0, zIndex: 90 }} />}
      <button ref={btnRef} onClick={handleOpen}
        style={{ background: T.bg0, border: `1px solid ${T.border}`, borderRadius: 4, color: count ? T.textPrimary : T.textDim, fontFamily: "'DM Mono', monospace", fontSize: 11, padding: "5px 10px", cursor: "pointer", display: "flex", alignItems: "center", gap: 6 }}>
        <span>{count ? `${count} parameter${count > 1 ? "s" : ""}` : "+ add parameters"}</span>
        <span style={{ fontSize: 8, opacity: 0.5 }}>▼</span>
      </button>
      {open && (
        <div onClick={e => e.stopPropagation()}
          style={{ position: "absolute", left: 0, ...(dropUp ? { bottom: "calc(100% + 4px)" } : { top: "calc(100% + 4px)" }), background: T.bg2, border: `1px solid ${T.borderBright}`, borderRadius: 6, zIndex: 200, minWidth: 260, maxHeight: 340, overflowY: "auto", boxShadow: "0 4px 16px rgba(0,0,0,.5)" }}>
          {groups.map(g => (
            <div key={g.group}>
              <div onClick={() => setExpanded(prev => ({ ...prev, [g.group]: !prev[g.group] }))}
                style={{ padding: "5px 12px", fontFamily: "'DM Mono', monospace", fontSize: 10, color: T.textDim, textTransform: "uppercase", letterSpacing: 0.5, background: T.bg3, cursor: "pointer", display: "flex", justifyContent: "space-between", alignItems: "center", userSelect: "none", borderTop: `1px solid ${T.border}` }}>
                <span>{g.group}</span>
                <span style={{ fontSize: 9, opacity: 0.6 }}>{expanded[g.group] ? "▲" : "▼"}</span>
              </div>
              {expanded[g.group] && g.params.map(p => (
                <label key={p.id} onClick={e => e.stopPropagation()}
                  style={{ display: "flex", alignItems: "center", gap: 8, padding: "4px 12px 4px 20px", cursor: "pointer", userSelect: "none" }}>
                  <input type="checkbox" checked={selectedIds.includes(p.id)} onChange={() => toggle(p.id)}
                    style={{ accentColor: T.amber, cursor: "pointer" }} />
                  <span style={{ fontFamily: "'DM Mono', monospace", fontSize: 11, color: selectedIds.includes(p.id) ? T.textPrimary : T.textSecondary }}
                    dangerouslySetInnerHTML={{ __html: `${p.label}${p.unit ? ` (${p.unit})` : ""}` }} />
                </label>
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function StatisticalAnalysisPanel({ sampleOrder, samples, plotCache, colors, labels = {}, config = {}, plotStyle, activeMaterial, structures = [], onUpdate }) {
  const ps          = plotStyle || DEFAULT_PLOT_STYLE;
  const selectedIds  = config.stat_params  || [];
  const corrMethod   = config.corr_method  || "pearson"; // "pearson" | "spearman"
  const statsView    = config.stats_view   || "corr";    // "corr" | "effects"
  const effectsY     = config.effects_y    || "";
  const corrReduced  = config.corr_reduced ?? false;     // lower-triangle + gray input-input
  // Single material selector covering both XRD and layer/growth params
  const statMaterial = config.stat_material ?? config.xrd_material ?? config.growth_material ?? activeMaterial ?? "";
  const [dragSrc, setDragSrc] = useState(null);
  const sampleMap  = useMemo(() => Object.fromEntries(samples.map(s => [s.id, s])), [samples]);

  // Dynamically build a "Stack" group:
  //   "Has [material]" — 0/1 for each material that appears in any layer
  //   "Buffer [mat1+mat2]" — 0/1 for each unique buffer-layer composition (co-sputter included)
  const stackGroup = useMemo(() => {
    const mats = new Set();
    // Map from sorted-material-key → display label (e.g. "BTO+SRO")
    const bufComboMap = new Map();
    for (const sid of sampleOrder) {
      const s = sampleMap[sid]; if (!s) continue;
      for (const layer of (s.layers || [])) {
        for (const t of (layer.targets || []))
          if (t.material) mats.add(t.material);
        if (layer.role === "buffer") {
          const layerMats = (layer.targets || []).map(t => t.material).filter(Boolean).sort();
          if (layerMats.length) {
            const key = layerMats.join("\0");
            if (!bufComboMap.has(key)) bufComboMap.set(key, layerMats.join("+"));
          }
        }
      }
    }
    // Common material abbreviations for compact heatmap labels
    const MAT_ABBREV = { LaSrMnO3: "LSMO", BaTiO3: "BTO", SrRuO3: "SRO", SrTiO3: "STO", BiFeO3: "BFO", PbZrTiO3: "PZT" };
    const abbrevMat = m => MAT_ABBREV[m] || m;

    const hasParams = [...mats].sort().map(mat => ({
      id: `stack_has_${mat}`,
      label: `Has ${mat}`,
      corrLabel: `Has ${abbrevMat(mat)}`,
      unit: "",
      extract: (s) => (s.layers || []).some(l => (l.targets || []).some(t => t.material === mat)) ? 1 : 0,
    }));
    const bufParams = [...bufComboMap.entries()].map(([key, label]) => {
      const comboMats = key.split("\0");
      return {
        id: `stack_buf_${key.replace(/\0/g, "_")}`,
        label: `Buffer ${label}`,
        corrLabel: "Buffer Layer",
        unit: "",
        extract: (s) => (s.layers || []).some(l =>
          l.role === "buffer" &&
          comboMats.every(m => (l.targets || []).some(t => t.material === m))
        ) ? 1 : 0,
      };
    });
    const params = [...hasParams, ...bufParams];
    return params.length ? { group: "Stack", isInput: true, params } : null;
  }, [sampleOrder, sampleMap]);

  // Filtered groups (same data-availability logic as MetaAnalysisPanel)
  const statGroups = useMemo(() => {
    const baseGroups = buildStatParams(META_PARAM_GROUPS);
    const hasPE    = sampleOrder.some(sid => plotCache[sid]?.pe?.length > 0);
    const hasDielF = sampleOrder.some(sid => plotCache[sid]?.diel_f?.length > 0);
    const hasDielB = sampleOrder.some(sid => (plotCache[sid]?.diel_b_up?.length || 0) + (plotCache[sid]?.diel_b_down?.length || 0) > 0);
    const hasXRD   = sampleOrder.some(sid => {
      const s = sampleMap[sid]; if (!s) return false;
      const saved = s.xrd_peaks;
      const lines = saved && !Array.isArray(saved) ? (saved.lines || []) : (Array.isArray(saved) ? saved : []);
      return lines.some(l => l.fitted_center != null);
    });
    const filtered = baseGroups.map(g => {
      let params;
      if (g.group === "Growth" || g.group === "Sample") {
        // Try activeMaterial first; fall back to any material present in the sample's layers
        params = g.params.filter(p => sampleOrder.some(sid => {
          const s = sampleMap[sid]; if (!s) return false;
          if (activeMaterial && p.extract(s, {}, activeMaterial) != null) return true;
          const mats = [...new Set((s.layers || []).flatMap(l => (l.targets || []).map(t => t.material).filter(Boolean)))];
          return mats.some(m => p.extract(s, {}, m) != null);
        }));
      } else if (g.group === "P–E Hysteresis")        { params = hasPE    ? g.params : []; }
      else if (g.group === "Dielectric — freq sweep") { params = hasDielF ? g.params : []; }
      else if (g.group === "Dielectric — bias sweep") { params = hasDielB ? g.params : []; }
      else if (g.group === "X-ray")                   { params = hasXRD   ? g.params : []; }
      else                                             { params = g.params; }
      return { ...g, params };
    }).filter(g => g.params.length > 0);
    return stackGroup ? [...filtered, stackGroup] : filtered;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sampleOrder, sampleMap, plotCache, activeMaterial, structures, stackGroup]);

  const statParamsFlat = useMemo(() => statGroups.flatMap(g => g.params), [statGroups]);

  // Set of param IDs that are "input" (growth conditions / stack flags) vs measured outputs
  const inputParamIds = useMemo(() => {
    const ids = new Set();
    for (const g of statGroups) {
      if (g.isInput) g.params.forEach(p => ids.add(p.id));
    }
    return ids;
  }, [statGroups]);

  const anyXRD   = selectedIds.some(id => statParamsFlat.find(p => p.id === id)?.needsXRD);
  const anyLayer = selectedIds.some(id => statParamsFlat.find(p => p.id === id)?.needsLayer);

  const growthMaterial = statMaterial;

  // Extract a value map {sid → number} for each selected param
  const paramData = useMemo(() => {
    return selectedIds.map(id => {
      const param = statParamsFlat.find(p => p.id === id);
      if (!param) return null;
      const mat = (param.needsXRD || param.needsLayer) ? statMaterial : activeMaterial;
      const data = {};
      for (const sid of sampleOrder) {
        const s = sampleMap[sid]; if (!s) continue;
        const raw = param.extract(s, plotCache, mat, structures);
        if (raw == null || !isFinite(raw)) continue;
        data[sid] = raw;
      }
      return { id, param, data };
    }).filter(Boolean);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedIds, sampleOrder, sampleMap, plotCache, activeMaterial, statMaterial, structures, statParamsFlat]);

  // Correlation matrix
  const { matrix, nMatrix } = useMemo(() => {
    const n = paramData.length;
    const matrix  = Array.from({ length: n }, () => Array(n).fill(null));
    const nMatrix = Array.from({ length: n }, () => Array(n).fill(0));
    for (let i = 0; i < n; i++) {
      matrix[i][i]  = 1;
      nMatrix[i][i] = Object.keys(paramData[i].data).length;
      for (let j = i + 1; j < n; j++) {
        const common = sampleOrder.filter(sid => paramData[i].data[sid] != null && paramData[j].data[sid] != null);
        nMatrix[i][j] = nMatrix[j][i] = common.length;
        if (common.length < 2) { matrix[i][j] = matrix[j][i] = null; continue; }
        const xs = common.map(sid => paramData[i].data[sid]);
        const ys = common.map(sid => paramData[j].data[sid]);
        const r = corrMethod === "spearman" ? spearmanRho(xs, ys) : pearsonR(xs, ys);
        matrix[i][j] = matrix[j][i] = r;
      }
    }
    return { matrix, nMatrix };
  }, [paramData, sampleOrder, corrMethod]);

  const stripHtml = s => s.replace(/<[^>]+>/g, "").replace(/&[a-z]+;/g, c => ({ "&lt;": "<", "&gt;": ">", "&amp;": "&" }[c] || c));

  // Heatmap axis labels: use corrLabel (short form, no units) if defined, else label without units
  const axLabels = paramData.map(pd =>
    pd.param.corrLabel ? pd.param.corrLabel : stripHtml(pd.param.label)
  );

  const n = paramData.length;

  // In reduced mode: rows = params[1..n-1] (skip first, it has no lower-tri cells)
  //                  cols = params[0..n-2] (skip last, it has no lower-tri cells)
  // In full mode:    rows = cols = all params
  let rowParams = corrReduced ? paramData.slice(1)      : paramData;
  let colParams = corrReduced ? paramData.slice(0, -1)  : paramData;
  let yLabels   = corrReduced ? axLabels.slice(1)       : axLabels;
  let xLabels   = corrReduced ? axLabels.slice(0, -1)   : axLabels;

  // Maps from display row/col index → original paramData index
  let rowOrigIdx = rowParams.map((_, r) => corrReduced ? r + 1 : r);
  let colOrigIdx = colParams.map((_, c) => c);

  // In reduced mode, prune rows whose every visible cell is input-input (all "—").
  // Users can order input params to the top and they collapse out automatically.
  // Then prune columns that become entirely empty after row pruning.
  if (corrReduced) {
    const rowMask = rowParams.map((rpd, r) => {
      const i = rowOrigIdx[r];
      // Keep if any visible cell (j < i) is not input-input
      return colParams.some((cpd, c) => colOrigIdx[c] < i && !(inputParamIds.has(rpd.id) && inputParamIds.has(cpd.id)));
    });
    const keptRowParams  = rowParams.filter((_, r) => rowMask[r]);
    const keptYLabels    = yLabels.filter((_, r) => rowMask[r]);
    const keptRowOrigIdx = rowOrigIdx.filter((_, r) => rowMask[r]);

    const colMask = colParams.map((cpd, c) => {
      const j = colOrigIdx[c];
      return keptRowParams.some((rpd, dr) => {
        const i = keptRowOrigIdx[dr];
        return j < i && !(inputParamIds.has(rpd.id) && inputParamIds.has(cpd.id));
      });
    });
    rowParams  = keptRowParams;
    yLabels    = keptYLabels;
    rowOrigIdx = keptRowOrigIdx;
    colParams  = colParams.filter((_, c) => colMask[c]);
    xLabels    = xLabels.filter((_, c) => colMask[c]);
    colOrigIdx = colOrigIdx.filter((_, c) => colMask[c]);
  }

  const nr = rowParams.length;
  const nc = colParams.length;
  const fSz = Math.max(nr, nc) > 6 ? 9 : 11;

  const zData = rowParams.map((rpd, r) => {
    const i = rowOrigIdx[r];
    return colParams.map((cpd, c) => {
      const j = colOrigIdx[c];
      if (corrReduced && j >= i) return null;  // upper triangle + diagonal hidden
      if (i === j) return 0;                   // diagonal → gray midpoint (full mode)
      const bothInput = inputParamIds.has(rpd.id) && inputParamIds.has(cpd.id);
      if (bothInput) return 0;                 // input-input → gray midpoint
      return matrix[i]?.[j] ?? null;
    });
  });

  const annotations = [];
  for (let r = 0; r < nr; r++) {
    const rpd = rowParams[r];
    const i   = rowOrigIdx[r];
    for (let c = 0; c < nc; c++) {
      const cpd = colParams[c];
      const j   = colOrigIdx[c];
      if (corrReduced && j >= i) continue;     // skip upper triangle + diagonal
      const bothInput = inputParamIds.has(rpd.id) && inputParamIds.has(cpd.id);
      if (i === j || bothInput) {
        annotations.push({
          x: xLabels[c], y: yLabels[r], text: "—",
          font: { size: fSz, family: ps.font || "'DM Mono', monospace", color: T.textDim },
          showarrow: false, xref: "x", yref: "y",
        });
        continue;
      }
      const rv = matrix[i]?.[j];
      const ns = nMatrix[i]?.[j];
      const text    = rv == null ? "—" : rv.toFixed(2);
      const subtext = (rv != null && ns < sampleOrder.length) ? `n=${ns}` : "";
      annotations.push({
        x: xLabels[c], y: yLabels[r], text: subtext ? `${text}<br><sub>${subtext}</sub>` : text,
        font: { size: fSz, family: ps.font || "'DM Mono', monospace", color: rv != null && Math.abs(rv) > 0.6 ? "#ffffff" : T.textPrimary },
        showarrow: false, xref: "x", yref: "y",
      });
    }
  }

  const corrColorscale = COOLWARM_SCALE();
  const cellPx  = Math.max(48, Math.min(100, Math.floor(360 / Math.max(nr, nc, 1))));
  const autoH   = nr > 0 ? Math.max(200, nr * cellPx + 80) : 200;
  const displayW = ps.plotWidth  ? Math.round(ps.plotWidth  * 96) : null;
  const displayH = ps.plotHeight ? Math.round(ps.plotHeight * 96) : autoH;

  const trace = {
    type: "heatmap",
    z: zData, x: xLabels, y: yLabels,
    zmin: -1, zmax: 1,
    colorscale: corrColorscale,
    showscale: false,
    hovertemplate: `<b>%{y}</b> vs <b>%{x}</b><br>${corrMethod === "spearman" ? "ρ" : "r"} = %{z:.2f}<extra></extra>`,
    xgap: 2, ygap: 2,
  };

  const layout = {
    paper_bgcolor: T.bg1,
    plot_bgcolor:  T.bg1,
    modebar: { bgcolor: "transparent", color: T.textDim, activecolor: T.textPrimary },
    margin: { t: 16, r: 16, b: 120, l: 120, pad: 0 },
    font: { family: ps.font || "'DM Mono', monospace", size: ps.fontSize || 11, color: T.textDim },
    xaxis: { tickangle: xLabels.length * Math.max(...xLabels.map(l => l.length), 0) > 60 ? -40 : 0, automargin: true, tickfont: { size: Math.max(8, (ps.fontSize || 11) - 1), family: ps.font }, side: "bottom", showgrid: false, zeroline: false },
    yaxis: { automargin: true, tickfont: { size: Math.max(8, (ps.fontSize || 11) - 1), family: ps.font }, showgrid: false, zeroline: false, autorange: "reversed" },
    annotations,
    ...(displayW ? { width: displayW } : {}),
    height: displayH,
    uirevision: `stats-${selectedIds.join("-")}-${corrMethod}-${corrReduced}`,
  };

  // Main effects data: per-factor regression
  const effectsYParam  = statParamsFlat.find(p => p.id === effectsY) || null;
  const effectsYData   = effectsYParam ? paramData.find(pd => pd.id === effectsY) : null;
  const effectsFactors = statsView === "effects"
    ? paramData.filter(pd => pd.id !== effectsY)
    : [];

  const monoSm = { fontFamily: "'DM Mono', monospace", fontSize: 10, color: T.textDim };
  const segBtn = (active) => ({ background: active ? T.bg3 : T.bg0, border: "none", borderRight: `1px solid ${T.border}`, color: active ? T.textPrimary : T.textDim, fontFamily: "'DM Mono', monospace", fontSize: 10, padding: "3px 10px", cursor: "pointer" });

  const xrdMats = useMemo(() => [...new Set(sampleOrder.flatMap(sid => {
    const s = sampleMap[sid]; if (!s) return [];
    const saved = s.xrd_peaks;
    const lines = saved && !Array.isArray(saved) ? (saved.lines || []) : (Array.isArray(saved) ? saved : []);
    return lines.map(l => l.material).filter(Boolean);
  }))].sort(), [sampleOrder, sampleMap]);

  const layerMats = useMemo(() => [...new Set(sampleOrder.flatMap(sid => {
    const s = sampleMap[sid]; if (!s) return [];
    return (s.layers || []).flatMap(l => (l.targets || []).map(t => t.material).filter(Boolean));
  }))].sort(), [sampleOrder, sampleMap]);

  const effectsCols = config.effects_cols ? Number(config.effects_cols) : 3;

  return (
    <div>
      {/* Parameter selector row — chips are draggable for reordering */}
      <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 6, marginBottom: 8 }}>
        <StatParamPicker selectedIds={selectedIds} groups={statGroups} onChange={ids => onUpdate({ stat_params: ids })} />
        {selectedIds.map((id, i) => {
          const p = statParamsFlat.find(x => x.id === id);
          if (!p) return null;
          const lbl = stripHtml(`${p.label}${p.unit ? ` (${p.unit})` : ""}`);
          const isOver = dragSrc != null && dragSrc !== i;
          return (
            <div key={id}
              draggable
              onDragStart={() => setDragSrc(i)}
              onDragOver={e => { e.preventDefault(); }}
              onDrop={() => {
                if (dragSrc == null || dragSrc === i) return;
                const next = [...selectedIds];
                const [item] = next.splice(dragSrc, 1);
                next.splice(i, 0, item);
                onUpdate({ stat_params: next });
                setDragSrc(null);
              }}
              onDragEnd={() => setDragSrc(null)}
              style={{ display: "flex", alignItems: "center", gap: 4, background: T.bg3, border: `1px solid ${isOver ? T.amber : T.border}`, borderRadius: 4, padding: "2px 6px", cursor: "grab", opacity: dragSrc === i ? 0.4 : 1 }}>
              <span style={{ ...monoSm, color: statsView === "effects" && id === effectsY ? T.amber : T.textSecondary }}>{lbl}</span>
              <button onClick={() => onUpdate({ stat_params: selectedIds.filter(x => x !== id) })}
                style={{ background: "none", border: "none", color: T.textDim, fontFamily: "'DM Mono', monospace", fontSize: 13, lineHeight: 1, padding: 0, cursor: "pointer" }}>×</button>
            </div>
          );
        })}
      </div>

      {/* Options row */}
      <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 16, marginBottom: 8 }}>
        {/* View toggle */}
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{ ...monoSm, textTransform: "uppercase", letterSpacing: 1 }}>VIEW</span>
          <div style={{ display: "flex", borderRadius: 4, overflow: "hidden", border: `1px solid ${T.border}` }}>
            <button onClick={() => onUpdate({ stats_view: "corr" })}    style={segBtn(statsView === "corr")}>Correlation</button>
            <button onClick={() => onUpdate({ stats_view: "effects" })} style={{ ...segBtn(statsView === "effects"), borderRight: "none" }}>Main effects</button>
          </div>
        </div>
        {/* Correlation method + reduce (only relevant for corr view) */}
        {statsView === "corr" && (<>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span style={{ ...monoSm, textTransform: "uppercase", letterSpacing: 1 }}>METHOD</span>
            <div style={{ display: "flex", borderRadius: 4, overflow: "hidden", border: `1px solid ${T.border}` }}>
              <button onClick={() => onUpdate({ corr_method: "pearson" })}  style={segBtn(corrMethod === "pearson")}>Pearson r</button>
              <button onClick={() => onUpdate({ corr_method: "spearman" })} style={{ ...segBtn(corrMethod === "spearman"), borderRight: "none" }}>Spearman ρ</button>
            </div>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span style={{ ...monoSm, textTransform: "uppercase", letterSpacing: 1 }}>REDUCE</span>
            <button onClick={() => onUpdate({ corr_reduced: !corrReduced })}
              style={{ fontFamily: "'DM Mono', monospace", fontSize: 11, padding: "3px 10px", borderRadius: 4, border: `1px solid ${corrReduced ? T.accent : T.border}`, background: corrReduced ? T.accent + "22" : "none", color: corrReduced ? T.accent : T.textDim, cursor: "pointer" }}>
              {corrReduced ? "on" : "off"}
            </button>
          </div>
        </>)}
        {/* Response selector (main effects only) */}
        {statsView === "effects" && (
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span style={{ ...monoSm, textTransform: "uppercase", letterSpacing: 1 }}>RESPONSE</span>
            <select value={effectsY} onChange={e => onUpdate({ effects_y: e.target.value })}
              style={{ background: T.bg0, border: `1px solid ${effectsY ? T.amber : T.border}`, borderRadius: 4, color: effectsY ? T.amber : T.textDim, fontFamily: "'DM Mono', monospace", fontSize: 11, padding: "3px 8px" }}>
              <option value="">— pick Y —</option>
              {selectedIds.map(id => { const p = statParamsFlat.find(x => x.id === id); return p ? <option key={id} value={id}>{stripHtml(`${p.label}${p.unit ? ` (${p.unit})` : ""}`)}</option> : null; })}
            </select>
          </div>
        )}
        {/* Unified material selector — shown when any XRD or layer/growth param is active */}
        {(anyXRD || anyLayer) && (
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span style={{ ...monoSm, textTransform: "uppercase", letterSpacing: 1 }}>MAT</span>
            <select value={statMaterial} onChange={e => onUpdate({ stat_material: e.target.value })}
              style={{ background: T.bg0, border: `1px solid ${statMaterial ? T.amber : T.border}`, borderRadius: 4, color: statMaterial ? T.amber : T.textDim, fontFamily: "'DM Mono', monospace", fontSize: 11, padding: "3px 8px" }}>
              <option value="">— material —</option>
              {[...new Set([...xrdMats, ...layerMats])].sort().map(m => <option key={m} value={m}>{m}</option>)}
            </select>
          </div>
        )}
      </div>

      {/* ── Correlation heatmap ── */}
      {statsView === "corr" && (n < 2 ? (
        <div style={{ ...monoSm, padding: "32px 0" }}>Select at least 2 parameters above to compute correlations.</div>
      ) : (
        <SciPlotWrap ps={ps}>
          {() => (
            <Plot data={[trace]} layout={layout} config={buildPlotConfig("stats-corr", ps)}
              style={{ width: displayW ? `${displayW}px` : "100%", height: `${displayH}px` }}
              useResizeHandler />
          )}
        </SciPlotWrap>
      ))}

      {/* ── Main effects plots ── */}
      {statsView === "effects" && (!effectsY || !effectsYData ? (
        <div style={{ ...monoSm, padding: "32px 0" }}>Pick a response variable above, then add factor parameters.</div>
      ) : effectsFactors.length === 0 ? (
        <div style={{ ...monoSm, padding: "32px 0" }}>Add at least one factor parameter (other than the response).</div>
      ) : (
        <div style={{ display: "grid", gridTemplateColumns: `repeat(${Math.min(effectsFactors.length, effectsCols)}, 1fr)`, gap: "16px 12px", marginTop: 8 }}>
          {effectsFactors.map(factorPd => {
            const common = sampleOrder.filter(sid => factorPd.data[sid] != null && effectsYData.data[sid] != null);
            const xs = common.map(sid => factorPd.data[sid]);
            const ys = common.map(sid => effectsYData.data[sid]);
            const reg = linearReg(xs, ys);
            const xLabel = stripHtml(`${factorPd.param.label}${factorPd.param.unit ? ` (${factorPd.param.unit})` : ""}`);
            const yLabel = stripHtml(`${effectsYParam.label}${effectsYParam.unit ? ` (${effectsYParam.unit})` : ""}`);
            // Regression line span
            const xMin = Math.min(...xs), xMax = Math.max(...xs);
            const pad = (xMax - xMin) * 0.15 || Math.abs(xMin) * 0.1 || 1;
            const rx0 = xMin - pad, rx1 = xMax + pad;
            const traces = [
              // Regression line
              ...(reg ? [{ x: [rx0, rx1], y: [reg.intercept + reg.slope * rx0, reg.intercept + reg.slope * rx1],
                type: "scatter", mode: "lines", line: { color: T.textDim, width: 1.5, dash: "dash" },
                hoverinfo: "skip", showlegend: false }] : []),
              // Sample points
              ...common.map((sid, ci) => {
                const idx = sampleOrder.indexOf(sid);
                return {
                  x: [xs[ci]], y: [ys[ci]],
                  type: "scatter", mode: ps.metaLabels ? "markers+text" : "markers",
                  marker: { color: colors[idx] ?? T.teal, size: 9, line: { color: T.bg0, width: 1.5 } },
                  text: ps.metaLabels ? [labels[sid] || sid] : undefined,
                  textposition: "top center",
                  textfont: { size: (ps.fontSize || 11) - 1, family: ps.font, color: colors[idx] },
                  hovertemplate: `<b>${labels[sid] || sid}</b><br>${xLabel}: %{x}<br>${yLabel}: %{y}<extra></extra>`,
                  showlegend: false,
                };
              }),
            ];
            const r2Str = reg?.r2 != null ? `R² = ${reg.r2.toFixed(2)}` : "";
            const r2Corner = reg && reg.slope >= 0
              ? { x: 0.03, xanchor: "left" }
              : { x: 0.97, xanchor: "right" };
            const effLayout = buildPlotLayout(
              ps,
              { title: { text: xLabel, font: { size: ps.fontSize, family: ps.font, color: T.textSecondary }, standoff: 6 } },
              { title: { text: yLabel, font: { size: ps.fontSize, family: ps.font, color: T.textSecondary }, standoff: 6 } },
              [],
              {
                margin: { t: 28, r: 12, b: 52, l: 60, pad: 0 },
                annotations: r2Str ? [{ xref: "paper", yref: "paper", ...r2Corner, y: 0.97, yanchor: "top", text: r2Str, showarrow: false, font: { size: (ps.fontSize || 11) - 1, family: ps.font, color: T.textDim }, bgcolor: T.bg1 + "dd", borderpad: 3 }] : [],
                uirevision: `effects-${factorPd.id}-${effectsY}`,
              }
            );
            return (
              <SciPlotWrap key={factorPd.id} ps={ps} noSpacer>
                {() => (
                  <Plot data={traces} layout={effLayout} config={{ ...buildPlotConfig(`effects-${factorPd.id}`, ps), displayModeBar: "hover" }}
                    style={{ width: "100%", height: "240px" }} useResizeHandler />
                )}
              </SciPlotWrap>
            );
          })}
        </div>
      ))}
    </div>
  );
}

function AnalysisPanelBlock({ panel, sampleOrder, samples, plotCache, colors, labels = {}, colorScale: bookColorScale = "viridis", structures = [], activeMaterial = null, onRemove, onDuplicate, onUpdate, onDragStart, onDragOver, onDrop, onDragEnd, isDragOver }) {
  const { type, config } = panel;
  const [cogOpen, setCogOpen] = useState(false);
  const [savedFlash, setSavedFlash] = useState(false);
  const ps = {
    font:       config.plot_font        || "'DM Mono', monospace",
    fontSize:   config.plot_font_size   || 11,
    box:        config.plot_box         || "solid",
    grid:       config.plot_grid        || "dashed",
    lineWidth:  config.plot_line_width  || 1.5,
    ticks:      config.plot_ticks       ?? false,
    tickLen:    config.plot_tick_len    || 4,
    zeroLines:  config.plot_zero_lines  ?? (type === "pe" || type === "de"),
    xTick:      config.plot_x_tick      || null,
    yTick:      config.plot_y_tick      || null,
    plotWidth:  config.plot_width       != null ? Number(config.plot_width)  : null,
    plotHeight: config.plot_height      != null ? Number(config.plot_height) : null,
    rsmBins:        config.rsm_bins          || 256,
    rsmColorbar:    config.rsm_colorbar      ?? false,
    rsmLogIntensity: config.rsm_log_intensity ?? true,
    rsmXMin:        config.rsm_x_min         != null ? Number(config.rsm_x_min) : null,
    rsmXMax:        config.rsm_x_max         != null ? Number(config.rsm_x_max) : null,
    rsmYMin:        config.rsm_y_min         != null ? Number(config.rsm_y_min) : null,
    rsmYMax:        config.rsm_y_max         != null ? Number(config.rsm_y_max) : null,
    rsmBgMethod:    config.rsm_bg_method      ?? (config.rsm_bg_sub ? "percentile" : null),
    rsmBgPct:       config.rsm_bg_pct        != null ? Number(config.rsm_bg_pct) : 5,
    rsmWhiteFade:   config.rsm_white_fade    != null ? Number(config.rsm_white_fade) : 0.10,
    rsmQ2pi:        config.rsm_q2pi         ?? false,
    rsmMaxCols:     config.rsm_max_cols      != null ? Number(config.rsm_max_cols) : null,
    rsmTight:       config.rsm_tight         ?? false,
    rsmLabelColor:  config.rsm_label_color   ?? "sample",
    colorScale:     bookColorScale,
    colorTrim:      config.color_trim        ?? 5,
    xMin:           config.x_min  != null ? Number(config.x_min)  : null,
    xMax:           config.x_max  != null ? Number(config.x_max)  : null,
    yMin:           config.y_min  != null ? Number(config.y_min)  : null,
    yMax:           config.y_max  != null ? Number(config.y_max)  : null,
    peXAxis:        config.pe_x_axis      || "field",
    deXAxis:        config.de_x_axis      || "field",
    metaLabels:     config.meta_labels    ?? false,
    y2Tick:         config.plot_y2_tick   || null,
    y2Min:          config.y2_min  != null ? Number(config.y2_min)  : null,
    y2Max:          config.y2_max  != null ? Number(config.y2_max)  : null,
  };
  const btnStyle = { background: "none", border: "none", color: T.textDim, cursor: "pointer", fontSize: 16, lineHeight: 1, padding: 0, borderRadius: 4, width: 26, height: 26, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 };
  const BOX_OPTS = ["off", "dashed", "solid"];
  return (
    <div
      onDragOver={e => { e.preventDefault(); onDragOver?.(); }}
      onDrop={e => { e.preventDefault(); onDrop?.(); }}
      style={{ background: T.bg1, border: `1px solid ${isDragOver ? T.accent : T.border}`, borderRadius: 10, padding: "14px 18px", transition: "border-color .12s", boxShadow: isDragOver ? `0 0 0 2px ${T.accent}44` : "none" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12 }}>
        {/* Drag handle */}
        <div draggable onDragStart={onDragStart} onDragEnd={onDragEnd}
          title="Drag to reorder"
          style={{ cursor: "grab", color: T.textDim, fontSize: 13, lineHeight: 1, padding: "0 1px", userSelect: "none", opacity: 0.5, flexShrink: 0 }}>⠿</div>
        <span style={{ fontFamily: "'DM Mono', monospace", fontSize: 11, color: T.textDim, textTransform: "uppercase", letterSpacing: 1 }}>{PANEL_LABELS[type] || type}</span>
        <div style={{ flex: 1 }} />
        {/* Duplicate */}
        <button onClick={onDuplicate} title="Duplicate panel"
          style={{ ...btnStyle, fontSize: 14 }}>⧉</button>
        {/* Cog */}
        <div style={{ position: "relative" }}>
          {cogOpen && <div onClick={() => setCogOpen(false)} style={{ position: "fixed", inset: 0, zIndex: 90 }} />}
          <button onClick={() => setCogOpen(v => !v)} title="Plot style"
            style={{ ...btnStyle, color: cogOpen ? T.textSecondary : T.textDim }}>⚙</button>
          {cogOpen && (
            <div onClick={e => e.stopPropagation()}
              style={{ position: "absolute", right: 0, top: "calc(100% + 6px)", background: T.bg2, border: `1px solid ${T.borderBright}`, borderRadius: 8, padding: "14px 16px", zIndex: 200, boxShadow: "0 4px 20px rgba(0,0,0,.5)", minWidth: 260, display: "flex", flexDirection: "column", gap: 12 }}>
              {/* Font */}
              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <span style={{ fontFamily: "'DM Mono', monospace", fontSize: 10, color: T.textDim, width: 66, flexShrink: 0 }}>FONT</span>
                <select value={ps.font} onChange={e => onUpdate({ plot_font: e.target.value })}
                  style={{ flex: 1, background: T.bg0, border: `1px solid ${T.border}`, borderRadius: 4, color: T.textPrimary, fontFamily: "'DM Mono', monospace", fontSize: 11, padding: "4px 6px", outline: "none" }}>
                  {FONT_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                </select>
              </div>
              {/* Font size */}
              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <span style={{ fontFamily: "'DM Mono', monospace", fontSize: 10, color: T.textDim, width: 66, flexShrink: 0 }}>FONT SIZE</span>
                <DeferredInput type="number" value={ps.fontSize} onChange={v => onUpdate({ plot_font_size: Number(v) || 11 })}
                  className="no-spin" min="6" max="20" step="1"
                  style={{ width: 60, background: T.bg0, border: `1px solid ${T.border}`, borderRadius: 4, color: T.textPrimary, fontFamily: "'DM Mono', monospace", fontSize: 11, padding: "4px 6px", outline: "none", textAlign: "center" }} />
              </div>
              {/* Box */}
              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <span style={{ fontFamily: "'DM Mono', monospace", fontSize: 10, color: T.textDim, width: 66, flexShrink: 0 }}>BOX</span>
                <div style={{ display: "flex", borderRadius: 4, overflow: "hidden", border: `1px solid ${T.border}` }}>
                  {BOX_OPTS.map((opt, idx) => (
                    <button key={opt} onClick={() => onUpdate({ plot_box: opt })}
                      style={{ fontFamily: "'DM Mono', monospace", fontSize: 10, padding: "4px 10px", background: ps.box === opt ? T.bg3 : T.bg0, border: "none", borderRight: idx < BOX_OPTS.length - 1 ? `1px solid ${T.border}` : "none", color: ps.box === opt ? T.textPrimary : T.textDim, cursor: "pointer", textTransform: "uppercase", letterSpacing: 0.5 }}>
                      {opt}
                    </button>
                  ))}
                </div>
              </div>
              {/* Grid */}
              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <span style={{ fontFamily: "'DM Mono', monospace", fontSize: 10, color: T.textDim, width: 66, flexShrink: 0 }}>GRID</span>
                <div style={{ display: "flex", borderRadius: 4, overflow: "hidden", border: `1px solid ${T.border}` }}>
                  {[["off","off"],["dotted","· ·"],["dashed","- -"],["solid","—"]].map(([val, lbl], idx, arr) => (
                    <button key={val} onClick={() => onUpdate({ plot_grid: val })}
                      style={{ fontFamily: "'DM Mono', monospace", fontSize: 10, padding: "4px 10px", background: ps.grid === val ? T.bg3 : T.bg0, border: "none", borderRight: idx < arr.length - 1 ? `1px solid ${T.border}` : "none", color: ps.grid === val ? T.textPrimary : T.textDim, cursor: "pointer", letterSpacing: 0.5 }}>
                      {lbl}
                    </button>
                  ))}
                </div>
              </div>
              {/* Line width */}
              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <span style={{ fontFamily: "'DM Mono', monospace", fontSize: 10, color: T.textDim, width: 66, flexShrink: 0 }}>LINE WIDTH</span>
                <DeferredInput type="number" value={ps.lineWidth} onChange={v => onUpdate({ plot_line_width: Number(v) || 1.5 })}
                  className="no-spin" min="0.5" max="5" step="0.5"
                  style={{ width: 60, background: T.bg0, border: `1px solid ${T.border}`, borderRadius: 4, color: T.textPrimary, fontFamily: "'DM Mono', monospace", fontSize: 11, padding: "4px 6px", outline: "none", textAlign: "center" }} />
              </div>
              {/* Ticks */}
              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <span style={{ fontFamily: "'DM Mono', monospace", fontSize: 10, color: T.textDim, width: 66, flexShrink: 0 }}>TICKS</span>
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <div style={{ display: "flex", borderRadius: 4, overflow: "hidden", border: `1px solid ${T.border}` }}>
                    {["off", "on"].map((opt, idx) => (
                      <button key={opt} onClick={() => onUpdate({ plot_ticks: opt === "on" })}
                        style={{ fontFamily: "'DM Mono', monospace", fontSize: 10, padding: "4px 10px", background: (ps.ticks ? "on" : "off") === opt ? T.bg3 : T.bg0, border: "none", borderRight: idx === 0 ? `1px solid ${T.border}` : "none", color: (ps.ticks ? "on" : "off") === opt ? T.textPrimary : T.textDim, cursor: "pointer", textTransform: "uppercase", letterSpacing: 0.5 }}>
                        {opt}
                      </button>
                    ))}
                  </div>
                  {ps.ticks && (
                    <DeferredInput type="number" value={ps.tickLen} onChange={v => onUpdate({ plot_tick_len: Number(v) || 4 })}
                      className="no-spin" min="2" max="12" step="1" placeholder="4"
                      style={{ width: 48, background: T.bg0, border: `1px solid ${T.border}`, borderRadius: 4, color: T.textPrimary, fontFamily: "'DM Mono', monospace", fontSize: 11, padding: "4px 6px", outline: "none", textAlign: "center" }} />
                  )}
                </div>
              </div>
              {/* Zero lines */}
              {type !== "xrd" && type !== "afm" && (
                <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                  <span style={{ fontFamily: "'DM Mono', monospace", fontSize: 10, color: T.textDim, width: 66, flexShrink: 0 }}>ZERO LINES</span>
                  <div style={{ display: "flex", borderRadius: 4, overflow: "hidden", border: `1px solid ${T.border}` }}>
                    {["off", "on"].map((opt, idx) => (
                      <button key={opt} onClick={() => onUpdate({ plot_zero_lines: opt === "on" })}
                        style={{ fontFamily: "'DM Mono', monospace", fontSize: 10, padding: "4px 10px", background: (ps.zeroLines ? "on" : "off") === opt ? T.bg3 : T.bg0, border: "none", borderRight: idx === 0 ? `1px solid ${T.border}` : "none", color: (ps.zeroLines ? "on" : "off") === opt ? T.textPrimary : T.textDim, cursor: "pointer", textTransform: "uppercase", letterSpacing: 0.5 }}>
                        {opt}
                      </button>
                    ))}
                  </div>
                </div>
              )}
              {/* Tick spacing overrides */}
              {type !== "xrd" && type !== "afm" && (
                <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                  <span style={{ fontFamily: "'DM Mono', monospace", fontSize: 10, color: T.textDim, width: 66, flexShrink: 0 }}>TICK STEP</span>
                  <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                    <span style={{ fontFamily: "'DM Mono', monospace", fontSize: 10, color: T.textDim }}>X</span>
                    <DeferredInput type="number" value={ps.xTick || ""} onChange={v => onUpdate({ plot_x_tick: Number(v) > 0 ? Number(v) : null })}
                      className="no-spin" min="0" placeholder="auto"
                      style={{ width: 56, background: T.bg0, border: `1px solid ${T.border}`, borderRadius: 4, color: T.textPrimary, fontFamily: "'DM Mono', monospace", fontSize: 11, padding: "4px 6px", outline: "none", textAlign: "center" }} />
                    <span style={{ fontFamily: "'DM Mono', monospace", fontSize: 10, color: T.textDim }}>Y</span>
                    <DeferredInput type="number" value={ps.yTick || ""} onChange={v => onUpdate({ plot_y_tick: Number(v) > 0 ? Number(v) : null })}
                      className="no-spin" min="0" placeholder="auto"
                      style={{ width: 56, background: T.bg0, border: `1px solid ${T.border}`, borderRadius: 4, color: T.textPrimary, fontFamily: "'DM Mono', monospace", fontSize: 11, padding: "4px 6px", outline: "none", textAlign: "center" }} />
                  </div>
                </div>
              )}
              {/* Size */}
              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <span style={{ fontFamily: "'DM Mono', monospace", fontSize: 10, color: T.textDim, width: 66, flexShrink: 0 }}>SIZE</span>
                <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                  <span style={{ fontFamily: "'DM Mono', monospace", fontSize: 10, color: T.textDim }}>W</span>
                  <DeferredInput type="number" value={ps.plotWidth ?? ""} onChange={v => onUpdate({ plot_width: v === "" ? null : Math.max(0.5, Math.round(Number(v) * 100) / 100 || 4) })}
                    className="no-spin" min="0.5" max="30" step="0.25" placeholder="auto"
                    style={{ width: 56, background: T.bg0, border: `1px solid ${T.border}`, borderRadius: 4, color: T.textPrimary, fontFamily: "'DM Mono', monospace", fontSize: 11, padding: "4px 6px", outline: "none", textAlign: "center" }} />
                  <span style={{ fontFamily: "'DM Mono', monospace", fontSize: 10, color: T.textDim }}>H</span>
                  <DeferredInput type="number" value={ps.plotHeight ?? ""} onChange={v => onUpdate({ plot_height: v === "" ? null : Math.max(0.5, Math.round(Number(v) * 100) / 100 || 3.5) })}
                    className="no-spin" min="0.5" max="30" step="0.25" placeholder="auto"
                    style={{ width: 56, background: T.bg0, border: `1px solid ${T.border}`, borderRadius: 4, color: T.textPrimary, fontFamily: "'DM Mono', monospace", fontSize: 11, padding: "4px 6px", outline: "none", textAlign: "center" }} />
                  <span style={{ fontFamily: "'DM Mono', monospace", fontSize: 10, color: T.textDim }}>in</span>
                </div>
              </div>
              {/* Point labels — meta / xrd_pos */}
              {(type === "meta" || type === "xrd_pos") && (
                <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                  <span style={{ fontFamily: "'DM Mono', monospace", fontSize: 10, color: T.textDim, width: 66, flexShrink: 0 }}>LABELS</span>
                  <div style={{ display: "flex", borderRadius: 4, overflow: "hidden", border: `1px solid ${T.border}` }}>
                    {["off", "on"].map((opt, idx) => (
                      <button key={opt} onClick={() => onUpdate({ meta_labels: opt === "on" })}
                        style={{ fontFamily: "'DM Mono', monospace", fontSize: 10, padding: "4px 10px", background: (ps.metaLabels ? "on" : "off") === opt ? T.bg3 : T.bg0, border: "none", borderRight: idx === 0 ? `1px solid ${T.border}` : "none", color: (ps.metaLabels ? "on" : "off") === opt ? T.textPrimary : T.textDim, cursor: "pointer", textTransform: "uppercase", letterSpacing: 0.5 }}>
                        {opt}
                      </button>
                    ))}
                  </div>
                </div>
              )}
              {/* Channel selector — AFM only */}
              {type === "afm" && (() => {
                const afmChannelNames = sampleOrder.map(sid => plotCache[sid]?.afm?.channel_names).find(Boolean) || [];
                return afmChannelNames.length > 1 ? (
                  <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                    <span style={{ fontFamily: "'DM Mono', monospace", fontSize: 10, color: T.textDim, width: 66, flexShrink: 0 }}>CHANNEL</span>
                    <div style={{ display: "flex", borderRadius: 4, overflow: "hidden", border: `1px solid ${T.border}` }}>
                      {afmChannelNames.map((name, idx) => (
                        <button key={name} onClick={() => onUpdate({ afm_channel: name })}
                          style={{ fontFamily: "'DM Mono', monospace", fontSize: 10, padding: "4px 8px", background: (config.afm_channel || afmChannelNames[0]) === name ? T.bg3 : T.bg0, border: "none", borderRight: idx < afmChannelNames.length - 1 ? `1px solid ${T.border}` : "none", color: (config.afm_channel || afmChannelNames[0]) === name ? T.textPrimary : T.textDim, cursor: "pointer" }}>
                          {afmShortLabel(name)}
                        </button>
                      ))}
                    </div>
                  </div>
                ) : null;
              })()}
              {/* Color range — AFM only, keyed per channel */}
              {type === "afm" && (() => {
                const afmChannelNames = sampleOrder.map(sid => plotCache[sid]?.afm?.channel_names).find(Boolean) || [];
                const activeCh = config.afm_channel || afmChannelNames[0] || null;
                const chRange = config.afm_ranges?.[activeCh] ?? [null, null];
                const setRange = (idx, v) => {
                  const next = [...(chRange)];
                  next[idx] = v === "" ? null : Number(v);
                  onUpdate({ afm_ranges: { ...(config.afm_ranges || {}), [activeCh]: next } });
                };
                return activeCh ? (
                  <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                    <span style={{ fontFamily: "'DM Mono', monospace", fontSize: 10, color: T.textDim, width: 66, flexShrink: 0 }}>COLOR RANGE</span>
                    <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                      <DeferredInput type="number" value={chRange[0] ?? ""} onChange={v => setRange(0, v)}
                        className="no-spin" placeholder="min"
                        style={{ width: 56, background: T.bg0, border: `1px solid ${T.border}`, borderRadius: 4, color: T.textPrimary, fontFamily: "'DM Mono', monospace", fontSize: 11, padding: "4px 6px", outline: "none", textAlign: "center" }} />
                      <span style={{ fontFamily: "'DM Mono', monospace", fontSize: 10, color: T.textDim }}>–</span>
                      <DeferredInput type="number" value={chRange[1] ?? ""} onChange={v => setRange(1, v)}
                        className="no-spin" placeholder="max"
                        style={{ width: 56, background: T.bg0, border: `1px solid ${T.border}`, borderRadius: 4, color: T.textPrimary, fontFamily: "'DM Mono', monospace", fontSize: 11, padding: "4px 6px", outline: "none", textAlign: "center" }} />
                    </div>
                  </div>
                ) : null;
              })()}
              {/* PE / DE x-axis unit toggle */}
              {(type === "pe" || type === "de") && (
                <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                  <span style={{ fontFamily: "'DM Mono', monospace", fontSize: 10, color: T.textDim, width: 66, flexShrink: 0 }}>X AXIS</span>
                  <div style={{ display: "flex", gap: 4 }}>
                    {[{ v: "field", label: "kV/cm" }, { v: "voltage", label: "V" }].map(({ v, label }) => (
                      <button key={v} onClick={() => onUpdate({ [type === "pe" ? "pe_x_axis" : "de_x_axis"]: v, x_min: null, x_max: null, x_tick: null })}
                        style={{ fontFamily: "'DM Mono', monospace", fontSize: 10, padding: "3px 8px", borderRadius: 4, border: `1px solid ${(type === "pe" ? ps.peXAxis : ps.deXAxis) === v ? T.accent : T.border}`, background: (type === "pe" ? ps.peXAxis : ps.deXAxis) === v ? T.accent + "22" : T.bg0, color: (type === "pe" ? ps.peXAxis : ps.deXAxis) === v ? T.accent : T.textDim, cursor: "pointer" }}>
                        {label}
                      </button>
                    ))}
                  </div>
                </div>
              )}
              {/* X/Y Range — for panels other than xrd/rsm/afm which have their own range controls */}
              {type !== "xrd" && type !== "rsm" && type !== "afm" && <>
                <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                  <span style={{ fontFamily: "'DM Mono', monospace", fontSize: 10, color: T.textDim, width: 66, flexShrink: 0 }}>X RANGE</span>
                  <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                    <DeferredInput type="number" value={ps.xMin ?? ""} onChange={v => onUpdate({ x_min: v === "" ? null : Number(v) })}
                      className="no-spin" placeholder="min"
                      style={{ width: 56, background: T.bg0, border: `1px solid ${T.border}`, borderRadius: 4, color: T.textPrimary, fontFamily: "'DM Mono', monospace", fontSize: 11, padding: "4px 6px", outline: "none", textAlign: "center" }} />
                    <span style={{ fontFamily: "'DM Mono', monospace", fontSize: 10, color: T.textDim }}>–</span>
                    <DeferredInput type="number" value={ps.xMax ?? ""} onChange={v => onUpdate({ x_max: v === "" ? null : Number(v) })}
                      className="no-spin" placeholder="max"
                      style={{ width: 56, background: T.bg0, border: `1px solid ${T.border}`, borderRadius: 4, color: T.textPrimary, fontFamily: "'DM Mono', monospace", fontSize: 11, padding: "4px 6px", outline: "none", textAlign: "center" }} />
                  </div>
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                  <span style={{ fontFamily: "'DM Mono', monospace", fontSize: 10, color: T.textDim, width: 66, flexShrink: 0 }}>Y RANGE</span>
                  <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                    <DeferredInput type="number" value={ps.yMin ?? ""} onChange={v => onUpdate({ y_min: v === "" ? null : Number(v) })}
                      className="no-spin" placeholder="min"
                      style={{ width: 56, background: T.bg0, border: `1px solid ${T.border}`, borderRadius: 4, color: T.textPrimary, fontFamily: "'DM Mono', monospace", fontSize: 11, padding: "4px 6px", outline: "none", textAlign: "center" }} />
                    <span style={{ fontFamily: "'DM Mono', monospace", fontSize: 10, color: T.textDim }}>–</span>
                    <DeferredInput type="number" value={ps.yMax ?? ""} onChange={v => onUpdate({ y_max: v === "" ? null : Number(v) })}
                      className="no-spin" placeholder="max"
                      style={{ width: 56, background: T.bg0, border: `1px solid ${T.border}`, borderRadius: 4, color: T.textPrimary, fontFamily: "'DM Mono', monospace", fontSize: 11, padding: "4px 6px", outline: "none", textAlign: "center" }} />
                  </div>
                </div>
                {/* Y₂ step + range — meta only, when right axis is active */}
                {type === "meta" && !!config.y2_param && <>
                  <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                    <span style={{ fontFamily: "'DM Mono', monospace", fontSize: 10, color: T.textDim, width: 66, flexShrink: 0 }}>Y₂ STEP</span>
                    <DeferredInput type="number" value={ps.y2Tick || ""} onChange={v => onUpdate({ plot_y2_tick: Number(v) > 0 ? Number(v) : null })}
                      className="no-spin" min="0" placeholder="auto"
                      style={{ width: 56, background: T.bg0, border: `1px solid ${T.border}`, borderRadius: 4, color: T.textPrimary, fontFamily: "'DM Mono', monospace", fontSize: 11, padding: "4px 6px", outline: "none", textAlign: "center" }} />
                  </div>
                  <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                    <span style={{ fontFamily: "'DM Mono', monospace", fontSize: 10, color: T.textDim, width: 66, flexShrink: 0 }}>Y₂ RANGE</span>
                    <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                      <DeferredInput type="number" value={ps.y2Min ?? ""} onChange={v => onUpdate({ y2_min: v === "" ? null : Number(v) })}
                        className="no-spin" placeholder="min"
                        style={{ width: 56, background: T.bg0, border: `1px solid ${T.border}`, borderRadius: 4, color: T.textPrimary, fontFamily: "'DM Mono', monospace", fontSize: 11, padding: "4px 6px", outline: "none", textAlign: "center" }} />
                      <span style={{ fontFamily: "'DM Mono', monospace", fontSize: 10, color: T.textDim }}>–</span>
                      <DeferredInput type="number" value={ps.y2Max ?? ""} onChange={v => onUpdate({ y2_max: v === "" ? null : Number(v) })}
                        className="no-spin" placeholder="max"
                        style={{ width: 56, background: T.bg0, border: `1px solid ${T.border}`, borderRadius: 4, color: T.textPrimary, fontFamily: "'DM Mono', monospace", fontSize: 11, padding: "4px 6px", outline: "none", textAlign: "center" }} />
                    </div>
                  </div>
                </>}
              </>}
              {/* Stats-specific */}
              {type === "stats" && <>
                <div style={{ borderTop: `1px solid ${T.border}`, margin: "2px 0" }} />
                <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                  <span style={{ fontFamily: "'DM Mono', monospace", fontSize: 10, color: T.textDim, width: 66, flexShrink: 0 }}>COLS</span>
                  <DeferredInput type="number" value={config.effects_cols ?? 3} onChange={v => onUpdate({ effects_cols: Math.max(1, Math.min(6, Number(v) || 3)) })}
                    className="no-spin" min="1" max="6" step="1" placeholder="3"
                    style={{ width: 52, background: T.bg0, border: `1px solid ${T.border}`, borderRadius: 4, color: T.textPrimary, fontFamily: "'DM Mono', monospace", fontSize: 11, padding: "4px 6px", outline: "none", textAlign: "center" }} />
                </div>
              </>}
              {/* XRD-specific */}
              {type === "xrd" && <>
                <div style={{ borderTop: `1px solid ${T.border}`, margin: "2px 0" }} />
                <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                  <span style={{ fontFamily: "'DM Mono', monospace", fontSize: 10, color: T.textDim, width: 66, flexShrink: 0 }}>OFFSET</span>
                  <DeferredInput type="number" value={config.offset_decades ?? 2} onChange={v => onUpdate({ offset_decades: parseFloat(v) === 0 ? 0 : (parseFloat(v) || 2) })}
                    className="no-spin" min="0" step="0.5" placeholder="2"
                    style={{ width: 60, background: T.bg0, border: `1px solid ${T.border}`, borderRadius: 4, color: T.textPrimary, fontFamily: "'DM Mono', monospace", fontSize: 11, padding: "4px 6px", outline: "none", textAlign: "center" }} />
                  <span style={{ fontFamily: "'DM Mono', monospace", fontSize: 10, color: T.textDim }}>dec.</span>
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                  <span style={{ fontFamily: "'DM Mono', monospace", fontSize: 10, color: T.textDim, width: 66, flexShrink: 0 }}>2θ RANGE</span>
                  <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                    <DeferredInput type="number" value={config.theta_min ?? ""} onChange={v => onUpdate({ theta_min: v === "" ? null : Number(v) })}
                      className="no-spin" placeholder="min"
                      style={{ width: 52, background: T.bg0, border: `1px solid ${T.border}`, borderRadius: 4, color: T.textPrimary, fontFamily: "'DM Mono', monospace", fontSize: 11, padding: "4px 6px", outline: "none", textAlign: "center" }} />
                    <span style={{ fontFamily: "'DM Mono', monospace", fontSize: 10, color: T.textDim }}>–</span>
                    <DeferredInput type="number" value={config.theta_max ?? ""} onChange={v => onUpdate({ theta_max: v === "" ? null : Number(v) })}
                      className="no-spin" placeholder="max"
                      style={{ width: 52, background: T.bg0, border: `1px solid ${T.border}`, borderRadius: 4, color: T.textPrimary, fontFamily: "'DM Mono', monospace", fontSize: 11, padding: "4px 6px", outline: "none", textAlign: "center" }} />
                  </div>
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                  <span style={{ fontFamily: "'DM Mono', monospace", fontSize: 10, color: T.textDim, width: 66, flexShrink: 0 }}>PAD Y</span>
                  <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                    <span style={{ fontFamily: "'DM Mono', monospace", fontSize: 10, color: T.textDim }}>↑</span>
                    <DeferredInput type="number" value={config.pad_above ?? 2} onChange={v => onUpdate({ pad_above: parseFloat(v) === 0 ? 0 : (parseFloat(v) || 2) })}
                      className="no-spin" min="0" step="0.5" placeholder="2"
                      style={{ width: 48, background: T.bg0, border: `1px solid ${T.border}`, borderRadius: 4, color: T.textPrimary, fontFamily: "'DM Mono', monospace", fontSize: 11, padding: "4px 6px", outline: "none", textAlign: "center" }} />
                    <span style={{ fontFamily: "'DM Mono', monospace", fontSize: 10, color: T.textDim }}>↓</span>
                    <DeferredInput type="number" value={config.pad_below ?? 1} onChange={v => onUpdate({ pad_below: parseFloat(v) === 0 ? 0 : (parseFloat(v) || 1) })}
                      className="no-spin" min="0" step="0.5" placeholder="1"
                      style={{ width: 48, background: T.bg0, border: `1px solid ${T.border}`, borderRadius: 4, color: T.textPrimary, fontFamily: "'DM Mono', monospace", fontSize: 11, padding: "4px 6px", outline: "none", textAlign: "center" }} />
                    <span style={{ fontFamily: "'DM Mono', monospace", fontSize: 10, color: T.textDim }}>dec.</span>
                  </div>
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                  <span style={{ fontFamily: "'DM Mono', monospace", fontSize: 10, color: T.textDim, width: 66, flexShrink: 0 }}>NORMALIZE</span>
                  <label style={{ display: "flex", alignItems: "center", gap: 6, cursor: "pointer" }}>
                    <input type="checkbox" checked={config.normalize_baseline ?? true}
                      onChange={e => onUpdate({ normalize_baseline: e.target.checked })}
                      style={{ accentColor: T.amber }} />
                    <span style={{ fontFamily: "'DM Mono', monospace", fontSize: 10, color: T.textDim }}>baseline</span>
                  </label>
                </div>
              </>}
              {/* RSM-specific */}
              {type === "rsm" && <>
                <div style={{ borderTop: `1px solid ${T.border}`, margin: "2px 0" }} />
                <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                  <span style={{ fontFamily: "'DM Mono', monospace", fontSize: 10, color: T.textDim, width: 66, flexShrink: 0 }}>BIN SIZE</span>
                  <DeferredInput type="number" value={ps.rsmBins} onChange={v => onUpdate({ rsm_bins: Math.max(32, Math.min(512, Number(v) || 256)) })}
                    className="no-spin" min="32" max="512" step="32" placeholder="256"
                    style={{ width: 60, background: T.bg0, border: `1px solid ${T.border}`, borderRadius: 4, color: T.textPrimary, fontFamily: "'DM Mono', monospace", fontSize: 11, padding: "4px 6px", outline: "none", textAlign: "center" }} />
                  <span style={{ fontFamily: "'DM Mono', monospace", fontSize: 10, color: T.textDim }}>px</span>
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                  <span style={{ fontFamily: "'DM Mono', monospace", fontSize: 10, color: T.textDim, width: 66, flexShrink: 0 }}>COLORBAR</span>
                  <div style={{ display: "flex", borderRadius: 4, overflow: "hidden", border: `1px solid ${T.border}` }}>
                    {["off", "on"].map((opt, idx) => (
                      <button key={opt} onClick={() => onUpdate({ rsm_colorbar: opt === "on" })}
                        style={{ fontFamily: "'DM Mono', monospace", fontSize: 10, padding: "4px 10px", background: (ps.rsmColorbar ? "on" : "off") === opt ? T.bg3 : T.bg0, border: "none", borderRight: idx === 0 ? `1px solid ${T.border}` : "none", color: (ps.rsmColorbar ? "on" : "off") === opt ? T.textPrimary : T.textDim, cursor: "pointer", textTransform: "uppercase", letterSpacing: 0.5 }}>
                        {opt}
                      </button>
                    ))}
                  </div>
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                  <span style={{ fontFamily: "'DM Mono', monospace", fontSize: 10, color: T.textDim, width: 66, flexShrink: 0 }}>INTENSITY</span>
                  <div style={{ display: "flex", borderRadius: 4, overflow: "hidden", border: `1px solid ${T.border}` }}>
                    {["log", "linear"].map((opt, idx) => (
                      <button key={opt} onClick={() => onUpdate({ rsm_log_intensity: opt === "log" })}
                        style={{ fontFamily: "'DM Mono', monospace", fontSize: 10, padding: "4px 10px", background: (ps.rsmLogIntensity ? "log" : "linear") === opt ? T.bg3 : T.bg0, border: "none", borderRight: idx === 0 ? `1px solid ${T.border}` : "none", color: (ps.rsmLogIntensity ? "log" : "linear") === opt ? T.textPrimary : T.textDim, cursor: "pointer", textTransform: "uppercase", letterSpacing: 0.5 }}>
                        {opt}
                      </button>
                    ))}
                  </div>
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                  <span style={{ fontFamily: "'DM Mono', monospace", fontSize: 10, color: T.textDim, width: 66, flexShrink: 0 }}>BG SUB</span>
                  <div style={{ display: "flex", borderRadius: 4, overflow: "hidden", border: `1px solid ${T.border}` }}>
                    {[["none", null], ["%ile", "percentile"], ["med", "median"], ["plane", "plane"]].map(([label, val], idx, arr) => (
                      <button key={label} onClick={() => onUpdate({ rsm_bg_method: val })}
                        style={{ fontFamily: "'DM Mono', monospace", fontSize: 10, padding: "4px 8px", background: (ps.rsmBgMethod ?? null) === val ? T.bg3 : T.bg0, border: "none", borderRight: idx < arr.length - 1 ? `1px solid ${T.border}` : "none", color: (ps.rsmBgMethod ?? null) === val ? T.textPrimary : T.textDim, cursor: "pointer", letterSpacing: 0.5 }}>
                        {label}
                      </button>
                    ))}
                  </div>
                  {ps.rsmBgMethod === "percentile" && <>
                    <span style={{ fontFamily: "'DM Mono', monospace", fontSize: 10, color: T.textDim }}>pct</span>
                    <DeferredInput type="number" value={ps.rsmBgPct} onChange={v => onUpdate({ rsm_bg_pct: Math.max(0, Math.min(49, Number(v) || 5)) })}
                      className="no-spin" min="0" max="49" step="1" placeholder="5"
                      style={{ width: 44, background: T.bg0, border: `1px solid ${T.border}`, borderRadius: 4, color: T.textPrimary, fontFamily: "'DM Mono', monospace", fontSize: 11, padding: "4px 6px", outline: "none", textAlign: "center" }} />
                  </>}
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                  <span style={{ fontFamily: "'DM Mono', monospace", fontSize: 10, color: T.textDim, width: 66, flexShrink: 0 }}>Q UNITS</span>
                  <div style={{ display: "flex", borderRadius: 4, overflow: "hidden", border: `1px solid ${T.border}` }}>
                    {[["nm⁻¹ (h/a)", false], ["Å⁻¹ (2π/d)", true]].map(([label, val], idx) => (
                      <button key={label} onClick={() => onUpdate({ rsm_q2pi: val })}
                        style={{ fontFamily: "'DM Mono', monospace", fontSize: 10, padding: "4px 9px", background: (ps.rsmQ2pi ?? false) === val ? T.bg3 : T.bg0, border: "none", borderRight: idx === 0 ? `1px solid ${T.border}` : "none", color: (ps.rsmQ2pi ?? false) === val ? T.textPrimary : T.textDim, cursor: "pointer" }}>
                        {label}
                      </button>
                    ))}
                  </div>
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                  <span style={{ fontFamily: "'DM Mono', monospace", fontSize: 10, color: T.textDim, width: 66, flexShrink: 0 }}>BG FADE</span>
                  <DeferredInput type="number" value={ps.rsmWhiteFade} onChange={v => onUpdate({ rsm_white_fade: Math.max(0, Math.min(0.9, Number(v) || 0)) })}
                    className="no-spin" min="0" max="0.9" step="0.05" placeholder="0"
                    style={{ width: 56, background: T.bg0, border: `1px solid ${T.border}`, borderRadius: 4, color: T.textPrimary, fontFamily: "'DM Mono', monospace", fontSize: 11, padding: "4px 6px", outline: "none", textAlign: "center" }} />
                  <span style={{ fontFamily: "'DM Mono', monospace", fontSize: 10, color: T.textDim }}>0–0.9</span>
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                  <span style={{ fontFamily: "'DM Mono', monospace", fontSize: 10, color: T.textDim, width: 66, flexShrink: 0 }}>Qx RANGE</span>
                  <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
                    <DeferredInput type="number" value={ps.rsmXMin ?? ""} onChange={v => onUpdate({ rsm_x_min: v === "" ? null : Number(v) })}
                      step="any" placeholder="auto"
                      style={{ width: 76, background: T.bg0, border: `1px solid ${T.border}`, borderRadius: 4, color: T.textPrimary, fontFamily: "'DM Mono', monospace", fontSize: 11, padding: "4px 6px", outline: "none", textAlign: "center" }} />
                    <span style={{ fontFamily: "'DM Mono', monospace", fontSize: 10, color: T.textDim }}>–</span>
                    <DeferredInput type="number" value={ps.rsmXMax ?? ""} onChange={v => onUpdate({ rsm_x_max: v === "" ? null : Number(v) })}
                      step="any" placeholder="auto"
                      style={{ width: 76, background: T.bg0, border: `1px solid ${T.border}`, borderRadius: 4, color: T.textPrimary, fontFamily: "'DM Mono', monospace", fontSize: 11, padding: "4px 6px", outline: "none", textAlign: "center" }} />
                  </div>
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                  <span style={{ fontFamily: "'DM Mono', monospace", fontSize: 10, color: T.textDim, width: 66, flexShrink: 0 }}>Qz RANGE</span>
                  <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
                    <DeferredInput type="number" value={ps.rsmYMin ?? ""} onChange={v => onUpdate({ rsm_y_min: v === "" ? null : Number(v) })}
                      step="any" placeholder="auto"
                      style={{ width: 76, background: T.bg0, border: `1px solid ${T.border}`, borderRadius: 4, color: T.textPrimary, fontFamily: "'DM Mono', monospace", fontSize: 11, padding: "4px 6px", outline: "none", textAlign: "center" }} />
                    <span style={{ fontFamily: "'DM Mono', monospace", fontSize: 10, color: T.textDim }}>–</span>
                    <DeferredInput type="number" value={ps.rsmYMax ?? ""} onChange={v => onUpdate({ rsm_y_max: v === "" ? null : Number(v) })}
                      step="any" placeholder="auto"
                      style={{ width: 76, background: T.bg0, border: `1px solid ${T.border}`, borderRadius: 4, color: T.textPrimary, fontFamily: "'DM Mono', monospace", fontSize: 11, padding: "4px 6px", outline: "none", textAlign: "center" }} />
                  </div>
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                  <span style={{ fontFamily: "'DM Mono', monospace", fontSize: 10, color: T.textDim, width: 66, flexShrink: 0 }}>COLUMNS</span>
                  <DeferredInput type="number" value={ps.rsmMaxCols ?? ""} onChange={v => onUpdate({ rsm_max_cols: v === "" ? null : Math.max(1, Math.round(Number(v))) })}
                    className="no-spin" min="1" placeholder="auto"
                    style={{ width: 56, background: T.bg0, border: `1px solid ${T.border}`, borderRadius: 4, color: T.textPrimary, fontFamily: "'DM Mono', monospace", fontSize: 11, padding: "4px 6px", outline: "none", textAlign: "center" }} />
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                  <span style={{ fontFamily: "'DM Mono', monospace", fontSize: 10, color: T.textDim, width: 66, flexShrink: 0 }}>TIGHT</span>
                  <div style={{ display: "flex", borderRadius: 4, overflow: "hidden", border: `1px solid ${T.border}` }}>
                    {["off", "on"].map((opt, idx) => (
                      <button key={opt} onClick={() => onUpdate({ rsm_tight: opt === "on" })}
                        style={{ fontFamily: "'DM Mono', monospace", fontSize: 10, padding: "4px 10px", background: (ps.rsmTight ? "on" : "off") === opt ? T.bg3 : T.bg0, border: "none", borderRight: idx === 0 ? `1px solid ${T.border}` : "none", color: (ps.rsmTight ? "on" : "off") === opt ? T.textPrimary : T.textDim, cursor: "pointer", textTransform: "uppercase", letterSpacing: 0.5 }}>
                        {opt}
                      </button>
                    ))}
                  </div>
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                  <span style={{ fontFamily: "'DM Mono', monospace", fontSize: 10, color: T.textDim, width: 66, flexShrink: 0 }}>LABEL</span>
                  <div style={{ display: "flex", borderRadius: 4, overflow: "hidden", border: `1px solid ${T.border}` }}>
                    {[["sample", "colored"], ["black", "black"], ["off", "off"]].map(([val, label], idx, arr) => (
                      <button key={val} onClick={() => onUpdate({ rsm_label_color: val })}
                        style={{ fontFamily: "'DM Mono', monospace", fontSize: 10, padding: "4px 8px", background: (ps.rsmLabelColor ?? "sample") === val ? T.bg3 : T.bg0, border: "none", borderRight: idx < arr.length - 1 ? `1px solid ${T.border}` : "none", color: (ps.rsmLabelColor ?? "sample") === val ? T.textPrimary : T.textDim, cursor: "pointer", letterSpacing: 0.5 }}>
                        {label}
                      </button>
                    ))}
                  </div>
                </div>
              </>}
              {/* Save as default */}
              <div style={{ borderTop: `1px solid ${T.border}`, paddingTop: 10, marginTop: 2 }}>
                <button
                  onClick={() => {
                    saveDefaultPanelConfig(type, config);
                    setSavedFlash(true);
                    setTimeout(() => setSavedFlash(false), 1800);
                  }}
                  style={{ width: "100%", background: savedFlash ? T.accent + "22" : T.bg0, border: `1px solid ${savedFlash ? T.accent : T.border}`, borderRadius: 5, color: savedFlash ? T.accent : T.textDim, fontFamily: "'DM Mono', monospace", fontSize: 10, padding: "5px 0", cursor: "pointer", letterSpacing: 0.5, transition: "all 0.2s" }}>
                  {savedFlash ? "SAVED AS DEFAULT ✓" : "SAVE AS DEFAULT"}
                </button>
              </div>
            </div>
          )}
        </div>
        <button onClick={onRemove} title="Remove panel"
          style={btnStyle}>×</button>
      </div>
      {type === "xrd"  && <XRDComparisonPanel  sampleOrder={sampleOrder} plotCache={plotCache} colors={colors} labels={labels} structures={structures} config={config} plotStyle={ps} onUpdate={onUpdate} />}
      {type === "pe"   && <PEComparisonPanel   sampleOrder={sampleOrder} samples={samples} plotCache={plotCache} colors={colors} labels={labels} plotStyle={ps} config={config} onUpdate={onUpdate} />}
      {type === "rsm"  && <RSMComparisonPanel  sampleOrder={sampleOrder} plotCache={plotCache} colors={colors} labels={labels} plotStyle={ps} config={config} onUpdate={onUpdate} structures={structures} />}
      {type === "afm"  && <AfmComparisonPanel  sampleOrder={sampleOrder} plotCache={plotCache} labels={labels} plotStyle={ps} config={config} onUpdate={onUpdate} />}
      {type === "de"   && <DEComparisonPanel   sampleOrder={sampleOrder} samples={samples} plotCache={plotCache} colors={colors} labels={labels} plotStyle={ps} config={config} onUpdate={onUpdate} />}
      {type === "df"   && <DfComparisonPanel   sampleOrder={sampleOrder} samples={samples} plotCache={plotCache} colors={colors} labels={labels} plotStyle={ps} />}
      {type === "meta" && <MetaAnalysisPanel   sampleOrder={sampleOrder} samples={samples} plotCache={plotCache} colors={colors} labels={labels} config={config} plotStyle={ps} activeMaterial={activeMaterial} structures={structures} onUpdate={onUpdate} />}
      {type === "xrd_pos" && <XRDPeakPositionPanel sampleOrder={sampleOrder} samples={samples} colors={colors} labels={labels} config={config} plotStyle={ps} structures={structures} onUpdate={onUpdate} />}
      {type === "stats"      && <StatisticalAnalysisPanel  sampleOrder={sampleOrder} samples={samples} plotCache={plotCache} colors={colors} labels={labels} config={config} plotStyle={ps} activeMaterial={activeMaterial} structures={structures} onUpdate={onUpdate} />}
      {type === "parcoords"  && <ParallelCoordsPanel       sampleOrder={sampleOrder} samples={samples} plotCache={plotCache} colors={colors} labels={labels} config={config} plotStyle={ps} activeMaterial={activeMaterial} structures={structures} onUpdate={onUpdate} />}
    </div>
  );
}

// ── Parallel Coordinates Panel ────────────────────────────────────────────────

function ParallelCoordsPanel({ sampleOrder, samples, plotCache, colors, labels = {}, config = {}, plotStyle, activeMaterial, structures = [], onUpdate }) {
  const ps           = plotStyle || DEFAULT_PLOT_STYLE;
  const selectedIds  = config.stat_params  || [];
  const statMaterial = config.stat_material ?? activeMaterial ?? "";
  const sampleMap    = useMemo(() => Object.fromEntries(samples.map(s => [s.id, s])), [samples]);
  const monoSm       = { fontFamily: "'DM Mono', monospace", fontSize: 11, color: T.textDim };
  const stripHtml    = s => s.replace(/<[^>]+>/g, "").replace(/&[a-z]+;/g, c => ({ "&lt;": "<", "&gt;": ">", "&amp;": "&" }[c] || c));

  // ── reuse same group/param infrastructure as stats panel ──────────────────
  const stackGroup = useMemo(() => {
    const mats = new Set();
    const bufComboMap = new Map();
    for (const sid of sampleOrder) {
      const s = sampleMap[sid]; if (!s) continue;
      for (const layer of (s.layers || [])) {
        for (const t of (layer.targets || [])) if (t.material) mats.add(t.material);
        if (layer.role === "buffer") {
          const lm = (layer.targets || []).map(t => t.material).filter(Boolean).sort();
          if (lm.length) { const key = lm.join("\0"); if (!bufComboMap.has(key)) bufComboMap.set(key, lm.join("+")); }
        }
      }
    }
    const sorted = [...mats].sort();
    const hasP = sorted.map(mat => ({ id: `stack_has_${mat}`, label: `Has ${mat}`, unit: "", extract: s => (s.layers||[]).some(l=>(l.targets||[]).some(t=>t.material===mat))?1:0 }));
    const bufP = [...bufComboMap.entries()].map(([key, label]) => {
      const cm = key.split("\0");
      return { id: `stack_buf_${key.replace(/\0/g,"_")}`, label: `Buffer ${label}`, unit: "", extract: s => (s.layers||[]).some(l=>l.role==="buffer"&&cm.every(m=>(l.targets||[]).some(t=>t.material===m)))?1:0 };
    });
    const params = [...hasP, ...bufP];
    return params.length ? { group: "Stack", params } : null;
  }, [sampleOrder, sampleMap]);

  const statGroups = useMemo(() => {
    const baseGroups = buildStatParams(META_PARAM_GROUPS);
    const hasPE    = sampleOrder.some(sid => plotCache[sid]?.pe?.length > 0);
    const hasDielF = sampleOrder.some(sid => plotCache[sid]?.diel_f?.length > 0);
    const hasDielB = sampleOrder.some(sid => (plotCache[sid]?.diel_b_up?.length||0)+(plotCache[sid]?.diel_b_down?.length||0) > 0);
    const hasXRD   = sampleOrder.some(sid => { const s=sampleMap[sid]; if(!s) return false; const saved=s.xrd_peaks; const lines=saved&&!Array.isArray(saved)?(saved.lines||[]):(Array.isArray(saved)?saved:[]); return lines.some(l=>l.fitted_center!=null); });
    const filtered = baseGroups.map(g => {
      let params;
      if (g.group === "Growth" || g.group === "Sample") {
        params = g.params.filter(p => sampleOrder.some(sid => {
          const s = sampleMap[sid]; if (!s) return false;
          if (activeMaterial && p.extract(s, {}, activeMaterial) != null) return true;
          return [...new Set((s.layers||[]).flatMap(l=>(l.targets||[]).map(t=>t.material).filter(Boolean)))].some(m => p.extract(s,{},m)!=null);
        }));
      } else if (g.group==="P–E Hysteresis")        { params = hasPE    ? g.params : []; }
        else if (g.group==="Dielectric — freq sweep") { params = hasDielF ? g.params : []; }
        else if (g.group==="Dielectric — bias sweep") { params = hasDielB ? g.params : []; }
        else if (g.group==="X-ray")                   { params = hasXRD   ? g.params : []; }
        else                                           { params = g.params; }
      return { ...g, params };
    }).filter(g => g.params.length > 0);
    return stackGroup ? [...filtered, stackGroup] : filtered;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sampleOrder, sampleMap, plotCache, activeMaterial, structures, stackGroup]);

  const statParamsFlat = useMemo(() => statGroups.flatMap(g => g.params), [statGroups]);
  const anyXRD   = selectedIds.some(id => statParamsFlat.find(p => p.id === id)?.needsXRD);
  const anyLayer = selectedIds.some(id => statParamsFlat.find(p => p.id === id)?.needsLayer);

  const xrdMats   = useMemo(() => [...new Set(sampleOrder.flatMap(sid => { const s=sampleMap[sid]; if(!s) return []; const saved=s.xrd_peaks; const lines=saved&&!Array.isArray(saved)?(saved.lines||[]):(Array.isArray(saved)?saved:[]); return lines.map(l=>l.material).filter(Boolean); }))].sort(), [sampleOrder, sampleMap]);
  const layerMats = useMemo(() => [...new Set(sampleOrder.flatMap(sid => { const s=sampleMap[sid]; if(!s) return []; return (s.layers||[]).flatMap(l=>(l.targets||[]).map(t=>t.material).filter(Boolean)); }))].sort(), [sampleOrder, sampleMap]);
  const allMats   = useMemo(() => [...new Set([...xrdMats, ...layerMats])].sort(), [xrdMats, layerMats]);

  const paramData = useMemo(() => {
    return selectedIds.map(id => {
      const param = statParamsFlat.find(p => p.id === id); if (!param) return null;
      const mat = (param.needsXRD || param.needsLayer) ? statMaterial : activeMaterial;
      const data = {};
      for (const sid of sampleOrder) {
        const s = sampleMap[sid]; if (!s) continue;
        const raw = param.extract(s, plotCache, mat, structures);
        if (raw == null || !isFinite(raw)) continue;
        data[sid] = raw;
      }
      return { id, param, data };
    }).filter(Boolean);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedIds, sampleOrder, sampleMap, plotCache, activeMaterial, statMaterial, structures, statParamsFlat]);

  // ── Plotly parcoords trace ─────────────────────────────────────────────────
  const n = sampleOrder.length;
  const colorscale = n <= 1
    ? [[0, colors[0] ?? T.teal], [1, colors[0] ?? T.teal]]
    : colors.slice(0, n).map((c, i) => [i / (n - 1), c]);

  const dimensions = paramData.map(pd => {
    const vals = sampleOrder.map(sid => pd.data[sid] ?? NaN);
    const isBinary = sampleOrder.every(sid => pd.data[sid] == null || pd.data[sid] === 0 || pd.data[sid] === 1);
    const dim = { label: stripHtml(`${pd.param.label}${pd.param.unit ? ` (${pd.param.unit})` : ""}`), values: vals };
    if (isBinary) { dim.tickvals = [0, 1]; dim.ticktext = ["No", "Yes"]; dim.range = [-0.3, 1.3]; }
    return dim;
  });

  const trace = {
    type: "parcoords",
    line: { color: sampleOrder.map((_, i) => i), colorscale, showscale: false },
    dimensions,
    unselected: { line: { opacity: 0.08 } },
    labelfont:  { family: ps.font, size: ps.fontSize,         color: T.textSecondary },
    tickfont:   { family: ps.font, size: (ps.fontSize||11)-1, color: T.textDim       },
    rangefont:  { family: ps.font, size: (ps.fontSize||11)-2, color: T.textDim       },
  };

  const layout = {
    paper_bgcolor: "transparent",
    plot_bgcolor:  "transparent",
    font: { family: ps.font, size: ps.fontSize, color: T.textSecondary },
    margin: { t: 48, r: 60, b: 16, l: 80 },
    modebar: { bgcolor: "transparent", color: T.textDim, activecolor: T.textPrimary },
    uirevision: `parcoords-${selectedIds.join("-")}`,
  };

  return (
    <div>
      {/* Param picker + chips */}
      <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 6, marginBottom: 8 }}>
        <StatParamPicker selectedIds={selectedIds} groups={statGroups} onChange={ids => onUpdate({ stat_params: ids })} />
        {selectedIds.map(id => {
          const p = statParamsFlat.find(x => x.id === id);
          const lbl = p ? stripHtml(`${p.label}${p.unit ? ` (${p.unit})` : ""}`) : id;
          return (
            <div key={id} style={{ display: "flex", alignItems: "center", gap: 4, background: T.bg3, border: `1px solid ${T.border}`, borderRadius: 4, padding: "2px 6px" }}>
              <span style={{ ...monoSm, color: T.textSecondary }}>{lbl}</span>
              <button onClick={() => onUpdate({ stat_params: selectedIds.filter(x => x !== id) })}
                style={{ background: "none", border: "none", color: T.textDim, fontFamily: "'DM Mono', monospace", fontSize: 13, lineHeight: 1, padding: 0, cursor: "pointer" }}>×</button>
            </div>
          );
        })}
      </div>

      {/* MAT selector */}
      {(anyXRD || anyLayer) && (
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
          <span style={{ ...monoSm, textTransform: "uppercase", letterSpacing: 1 }}>MAT</span>
          <select value={statMaterial} onChange={e => onUpdate({ stat_material: e.target.value })}
            style={{ background: T.bg0, border: `1px solid ${statMaterial ? T.amber : T.border}`, borderRadius: 4, color: statMaterial ? T.amber : T.textDim, fontFamily: "'DM Mono', monospace", fontSize: 11, padding: "3px 8px" }}>
            <option value="">— material —</option>
            {allMats.map(m => <option key={m} value={m}>{m}</option>)}
          </select>
        </div>
      )}

      {/* Plot */}
      {dimensions.length < 2 ? (
        <div style={{ ...monoSm, padding: "32px 0" }}>Select at least 2 parameters above.</div>
      ) : (
        <SciPlotWrap ps={ps} noSpacer>
          {() => (
            <Plot data={[trace]} layout={layout}
              config={{ ...buildPlotConfig("parcoords", ps), displayModeBar: false }}
              style={{ width: "100%", height: "300px" }}
              useResizeHandler />
          )}
        </SciPlotWrap>
      )}

      {/* Sample legend */}
      {n > 0 && dimensions.length >= 2 && (
        <div style={{ display: "flex", flexWrap: "wrap", gap: "4px 14px", marginTop: 8 }}>
          {sampleOrder.map((sid, i) => (
            <div key={sid} style={{ display: "flex", alignItems: "center", gap: 5 }}>
              <div style={{ width: 20, height: 2, background: colors[i] ?? T.teal, borderRadius: 1 }} />
              <span style={{ ...monoSm, fontSize: 10, color: T.textSecondary }}>{labels[sid] || sid}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function AddPanelRow({ onAdd }) {
  const [open, setOpen] = useState(false);
  const [openUp, setOpenUp] = useState(false);
  const btnRef = useRef(null);
  const PANEL_TYPES = [
    { type: "xrd",       label: "XRD ω–2θ"              },
    { type: "rsm",       label: "RSM"                   },
    { type: "afm",       label: "Scanning Probe"        },
    { type: "pe",        label: "P–E Hysteresis"        },
    { type: "de",        label: "εᵣ vs E"               },
    { type: "df",        label: "εᵣ vs f"               },
    { type: "meta",      label: "Meta-analysis"         },
    { type: "stats",     label: "Statistical Analysis"  },
    { type: "parcoords", label: "Parallel Coordinates"  },
  ];
  const toggle = () => {
    if (!open && btnRef.current) {
      const rect = btnRef.current.getBoundingClientRect();
      const spaceBelow = window.innerHeight - rect.bottom;
      setOpenUp(spaceBelow < 240); // dropdown is ~220px tall
    }
    setOpen(v => !v);
  };
  const dropStyle = openUp
    ? { bottom: "100%", marginBottom: 4 }
    : { top: "100%",    marginTop: 4 };
  return (
    <div ref={btnRef} style={{ position: "relative", alignSelf: "center" }}>
      {open && <div onClick={() => setOpen(false)} style={{ position: "fixed", inset: 0, zIndex: 190 }} />}
      <Btn variant="ghost" onClick={toggle}>+ Add Panel</Btn>
      {open && (
        <div style={{ position: "absolute", left: "50%", transform: "translateX(-50%)", ...dropStyle, background: T.bg2, border: `1px solid ${T.borderBright}`, borderRadius: 8, padding: 6, zIndex: 200, display: "flex", flexDirection: "column", gap: 2, minWidth: 170, boxShadow: "0 4px 16px rgba(0,0,0,.55)" }}>
          {PANEL_TYPES.map(p => (
            <button key={p.type} onMouseDown={() => { onAdd(p.type); setOpen(false); }}
              style={{ background: "none", border: "none", color: T.textSecondary, cursor: "pointer", fontFamily: "'DM Mono', monospace", fontSize: 12, padding: "7px 12px", textAlign: "left", borderRadius: 5 }}>
              {p.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function AnalysisBookDetail({ book, samples, plotCache, onUpdateBook, settings }) {
  const cfg            = book.config || {};
  const sampleOrder    = cfg.sample_order?.length ? cfg.sample_order : (book.sample_ids || []);
  const colorScale     = cfg.color_scale    || "viridis";
  const colorTrim      = cfg.color_trim     ?? 5;
  const panels         = cfg.panels         || [];
  const labels         = cfg.labels         || {};
  const activeMaterial = cfg.active_material ?? null;
  const colors      = sampleColorScale(colorScale, sampleOrder.length, colorTrim);

  const updateCfg = (patch) => {
    const newCfg = { ...cfg, ...patch };
    const updates = { config: newCfg };
    if (patch.sample_order !== undefined) updates.sample_ids = patch.sample_order;
    onUpdateBook(updates);
  };

  const reorderSamples = (fromIdx, toIdx) => {
    const order = [...sampleOrder];
    const [item] = order.splice(fromIdx, 1);
    order.splice(toIdx, 0, item);
    updateCfg({ sample_order: order });
  };

  const [panelDragIdx,     setPanelDragIdx]     = useState(null);
  const [panelDragOverIdx, setPanelDragOverIdx] = useState(null);

  const reorderPanels = (fromIdx, toIdx) => {
    const arr = [...panels];
    const [item] = arr.splice(fromIdx, 1);
    arr.splice(toIdx, 0, item);
    updateCfg({ panels: arr });
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <SampleRoster
        sampleOrder={sampleOrder}
        samples={samples}
        colors={colors}
        colorScale={colorScale}
        colorTrim={colorTrim}
        labels={labels}
        activeMaterial={activeMaterial}
        onChangeActiveMaterial={m => updateCfg({ active_material: m })}
        onReorder={reorderSamples}
        onRemove={id => updateCfg({ sample_order: sampleOrder.filter(s => s !== id) })}
        onAddSamples={ids => {
          const existing = new Set(sampleOrder);
          updateCfg({ sample_order: [...sampleOrder, ...ids.filter(id => !existing.has(id))] });
        }}
        onChangeScale={scale => updateCfg({ color_scale: scale })}
        onChangeTrim={trim => updateCfg({ color_trim: trim })}
        onLabelChange={(sid, val) => updateCfg({ labels: { ...labels, [sid]: val } })}
      />
      {panels.map((panel, i) => (
        <AnalysisPanelBlock
          key={panel.id}
          panel={panel}
          sampleOrder={sampleOrder}
          samples={samples}
          plotCache={plotCache}
          colors={colors}
          labels={labels}
          colorScale={colorScale}
          structures={settings?.structures || []}
          activeMaterial={activeMaterial}
          isDragOver={panelDragOverIdx === i && panelDragIdx !== i}
          onDragStart={() => setPanelDragIdx(i)}
          onDragOver={() => setPanelDragOverIdx(i)}
          onDrop={() => { if (panelDragIdx !== null && panelDragIdx !== i) reorderPanels(panelDragIdx, i); setPanelDragIdx(null); setPanelDragOverIdx(null); }}
          onDragEnd={() => { setPanelDragIdx(null); setPanelDragOverIdx(null); }}
          onRemove={() => updateCfg({ panels: panels.filter(p => p.id !== panel.id) })}
          onDuplicate={() => {
            const clone = { ...panel, id: String(Date.now()), config: { ...panel.config } };
            const idx = panels.indexOf(panel);
            const next = [...panels];
            next.splice(idx + 1, 0, clone);
            updateCfg({ panels: next });
          }}
          onUpdate={patch => updateCfg({ panels: panels.map(p => p.id === panel.id ? { ...p, config: { ...p.config, ...patch } } : p) })}
        />
      ))}
      <AddPanelRow onAdd={type => updateCfg({ panels: [...panels, { id: String(Date.now()), type, config: defaultPanelConfig(type) }] })} />
    </div>
  );
}

// ── Analysis Books (tile + folder tile + modal) ───────────────────────────────

function BookFolderTile({ folder, books, childContent = null, depth = 0,
  onDeleteBook, onEditBook, onDuplicateBook, onOpenBook,
  onDrop, onDragStartBook, onEdit, onDelete, onDragStartFolder, onDropFolder }) {
  const lsKey = `bookfolder-open-${folder.id}`;
  const [open, setOpen] = useState(() => { try { const v = localStorage.getItem(lsKey); return v === null ? false : v === "1"; } catch { return false; } });
  const toggleOpen = () => setOpen(v => { const next = !v; try { localStorage.setItem(lsKey, next ? "1" : "0"); } catch {} return next; });
  const [bookDragOver, setBookDragOver] = useState(false);
  const [insertPos, setInsertPos] = useState(null);
  const folderBoxRef = useRef(null);
  const color = folder.color || T.borderBright;
  const isFolderDrag = e => e.dataTransfer.types.includes("text/x-folder");

  const handleDragOver = e => {
    e.preventDefault();
    if (isFolderDrag(e)) {
      const rect = folderBoxRef.current?.getBoundingClientRect();
      if (rect) {
        const pct = (e.clientY - rect.top) / rect.height;
        setInsertPos(pct < 0.25 ? "above" : pct > 0.75 ? "below" : "inside");
      }
      e.dataTransfer.dropEffect = "move";
    } else {
      e.dataTransfer.dropEffect = "move";
      setBookDragOver(true);
    }
  };
  const handleDragLeave = e => {
    if (!e.currentTarget.contains(e.relatedTarget)) {
      setBookDragOver(false);
      setInsertPos(null);
    }
  };
  const handleDrop = e => {
    e.preventDefault();
    if (isFolderDrag(e)) {
      const fid = e.dataTransfer.getData("text/x-folder");
      onDropFolder?.(fid, folder.id, insertPos ?? "inside");
    } else {
      onDrop?.();
    }
    setBookDragOver(false);
    setInsertPos(null);
  };
  const folderDragInside = insertPos === "inside";

  return (
    <div onDragOver={handleDragOver} onDragLeave={handleDragLeave} onDrop={handleDrop}
      style={{ marginLeft: depth > 0 ? 10 : 0, marginBottom: 8 }}>
      {insertPos === "above" && <div style={{ height: 3, background: T.amber, borderRadius: 2, marginBottom: 4 }} />}
      <div ref={folderBoxRef}
        style={{ border: `2px solid ${bookDragOver || folderDragInside ? T.amber : color}`, borderRadius: 10, overflow: "hidden", boxShadow: bookDragOver || folderDragInside ? `0 0 0 3px ${T.amberGlow}` : "none", transition: "border-color .12s, box-shadow .12s" }}>
        <div style={{ padding: "10px 16px", display: "flex", alignItems: "center", gap: 10, background: bookDragOver || folderDragInside ? T.bg3 : T.bg2, cursor: "pointer", userSelect: "none", transition: "background .12s" }}
          onClick={toggleOpen}>
          <span
            draggable
            onDragStart={e => {
              e.stopPropagation();
              e.dataTransfer.effectAllowed = "move";
              e.dataTransfer.setData("text/x-folder", folder.id);
              const ghost = document.createElement("div");
              ghost.style.cssText = `position:fixed;top:-1000px;left:-1000px;background:${T.bg2};border:2px solid ${color};border-radius:8px;padding:7px 14px;display:flex;align-items:center;gap:8px;font-family:'Playfair Display',serif;font-size:14px;color:${T.textPrimary};white-space:nowrap;pointer-events:none;box-shadow:0 4px 16px rgba(0,0,0,.4)`;
              ghost.innerHTML = `<span style="color:${T.textDim};font-size:14px;margin-right:2px">⠿</span><span style="width:10px;height:10px;border-radius:50%;background:${color};display:inline-block;flex-shrink:0"></span><span style="margin-left:4px">${folder.name}</span>`;
              document.body.appendChild(ghost);
              e.dataTransfer.setDragImage(ghost, 20, 18);
              setTimeout(() => document.body.removeChild(ghost), 0);
              onDragStartFolder?.(folder.id);
            }}
            onClick={e => e.stopPropagation()}
            style={{ cursor: "grab", color: T.textDim, fontSize: 16, lineHeight: 1, padding: "0 2px", flexShrink: 0, userSelect: "none" }}>⠿</span>
          <div style={{ width: 12, height: 12, borderRadius: "50%", background: color, flexShrink: 0 }} />
          <span style={{ fontFamily: "'Playfair Display', serif", fontSize: 16, color: T.textPrimary, flex: 1 }}>{folder.name}</span>
          <span style={{ fontFamily: "'DM Mono', monospace", fontSize: 11, color: T.textDim }}>{books.length}</span>
          <span style={{ color: T.textDim, fontSize: 11 }}>{open ? "▾" : "▸"}</span>
          <button onClick={e => { e.stopPropagation(); onEdit?.(); }} style={{ background: "none", border: "none", color: T.textDim, cursor: "pointer", fontSize: 13, padding: "0 3px" }}>✎</button>
          <button onClick={e => { e.stopPropagation(); if (window.confirm(`Delete folder "${folder.name}"? Books will become ungrouped.`)) onDelete?.(); }} style={{ background: "none", border: "none", color: T.red, cursor: "pointer", fontSize: 16, padding: "0 3px" }}>×</button>
        </div>
        {open && (
          <div style={{ padding: 12, background: T.bg0 }}>
            {childContent}
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill,minmax(310px,1fr))", gap: 12, marginTop: childContent ? 8 : 0 }}>
              {books.map(b => (
                <AnalysisBookTile key={b.id} book={b}
                  onClick={() => onOpenBook(b.id)}
                  onDelete={() => { if (window.confirm(`Delete book "${b.name}"?`)) onDeleteBook(b.id); }}
                  onEdit={() => onEditBook(b)}
                  onDuplicate={() => onDuplicateBook?.(b)}
                  onDragStart={onDragStartBook} />
              ))}
              {!books.length && !childContent && <div style={{ fontFamily: "'DM Mono', monospace", fontSize: 12, color: bookDragOver ? T.amber : T.textDim, padding: "8px 4px", transition: "color .12s" }}>{bookDragOver ? "Drop to add" : "Empty folder"}</div>}
            </div>
          </div>
        )}
      </div>
      {insertPos === "below" && <div style={{ height: 3, background: T.amber, borderRadius: 2, marginTop: 4 }} />}
    </div>
  );
}

function AnalysisBookTile({ book, onDelete, onEdit, onDuplicate, onClick, onDragStart }) {
  const orderedIds = book.config?.sample_order?.length ? book.config.sample_order : (book.sample_ids || []);
  const n = orderedIds.length;
  const scaleName  = book.config?.color_scale || "viridis";
  const colorTrim  = book.config?.color_trim  ?? 5;
  const colors = sampleColorScale(scaleName, n, colorTrim);
  const colorMap = Object.fromEntries(orderedIds.map((id, i) => [id, colors[i]]));
  return (
    <div
      draggable={!!onDragStart}
      onDragStart={onDragStart ? e => { e.dataTransfer.effectAllowed = "move"; e.dataTransfer.setData("text/x-book", book.id); onDragStart(book.id); } : undefined}
      onClick={onClick}
      style={{ background: T.bg1, border: `1px solid ${T.border}`, borderRadius: 10, padding: "14px 18px", display: "flex", flexDirection: "column", gap: 8, cursor: onClick ? "pointer" : "default" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
        <span style={{ fontFamily: "'Playfair Display', serif", fontSize: 18, color: T.blue }}>{book.name}</span>
        <div style={{ display: "flex", gap: 6 }}>
          <button onClick={e => { e.stopPropagation(); onEdit(); }}      style={{ background: "none", border: "none", color: T.textDim, cursor: "pointer", fontSize: 13 }}>✎</button>
          <button onClick={e => { e.stopPropagation(); onDuplicate?.(); }} title="Duplicate" style={{ background: "none", border: "none", color: T.textDim, cursor: "pointer", fontSize: 13, padding: "0 1px" }}>⧉</button>
          <button onClick={e => { e.stopPropagation(); onDelete(); }}     style={{ background: "none", border: "none", color: T.red,     cursor: "pointer", fontSize: 16 }}>×</button>
        </div>
      </div>
      <div style={{ fontFamily: "'DM Mono', monospace", fontSize: 11, color: T.textDim }}>
        {n} sample{n !== 1 ? "s" : ""}
      </div>
      <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
        {orderedIds.slice(0, 6).map(id => (
          <span key={id} style={{ fontFamily: "'DM Mono', monospace", fontSize: 10, color: "#fff", background: colorMap[id] || T.amber, borderRadius: 3, padding: "1px 6px" }}>{id}</span>
        ))}
        {n > 6 && <span style={{ fontFamily: "'DM Mono', monospace", fontSize: 10, color: T.textDim }}>+{n - 6} more</span>}
      </div>
    </div>
  );
}

function AddBookModal({ onSave, onClose, existing, samples, folders = [], bookFolders = [] }) {
  const [name,     setName]     = useState(existing?.name || "");
  const [folderId, setFolderId] = useState(existing?.folder_id || "");
  const [selected, setSelected] = useState(new Set(existing?.sample_ids || []));
  const toggle = id => setSelected(p => { const s = new Set(p); s.has(id) ? s.delete(id) : s.add(id); return s; });

  // Group samples by sample folder; ungrouped last.
  const byId = (a, b) => a.id.localeCompare(b.id, undefined, { numeric: true, sensitivity: "base" });
  const sampleFolders = folders.filter(f => !f.book_folder);
  const groups = [
    ...sampleFolders.map(f => ({ id: f.id, name: f.name, color: f.color, samples: samples.filter(s => s.folder_id === f.id).sort(byId) })),
    { id: "__ungrouped__", name: "Ungrouped", color: null, samples: samples.filter(s => !s.folder_id || !sampleFolders.find(f => f.id === s.folder_id)).sort(byId) },
  ].filter(g => g.samples.length > 0);

  // Auto-expand groups that contain already-selected samples (useful when editing).
  const [expanded, setExpanded] = useState(() => {
    const init = {};
    groups.forEach(g => { if (g.samples.some(s => selected.has(s.id))) init[g.id] = true; });
    return init;
  });
  const toggleGroup = id => setExpanded(p => ({ ...p, [id]: !p[id] }));

  const SampleRow = ({ s }) => (
    <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer", fontFamily: "'DM Mono', monospace", fontSize: 12, color: selected.has(s.id) ? T.blue : T.textSecondary, padding: "3px 8px", borderRadius: 4, background: selected.has(s.id) ? "rgba(99,179,237,.1)" : "transparent" }}>
      <input type="checkbox" checked={selected.has(s.id)} onChange={() => toggle(s.id)} style={{ accentColor: T.blue }} />
      <span style={{ fontWeight: 600 }}>{s.id}</span>
      {s.date  && <span style={{ color: T.textDim, fontSize: 10 }}>{s.date}</span>}
      {s.notes && <span style={{ color: T.textDim, fontSize: 10, flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{s.notes}</span>}
    </label>
  );

  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.75)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 100 }}>
      <div style={{ background: T.bg1, border: `1px solid ${T.borderBright}`, borderRadius: 12, padding: 28, width: 480, display: "flex", flexDirection: "column", gap: 16, maxHeight: "80vh" }}>
        <h2 style={{ margin: 0, fontFamily: "'Playfair Display', serif", color: T.blue, fontSize: 20 }}>{existing ? "Edit Book" : "New Analysis Book"}</h2>
        <Input label="Name" value={name} onChange={setName} placeholder="e.g. Thickness Study" />
        {bookFolders.length > 0 && (
          <Sel label="Folder (optional)" value={folderId} onChange={setFolderId}
            options={[{ value: "", label: "— No folder —" }, ...bookFolders.map(f => ({ value: f.id, label: f.name }))]} />
        )}
        <div style={{ display: "flex", flexDirection: "column", gap: 6, overflow: "hidden" }}>
          <Label>Samples</Label>
          <div style={{ overflowY: "auto", maxHeight: 300, border: `1px solid ${T.border}`, borderRadius: 6, overflow: "hidden auto" }}>
            {groups.map(g => (
              <div key={g.id}>
                {/* Group header */}
                <div onClick={() => toggleGroup(g.id)}
                  style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 8px", background: T.bg2, cursor: "pointer", userSelect: "none", borderBottom: `1px solid ${T.border}` }}>
                  {g.color && <div style={{ width: 8, height: 8, borderRadius: "50%", background: g.color, flexShrink: 0 }} />}
                  <span style={{ fontFamily: "'DM Mono', monospace", fontSize: 10, color: T.textDim, textTransform: "uppercase", letterSpacing: 0.8, flex: 1 }}>{g.name}</span>
                  <span style={{ fontFamily: "'DM Mono', monospace", fontSize: 10, color: T.textDim }}>{g.samples.filter(s => selected.has(s.id)).length}/{g.samples.length}</span>
                  <span style={{ fontSize: 9, color: T.textDim }}>{expanded[g.id] ? "▲" : "▼"}</span>
                </div>
                {/* Group samples */}
                {expanded[g.id] && (
                  <div style={{ display: "flex", flexDirection: "column", gap: 2, padding: "4px 0", background: T.bg0 }}>
                    {g.samples.map(s => <SampleRow key={s.id} s={s} />)}
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
          <Btn variant="ghost" onClick={onClose}>Cancel</Btn>
          <Btn onClick={() => { if (name.trim()) onSave({ name: name.trim(), sample_ids: [...selected], folder_id: folderId || null }); }} disabled={!name.trim()}>
            {existing ? "Save" : "Create"}
          </Btn>
        </div>
      </div>
    </div>
  );
}

// ── App ───────────────────────────────────────────────────────────────────────

export default function App() {
  const [darkMode, setDarkMode] = useState(() => localStorage.getItem("lablog-theme") !== "light");
  // Re-assign module-level T and MAT_PALETTE so every child render sees the current theme
  T = darkMode ? DARK_T : LIGHT_T;
  MAT_PALETTE = darkMode ? MAT_PALETTE_DARK : MAT_PALETTE_LIGHT;

  const [samples,  setSamples]  = useState([]);
  const [folders,  setFolders]  = useState([]);
  const [books,    setBooks]    = useState([]);
  const booksRef = useRef([]);
  useEffect(() => { booksRef.current = books; }, [books]);
  const [plotCache, setPlotCache] = useState({}); // { [sampleId]: { xrd_ot, xrr, rsm, pe, diel_b_up, diel_b_down, diel_f } }
  const [active,      setActive]      = useState(null); // sample id
  const [activeBook,  setActiveBook]  = useState(null); // book id
  const [editingMeta, setEditingMeta] = useState(false);
  const [adding,   setAdding]   = useState(false);
  const [templateSample, setTemplateSample] = useState(null); // sample to duplicate
  const [draggingSampleId, setDraggingSampleId] = useState(null);
  const [draggingBookId,   setDraggingBookId]   = useState(null);
  const [draggingFolderId, setDraggingFolderId] = useState(null);
  const [addingFolder, setAddingFolder] = useState(false);
  const [editingFolder, setEditingFolder] = useState(null); // folder object
  const [addingBook,    setAddingBook]    = useState(false);
  const [editingBook,   setEditingBook]   = useState(null);
  const [loading,  setLoading]  = useState(true);
  const [error,    setError]    = useState(null);
  const [settings, setSettings] = useState(() => JSON.parse(JSON.stringify(DEFAULT_SETTINGS)));
  const [settingsOpen,  setSettingsOpen]  = useState(false);
  const [exportOpen,    setExportOpen]    = useState(false);
  const [viewDataOpen,  setViewDataOpen]  = useState(false);  // View Data modal
  const [viewDataFiles, setViewDataFiles] = useState([]);
  const [viewDataLoading, setViewDataLoading] = useState(false);

  const handleSaveSettings = (s) => {
    // Always deep-merge with current settings so partial updates (e.g. xrd_configs)
    // never silently wipe other fields (structures, materials, etc.)
    const merged = mergeSettings({ ...settings, ...s });
    saveSettings(merged);
    setSettings(merged);
  };

  // Persist theme choice + sync body background
  useEffect(() => {
    localStorage.setItem("lablog-theme", darkMode ? "dark" : "light");
    document.body.style.background = darkMode ? DARK_T.bg0 : LIGHT_T.bg0;
  }, [darkMode]);

  // Load all data on mount
  useEffect(() => {
    document.body.style.margin = "0"; document.body.style.background = T.bg0;
    Promise.all([
      api("GET", "/samples"),
      api("GET", "/folders"),
      api("GET", "/analysis-books"),
      api("GET", "/settings"),
    ]).then(([s, f, b, cfg]) => {
      setSamples(s); setFolders(f); setBooks(b);
      setSettings(mergeSettings(cfg || {}));
      setLoading(false);
    }).catch(e => { setError(e.message); setLoading(false); });
  }, []);

  // ── Samples ──────────────────────────────────────────────────────────────

  const addSample = async (data) => {
    const payload = {
      ...data,
      layers: JSON.stringify ? data.layers : data.layers,
      id: data.id,
    };
    await api("POST", "/samples", { ...data });
    setSamples(p => [...p, { ...data }]);
    setAdding(false);
    setActive(data.id);
  };

  const updateSample = async (s) => {
    await api("PUT", `/samples/${s.id}`, s);
    setSamples(p => p.map(x => x.id === s.id ? s : x));
  };

  const deleteSample = async (id) => {
    try {
      await api("DELETE", `/samples/${id}`);
    } catch (e) {
      alert(`Delete failed: ${e.message}`);
      return;
    }
    setSamples(p => p.filter(x => x.id !== id));
    setPlotCache(p => { const c = { ...p }; delete c[id]; return c; });
    setActive(prev => (prev === id ? null : prev));
  };

  // ── File upload + plotCache ──────────────────────────────────────────────

  const handleUploadFile = async (measType, file, parsed, peArea) => {
    if (!active) return;
    const sample = samples.find(s => s.id === active);
    if (!sample) return;
    try {
      const { filename } = await uploadFile(active, measType, file);
      if (measType === "afm") {
        // Binary file — fetch processed data from the backend
        const afmData = await api("GET", `/samples/${active}/afm_data`);
        setPlotCache(p => ({ ...p, [active]: { ...(p[active] || {}), afm: afmData } }));
      } else {
        setPlotCache(p => {
          const prev = p[active] || {};
          if (measType === "diel_b_up" || measType === "diel_b_down") {
            const dir = measType === "diel_b_up" ? "up" : "down";
            return { ...p, [active]: { ...prev, [`diel_b_${dir}`]: parsed } };
          }
          return { ...p, [active]: { ...prev, [measType]: parsed } };
        });
      }
      // update sample filenames + area if PE
      const updatedSample = {
        ...sample,
        filenames: { ...sample.filenames, [measType]: filename },
        ...(measType === "pe" && peArea ? { area_m2: peArea } : {}),
      };
      await updateSample(updatedSample);
    } catch (e) { console.error("Upload failed", e); }
  };

  const handleViewData = async () => {
    if (!active) return;
    setViewDataLoading(true);
    setViewDataOpen(true);
    try {
      const files = await api("GET", `/samples/${active}/files`);
      setViewDataFiles(files || []);
    } catch (e) {
      setViewDataFiles([]);
      console.error("Failed to list files:", e);
    }
    setViewDataLoading(false);
  };

  const handleExportSample = () => {
    if (!active) return;
    const a = document.createElement("a");
    a.href = `${API_BASE}/samples/${active}/export`;
    a.download = `${active}_export.zip`;
    a.click();
  };

  const handleReparseFiles = async () => {
    const sample = samples.find(s => s.id === active);
    if (!sample) return;
    const filenames = sample.filenames || {};
    if (!Object.keys(filenames).length) return;
    const thick = sample.thickness_nm || 0;
    const newCache = {};
    let newArea = sample.area_m2;
    for (const [measType, filename] of Object.entries(filenames)) {
      if (!filename) continue;
      if (measType === "afm") {
        try { newCache.afm = await api("GET", `/samples/${sample.id}/afm_data`); } catch {}
        continue;
      }
      const text = await fetchFile(sample.id, filename);
      if (!text) continue;
      const parsed = csvToPlotData(text, measType, thick);
      if (!parsed || !hasPlotData(parsed)) continue;
      if (measType === "pe" && !newArea) newArea = findAreaFromFile(text);
      newCache[measType] = parsed;
    }
    setPlotCache(p => ({ ...p, [active]: { ...(p[active] || {}), ...newCache } }));
    if (newArea !== sample.area_m2) await updateSample({ ...sample, area_m2: newArea });
  };

  // Load plot data for a sample without changing the active view
  const loadSampleData = async (id) => {
    if (plotCache[id]) return; // already loaded
    const sample = samples.find(s => s.id === id);
    if (!sample) return;
    const filenames = sample.filenames || {};
    if (!Object.keys(filenames).length) return;
    const thick = sample.thickness_nm || 0;
    const cache = {};
    for (const [measType, filename] of Object.entries(filenames)) {
      if (!filename) continue;
      if (measType === "afm") {
        try { cache.afm = await api("GET", `/samples/${id}/afm_data`); } catch {}
        continue;
      }
      const text = await fetchFile(id, filename);
      if (!text) continue;
      const parsed = csvToPlotData(text, measType, thick);
      if (parsed && hasPlotData(parsed)) cache[measType] = parsed;
    }
    setPlotCache(p => ({ ...p, [id]: cache }));
  };

  // Load plot data when opening a sample
  const openSample = async (id) => {
    setActive(id);
    await loadSampleData(id);
  };

  // ── Folders ──────────────────────────────────────────────────────────────

  const createFolder = async (data) => {
    const id = String(Date.now());
    const siblings = folders.filter(f => !!f.book_folder === !!data.book_folder && (f.parent_id ?? null) === (data.parent_id ?? null));
    const sort_order = siblings.length;
    const folder = { id, sort_order, ...data };
    await api("POST", "/folders", folder);
    setFolders(p => [...p, folder]);
    setAddingFolder(false);
  };

  const saveFolder = async (data) => {
    if (editingFolder) {
      await api("PUT", `/folders/${editingFolder.id}`, { ...editingFolder, ...data });
      setFolders(p => p.map(f => f.id === editingFolder.id ? { ...f, ...data } : f));
    } else {
      await createFolder(data);
    }
    setEditingFolder(null); setAddingFolder(false);
  };

  const deleteFolder = async (id) => {
    await api("DELETE", `/folders/${id}`);
    setFolders(p => p.filter(f => f.id !== id));
    setSamples(p => p.map(s => s.folder_id === id ? { ...s, folder_id: null } : s));
    // Ungroup any books in a book folder being deleted
    setBooks(p => p.map(b => b.folder_id === id ? { ...b, folder_id: null } : b));
  };

  // ── Books ────────────────────────────────────────────────────────────────

  const saveBook = async (data) => {
    if (editingBook) {
      await api("PUT", `/analysis-books/${editingBook.id}`, { ...editingBook, ...data });
      setBooks(p => p.map(b => b.id === editingBook.id ? { ...b, ...data } : b));
    } else {
      const id = String(Date.now());
      await api("POST", "/analysis-books", { id, ...data });
      setBooks(p => [...p, { id, ...data }]);
    }
    setEditingBook(null); setAddingBook(false);
  };

  const deleteBook = async (id) => {
    await api("DELETE", `/analysis-books/${id}`);
    setBooks(p => p.filter(b => b.id !== id));
    setActiveBook(prev => prev === id ? null : prev);
  };

  const duplicateBook = async (book) => {
    const newId = String(Date.now());
    const copy = { ...book, id: newId, name: `${book.name} (copy)`, panels: JSON.parse(JSON.stringify(book.panels || [])) };
    await api("POST", "/analysis-books", copy);
    setBooks(p => [...p, copy]);
  };

  const openBook = async (id) => {
    const book = books.find(b => b.id === id);
    if (!book) return;
    setActiveBook(id);
    const sampleIds = book.config?.sample_order?.length ? book.config.sample_order : (book.sample_ids || []);
    await Promise.all(sampleIds.map(sid => loadSampleData(sid)));
  };

  const bookSaveTimers = useRef({});
  const updateBookInPlace = (bookId, updates) => {
    setBooks(p => {
      const next = p.map(b => b.id === bookId ? { ...b, ...updates } : b);
      booksRef.current = next;
      return next;
    });
    clearTimeout(bookSaveTimers.current[bookId]);
    bookSaveTimers.current[bookId] = setTimeout(() => {
      const book = booksRef.current.find(b => b.id === bookId);
      if (book) api("PUT", `/analysis-books/${bookId}`, book).catch(() => {});
    }, 800);
  };

  // ── Sample folder drag-and-drop ───────────────────────────────────────────

  const handleDropToBookFolder = async (folderId) => {
    if (!draggingBookId) return;
    const book = books.find(b => b.id === draggingBookId);
    if (!book) return;
    const newFolderId = folderId || null;
    if (book.folder_id === newFolderId) return;
    setDraggingBookId(null);
    const updated = { ...book, folder_id: newFolderId };
    setBooks(p => p.map(b => b.id === draggingBookId ? updated : b));
    await api("PUT", `/analysis-books/${draggingBookId}`, updated);
  };

  const handleDropToFolder = async (folderId) => {
    if (!draggingSampleId) return;
    const sample = samples.find(s => s.id === draggingSampleId);
    if (!sample) return;
    const newFolderId = folderId || null;
    if (sample.folder_id === newFolderId) return;
    setDraggingSampleId(null);
    await updateSample({ ...sample, folder_id: newFolderId });
  };

  const handleFolderReorder = async (draggedId, targetId, pos) => {
    if (!draggedId || draggedId === targetId) return;
    const dragged = folders.find(f => f.id === draggedId);
    const target  = folders.find(f => f.id === targetId);
    if (!dragged || !target) return;

    if (pos === "inside") {
      // Nest dragged folder inside target folder
      // Guard against dropping a folder into one of its own descendants
      const getDescIds = (id) => {
        const s = new Set([id]);
        folders.filter(f => f.parent_id === id).forEach(c => getDescIds(c.id).forEach(x => s.add(x)));
        return s;
      };
      if (getDescIds(draggedId).has(targetId)) return;
      const children = folders.filter(f => (f.parent_id ?? null) === targetId && f.id !== draggedId);
      const sort_order = children.length;
      const updates = [{ id: draggedId, sort_order, parent_id: targetId }];
      setFolders(prev => prev.map(f => f.id === draggedId ? { ...f, parent_id: targetId, sort_order } : f));
      setDraggingFolderId(null);
      await api("POST", "/folders/reorder", updates);
      return;
    }

    // Reorder among siblings at target's level (same parent, same type)
    const newParent = target.parent_id ?? null;
    const siblings = [...folders]
      .filter(f => !!f.book_folder === !!target.book_folder && (f.parent_id ?? null) === newParent && f.id !== draggedId)
      .sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0) || a.name.localeCompare(b.name));
    const targetIdx = siblings.findIndex(f => f.id === targetId);
    const insertIdx = pos === "above" ? targetIdx : targetIdx + 1;
    siblings.splice(insertIdx, 0, dragged);
    const updates = siblings.map((f, i) => ({ id: f.id, sort_order: i, parent_id: f.id === draggedId ? newParent : (f.parent_id ?? null) }));
    setFolders(prev => prev.map(f => {
      const u = updates.find(u => u.id === f.id);
      return u ? { ...f, sort_order: u.sort_order, parent_id: u.parent_id } : f;
    }));
    setDraggingFolderId(null);
    await api("POST", "/folders/reorder", updates);
  };

  // reset edit mode whenever the active sample changes
  useEffect(() => { setEditingMeta(false); }, [active]);

  // ── Render ───────────────────────────────────────────────────────────────

  const activeSample  = samples.find(s => s.id === active);
  const activeBookObj = books.find(b => b.id === activeBook);
  const hasFilesForActive = activeSample ? Object.keys(activeSample.filenames || {}).length > 0 : false;

  const byId = (a, b) => a.id.localeCompare(b.id, undefined, { numeric: true, sensitivity: "base" });
  const sortedFolders = [...folders].sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0) || a.name.localeCompare(b.name));
  const getSiblings = (parentId, isBook) => sortedFolders.filter(f => !!f.book_folder === isBook && (f.parent_id ?? null) === parentId);
  const allSampleFolders = folders.filter(f => !f.book_folder);
  const ungrouped = samples.filter(s => !s.folder_id || !allSampleFolders.find(f => f.id === s.folder_id)).sort(byId);
  const [ungroupedDragOver,     setUngroupedDragOver]     = useState(false);
  const [bookUngroupedDragOver, setBookUngroupedDragOver] = useState(false);

  return (
    <>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Playfair+Display:wght@400;700&family=DM+Mono:wght@400;500&display=swap');
        * { box-sizing: border-box; }
        ::-webkit-scrollbar{width:6px} ::-webkit-scrollbar-track{background:${T.bg0}} ::-webkit-scrollbar-thumb{background:${T.border};border-radius:3px}
        input[type=date]::-webkit-calendar-picker-indicator{filter:invert(${darkMode ? "0.5" : "0.3"})}
        select option{background:${T.bg0}}
      `}</style>
      <div style={{ minHeight: "100vh", background: T.bg0, color: T.textPrimary }}>
        {/* Header */}
        <div style={{ borderBottom: `1px solid ${T.border}`, background: T.bg1, position: "sticky", top: 0, zIndex: 300 }}>
          <div style={{ maxWidth: 1600, margin: "0 auto", padding: "12px 20px", display: "flex", alignItems: "center", gap: 14 }}>
          {/* Conditional nav — flex:1 so the theme toggle always sits at the far right */}
          <div style={{ display: "flex", alignItems: "center", gap: 14, flex: 1, minWidth: 0 }}>
            {active && activeSample ? (
              <>
                <button onClick={() => setActive(null)} style={{ background: "none", border: "none", color: T.textDim, cursor: "pointer", fontSize: 20, lineHeight: 1, padding: 0 }}>←</button>
                <span style={{ fontFamily: "'Playfair Display', serif", fontSize: 22, color: T.amber }}>{activeSample.id}</span>
                <span style={{ fontFamily: "'DM Mono', monospace", fontSize: 11, color: T.textDim, background: T.bg2, border: `1px solid ${T.border}`, borderRadius: 4, padding: "2px 8px" }}>{activeSample.technique || "sputter"}</span>
                <div style={{ flex: 1 }} />
                {hasFilesForActive && <Btn variant="teal" small onClick={handleReparseFiles}>↻ Reparse</Btn>}
                {hasFilesForActive && <Btn variant="ghost" small onClick={handleViewData}>View Data</Btn>}
                <Btn variant="ghost" small onClick={handleExportSample}>Export Sample</Btn>
                <Btn variant="ghost" small onClick={() => setEditingMeta(v => !v)}>{editingMeta ? "Cancel" : "Edit"}</Btn>
                <Btn variant="danger" small onClick={() => { if (window.confirm(`Delete ${activeSample.id}?`)) deleteSample(activeSample.id); }}>Delete</Btn>
              </>
            ) : activeBook && activeBookObj ? (
              <>
                <button onClick={() => setActiveBook(null)} style={{ background: "none", border: "none", color: T.textDim, cursor: "pointer", fontSize: 20, lineHeight: 1, padding: 0 }}>←</button>
                <span style={{ fontFamily: "'Playfair Display', serif", fontSize: 22, color: T.blue }}>{activeBookObj.name}</span>
                <span style={{ fontFamily: "'DM Mono', monospace", fontSize: 11, color: T.textDim, background: T.bg2, border: `1px solid ${T.border}`, borderRadius: 4, padding: "2px 8px" }}>Analysis Book</span>
                <div style={{ flex: 1 }} />
                <Btn variant="ghost" small onClick={() => setEditingBook(activeBookObj)}>Edit</Btn>
                <Btn variant="danger" small onClick={() => { if (window.confirm(`Delete book "${activeBookObj.name}"?`)) { deleteBook(activeBookObj.id); } }}>Delete</Btn>
              </>
            ) : (
              <>
                <span style={{ fontFamily: "'Playfair Display', serif", fontSize: 18, color: T.amber, letterSpacing: 1 }}>LabLog</span>
                <span style={{ fontFamily: "'DM Mono', monospace", fontSize: 11, color: T.textDim }}>ferroelectric oxide films</span>
                <div style={{ flex: 1 }} />
                <Btn variant="ghost" small onClick={() => setExportOpen(true)}>Export</Btn>
                <Btn variant="ghost" small onClick={() => setAddingFolder(true)}>+ Folder</Btn>
                <button onClick={() => setSettingsOpen(true)}
                  title="Settings"
                  style={{ background: "none", border: "none", color: T.textDim, cursor: "pointer", fontSize: 18, lineHeight: 1, padding: "2px 4px", borderRadius: 4, display: "flex", alignItems: "center" }}>⚙</button>
              </>
            )}
          </div>
          {/* Theme toggle — always visible */}
          <button
            onClick={() => setDarkMode(v => !v)}
            title={darkMode ? "Switch to light mode" : "Switch to dark mode"}
            style={{ background: "none", border: `1px solid ${T.border}`, color: T.textDim, cursor: "pointer", fontSize: 15, lineHeight: 1, padding: "4px 8px", borderRadius: 6, flexShrink: 0 }}>
            {darkMode ? "☀" : "🌙"}
          </button>
          </div>{/* end max-width inner */}
        </div>

        <div style={{ maxWidth: 1600, margin: "0 auto", padding: "28px 20px" }}>
          {loading ? (
            <div style={{ fontFamily: "'DM Mono', monospace", fontSize: 13, color: T.textDim, padding: "40px 0", textAlign: "center" }}>Loading…</div>
          ) : error ? (
            <div style={{ fontFamily: "'DM Mono', monospace", fontSize: 13, color: T.red, padding: "40px 0", textAlign: "center" }}>
              Could not connect to backend: {error}<br />
              <span style={{ color: T.textDim, fontSize: 11 }}>Make sure uvicorn is running on port 8000.</span>
            </div>
          ) : active && activeSample ? (
            <SampleDetail
              sample={activeSample}
              plotData={plotCache[activeSample.id]}
              onUpdate={updateSample}
              onUploadFile={handleUploadFile}
              onReparseFiles={handleReparseFiles}
              onBack={() => setActive(null)}
              onDelete={deleteSample}
              editingMeta={editingMeta}
              setEditingMeta={setEditingMeta}
              settings={settings}
              onSaveSettings={handleSaveSettings} />
          ) : activeBook && activeBookObj ? (
            <AnalysisBookDetail
              book={activeBookObj}
              samples={samples}
              plotCache={plotCache}
              settings={settings}
              onUpdateBook={(updates) => updateBookInPlace(activeBook, updates)} />
          ) : (
            <>
              {/* Samples section */}
              <div style={{ marginBottom: 32 }}>
                <div style={{ marginBottom: 18, display: "flex", alignItems: "baseline", gap: 12 }}>
                  <h1 style={{ margin: 0, fontFamily: "'Playfair Display', serif", fontSize: 26, color: T.textPrimary }}>Samples</h1>
                  <span style={{ fontFamily: "'DM Mono', monospace", fontSize: 13, color: T.textDim }}>{samples.length} total</span>
                  <div style={{ flex: 1 }} />
                  <Btn variant="primary" small onClick={() => setAdding(true)}>+ New Sample</Btn>
                </div>

                {/* Foldered groups — recursive tree */}
                {(() => {
                  const renderSampleFolders = (parentId, depth = 0) =>
                    getSiblings(parentId, false).map(folder => (
                      <FolderTile key={folder.id} folder={folder} depth={depth}
                        samples={samples.filter(s => s.folder_id === folder.id).sort(byId)}
                        childContent={renderSampleFolders(folder.id, depth + 1)}
                        plotCache={plotCache}
                        onSelectSample={openSample} onDeleteSample={deleteSample}
                        onDuplicateTemplate={setTemplateSample}
                        onEdit={() => setEditingFolder(folder)}
                        onDelete={() => deleteFolder(folder.id)}
                        onDropSample={() => handleDropToFolder(folder.id)}
                        onDragStartSample={setDraggingSampleId}
                        onDragStartFolder={setDraggingFolderId}
                        onDropFolder={handleFolderReorder} />
                    ));
                  return renderSampleFolders(null);
                })()}

                {/* Ungrouped */}
                {(ungrouped.length > 0 || (draggingSampleId && folders.length > 0)) && (
                  <div
                    onDragOver={e => { e.preventDefault(); e.dataTransfer.dropEffect = "move"; setUngroupedDragOver(true); }}
                    onDragLeave={e => { if (!e.currentTarget.contains(e.relatedTarget)) setUngroupedDragOver(false); }}
                    onDrop={e => { e.preventDefault(); setUngroupedDragOver(false); handleDropToFolder(null); }}
                    style={{ border: `2px solid ${ungroupedDragOver ? T.amber : "transparent"}`, borderRadius: 10, padding: ungroupedDragOver ? 10 : 0, transition: "all .12s", boxShadow: ungroupedDragOver ? `0 0 0 3px ${T.amberGlow}` : "none" }}>
                    {folders.length > 0 && (
                      <div style={{ fontFamily: "'DM Mono', monospace", fontSize: 11, color: ungroupedDragOver ? T.amber : T.textDim, textTransform: "uppercase", letterSpacing: 1, marginBottom: 8, transition: "color .12s" }}>
                        {ungroupedDragOver ? "Drop to ungroup" : "Ungrouped"}
                      </div>
                    )}
                    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill,minmax(310px,1fr))", gap: 12 }}>
                      {ungrouped.map(s => <SampleCard key={s.id} sample={s} plotData={plotCache[s.id]} onClick={() => openSample(s.id)} onDelete={deleteSample} onDuplicateTemplate={setTemplateSample} onDragStart={setDraggingSampleId} />)}
                    </div>
                  </div>
                )}

                {samples.length === 0 && !loading && (
                  <div style={{ fontFamily: "'DM Mono', monospace", fontSize: 13, color: T.textDim, padding: "32px 0" }}>No samples yet — create one above.</div>
                )}
              </div>

              {/* Analysis Books section */}
              <div>
                <div style={{ marginBottom: 14, display: "flex", alignItems: "baseline", gap: 12 }}>
                  <h2 style={{ margin: 0, fontFamily: "'Playfair Display', serif", fontSize: 22, color: T.textPrimary }}>Analysis Books</h2>
                  <span style={{ fontFamily: "'DM Mono', monospace", fontSize: 13, color: T.textDim }}>{books.length}</span>
                  <div style={{ flex: 1 }} />
                  <Btn variant="primary" small onClick={() => setAddingBook(true)}>+ New Book</Btn>
                </div>
                {(() => {
                  const allBookFolders = folders.filter(f => f.book_folder);
                  const ungroupedBooks = books.filter(b => !b.folder_id || !allBookFolders.find(f => f.id === b.folder_id));
                  const renderBookFolders = (parentId, depth = 0) =>
                    getSiblings(parentId, true).map(f => (
                      <BookFolderTile key={f.id} folder={f} depth={depth}
                        books={books.filter(b => b.folder_id === f.id)}
                        childContent={renderBookFolders(f.id, depth + 1)}
                        onOpenBook={openBook}
                        onDeleteBook={deleteBook}
                        onEditBook={b => setEditingBook(b)}
                        onDuplicateBook={duplicateBook}
                        onDrop={() => handleDropToBookFolder(f.id)}
                        onDragStartBook={setDraggingBookId}
                        onEdit={() => setEditingFolder(f)}
                        onDelete={() => deleteFolder(f.id)}
                        onDragStartFolder={setDraggingFolderId}
                        onDropFolder={handleFolderReorder} />
                    ));
                  return (
                    <>
                      {renderBookFolders(null)}
                      {(ungroupedBooks.length > 0 || (draggingBookId && allBookFolders.length > 0)) && (
                        <div
                          onDragOver={e => { e.preventDefault(); e.dataTransfer.dropEffect = "move"; setBookUngroupedDragOver(true); }}
                          onDragLeave={e => { if (!e.currentTarget.contains(e.relatedTarget)) setBookUngroupedDragOver(false); }}
                          onDrop={e => { e.preventDefault(); setBookUngroupedDragOver(false); handleDropToBookFolder(null); }}
                          style={{ border: `2px solid ${bookUngroupedDragOver ? T.amber : "transparent"}`, borderRadius: 10, padding: bookUngroupedDragOver ? 10 : 0, transition: "all .12s", boxShadow: bookUngroupedDragOver ? `0 0 0 3px ${T.amberGlow}` : "none", marginTop: allBookFolders.length ? 8 : 0 }}>
                          {allBookFolders.length > 0 && (
                            <div style={{ fontFamily: "'DM Mono', monospace", fontSize: 11, color: bookUngroupedDragOver ? T.amber : T.textDim, textTransform: "uppercase", letterSpacing: 1, marginBottom: 8, transition: "color .12s" }}>
                              {bookUngroupedDragOver ? "Drop to ungroup" : "Ungrouped"}
                            </div>
                          )}
                          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill,minmax(310px,1fr))", gap: 12 }}>
                            {ungroupedBooks.map(b => (
                              <AnalysisBookTile key={b.id} book={b}
                                onClick={() => openBook(b.id)}
                                onDelete={() => { if (window.confirm(`Delete book "${b.name}"?`)) deleteBook(b.id); }}
                                onEdit={() => setEditingBook(b)}
                                onDuplicate={() => duplicateBook(b)}
                                onDragStart={allBookFolders.length > 0 ? setDraggingBookId : undefined} />
                            ))}
                          </div>
                        </div>
                      )}
                      {books.length === 0 && <div style={{ fontFamily: "'DM Mono', monospace", fontSize: 12, color: T.textDim }}>No books yet.</div>}
                    </>
                  );
                })()}
              </div>
            </>
          )}
        </div>
      </div>

      {adding && <AddSampleModal onAdd={addSample} onClose={() => setAdding(false)} folders={folders} settings={settings} />}
      {templateSample && <AddSampleModal onAdd={s => { addSample(s); setTemplateSample(null); }} onClose={() => setTemplateSample(null)} folders={folders} template={templateSample} settings={settings} />}
      {exportOpen   && <ExportModal samples={samples} onClose={() => setExportOpen(false)} />}
      {viewDataOpen && <ViewDataModal sampleId={active} files={viewDataFiles} loading={viewDataLoading} onClose={() => setViewDataOpen(false)} />}
      {settingsOpen && <SettingsModal settings={settings} onSave={handleSaveSettings} onClose={() => setSettingsOpen(false)} />}
      {(addingFolder || editingFolder) && (
        <AddFolderModal onSave={saveFolder} onClose={() => { setAddingFolder(false); setEditingFolder(null); }} existing={editingFolder} allFolders={folders} />
      )}
      {(addingBook || editingBook) && (
        <AddBookModal onSave={saveBook} onClose={() => { setAddingBook(false); setEditingBook(null); }} existing={editingBook} samples={samples} folders={folders} bookFolders={folders.filter(f => f.book_folder)} />
      )}
    </>
  );
}
