import { useState, useCallback, useRef, useEffect } from "react";
import { LineChart, ComposedChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ReferenceLine, ResponsiveContainer } from "recharts";

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

const T = {
  bg0: "#0d1117", bg1: "#161b22", bg2: "#1c2333", bg3: "#243044",
  border: "#2d3748", borderBright: "#4a5568",
  amber: "#f6ad55", amberDim: "#c47f2a", amberGlow: "rgba(246,173,85,0.15)",
  teal: "#4fd1c5", red: "#fc8181", green: "#68d391", blue: "#63b3ed",
  textPrimary: "#e2e8f0", textSecondary: "#a0aec0", textDim: "#718096",
};

// ── Measurement type definitions ──────────────────────────────────────────────

const MEAS_TYPES = {
  xrd_ot: { label: "XRD ω–2θ",                    xLabel: "2θ (°)",         yLabel: "Intensity (cts)", logY: true,  color: T.amber },
  xrr:    { label: "XRR",                          xLabel: "2θ (°)",         yLabel: "Intensity (cts)", logY: true,  color: T.teal  },
  rsm:    { label: "RSM",                          xLabel: "Qₓ (Å⁻¹)",      yLabel: "Qz (Å⁻¹)",       isRSM: true, color: T.blue  },
  pe:     { label: "P–E Hysteresis",               xLabel: "E (kV/cm)",      yLabel: "P (µC/cm²)",      logY: false, color: T.red, ySymRange: 30, symXTicks: true, zeroRefY: true },
  diel_f: { label: "Rel. Permittivity vs f",       xLabel: "Frequency (Hz)", yLabel: "εᵣ",              logX: true,  color: T.green, clampYZero: true },
  diel_b: { label: "Rel. Permittivity vs E",       xLabel: "E (kV/cm)",      yLabel: "εᵣ",              logY: false, color: T.green, clampYZero: true, twoSweep: true, symXTicks: true },
};

// ── Material colour palette (hash-based for any string) ───────────────────────

const MAT_PALETTE = [
  { bg: "#1a3a5c", border: "#3182ce" },
  { bg: "#1a3d2b", border: "#38a169" },
  { bg: "#3d2e0a", border: "#d69e2e" },
  { bg: "#3a1a3d", border: "#9f7aea" },
  { bg: "#3d1a1a", border: "#fc8181" },
  { bg: "#1a3a3a", border: "#4fd1c5" },
  { bg: "#1a2a3d", border: "#63b3ed" },
  { bg: "#2a3d1a", border: "#68d391" },
];

