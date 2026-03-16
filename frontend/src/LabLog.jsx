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
  teal: "#4fd1c5", red: "#fc8181", green: "#68d391", blue: "#63b3ed",
  textPrimary: "#e2e8f0", textSecondary: "#a0aec0", textDim: "#718096",
};
const LIGHT_T = {
  bg0: "#f0f2f5", bg1: "#ffffff", bg2: "#f8f9fa", bg3: "#e4e8ef",
  border: "#d0d7de", borderBright: "#8c959f",
  amber: "#d97706", amberDim: "#b45309", amberGlow: "rgba(217,119,6,0.08)",
  teal: "#0d9488", red: "#dc2626", green: "#16a34a", blue: "#2563eb",
  textPrimary: "#1a202c", textSecondary: "#4a5568", textDim: "#6b7280",
};
let T = DARK_T;

// ── Measurement type definitions ──────────────────────────────────────────────

const MEAS_TYPES = {
  xrd_ot: { label: "XRD ω–2θ",                    xLabel: "2θ (°)",         yLabel: "Intensity (cts)", logY: true,  color: T.amber },
  xrr:    { label: "XRR",                          xLabel: "2θ (°)",         yLabel: "Intensity (cts)", logY: true,  color: T.teal  },
  rsm:    { label: "RSM",                          xLabel: "Qₓ (Å⁻¹)",      yLabel: "Qz (Å⁻¹)",       isRSM: true, color: T.blue  },
  pe:     { label: "P–E Hysteresis",               xLabel: "E (kV/cm)",      yLabel: "P (µC/cm²)",      logY: false, color: T.red, ySymRange: 30, symXTicks: true, zeroRefY: true },
  diel_f: { label: "Rel. Permittivity vs f",       xLabel: "log f (Hz)",     yLabel: "εᵣ",              logX: true,  color: T.green, clampYZero: true },
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
    xTickFmt = v => String(Math.round(Math.log10(v))); // show decade exponent: 3, 4, 5 …
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

function RSMPlot({ data, cfg, forcedXDomain, forcedYDomain }) {
  const containerRef = useRef(null);
  const canvasRef    = useRef(null);
  const draw = useCallback(() => {
    const canvas = canvasRef.current, container = containerRef.current;
    if (!canvas || !container || !data.length) return;
    const W = container.clientWidth || 320, H = 220;
    canvas.width = W; canvas.height = H;
    const ctx = canvas.getContext("2d");
    const M = { top: 10, right: 14, bottom: 36, left: 52 };
    const pw = W - M.left - M.right, ph = H - M.top - M.bottom;
    let xMin = Infinity, xMax = -Infinity, yMin = Infinity, yMax = -Infinity, zMin = Infinity, zMax = -Infinity;
    for (const d of data) {
      if (d.x < xMin) xMin = d.x; if (d.x > xMax) xMax = d.x;
      if (d.y < yMin) yMin = d.y; if (d.y > yMax) yMax = d.y;
      if (d.z < zMin) zMin = d.z; if (d.z > zMax) zMax = d.z;
    }
    const xp = (xMax - xMin) * 0.05, yp = (yMax - yMin) * 0.05;
    const x0 = forcedXDomain ? forcedXDomain[0] : xMin - xp;
    const x1 = forcedXDomain ? forcedXDomain[1] : xMax + xp;
    const y0 = forcedYDomain ? forcedYDomain[0] : yMin - yp;
    const y1 = forcedYDomain ? forcedYDomain[1] : yMax + yp;
    const logZMin   = zMin > 0 ? Math.log10(zMin) : 0;
    const logZRange = zMax > zMin ? Math.log10(Math.max(zMax, zMin + 1e-12)) - logZMin : 1;
    const sx = x => M.left + (x - x0) / (x1 - x0) * pw;
    const sy = y => M.top  + (1 - (y - y0) / (y1 - y0)) * ph;
    ctx.fillStyle = T.bg2; ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = T.bg1; ctx.fillRect(M.left, M.top, pw, ph);
    for (const d of data) {
      const lz = d.z > 0 ? Math.log10(d.z) : logZMin;
      const t  = Math.max(0, Math.min(1, (lz - logZMin) / logZRange));
      ctx.fillStyle = `hsl(${240 - 240 * t},80%,55%)`;
      ctx.fillRect(Math.round(sx(d.x)), Math.round(sy(d.y)), 2, 2);
    }
    ctx.font = `10px "DM Mono", monospace`;
    const { ticks: xTkArr, fmt: xFmt } = niceCanvasTicks(x0, x1);
    ctx.textAlign = "center"; ctx.textBaseline = "top";
    for (const xv of xTkArr) {
      const px = Math.round(sx(xv));
      ctx.strokeStyle = T.border; ctx.lineWidth = 0.5;
      ctx.beginPath(); ctx.moveTo(px, M.top); ctx.lineTo(px, M.top + ph); ctx.stroke();
      ctx.fillStyle = T.textDim; ctx.fillText(xFmt(xv), px, M.top + ph + 4);
    }
    const { ticks: yTkArr, fmt: yFmt } = niceCanvasTicks(y0, y1);
    ctx.textAlign = "right"; ctx.textBaseline = "middle";
    for (const yv of yTkArr) {
      const py = Math.round(sy(yv));
      ctx.strokeStyle = T.border; ctx.lineWidth = 0.5;
      ctx.beginPath(); ctx.moveTo(M.left, py); ctx.lineTo(M.left + pw, py); ctx.stroke();
      ctx.fillStyle = T.textDim; ctx.fillText(yFmt(yv), M.left - 4, py);
    }
    // Inside tick marks on all 4 sides
    const TK = 4;
    ctx.strokeStyle = T.borderBright; ctx.lineWidth = 1;
    for (const xv of xTkArr) {
      const px = Math.round(sx(xv));
      ctx.beginPath(); ctx.moveTo(px, M.top);      ctx.lineTo(px, M.top + TK);      ctx.stroke();
      ctx.beginPath(); ctx.moveTo(px, M.top + ph); ctx.lineTo(px, M.top + ph - TK); ctx.stroke();
    }
    for (const yv of yTkArr) {
      const py = Math.round(sy(yv));
      ctx.beginPath(); ctx.moveTo(M.left,      py); ctx.lineTo(M.left + TK,      py); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(M.left + pw, py); ctx.lineTo(M.left + pw - TK, py); ctx.stroke();
    }
    ctx.strokeRect(M.left + 0.5, M.top + 0.5, pw, ph);
    ctx.fillStyle = T.textSecondary; ctx.font = `11px "DM Mono", monospace`;
    ctx.textAlign = "center"; ctx.textBaseline = "bottom";
    ctx.fillText(cfg.xLabel, M.left + pw / 2, H - 2);
    ctx.save(); ctx.translate(13, M.top + ph / 2); ctx.rotate(-Math.PI / 2);
    ctx.textAlign = "center"; ctx.textBaseline = "middle";
    ctx.fillText(cfg.yLabel, 0, 0); ctx.restore();
  }, [data, cfg, forcedXDomain, forcedYDomain]);
  useEffect(() => {
    draw();
    const container = containerRef.current;
    if (!container) return;
    const ro = new ResizeObserver(() => draw());
    ro.observe(container);
    return () => ro.disconnect();
  }, [draw]);
  return (
    <div ref={containerRef} style={{ width: "100%" }}>
      <canvas ref={canvasRef} style={{ display: "block", width: "100%", height: 220 }} />
    </div>
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

function MeasPlot({ data, type, thicknessNm = 0, areaM2, areaCorrFactor = 1.0 }) {
  const cfg = MEAS_TYPES[type];
  if (!hasPlotData(data)) return null;
  if (type === "rsm") return <RSMPlot data={data} cfg={cfg} />;
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

function MeasCard({ type, plotData, filename, filenames, onFile, thicknessNm = 0, areaM2, areaCorrFactor = 1.0, onAreaChange }) {
  const cfg = MEAS_TYPES[type];
  const [corrExpr,      setCorrExpr]      = useState(String(areaCorrFactor ?? 1.0));
  const [peLoop,        setPeLoop]        = useState("all"); // "all" | "second"

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
          {filename && <span style={{ fontSize: 10, color: T.textDim, fontFamily: "'DM Mono', monospace", maxWidth: 160, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{filename}</span>}
        </div>
      </div>
      <div style={{ padding: "10px 12px" }}>
        {has ? (
          <>
            <MeasPlot data={displayPEData} type={type} thicknessNm={thicknessNm} areaM2={areaM2} areaCorrFactor={areaCorrFactor} />
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
        </div>
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
      <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
        <Btn variant="ghost" small onClick={cancelEdit}>Cancel</Btn>
        <Btn small onClick={saveEdit}>Save Layer</Btn>
      </div>
    </div>
  );
}

// ── SampleDetail ──────────────────────────────────────────────────────────────

function SampleDetail({ sample, plotData, onUpdate, onUploadFile, onReparseFiles, onBack, onDelete, editingMeta, setEditingMeta, settings }) {
  const [addingLayer, setAddingLayer]   = useState(false);
  const [meta, setMeta]                 = useState({ date: sample.date, substrate: sample.substrate, notes: sample.notes, thickness_nm: sample.thickness_nm ?? "" });
  const [dragIdx, setDragIdx]           = useState(null);
  const [overIdx, setOverIdx]           = useState(null);
  const [knownMaterials, setKnownMaterials] = useState([]);

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
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(300px,1fr))", gap: 12 }}>
          {["xrd_ot", "xrr", "rsm"].map(t => (
            <MeasCard key={t} type={t} plotData={pd[t]} filename={sample.filenames?.[t]}
              onFile={(measType, file) => handleFile(measType, file)} />
          ))}
        </div>
      </section>

      <section>
        <div style={{ fontFamily: "'DM Mono', monospace", fontSize: 12, color: T.textSecondary, textTransform: "uppercase", letterSpacing: 2, marginBottom: 10 }}>Electrical Characterization</div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(300px,1fr))", gap: 12 }}>
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
        </div>
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
    technique: template.technique ?? "sputter",
    folder_id: template.folder_id ?? "",
  } : {
    id: "", date: new Date().toISOString().slice(0, 10),
    substrate: settings?.defaultSubstrate ?? "STO (001)", notes: "", thickness_nm: "",
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
            onAdd({ ...f, thickness_nm: f.thickness_nm === "" ? null : +f.thickness_nm, folder_id: f.folder_id || null, layers, filenames: {}, area_m2: null, area_correction: 1.0 });
          }} disabled={!f.id.trim()}>Create</Btn>
        </div>
      </div>
    </div>
  );
}

// ── SettingsModal ─────────────────────────────────────────────────────────────

function SettingsModal({ settings, onSave, onClose }) {
  const [draft, setDraft] = useState(() => JSON.parse(JSON.stringify(settings)));
  const [knownMaterials, setKnownMaterials] = useState([]);
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
    <div style={{ fontFamily: "'DM Mono', monospace", fontSize: 10, color: T.textDim, textTransform: "uppercase", letterSpacing: 2, borderBottom: `1px solid ${T.border}`, paddingBottom: 6, marginBottom: 10, marginTop: 4 }}>{label}</div>
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
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.75)", display: "flex", alignItems: "flex-start", justifyContent: "center", zIndex: 100, overflowY: "auto", padding: "40px 20px" }}>
      <style>{`.no-spin::-webkit-inner-spin-button,.no-spin::-webkit-outer-spin-button{-webkit-appearance:none;margin:0}.no-spin{-moz-appearance:textfield}`}</style>
      <div style={{ background: T.bg1, border: `1px solid ${T.borderBright}`, borderRadius: 12, padding: 28, width: 640, display: "flex", flexDirection: "column", gap: 18, marginBottom: 40 }}>
        <h2 style={{ margin: 0, fontFamily: "'Playfair Display', serif", color: T.amber, fontSize: 22 }}>Settings</h2>

        {/* General */}
        {sectionHdr("General")}
        <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
          <div style={{ flex: 1, minWidth: 180 }}>
            <div style={{ fontSize: 9, color: T.textDim, fontFamily: "'DM Mono', monospace", textTransform: "uppercase", marginBottom: 4 }}>Default Substrate</div>
            <input value={draft.defaultSubstrate}
              onChange={e => set("defaultSubstrate", e.target.value)}
              placeholder="e.g. STO (001)"
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

        {/* Material library — Sputter */}
        {sectionHdr("Material Library — Sputter")}
        <div style={{ fontSize: 11, color: T.textDim, fontFamily: "'DM Mono', monospace", marginTop: -10, marginBottom: 2 }}>Leave fields blank to use global sputter defaults for that material.</div>
        {renderMatLib("sputter")}

        {/* Material library — PLD */}
        {sectionHdr("Material Library — PLD")}
        <div style={{ fontSize: 11, color: T.textDim, fontFamily: "'DM Mono', monospace", marginTop: -10, marginBottom: 2 }}>Leave fields blank to use global PLD defaults for that material.</div>
        {renderMatLib("pld")}

        {/* Structure library */}
        {sectionHdr("Structure Library")}
        <div style={{ fontSize: 11, color: T.textDim, fontFamily: "'DM Mono', monospace", marginTop: -10, marginBottom: 2 }}>Lattice parameters for peak prediction and strain calculations. Drop a .cif onto an entry to auto-fill.</div>
        {renderStructLib()}

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
      onDragStart={e => { wasDragged.current = true; e.dataTransfer.effectAllowed = "move"; onDragStart?.(sample.id); }}
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
        <div style={{ display: "flex", gap: 5, flexWrap: "wrap" }}>
          {materials.map(m => { const s = getMaterialStyle(m); return (
            <span key={m} style={{ fontFamily: "'DM Mono', monospace", fontSize: 11, color: s.border, background: s.bg, border: `1px solid ${s.border}`, borderRadius: 4, padding: "2px 7px" }}><ChemName name={m} /></span>
          );})}
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

function FolderTile({ folder, samples, plotCache, onSelectSample, onDeleteSample, onDuplicateTemplate, onEdit, onDelete, onDropSample, onDragStartSample }) {
  const [open, setOpen]       = useState(true);
  const [dragOver, setDragOver] = useState(false);
  const color = folder.color || T.borderBright;

  const handleDragOver = e => { e.preventDefault(); e.dataTransfer.dropEffect = "move"; setDragOver(true); };
  const handleDragLeave = e => { if (!e.currentTarget.contains(e.relatedTarget)) setDragOver(false); };
  const handleDrop = e => { e.preventDefault(); setDragOver(false); onDropSample?.(); };

  return (
    <div
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
      style={{ border: `2px solid ${dragOver ? T.amber : color}`, borderRadius: 10, overflow: "hidden", marginBottom: 16, boxShadow: dragOver ? `0 0 0 3px ${T.amberGlow}` : "none", transition: "border-color .12s, box-shadow .12s" }}>
      <div style={{ padding: "10px 16px", display: "flex", alignItems: "center", gap: 10, background: dragOver ? T.bg3 : T.bg2, cursor: "pointer", userSelect: "none", transition: "background .12s" }}
        onClick={() => setOpen(v => !v)}>
        <div style={{ width: 12, height: 12, borderRadius: "50%", background: color, flexShrink: 0 }} />
        <span style={{ fontFamily: "'Playfair Display', serif", fontSize: 16, color: T.textPrimary, flex: 1 }}>{folder.name}</span>
        <span style={{ fontFamily: "'DM Mono', monospace", fontSize: 11, color: T.textDim }}>{samples.length}</span>
        <span style={{ color: T.textDim, fontSize: 11 }}>{open ? "▾" : "▸"}</span>
        <button onClick={e => { e.stopPropagation(); onEdit(); }} style={{ background: "none", border: "none", color: T.textDim, cursor: "pointer", fontSize: 13, padding: "0 3px" }}>✎</button>
        <button onClick={e => { e.stopPropagation(); if (window.confirm(`Delete folder "${folder.name}"? Samples will become ungrouped.`)) onDelete(); }} style={{ background: "none", border: "none", color: T.red, cursor: "pointer", fontSize: 16, padding: "0 3px" }}>×</button>
      </div>
      {open && (
        <div style={{ padding: 12, display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(270px,1fr))", gap: 12, background: T.bg0 }}>
          {samples.map(s => <SampleCard key={s.id} sample={s} plotData={plotCache[s.id]} onClick={() => onSelectSample(s.id)} onDelete={onDeleteSample} onDuplicateTemplate={onDuplicateTemplate} onDragStart={onDragStartSample} />)}
          {!samples.length && (
            <div style={{ fontFamily: "'DM Mono', monospace", fontSize: 12, color: dragOver ? T.amber : T.textDim, padding: "8px 4px", transition: "color .12s" }}>
              {dragOver ? "Drop to add to this folder" : "Empty folder"}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function AddFolderModal({ onSave, onClose, existing }) {
  const [name, setName]   = useState(existing?.name || "");
  const [color, setColor] = useState(existing?.color || COLOR_OPTIONS[0]);
  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.75)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 100 }}>
      <div style={{ background: T.bg1, border: `1px solid ${T.borderBright}`, borderRadius: 12, padding: 28, width: 360, display: "flex", flexDirection: "column", gap: 16 }}>
        <h2 style={{ margin: 0, fontFamily: "'Playfair Display', serif", color: T.amber, fontSize: 20 }}>{existing ? "Edit Folder" : "New Folder"}</h2>
        <Input label="Name" value={name} onChange={setName} placeholder="e.g. BTO Series" />
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
          <Btn onClick={() => { if (name.trim()) onSave({ name: name.trim(), color }); }} disabled={!name.trim()}>
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

function defaultPanelConfig(type) {
  if (type === "xrd") return { offset_decades: 2, theta_min: null, theta_max: null, pad_above: 2, pad_below: 1 };
  return {};
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

function SampleRoster({ sampleOrder, samples, colors, colorScale, colorTrim, labels = {}, onReorder, onRemove, onAddSamples, onChangeScale, onChangeTrim, onLabelChange }) {
  const [dragIdx,     setDragIdx]     = useState(null);
  const [dragOverIdx, setDragOverIdx] = useState(null);
  const [showPicker,  setShowPicker]  = useState(false);
  const [localTrim,   setLocalTrim]   = useState(colorTrim ?? 5);
  useEffect(() => { setLocalTrim(colorTrim ?? 5); }, [colorTrim]);
  const commitTrim = () => onChangeTrim(Math.max(0, Math.min(49, Number(localTrim) || 0)));
  const sampleMap = Object.fromEntries(samples.map(s => [s.id, s]));
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
        <select value={colorScale} onChange={e => onChangeScale(e.target.value)}
          style={{ background: T.bg0, border: `1px solid ${T.border}`, borderRadius: 4, color: T.textSecondary, padding: "4px 8px", fontFamily: "'DM Mono', monospace", fontSize: 11, outline: "none", cursor: "pointer" }}>
          {SCALE_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
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
    </div>
  );
}

// Color legend strip shown under each comparison chart
function BookColorLegend({ sampleOrder, colors, labels = {} }) {
  return (
    <div style={{ display: "flex", gap: 14, flexWrap: "wrap", marginTop: 6 }}>
      {sampleOrder.map((sid, i) => (
        <div key={sid} style={{ display: "flex", alignItems: "center", gap: 5 }}>
          <div style={{ width: 18, height: 2.5, background: colors[i], borderRadius: 2 }} />
          <span style={{ fontFamily: "'DM Mono', monospace", fontSize: 10, color: T.textDim }}>{labels[sid] || sid}</span>
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
    const exx = parseFloat(ln.strain_eps_xx), eyy = parseFloat(ln.strain_eps_yy ?? ln.strain_eps_xx);
    if (isNaN(exx)) return null;
    const ey = isNaN(eyy) ? exx : eyy;
    const eps_zz = -nu / (1 - nu) * (exx + ey);
    return { ...filmStruct, a: a_f * (1 + exx), b: b_f * (1 + ey), c: c_f * (1 + eps_zz) };
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

const LINE_COLORS = [
  "#f0f0f0", "#bbbbbb", "#888888", "#555555", "#1a1a1a",
  "#c8b89a", "#8aa8b4",
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
};

function buildPlotLayout(ps, xaxisExtra = {}, yaxisExtra = {}, extraShapes = []) {
  const gridDash = { dotted: "dot", dashed: "dash", solid: "solid" }[ps.grid] || "dash";
  const axisBase = {
    showgrid: false, zeroline: false, showline: false,
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
  return {
    autosize: true, uirevision: "plot",
    margin: { t: 12, r: 20, b: 52, l: 65, pad: 0 },
    paper_bgcolor: T.bg1, plot_bgcolor: T.bg1,
    font: { family: ps.font, size: ps.fontSize, color: T.textPrimary },
    hovermode: "x", hoverdistance: 40,
    hoverlabel: { bgcolor: "rgba(0,0,0,0)", bordercolor: "rgba(0,0,0,0)", font: { color: "rgba(0,0,0,0)" } },
    xaxis: {
      ...axisBase, ...spikeProps,
      showgrid: ps.grid !== "off", gridcolor: T.border, griddash: gridDash, color: T.textDim,
      tickfont: { size: ps.fontSize - 1, family: ps.font, color: T.textDim },
      ...xaxisExtra,
    },
    yaxis: {
      ...axisBase,
      showgrid: ps.grid !== "off", gridcolor: T.border, griddash: gridDash, color: T.textDim,
      tickfont: { size: ps.fontSize - 1, family: ps.font, color: T.textDim },
      ...yaxisExtra,
    },
    shapes: [...boxShapes, ...extraShapes],
  };
}

function buildPlotConfig(filename = "plot") {
  return {
    responsive: true, displayModeBar: true, displaylogo: false,
    modeBarButtonsToRemove: ["lasso2d", "select2d", "autoScale2d"],
    modeBarButtonsToAdd: [{
      name: "copyImage", title: "Copy to clipboard",
      icon: { width: 24, height: 24, path: "M16 1H4C2.9 1 2 1.9 2 3v14h2V3h12V1zm3 4H8C6.9 5 6 5.9 6 7v14c0 1.1.9 2 2 2h11c1.1 0 2-.9 2-2V7c0-1.1-.9-2-2-2zm0 16H8V7h11v14z" },
      click: async (gd) => {
        try {
          const dataUrl = await window.Plotly.toImage(gd, { format: "png", scale: 2, width: 900, height: 400 });
          const blob = await fetch(dataUrl).then(r => r.blob());
          await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
        } catch (err) { console.error("Copy to clipboard failed:", err); }
      },
    }],
    toImageButtonOptions: { format: "svg", filename, width: 900, height: 400 },
  };
}

function SciPlotWrap({ ps, cursorLabel, children }) {
  const [cursor, setCursor] = useState(null);
  const child = typeof children === "function" ? children(setCursor) : children;
  return (
    <div className="sci-plot-wrap">
      <div style={{ height: 30 }} />
      <div style={{ position: "relative" }} onMouseLeave={() => setCursor(null)}>
        <Suspense fallback={<div style={{ height: 320, display: "flex", alignItems: "center", justifyContent: "center", fontFamily: "'DM Mono', monospace", fontSize: 12, color: T.textDim }}>Loading chart…</div>}>
          {child}
        </Suspense>
        {cursor != null && (
          <div style={{ position: "absolute", top: 20, left: 74, fontFamily: ps.font, fontSize: ps.fontSize, color: T.textSecondary, pointerEvents: "none", userSelect: "none", letterSpacing: "0.02em" }}>
            {cursorLabel(cursor)}
          </div>
        )}
      </div>
    </div>
  );
}

// ── XRD ω–2θ comparison ───────────────────────────────────────────────────────

function XRDComparisonPanel({ sampleOrder, plotCache, colors, labels = {}, config, plotStyle, structures = [], onUpdate }) {
  const ps = plotStyle || { font: "'DM Mono', monospace", fontSize: 11, box: "solid", lineWidth: 1.5 };
  const [cursor, setCursor] = useState(null);
  const offsetDecades = config.offset_decades ?? 2;
  const thetaMin  = config.theta_min  != null ? Number(config.theta_min)  : null;
  const thetaMax  = config.theta_max  != null ? Number(config.theta_max)  : null;
  const padAbove  = config.pad_above  ?? 2;
  const padBelow  = config.pad_below  ?? 1;

  const { traces, yDomMin, yDomMax, xTicks, xDomain } = useMemo(() => {
    const traces = sampleOrder.map((sid, i) => {
      let pts = plotCache[sid]?.xrd_ot || [];
      if (thetaMin != null && !isNaN(thetaMin)) pts = pts.filter(p => p.x >= thetaMin);
      if (thetaMax != null && !isNaN(thetaMax)) pts = pts.filter(p => p.x <= thetaMax);
      const pos = pts.filter(p => p.y > 0);
      if (pos.length === 0) return null;
      const sorted = [...pos.map(p => p.y)].sort((a, b) => a - b);
      const floor  = sorted[Math.max(0, Math.floor(sorted.length * 0.05))];
      const scale  = Math.pow(10, i * offsetDecades);
      const data   = pos.map(p => ({ x: p.x, y: Math.max(p.y, floor) * scale }));
      return { sid, color: colors[i], data };
    }).filter(Boolean);
    const posY    = traces.flatMap(t => t.data.map(p => p.y));
    const yDomMin = posY.length ? Math.pow(10, Math.floor(Math.log10(Math.min(...posY))) - padBelow) : 1e-1;
    const yDomMax = posY.length ? Math.pow(10, Math.ceil(Math.log10(Math.max(...posY)))  + padAbove) : 1e8;
    const allX    = traces.flatMap(t => t.data.map(p => p.x));
    const { ticks: xTicks, domain: xDomain } = allX.length
      ? niceLinTicks(Math.min(...allX), Math.max(...allX))
      : { ticks: [], domain: ["auto", "auto"] };
    return { traces, yDomMin, yDomMax, xTicks, xDomain };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sampleOrder.join(","), plotCache, thetaMin, thetaMax, offsetDecades, padAbove, padBelow, colors.join(",")]);

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

  return (
    <div>
      <div style={{ display: "flex", gap: 12, marginBottom: 12, alignItems: "flex-end", flexWrap: "wrap" }}>
        <PanelInput label="Offset (decades)" value={config.offset_decades ?? 2} placeholder="2" step="0.5" width={90}
          onChange={e => onUpdate({ offset_decades: parseFloat(e.target.value) === 0 ? 0 : (parseFloat(e.target.value) || 2) })} />
        <PanelInput label="2θ min" value={config.theta_min ?? ""} placeholder="auto"
          onChange={e => onUpdate({ theta_min: e.target.value === "" ? null : Number(e.target.value) })} />
        <PanelInput label="2θ max" value={config.theta_max ?? ""} placeholder="auto"
          onChange={e => onUpdate({ theta_max: e.target.value === "" ? null : Number(e.target.value) })} />
        <PanelInput label="Pad above (dec.)" value={config.pad_above ?? 2} placeholder="2" step="0.5" width={80}
          onChange={e => onUpdate({ pad_above: parseFloat(e.target.value) === 0 ? 0 : (parseFloat(e.target.value) || 2) })} />
        <PanelInput label="Pad below (dec.)" value={config.pad_below ?? 1} placeholder="1" step="0.5" width={80}
          onChange={e => onUpdate({ pad_below: parseFloat(e.target.value) === 0 ? 0 : (parseFloat(e.target.value) || 1) })} />
      </div>
      {traces.length === 0 ? (
        <div style={{ fontFamily: "'DM Mono', monospace", fontSize: 12, color: T.textDim, padding: "20px 0" }}>No XRD ω–2θ data loaded for selected samples.</div>
      ) : (() => {
        const gridDash = { dotted: "dot", dashed: "dash", solid: "solid" }[ps.grid] || "dash";
        const shapes = [
          ...(ps.box !== "off" ? [{
            type: "rect", xref: "paper", yref: "paper",
            x0: 0, y0: 0, x1: 1, y1: 1, layer: "above",
            line: {
              color: ps.box === "solid" ? T.textPrimary : T.borderBright,
              width: ps.box === "solid" ? 1.5 : 1,
              dash:  ps.box === "dashed" ? "dash" : "solid",
            },
          }] : []),
          ...lines.map((ln, i) => {
            const tt = lineEffStructs[i] ? calcTwoTheta(lineEffStructs[i], ln.hkl) : null;
            if (tt == null) return null;
            return {
              type: "line", xref: "x", yref: "paper",
              x0: tt, x1: tt, y0: 0, y1: 1, layer: "above",
              line: {
                color: ln.color, width: ps.lineWidth,
                dash: ln.style === "dashed" ? "dash" : ln.style === "dotted" ? "dot" : "solid",
              },
            };
          }).filter(Boolean),
        ];
        const axisBase = {
          showgrid: false, zeroline: false, showline: false,
          ticks:   ps.ticks ? "inside" : "",
          ticklen: ps.ticks ? ps.tickLen : 0,
          mirror:  ps.ticks ? "ticks" : false,
        };
        const plotlyTraces = traces.map(t => ({
          x: t.data.map(p => p.x),
          y: t.data.map(p => p.y),
          type: "scatter", mode: "lines",
          line: { color: t.color, width: ps.lineWidth },
          showlegend: false,
          hovertemplate: "<extra></extra>",
        }));
        const layout = {
          autosize: true, uirevision: "xrd",
          margin: { t: 12, r: 20, b: 52, l: 65, pad: 0 },
          paper_bgcolor: T.bg1, plot_bgcolor: T.bg1,
          font: { family: ps.font, size: ps.fontSize, color: T.textPrimary },
          hovermode: "x", hoverdistance: 40,
          hoverlabel: { bgcolor: "rgba(0,0,0,0)", bordercolor: "rgba(0,0,0,0)", font: { color: "rgba(0,0,0,0)" } },
          dragmode: "zoom",
          xaxis: {
            ...axisBase,
            title: { text: "2θ (°)", font: { size: ps.fontSize, family: ps.font, color: T.textSecondary }, standoff: 10 },
            range: xDomain[0] === "auto" ? undefined : xDomain,
            tickvals: xTicks.length ? xTicks : undefined,
            tickformat: "~d",
            tickfont: { size: ps.fontSize - 1, family: ps.font, color: T.textDim },
            showgrid: ps.grid !== "off", gridcolor: T.border, griddash: gridDash, color: T.textDim,
            showspikes: true, spikemode: "across", spikecolor: T.textDim,
            spikethickness: 1, spikedash: "dot", spikesnap: "cursor",
          },
          yaxis: {
            ...axisBase,
            title: { text: "Intensity (arb.)", font: { size: ps.fontSize, family: ps.font, color: T.textSecondary }, standoff: 8 },
            type: "log", range: [Math.log10(yDomMin), Math.log10(yDomMax)],
            showticklabels: false, color: T.textDim,
          },
          shapes,
        };
        const plotConfig = {
          responsive: true, displayModeBar: true, displaylogo: false,
          modeBarButtonsToRemove: ["lasso2d", "select2d", "autoScale2d"],
          modeBarButtonsToAdd: [{
            name: "copyImage", title: "Copy to clipboard",
            icon: { width: 24, height: 24, path: "M16 1H4C2.9 1 2 1.9 2 3v14h2V3h12V1zm3 4H8C6.9 5 6 5.9 6 7v14c0 1.1.9 2 2 2h11c1.1 0 2-.9 2-2V7c0-1.1-.9-2-2-2zm0 16H8V7h11v14z" },
            click: async (gd) => {
              try {
                const dataUrl = await window.Plotly.toImage(gd, { format: "png", scale: 2, width: 900, height: 400 });
                const blob = await fetch(dataUrl).then(r => r.blob());
                await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
              } catch (err) { console.error("Copy to clipboard failed:", err); }
            },
          }],
          toImageButtonOptions: { format: "svg", filename: "xrd", width: 900, height: 400 },
        };
        return (
          <>
            <div className="xrd-plot-wrap">
              <div style={{ height: 30 }} />
              <div style={{ position: "relative" }} onMouseLeave={() => setCursor(null)}>
                <Suspense fallback={<div style={{ height: 320, display: "flex", alignItems: "center", justifyContent: "center", fontFamily: "'DM Mono', monospace", fontSize: 12, color: T.textDim }}>Loading chart…</div>}>
                  <Plot data={plotlyTraces} layout={layout} config={plotConfig}
                    style={{ width: "100%", height: "320px" }}
                    useResizeHandler
                    onHover={e => {
                      const x = e.xvals?.[0] ?? e.points?.[0]?.x;
                      if (x != null) setCursor({ x });
                    }} />
                </Suspense>
                {cursor && (
                  <div style={{
                    position: "absolute", top: 20, left: 74,
                    fontFamily: ps.font, fontSize: ps.fontSize,
                    color: T.textSecondary, pointerEvents: "none", userSelect: "none",
                    letterSpacing: "0.02em",
                  }}>
                    2θ = {cursor.x.toFixed(3)}°
                  </div>
                )}
              </div>
            </div>
            <BookColorLegend sampleOrder={sampleOrder} colors={colors} labels={labels} />
          </>
        );
      })()}

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
              {/* Bulk / Strained toggle */}
              <div style={{ display: "flex", borderRadius: 4, overflow: "hidden", border: `1px solid ${T.border}`, flexShrink: 0 }}>
                {["bulk", "strained"].map(m => (
                  <button key={m} onClick={() => updateLine(ln.id, { mode: m })}
                    style={{ ...rc, background: ln.mode === m ? T.bg3 : T.bg0, border: "none", borderRight: m === "bulk" ? `1px solid ${T.border}` : "none", color: ln.mode === m ? T.textPrimary : T.textDim, textTransform: "uppercase", letterSpacing: 0.5 }}>
                    {m}
                  </button>
                ))}
              </div>
              {/* Configure + substrate (strained only) */}
              {isStrained && (<>
                <div style={{ position: "relative", zIndex: 50 }}>
                  <button onClick={e => { e.stopPropagation(); setOpenPicker(cfgOpen ? null : { id: ln.id, type: "strainCfg" }); }}
                    style={{ ...rc, background: cfgOpen ? T.bg3 : T.bg0, border: `1px solid ${cfgOpen ? T.borderBright : T.border}`, color: T.textSecondary }}>
                    Configure
                  </button>
                  {cfgOpen && (
                    <div onClick={e => e.stopPropagation()}
                      style={{ position: "absolute", left: 0, top: "calc(100% + 4px)", background: T.bg2, border: `1px solid ${T.borderBright}`, borderRadius: 8, padding: "12px 14px", zIndex: 200, boxShadow: "0 4px 16px rgba(0,0,0,.55)", minWidth: 280, display: "flex", flexDirection: "column", gap: 12 }}>
                      {[
                        { id: "substrate",        label: "Strain based on substrate" },
                        { id: "arbitrary_strain",  label: "Arbitrary strain (biaxial)" },
                        { id: "arbitrary_lattice", label: "Arbitrary in-plane lattice parameter" },
                      ].map(opt => (
                        <div key={opt.id} style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                          <div onClick={() => updateLine(ln.id, { strain_mode: opt.id })}
                            style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer" }}>
                            <div style={{ width: 14, height: 14, borderRadius: "50%", border: `2px solid ${smode === opt.id ? T.teal : T.border}`, background: smode === opt.id ? T.teal : "transparent", flexShrink: 0, transition: "all .12s" }} />
                            <span style={{ fontFamily: "'DM Mono', monospace", fontSize: 11, color: smode === opt.id ? T.textPrimary : T.textDim }}>{opt.label}</span>
                          </div>
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
                {smode === "substrate" && (
                  <select value={ln.substrate} onChange={e => updateLine(ln.id, { substrate: e.target.value })}
                    style={{ ...rc, background: T.bg0, border: `1px solid ${T.border}`, color: T.textSecondary }}>
                    <option value="">— substrate —</option>
                    {structures.filter(s => s.name !== ln.material).map(s => <option key={s.name} value={s.name}>{s.name}</option>)}
                    {lines.map((other, j) => j !== i && (
                      <option key={`entry:${j}`} value={`entry:${j}`}>Entry {j + 1}</option>
                    ))}
                  </select>
                )}
              </>)}
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

function PEComparisonPanel({ sampleOrder, samples, plotCache, colors, labels = {}, plotStyle }) {
  const ps = plotStyle || DEFAULT_PLOT_STYLE;
  const [peLoop, setPeLoop] = useState("all");

  const traces = sampleOrder.map((sid, i) => {
    const sample = samples.find(s => s.id === sid);
    const corr   = sample?.area_correction ?? 1.0;
    const raw    = plotCache[sid]?.pe || [];
    const looped = peLoop === "second" ? splitPELoops(raw).second : raw;
    const data   = (corr && corr !== 1.0) ? looped.map(p => ({ ...p, y: p.y / corr })) : looped;
    return { sid, color: colors[i], data };
  }).filter(t => t.data.length > 0);

  if (!traces.length) return (
    <div style={{ fontFamily: "'DM Mono', monospace", fontSize: 12, color: T.textDim, padding: "20px 0" }}>No P–E data loaded for selected samples.</div>
  );

  const allX    = traces.flatMap(t => t.data.map(p => p.x));
  const allY    = traces.flatMap(t => t.data.map(p => p.y));
  const { ticks: xTicks, domain: xDomain } = niceLinTicks(Math.min(...allX), Math.max(...allX));
  const rawAbsY  = Math.max(...allY.map(Math.abs)) * 1.05;
  const absYMax0 = Math.max(rawAbsY, 30);
  const peStep   = absYMax0 >= 500 ? 200 : absYMax0 >= 250 ? 100 : absYMax0 >= 100 ? 50 : absYMax0 >= 40 ? 10 : 5;
  const absYMax  = Math.ceil(absYMax0 / peStep) * peStep;
  const peTicks  = Array.from({ length: 2 * (absYMax / peStep) + 1 }, (_, i) => -absYMax + i * peStep);

  const plotlyTraces = traces.map(t => ({
    x: t.data.map(p => p.x), y: t.data.map(p => p.y),
    type: "scatter", mode: "lines",
    line: { color: t.color, width: ps.lineWidth },
    showlegend: false, hovertemplate: "<extra></extra>",
  }));
  const layout = buildPlotLayout(ps,
    { tickvals: xTicks, tickformat: "d", range: xDomain,
      title: { text: "E (kV/cm)", font: { size: ps.fontSize, family: ps.font, color: T.textSecondary }, standoff: 10 } },
    { range: [-absYMax, absYMax], tickvals: peTicks, tickformat: "d",
      title: { text: "P (µC/cm²)", font: { size: ps.fontSize, family: ps.font, color: T.textSecondary }, standoff: 8 } },
    [{ type: "line", xref: "paper", yref: "y", x0: 0, x1: 1, y0: 0, y1: 0, layer: "below",
       line: { color: T.borderBright, width: 1 } }]
  );

  return (
    <>
      <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: 6 }}>
        <LoopToggle value={peLoop} onChange={setPeLoop} />
      </div>
      <SciPlotWrap ps={ps} cursorLabel={x => `E = ${x.toFixed(3)} kV/cm`}>
        {setCursor => (
          <Plot data={plotlyTraces} layout={layout} config={buildPlotConfig("pe-hysteresis")}
            style={{ width: "100%", height: "320px" }} useResizeHandler
            onHover={e => { const x = e.xvals?.[0] ?? e.points?.[0]?.x; if (x != null) setCursor(x); }} />
        )}
      </SciPlotWrap>
      <BookColorLegend sampleOrder={sampleOrder} colors={colors} labels={labels} />
    </>
  );
}

// ── RSM comparison ────────────────────────────────────────────────────────────

function RSMComparisonPanel({ sampleOrder, plotCache, colors, labels = {} }) {
  const rsmCfg = MEAS_TYPES.rsm;
  const entries = sampleOrder.map((sid, i) => ({
    sid, color: colors[i], data: plotCache[sid]?.rsm || [],
  })).filter(e => e.data.length > 0);

  if (!entries.length) return (
    <div style={{ fontFamily: "'DM Mono', monospace", fontSize: 12, color: T.textDim, padding: "20px 0" }}>No RSM data loaded for selected samples.</div>
  );

  let xMin = Infinity, xMax = -Infinity, yMin = Infinity, yMax = -Infinity;
  for (const e of entries) for (const p of e.data) {
    if (p.x < xMin) xMin = p.x; if (p.x > xMax) xMax = p.x;
    if (p.y < yMin) yMin = p.y; if (p.y > yMax) yMax = p.y;
  }
  const xp = (xMax - xMin) * 0.05, yp = (yMax - yMin) * 0.05;
  const forcedXDomain = [xMin - xp, xMax + xp];
  const forcedYDomain = [yMin - yp, yMax + yp];

  return (
    <div style={{ display: "flex", gap: 14, flexWrap: "wrap" }}>
      {entries.map(e => (
        <div key={e.sid} style={{ flex: "0 0 auto", width: 220 }}>
          <div style={{ fontFamily: "'DM Mono', monospace", fontSize: 11, color: e.color, marginBottom: 4, textAlign: "center" }}>{labels[e.sid] || e.sid}</div>
          <RSMPlot data={e.data} cfg={rsmCfg} forcedXDomain={forcedXDomain} forcedYDomain={forcedYDomain} />
        </div>
      ))}
    </div>
  );
}

// ── εr vs E comparison ────────────────────────────────────────────────────────

function DEComparisonPanel({ sampleOrder, samples, plotCache, colors, labels = {}, plotStyle }) {
  const ps = plotStyle || DEFAULT_PLOT_STYLE;
  const traces = sampleOrder.flatMap((sid, i) => {
    const sample = samples.find(s => s.id === sid);
    const thick  = (sample?.thickness_nm || 30) * 1e-9;
    const area   = (sample?.area_m2 || DEFAULT_AREA_M2) * (sample?.area_correction || 1.0);
    const convert = pts => {
      if (!pts?.length) return [];
      const maxY = pts.reduce((m, p) => Math.max(m, Math.abs(p.y)), 0);
      return (maxY > 0 && maxY < 1)
        ? pts.map(p => ({ x: p.x, y: p.y * thick / (area * EPS0) }))
        : pts.map(p => ({ x: p.x, y: p.y }));
    };
    const up   = convert(plotCache[sid]?.diel_b_up   || []);
    const down = convert(plotCache[sid]?.diel_b_down || []);
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
  const { ticks: xTicks, domain: xDomain } = niceLinTicks(Math.min(...allX), Math.max(...allX));
  const rawYMax = allY.length ? Math.max(...allY) * 1.05 : 1000;
  const erStep  = rawYMax >= 8000 ? 2000 : rawYMax >= 4000 ? 1000 : rawYMax >= 2000 ? 500 : rawYMax >= 800 ? 200 : rawYMax >= 300 ? 100 : 50;
  const erMax   = Math.ceil(rawYMax / erStep) * erStep;
  const erTicks = Array.from({ length: erMax / erStep + 1 }, (_, i) => i * erStep);

  const plotlyTraces = traces.map(t => ({
    x: t.data.map(p => p.x), y: t.data.map(p => p.y),
    type: "scatter", mode: "lines",
    line: { color: t.color, width: ps.lineWidth },
    showlegend: false, hovertemplate: "<extra></extra>",
  }));
  const layout = buildPlotLayout(ps,
    { tickvals: xTicks, tickformat: "d", range: xDomain,
      title: { text: "E (kV/cm)", font: { size: ps.fontSize, family: ps.font, color: T.textSecondary }, standoff: 10 } },
    { range: [0, erMax], tickvals: erTicks, tickformat: "d",
      title: { text: "εᵣ", font: { size: ps.fontSize, family: ps.font, color: T.textSecondary }, standoff: 8 } }
  );

  return (
    <>
      <SciPlotWrap ps={ps} cursorLabel={x => `E = ${x.toFixed(3)} kV/cm`}>
        {setCursor => (
          <Plot data={plotlyTraces} layout={layout} config={buildPlotConfig("er-vs-E")}
            style={{ width: "100%", height: "320px" }} useResizeHandler
            onHover={e => { const x = e.xvals?.[0] ?? e.points?.[0]?.x; if (x != null) setCursor(x); }} />
        )}
      </SciPlotWrap>
      <BookColorLegend sampleOrder={sampleOrder} colors={colors} labels={labels} />
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
  const xLo = Math.floor(Math.log10(Math.min(...allX)));
  const xHi = Math.ceil(Math.log10(Math.max(...allX)));
  const decadeVals = Array.from({ length: xHi - xLo + 1 }, (_, i) => Math.pow(10, xLo + i));
  const decadeText = decadeVals.map(v => String(Math.round(Math.log10(v))));
  const rawYMax = allY.length ? Math.max(...allY) * 1.05 : 1000;
  const erStep  = rawYMax >= 8000 ? 2000 : rawYMax >= 4000 ? 1000 : rawYMax >= 2000 ? 500 : rawYMax >= 800 ? 200 : rawYMax >= 300 ? 100 : 50;
  const erMax   = Math.ceil(rawYMax / erStep) * erStep;
  const erTicks = Array.from({ length: erMax / erStep + 1 }, (_, i) => i * erStep);

  const plotlyTraces = traces.map(t => ({
    x: t.data.map(p => p.x), y: t.data.map(p => p.y),
    type: "scatter", mode: "lines",
    line: { color: t.color, width: ps.lineWidth },
    showlegend: false, hovertemplate: "<extra></extra>",
  }));
  const layout = buildPlotLayout(ps,
    { type: "log", range: [xLo, xHi], tickvals: decadeVals, ticktext: decadeText,
      title: { text: "log f (Hz)", font: { size: ps.fontSize, family: ps.font, color: T.textSecondary }, standoff: 10 } },
    { range: [0, erMax], tickvals: erTicks, tickformat: "d",
      title: { text: "εᵣ", font: { size: ps.fontSize, family: ps.font, color: T.textSecondary }, standoff: 8 } }
  );

  return (
    <>
      <SciPlotWrap ps={ps} cursorLabel={x => `log f = ${Math.log10(x).toFixed(3)}`}>
        {setCursor => (
          <Plot data={plotlyTraces} layout={layout} config={buildPlotConfig("er-vs-f")}
            style={{ width: "100%", height: "320px" }} useResizeHandler
            onHover={e => { const x = e.xvals?.[0] ?? e.points?.[0]?.x; if (x != null) setCursor(x); }} />
        )}
      </SciPlotWrap>
      <BookColorLegend sampleOrder={sampleOrder} colors={colors} labels={labels} />
    </>
  );
}

// ── Panel wrapper + add panel row ─────────────────────────────────────────────

const PANEL_LABELS = { xrd: "XRD ω–2θ", pe: "P–E Hysteresis", rsm: "RSM", de: "εᵣ vs E", df: "εᵣ vs f" };

function AnalysisPanelBlock({ panel, sampleOrder, samples, plotCache, colors, labels = {}, structures = [], onRemove, onUpdate }) {
  const { type, config } = panel;
  const [cogOpen, setCogOpen] = useState(false);
  const ps = {
    font:      config.plot_font       || "'DM Mono', monospace",
    fontSize:  config.plot_font_size  || 11,
    box:       config.plot_box        || "solid",
    grid:      config.plot_grid       || "dashed",
    lineWidth: config.plot_line_width || 1.5,
    ticks:     config.plot_ticks      ?? false,
    tickLen:   config.plot_tick_len   || 4,
  };
  const btnStyle = { background: "none", border: "none", color: T.textDim, cursor: "pointer", fontSize: 16, lineHeight: 1, padding: 0, borderRadius: 4, width: 26, height: 26, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 };
  const BOX_OPTS = ["off", "dashed", "solid"];
  return (
    <div style={{ background: T.bg1, border: `1px solid ${T.border}`, borderRadius: 10, padding: "14px 18px" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12 }}>
        <span style={{ fontFamily: "'DM Mono', monospace", fontSize: 11, color: T.textDim, textTransform: "uppercase", letterSpacing: 1 }}>{PANEL_LABELS[type] || type}</span>
        <div style={{ flex: 1 }} />
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
            </div>
          )}
        </div>
        <button onClick={onRemove} title="Remove panel"
          style={btnStyle}>×</button>
      </div>
      {type === "xrd" && <XRDComparisonPanel sampleOrder={sampleOrder} plotCache={plotCache} colors={colors} labels={labels} structures={structures} config={config} plotStyle={ps} onUpdate={onUpdate} />}
      {type === "pe"  && <PEComparisonPanel  sampleOrder={sampleOrder} samples={samples} plotCache={plotCache} colors={colors} labels={labels} plotStyle={ps} />}
      {type === "rsm" && <RSMComparisonPanel sampleOrder={sampleOrder} plotCache={plotCache} colors={colors} labels={labels} />}
      {type === "de"  && <DEComparisonPanel  sampleOrder={sampleOrder} samples={samples} plotCache={plotCache} colors={colors} labels={labels} plotStyle={ps} />}
      {type === "df"  && <DfComparisonPanel  sampleOrder={sampleOrder} samples={samples} plotCache={plotCache} colors={colors} labels={labels} plotStyle={ps} />}
    </div>
  );
}

function AddPanelRow({ onAdd }) {
  const [open, setOpen] = useState(false);
  const PANEL_TYPES = [
    { type: "xrd", label: "XRD ω–2θ"      },
    { type: "pe",  label: "P–E Hysteresis" },
    { type: "rsm", label: "RSM"            },
    { type: "de",  label: "εᵣ vs E"        },
    { type: "df",  label: "εᵣ vs f"        },
  ];
  return (
    <div style={{ position: "relative" }}>
      <Btn variant="ghost" onClick={() => setOpen(v => !v)}>+ Add Panel</Btn>
      {open && (
        <div style={{ position: "absolute", top: "100%", left: 0, marginTop: 4, background: T.bg2, border: `1px solid ${T.borderBright}`, borderRadius: 8, padding: 6, zIndex: 200, display: "flex", flexDirection: "column", gap: 2, minWidth: 170, boxShadow: "0 4px 16px rgba(0,0,0,.55)" }}>
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
  const cfg         = book.config || {};
  const sampleOrder = cfg.sample_order?.length ? cfg.sample_order : (book.sample_ids || []);
  const colorScale  = cfg.color_scale || "viridis";
  const colorTrim   = cfg.color_trim  ?? 5;
  const panels      = cfg.panels      || [];
  const labels      = cfg.labels      || {};
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

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <SampleRoster
        sampleOrder={sampleOrder}
        samples={samples}
        colors={colors}
        colorScale={colorScale}
        colorTrim={colorTrim}
        labels={labels}
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
      {panels.map(panel => (
        <AnalysisPanelBlock
          key={panel.id}
          panel={panel}
          sampleOrder={sampleOrder}
          samples={samples}
          plotCache={plotCache}
          colors={colors}
          labels={labels}
          structures={settings?.structures || []}
          onRemove={() => updateCfg({ panels: panels.filter(p => p.id !== panel.id) })}
          onUpdate={patch => updateCfg({ panels: panels.map(p => p.id === panel.id ? { ...p, config: { ...p.config, ...patch } } : p) })}
        />
      ))}
      <AddPanelRow onAdd={type => updateCfg({ panels: [...panels, { id: String(Date.now()), type, config: defaultPanelConfig(type) }] })} />
    </div>
  );
}

// ── Analysis Books (tile + modal) ─────────────────────────────────────────────

function AnalysisBookTile({ book, samples, onDelete, onEdit, onClick }) {
  const orderedIds = book.config?.sample_order?.length ? book.config.sample_order : (book.sample_ids || []);
  const n = orderedIds.length;
  const scaleName  = book.config?.color_scale || "viridis";
  const colorTrim  = book.config?.color_trim  ?? 5;
  const colors = sampleColorScale(scaleName, n, colorTrim);
  const colorMap = Object.fromEntries(orderedIds.map((id, i) => [id, colors[i]]));
  return (
    <div
      onClick={onClick}
      style={{ background: T.bg1, border: `1px solid ${T.border}`, borderRadius: 10, padding: "14px 18px", display: "flex", flexDirection: "column", gap: 8, cursor: onClick ? "pointer" : "default" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
        <span style={{ fontFamily: "'Playfair Display', serif", fontSize: 18, color: T.blue }}>{book.name}</span>
        <div style={{ display: "flex", gap: 6 }}>
          <button onClick={e => { e.stopPropagation(); onEdit(); }}   style={{ background: "none", border: "none", color: T.textDim, cursor: "pointer", fontSize: 13 }}>✎</button>
          <button onClick={e => { e.stopPropagation(); onDelete(); }} style={{ background: "none", border: "none", color: T.red,     cursor: "pointer", fontSize: 16 }}>×</button>
        </div>
      </div>
      <div style={{ fontFamily: "'DM Mono', monospace", fontSize: 11, color: T.textDim }}>
        {n} sample{n !== 1 ? "s" : ""}
        {book.config?.color_scale && <span style={{ marginLeft: 8, opacity: 0.6 }}>{book.config.color_scale}</span>}
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

function AddBookModal({ onSave, onClose, existing, samples }) {
  const [name, setName]       = useState(existing?.name || "");
  const [selected, setSelected] = useState(new Set(existing?.sample_ids || []));
  const toggle = id => setSelected(p => { const s = new Set(p); s.has(id) ? s.delete(id) : s.add(id); return s; });
  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.75)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 100 }}>
      <div style={{ background: T.bg1, border: `1px solid ${T.borderBright}`, borderRadius: 12, padding: 28, width: 480, display: "flex", flexDirection: "column", gap: 16, maxHeight: "80vh" }}>
        <h2 style={{ margin: 0, fontFamily: "'Playfair Display', serif", color: T.blue, fontSize: 20 }}>{existing ? "Edit Book" : "New Analysis Book"}</h2>
        <Input label="Name" value={name} onChange={setName} placeholder="e.g. Thickness Study" />
        <div style={{ display: "flex", flexDirection: "column", gap: 6, overflow: "hidden" }}>
          <Label>Samples</Label>
          <div style={{ overflowY: "auto", maxHeight: 260, display: "flex", flexDirection: "column", gap: 4, border: `1px solid ${T.border}`, borderRadius: 6, padding: 8 }}>
            {[...samples].sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true, sensitivity: "base" })).map(s => (
              <label key={s.id} style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer", fontFamily: "'DM Mono', monospace", fontSize: 12, color: selected.has(s.id) ? T.blue : T.textSecondary, padding: "3px 4px", borderRadius: 4, background: selected.has(s.id) ? "rgba(99,179,237,.1)" : "transparent" }}>
                <input type="checkbox" checked={selected.has(s.id)} onChange={() => toggle(s.id)} style={{ accentColor: T.blue }} />
                <span style={{ fontWeight: 600 }}>{s.id}</span>
                {s.date && <span style={{ color: T.textDim, fontSize: 10 }}>{s.date}</span>}
                {s.notes && <span style={{ color: T.textDim, fontSize: 10, flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{s.notes}</span>}
              </label>
            ))}
          </div>
        </div>
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
          <Btn variant="ghost" onClick={onClose}>Cancel</Btn>
          <Btn onClick={() => { if (name.trim()) onSave({ name: name.trim(), sample_ids: [...selected] }); }} disabled={!name.trim()}>
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
  const [addingFolder, setAddingFolder] = useState(false);
  const [editingFolder, setEditingFolder] = useState(null); // folder object
  const [addingBook,    setAddingBook]    = useState(false);
  const [editingBook,   setEditingBook]   = useState(null);
  const [loading,  setLoading]  = useState(true);
  const [error,    setError]    = useState(null);
  const [settings, setSettings] = useState(() => JSON.parse(JSON.stringify(DEFAULT_SETTINGS)));
  const [settingsOpen, setSettingsOpen] = useState(false);

  const handleSaveSettings = (s) => {
    saveSettings(s);
    setSettings(s);
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
      // update plotCache
      setPlotCache(p => {
        const prev = p[active] || {};
        if (measType === "diel_b_up" || measType === "diel_b_down") {
          const dir = measType === "diel_b_up" ? "up" : "down";
          return { ...p, [active]: { ...prev, [`diel_b_${dir}`]: parsed } };
        }
        return { ...p, [active]: { ...prev, [measType]: parsed } };
      });
      // update sample filenames + area if PE
      const updatedSample = {
        ...sample,
        filenames: { ...sample.filenames, [measType]: filename },
        ...(measType === "pe" && peArea ? { area_m2: peArea } : {}),
      };
      await updateSample(updatedSample);
    } catch (e) { console.error("Upload failed", e); }
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
      const text = await fetchFile(sample.id, filename);
      if (!text) continue;
      const parsed = csvToPlotData(text, measType, thick);
      if (!parsed || !hasPlotData(parsed)) continue;
      if (measType === "pe" && !newArea) newArea = findAreaFromFile(text);
      if (measType === "diel_b_up" || measType === "diel_b_down") {
        newCache[measType] = parsed;
      } else {
        newCache[measType] = parsed;
      }
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
    await api("POST", "/folders", { id, ...data });
    setFolders(p => [...p, { id, ...data }]);
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

  const handleDropToFolder = async (folderId) => {
    if (!draggingSampleId) return;
    const sample = samples.find(s => s.id === draggingSampleId);
    if (!sample) return;
    const newFolderId = folderId || null;
    if (sample.folder_id === newFolderId) return;
    setDraggingSampleId(null);
    await updateSample({ ...sample, folder_id: newFolderId });
  };

  // reset edit mode whenever the active sample changes
  useEffect(() => { setEditingMeta(false); }, [active]);

  // ── Render ───────────────────────────────────────────────────────────────

  const activeSample  = samples.find(s => s.id === active);
  const activeBookObj = books.find(b => b.id === activeBook);
  const hasFilesForActive = activeSample ? Object.keys(activeSample.filenames || {}).length > 0 : false;

  const byId = (a, b) => a.id.localeCompare(b.id, undefined, { numeric: true, sensitivity: "base" });
  const grouped   = folders.map(f => ({ folder: f, samples: samples.filter(s => s.folder_id === f.id).sort(byId) }));
  const ungrouped = samples.filter(s => !s.folder_id || !folders.find(f => f.id === s.folder_id)).sort(byId);
  const [ungroupedDragOver, setUngroupedDragOver] = useState(false);

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
        <div style={{ borderBottom: `1px solid ${T.border}`, padding: "12px 28px", display: "flex", alignItems: "center", gap: 14, background: T.bg1, position: "sticky", top: 0, zIndex: 50 }}>
          {/* Conditional nav — flex:1 so the theme toggle always sits at the far right */}
          <div style={{ display: "flex", alignItems: "center", gap: 14, flex: 1, minWidth: 0 }}>
            {active && activeSample ? (
              <>
                <button onClick={() => setActive(null)} style={{ background: "none", border: "none", color: T.textDim, cursor: "pointer", fontSize: 20, lineHeight: 1, padding: 0 }}>←</button>
                <span style={{ fontFamily: "'Playfair Display', serif", fontSize: 22, color: T.amber }}>{activeSample.id}</span>
                <span style={{ fontFamily: "'DM Mono', monospace", fontSize: 11, color: T.textDim, background: T.bg2, border: `1px solid ${T.border}`, borderRadius: 4, padding: "2px 8px" }}>{activeSample.technique || "sputter"}</span>
                <div style={{ flex: 1 }} />
                {hasFilesForActive && <Btn variant="teal" small onClick={handleReparseFiles}>↻ Reparse</Btn>}
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
                <Btn variant="ghost" small onClick={() => setAddingFolder(true)}>+ Folder</Btn>
                <Btn onClick={() => setAdding(true)}>+ New Sample</Btn>
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
        </div>

        <div style={{ maxWidth: 1100, margin: "0 auto", padding: "28px 20px" }}>
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
              settings={settings} />
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
                </div>

                {/* Foldered groups */}
                {grouped.map(({ folder, samples: fs }) => (
                  <FolderTile key={folder.id} folder={folder} samples={fs} plotCache={plotCache}
                    onSelectSample={openSample} onDeleteSample={deleteSample}
                    onDuplicateTemplate={setTemplateSample}
                    onEdit={() => setEditingFolder(folder)}
                    onDelete={() => deleteFolder(folder.id)}
                    onDropSample={() => handleDropToFolder(folder.id)}
                    onDragStartSample={setDraggingSampleId} />
                ))}

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
                    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill,minmax(270px,1fr))", gap: 12 }}>
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
                  <Btn variant="ghost" small onClick={() => setAddingBook(true)}>+ New Book</Btn>
                </div>
                {books.length > 0 ? (
                  <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill,minmax(280px,1fr))", gap: 12 }}>
                    {books.map(b => (
                      <AnalysisBookTile key={b.id} book={b} samples={samples}
                        onClick={() => openBook(b.id)}
                        onDelete={() => { if (window.confirm(`Delete book "${b.name}"?`)) deleteBook(b.id); }}
                        onEdit={() => setEditingBook(b)} />
                    ))}
                  </div>
                ) : (
                  <div style={{ fontFamily: "'DM Mono', monospace", fontSize: 12, color: T.textDim }}>No books yet.</div>
                )}
              </div>
            </>
          )}
        </div>
      </div>

      {adding && <AddSampleModal onAdd={addSample} onClose={() => setAdding(false)} folders={folders} settings={settings} />}
      {templateSample && <AddSampleModal onAdd={s => { addSample(s); setTemplateSample(null); }} onClose={() => setTemplateSample(null)} folders={folders} template={templateSample} settings={settings} />}
      {settingsOpen && <SettingsModal settings={settings} onSave={handleSaveSettings} onClose={() => setSettingsOpen(false)} />}
      {(addingFolder || editingFolder) && (
        <AddFolderModal onSave={saveFolder} onClose={() => { setAddingFolder(false); setEditingFolder(null); }} existing={editingFolder} />
      )}
      {(addingBook || editingBook) && (
        <AddBookModal onSave={saveBook} onClose={() => { setAddingBook(false); setEditingBook(null); }} existing={editingBook} samples={samples} />
      )}
    </>
  );
}