function getMaterialStyle(material) {
  if (!material) return { ...MAT_PALETTE[0], label: "?" };
  let h = 0;
  for (const c of material) h = (h * 31 + c.charCodeAt(0)) & 0xffffffff;
  return { ...MAT_PALETTE[Math.abs(h) % MAT_PALETTE.length], label: material };
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

const Sel = ({ label, value, onChange, options }) => (
  <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
    {label && <Label>{label}</Label>}
    <select value={value} onChange={e => onChange(e.target.value)}
      style={{ background: T.bg0, border: `1px solid ${T.border}`, borderRadius: 5, color: T.textPrimary, padding: "8px 10px", fontFamily: "'DM Mono', monospace", fontSize: 13, outline: "none", cursor: "pointer" }}>
      {options.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
    </select>
  </div>
);

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
                {m}
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

// Returns { ticks, domain } with zero always included, clean steps, ~5-7 ticks.
function niceLinTicks(lo, hi, target = 6) {
  const mn = Math.min(lo, 0, hi);
  const mx = Math.max(hi, 0, lo);
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
    const hi = Math.ceil(Math.log10(arrMax(xVals.filter(v => v > 0))));
    xDomain = [Math.pow(10, lo), Math.pow(10, hi)];
    xTicks  = Array.from({ length: hi - lo + 1 }, (_, i) => Math.pow(10, lo + i));
    xTickFmt = v => { const n = Math.round(Math.log10(v)); return n === 0 ? "1" : n === 1 ? "10" : `10^${n}`; };
  } else {
    if (cfg.symXTicks) {
      const { ticks } = niceLinTicks(arrMin(xVals), arrMax(xVals));
      xDomain = padDomain(xVals, 0.05);
      xTicks  = ticks;
    } else {
      xDomain = padDomain(xVals);
      xTicks  = undefined;
    }
    xTickFmt = v => numFmt(v);
  }
  let yDomain, yTicks;
  if (logY) {
    const lo = Math.floor(arrMin(yVals)), hi = Math.ceil(arrMax(yVals));
    yDomain = [lo, hi];
    yTicks  = Array.from({ length: hi - lo + 1 }, (_, i) => lo + i);
  } else if (cfg.ySymRange != null) {
    const absMax = yVals.reduce((m, v) => Math.max(m, Math.abs(v)), 0);
    const sym = Math.max(cfg.ySymRange, absMax * 1.1);
    yDomain = [-sym, sym];
    yTicks  = undefined;
  } else {
    const [domLo, domHi] = padDomain(yVals);
    yDomain = cfg.clampYZero ? [0, domHi] : [domLo, domHi];
    yTicks  = undefined;
  }
  const yTickFmt = logY
    ? v => { const n = Math.round(v); return n === 0 ? "1" : n === 1 ? "10" : `10^${n}`; }
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
            tickFormatter={xTickFmt} ticks={xTicks}
            label={{ value: xLabel, position: "insideBottom", offset: -14, fill: T.textSecondary, fontSize: 11 }}
            scale={logX ? "log" : "auto"} domain={xDomain} />
          <YAxis yAxisId="left" tick={{ fill: T.textDim, fontSize: 10, fontFamily: "'DM Mono', monospace" }}
            tickFormatter={yTickFmt} ticks={yTicks}
            label={{ value: yLabel, angle: -90, position: "insideLeft", offset: 14, fill: T.textSecondary, fontSize: 10 }}
            domain={yDomain} />
          {hasD && <YAxis yAxisId="right" orientation="right"
            tick={{ fill: T.amber, fontSize: 9, fontFamily: "'DM Mono', monospace" }}
            tickFormatter={v => numFmt(v)}
            label={{ value: "D (tan δ)", angle: 90, position: "insideRight", offset: -6, fill: T.amber, fontSize: 9 }}
            domain={dDomain} />}
          <Tooltip position={tooltipPos}
            contentStyle={{ background: T.bg2, border: `1px solid ${T.border}`, borderRadius: 6, fontFamily: "'DM Mono', monospace", fontSize: 11 }}
            formatter={(v, name) => name === "y2" ? [numFmt(+v), "D (tan δ)"] : [logY ? numFmt(Math.pow(10, +v)) : numFmt(+v), yLabel]}
            labelFormatter={v => `${xLabel}: ${numFmt(+v)}`} />
          {cfg.zeroRefY && <ReferenceLine yAxisId="left" y={0} stroke={T.borderBright} strokeWidth={1} />}
          <Line yAxisId="left" type="monotone" dataKey="yp" dot={false} stroke={color} strokeWidth={1.5} isAnimationActive={false} />
          {hasD && <Line yAxisId="right" type="monotone" dataKey="y2" dot={false} stroke={T.amber} strokeWidth={1.5} strokeDasharray="4 2" isAnimationActive={false} name="y2" />}
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

function RSMPlot({ data, cfg }) {
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
    const x0 = xMin - xp, x1 = xMax + xp, y0 = yMin - yp, y1 = yMax + yp;
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
    ctx.strokeStyle = T.borderBright; ctx.lineWidth = 1;
    ctx.strokeRect(M.left + 0.5, M.top + 0.5, pw, ph);
    ctx.fillStyle = T.textSecondary; ctx.font = `11px "DM Mono", monospace`;
    ctx.textAlign = "center"; ctx.textBaseline = "bottom";
    ctx.fillText(cfg.xLabel, M.left + pw / 2, H - 2);
    ctx.save(); ctx.translate(13, M.top + ph / 2); ctx.rotate(-Math.PI / 2);
    ctx.textAlign = "center"; ctx.textBaseline = "middle";
    ctx.fillText(cfg.yLabel, 0, 0); ctx.restore();
  }, [data, cfg]);
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
  let yDomain;
  if (cfg.ySymRange != null) {
    const absMax = yVals.reduce((m, v) => Math.max(m, Math.abs(v)), 0);
    const sym = Math.max(cfg.ySymRange, Math.ceil(absMax * 1.05));
    yDomain = [-sym, sym];
  } else {
    const [domLo, domHi] = padDomain(yVals);
    yDomain = clampYZero ? [0, domHi] : [domLo, domHi];
  }
  const hasD = allPts.some(d => d.y2 != null);
  const dVals = hasD ? allPts.filter(d => d.y2 != null).map(d => d.y2) : [];
  const [dDomLo, dDomHi] = hasD ? padDomain(dVals) : [0, 1];
  const dDomain = hasD ? [dDomLo, dDomHi] : [0, 1];
  return (
    <div ref={ref}>
      <ResponsiveContainer width="100%" height={200}>
        <ComposedChart onMouseMove={onMouseMove} margin={{ top: 6, right: hasD ? 44 : 12, bottom: 28, left: 10 }}>
          <CartesianGrid strokeDasharray="3 3" stroke={T.border} />
          <XAxis dataKey="x" type="number" domain={xDomain} ticks={xTicks}
            tick={{ fill: T.textDim, fontSize: 10, fontFamily: "'DM Mono', monospace" }} tickFormatter={v => numFmt(v)}
            label={{ value: xLabel, position: "insideBottom", offset: -14, fill: T.textSecondary, fontSize: 11 }} />
          <YAxis yAxisId="left" domain={yDomain}
            tick={{ fill: T.textDim, fontSize: 10, fontFamily: "'DM Mono', monospace" }} tickFormatter={v => numFmt(v)}
            label={{ value: yLabel, angle: -90, position: "insideLeft", offset: 14, fill: T.textSecondary, fontSize: 10 }} />
          {hasD && <YAxis yAxisId="right" orientation="right" domain={dDomain}
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
  const [corrExpr, setCorrExpr] = useState(String(areaCorrFactor ?? 1.0));

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
  return (
    <div style={{ background: T.bg2, border: `1px solid ${T.border}`, borderRadius: 8, overflow: "hidden" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "8px 12px", borderBottom: `1px solid ${T.border}` }}>
        <span style={{ fontFamily: "'DM Mono', monospace", fontSize: 12, color: cfg.color, fontWeight: 600 }}>{cfg.label}</span>
        {filename && <span style={{ fontSize: 10, color: T.textDim, fontFamily: "'DM Mono', monospace", maxWidth: 160, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{filename}</span>}
      </div>
      <div style={{ padding: "10px 12px" }}>
        {has ? (
          <>
            <MeasPlot data={plotData} type={type} thicknessNm={thicknessNm} areaM2={areaM2} areaCorrFactor={areaCorrFactor} />
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

const SPUTTER_DEFAULTS = { material: "", power_W: 150 };
const PLD_DEFAULTS     = { material: "", energy_mJ: 60, pulses: 10000 };

function newLayer(technique) {
  return {
    id: crypto.randomUUID ? crypto.randomUUID() : String(Date.now()),
    temp: 600,
    pressure: technique === "pld" ? 2 : 10,
    ...(technique === "pld" ? { frequency_hz: 10, focal_position: "" } : { oxygen_pct: 20, time_s: 2000 }),
    targets: [technique === "pld" ? { ...PLD_DEFAULTS } : { ...SPUTTER_DEFAULTS }],
  };
}

function TargetRow({ target, technique, onChange, onRemove, canRemove, knownMaterials }) {
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
  return (
    <div style={{ display: "flex", alignItems: "flex-end", gap: 8, flexWrap: "wrap" }}>
      <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
        <span style={{ fontSize: 9, color: T.textDim, fontFamily: "'DM Mono', monospace", textTransform: "uppercase" }}>Material</span>
        <div style={{ width: 120 }}>
          <MaterialCombobox value={target.material} onChange={v => onChange({ ...target, material: v })} knownMaterials={knownMaterials} small />
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

function LayerEditor({ layer, technique, onRemove, onDuplicate, onUpdate, onDragStart, onDragOver, onDrop, onDragEnd, isDragOver, knownMaterials, initialEditing = false }) {
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
  const updateTarget = (i, t)  => setDraft(p => { const ts = [...p.targets]; ts[i] = t; return { ...p, targets: ts }; });
  const removeTarget = (i)     => setDraft(p => { const ts = p.targets.filter((_, j) => j !== i); return { ...p, targets: ts }; });
  const addTarget = () => setDraft(p => ({ ...p, targets: [...p.targets, technique === "pld" ? { ...PLD_DEFAULTS } : { ...SPUTTER_DEFAULTS }] }));

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
                {t.material || "?"}
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
          <TargetRow key={i} target={t} technique={technique} knownMaterials={knownMaterials}
            onChange={t2 => updateTarget(i, t2)}
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

function SampleDetail({ sample, plotData, onUpdate, onUploadFile, onReparseFiles, onBack, onDelete, editingMeta, setEditingMeta }) {
  const [addingLayer, setAddingLayer]   = useState(false);
  const [meta, setMeta]                 = useState({ date: sample.date, substrate: sample.substrate, notes: sample.notes, thickness_nm: sample.thickness_nm ?? "" });
  const [dragIdx, setDragIdx]           = useState(null);
  const [overIdx, setOverIdx]           = useState(null);
  const [knownMaterials, setKnownMaterials] = useState([]);

  useEffect(() => {
    api("GET", "/materials").then(setKnownMaterials).catch(() => {});
  }, []);

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
          <Input label="Film thickness (nm)" value={meta.thickness_nm} onChange={v => setMeta(p => ({ ...p, thickness_nm: v === "" ? "" : v }))} type="number" placeholder="e.g. 30" />
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
          <Btn variant="teal" small onClick={() => setAddingLayer(v => !v)}>{addingLayer ? "Cancel" : "+ Add Layer"}</Btn>
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {sample.layers.map((l, i) => (
            <LayerEditor key={l.id} layer={l} technique={sample.technique || "sputter"} knownMaterials={knownMaterials}
              onRemove={() => removeLayer(l.id)} onDuplicate={() => duplicateLayer(l.id)} onUpdate={updateLayer}
              isDragOver={overIdx === i && dragIdx !== i}
              onDragStart={() => setDragIdx(i)} onDragOver={() => setOverIdx(i)}
              onDrop={() => handleDrop(i)} onDragEnd={() => { setDragIdx(null); setOverIdx(null); }} />
          ))}
          {!sample.layers.length && !addingLayer && <div style={{ color: T.textDim, fontFamily: "'DM Mono', monospace", fontSize: 12, padding: "10px 0" }}>No layers — add one above.</div>}
          {addingLayer && (
            <LayerEditor
              layer={newLayer(sample.technique || "sputter")}
              technique={sample.technique || "sputter"}
              knownMaterials={knownMaterials}
              initialEditing={true}
              onRemove={() => setAddingLayer(false)}
              onDuplicate={() => {}}
              onUpdate={l => { addLayer(l); }}
              isDragOver={false}
              onDragStart={() => {}} onDragOver={() => {}} onDrop={() => {}} onDragEnd={() => {}}
            />
          )}
        </div>
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

// ── AddSampleModal ────────────────────────────────────────────────────────────

function AddSampleModal({ onAdd, onClose, folders, template }) {
  const [f, setF] = useState(() => template ? {
    id: "", date: template.date ?? new Date().toISOString().slice(0, 10),
    substrate: template.substrate ?? "", notes: template.notes ?? "",
    thickness_nm: template.thickness_nm ?? "",
    technique: template.technique ?? "sputter",
    folder_id: template.folder_id ?? "",
  } : {
    id: "", date: new Date().toISOString().slice(0, 10),
    substrate: "STO (001)", notes: "", thickness_nm: "",
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
            <span key={m} style={{ fontFamily: "'DM Mono', monospace", fontSize: 11, color: s.border, background: s.bg, border: `1px solid ${s.border}`, borderRadius: 4, padding: "2px 7px" }}>{m}</span>
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

// ── Analysis Books (stub) ─────────────────────────────────────────────────────

function AnalysisBookTile({ book, samples, onDelete, onEdit }) {
  return (
    <div style={{ background: T.bg1, border: `1px solid ${T.border}`, borderRadius: 10, padding: "14px 18px", display: "flex", flexDirection: "column", gap: 8 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
        <span style={{ fontFamily: "'Playfair Display', serif", fontSize: 18, color: T.blue }}>{book.name}</span>
        <div style={{ display: "flex", gap: 6 }}>
          <button onClick={onEdit}   style={{ background: "none", border: "none", color: T.textDim, cursor: "pointer", fontSize: 13 }}>✎</button>
          <button onClick={onDelete} style={{ background: "none", border: "none", color: T.red,     cursor: "pointer", fontSize: 16 }}>×</button>
        </div>
      </div>
      <div style={{ fontFamily: "'DM Mono', monospace", fontSize: 11, color: T.textDim }}>
        {book.sample_ids?.length || 0} sample{(book.sample_ids?.length || 0) !== 1 ? "s" : ""}
      </div>
      <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
        {(book.sample_ids || []).slice(0, 6).map(id => (
          <span key={id} style={{ fontFamily: "'DM Mono', monospace", fontSize: 10, color: T.amber, background: T.amberGlow, border: `1px solid ${T.amberDim}`, borderRadius: 3, padding: "1px 6px" }}>{id}</span>
        ))}
        {(book.sample_ids?.length || 0) > 6 && <span style={{ fontFamily: "'DM Mono', monospace", fontSize: 10, color: T.textDim }}>+{book.sample_ids.length - 6} more</span>}
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
  const [samples,  setSamples]  = useState([]);
  const [folders,  setFolders]  = useState([]);
  const [books,    setBooks]    = useState([]);
  const [plotCache, setPlotCache] = useState({}); // { [sampleId]: { xrd_ot, xrr, rsm, pe, diel_b_up, diel_b_down, diel_f } }
  const [active,   setActive]   = useState(null); // sample id
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

  // Load all data on mount
  useEffect(() => {
    document.body.style.margin = "0"; document.body.style.background = T.bg0;
    Promise.all([
      api("GET", "/samples"),
      api("GET", "/folders"),
      api("GET", "/analysis-books"),
    ]).then(([s, f, b]) => {
      setSamples(s); setFolders(f); setBooks(b); setLoading(false);
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

  // Load plot data when opening a sample
  const openSample = async (id) => {
    setActive(id);
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

  const activeSample = samples.find(s => s.id === active);
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
        input[type=date]::-webkit-calendar-picker-indicator{filter:invert(0.5)}
        select option{background:${T.bg0}}
      `}</style>
      <div style={{ minHeight: "100vh", background: T.bg0, color: T.textPrimary }}>
        {/* Header */}
        <div style={{ borderBottom: `1px solid ${T.border}`, padding: "12px 28px", display: "flex", alignItems: "center", gap: 14, background: T.bg1, position: "sticky", top: 0, zIndex: 50 }}>
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
          ) : (
            <>
              <span style={{ fontFamily: "'Playfair Display', serif", fontSize: 18, color: T.amber, letterSpacing: 1 }}>LabLog</span>
              <span style={{ fontFamily: "'DM Mono', monospace", fontSize: 11, color: T.textDim }}>ferroelectric oxide films</span>
              <div style={{ flex: 1 }} />
              <Btn variant="ghost" small onClick={() => setAddingFolder(true)}>+ Folder</Btn>
              <Btn onClick={() => setAdding(true)}>+ New Sample</Btn>
            </>
          )}
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
              setEditingMeta={setEditingMeta} />
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

      {adding && <AddSampleModal onAdd={addSample} onClose={() => setAdding(false)} folders={folders} />}
      {templateSample && <AddSampleModal onAdd={s => { addSample(s); setTemplateSample(null); }} onClose={() => setTemplateSample(null)} folders={folders} template={templateSample} />}
      {(addingFolder || editingFolder) && (
        <AddFolderModal onSave={saveFolder} onClose={() => { setAddingFolder(false); setEditingFolder(null); }} existing={editingFolder} />
      )}
      {(addingBook || editingBook) && (
        <AddBookModal onSave={saveBook} onClose={() => { setAddingBook(false); setEditingBook(null); }} existing={editingBook} samples={samples} />
      )}
    </>
  );
}
