// Run with: node --test frontend/tests/rsm-resampling.test.cjs
// Load the pure plotting functions without importing React/Plotly or moving UI
// out of LabLog.jsx. Fixtures are synthetic, never the user's database/files.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../src/LabLog.jsx'), 'utf8');
const context = vm.createContext({});
vm.runInContext(
  source.slice(source.indexOf('function xrayPayloadToPlotData('), source.indexOf('// Does this text file'))
  + source.slice(source.indexOf('// Keep acquisition connectivity'), source.indexOf('function useRsmViewport('))
  + source.slice(source.indexOf('function binRSM('), source.indexOf('// Generate evenly-spaced ticks'))
  + ';this.api = { xrayPayloadToPlotData, resampleRSM, sampleRsmMesh, binRSM, rsmMeshShape, rsmMeshShapes, rsmRelayoutWindow };', context);
const { xrayPayloadToPlotData, resampleRSM, sampleRsmMesh, binRSM, rsmMeshShape, rsmMeshShapes, rsmRelayoutWindow } = context.api;
function mesh(value = (x, y) => 4 + 2*x + 3*y) {
  const data = [];
  for (let row = 0; row < 5; row++) for (let col = 0; col < 6; col++) {
    const x = col + row*.15, y = row;
    data.push({ x, y, z: value(x, y) });
  }
  rsmMeshShapes.set(data, { rows: 5, cols: 6 });
  return data;
}
function assertNoInteriorHoles(raster) {
  for (const row of raster.z) {
    const lo = row.findIndex(v => v !== null), hi = row.findLastIndex(v => v !== null);
    for (let i = lo; i <= hi; i++) assert.notEqual(row[i], null);
  }
}
test('tilted measured cells make a continuous, exact linear surface with blank exterior', () => {
  const data = mesh();
  const z = sampleRsmMesh(data, 120, 100, [-1, 7], [-1, 5]);
  assertNoInteriorHoles({ z });
  assert.equal(z[0][0], null);
  for (let j = 0; j < 100; j++) for (let i = 0; i < 120; i++) {
    const value = z[j][i], x = -1 + (i+.5)*8/120, y = -1 + (j+.5)*6/100;
    if (value !== null) assert.ok(Math.abs(value - (4 + 2*x + 3*y)) < 1e-10);
  }
});
test('crop keeps surrounding source cells even when no source point lies inside', () => {
  const result = resampleRSM(mesh(), 32, 32, [.6, .8], [.4, .6], false, null, 5);
  assert.ok(result.z.flat().every(Number.isFinite));
});
test('all original measured pixels, background decisions and color limits are preserved', () => {
  for (const log of [false, true]) for (const bg of [null, 'percentile', 'median', 'plane']) {
    const data = mesh((x, y) => (x < 2 ? 0 : x < 3 ? -1 : 4 + 2*x + 3*y));
    const original = binRSM(data, 64, 64, [-1, 7], [-1, 5], log, bg, 25);
    const filled = resampleRSM(data, 64, 64, [-1, 7], [-1, 5], log, bg, 25);
    assert.equal(filled.zmin, original.zmin); assert.equal(filled.zmax, original.zmax);
    for (let j = 0; j < 64; j++) for (let i = 0; i < 64; i++) {
      if (original.z[j][i] != null) assert.equal(filled.z[j][i], original.z[j][i]);
    }
    assert.ok(filled.z.flat().filter(v => v !== null).every(Number.isFinite));
  }
});
test('median background remains blank while sampling gaps in positive peaks fill', () => {
  const data = mesh((x, y) => x > 2 && x < 4 && y > 1 && y < 3 ? 100 : 1);
  const original = binRSM(data, 100, 100, [-1, 7], [-1, 5], true, 'median', 50);
  const filled = resampleRSM(data, 100, 100, [-1, 7], [-1, 5], true, 'median', 50);
  assert.equal(filled.zmin, original.zmin); assert.equal(filled.zmax, original.zmax);
  assert.ok(filled.z.flat().filter(v => v !== null).length > original.z.flat().filter(v => v !== null).length);
  const background = resampleRSM(mesh(() => 1), 64, 64, [1, 4], [1, 3], true, 'median', 50);
  assert.ok(background.z.flat().every(v => v === null));
});
test('interpolation cannot overshoot the measured range or change the raw points', () => {
  const data = mesh((x, y) => Math.exp(-((x-2.2)**2 + (y-2)**2)/.3));
  const snapshot = JSON.stringify(data);
  const result = resampleRSM(data, 180, 160, [-1, 7], [-1, 5], false, null, 5);
  const max = Math.max(...data.map(p => p.z));
  const populated = result.z.flat().filter(v => v !== null);
  assert.ok(populated.every(v => v >= 0 && v <= max));
  const peak = Math.max(...populated), row = result.z.findIndex(r => r.includes(peak));
  const col = result.z[row].indexOf(peak);
  const measured = data.reduce((a, b) => a.z > b.z ? a : b);
  assert.ok(Math.abs(result.x[col] - measured.x) < .05);
  assert.ok(Math.abs(result.y[row] - measured.y) < .05);
  assert.equal(JSON.stringify(data), snapshot);
});
test('a missing measurement remains a genuine gap', () => {
  const data = mesh(); data[2*6 + 3].z = NaN;
  const result = sampleRsmMesh(data, 80, 80, [2, 4], [1, 3]);
  assert.ok(result.flat().includes(null));
});
test('a new coordinate array with the same point count replaces the displayed surface', () => {
  const data = mesh(), moved = data.map(p => ({ ...p, x: p.x + 10 }));
  rsmMeshShapes.set(moved, { rows: 5, cols: 6 });
  const before = resampleRSM(data, 32, 32, [1, 4], [1, 3], false, null, 5);
  const after = resampleRSM(moved, 32, 32, [1, 4], [1, 3], false, null, 5);
  assert.ok(before.z.flat().some(Number.isFinite));
  assert.ok(after.z.flat().every(v => v === null));
});
test('SmartLab CSV row resets recover the same connectivity as rasx', () => {
  const p = { omega: [55, 55.02, 55.04], two_theta: Array.from({length: 101}, (_, i) => 73+i*.01),
    intensity: Array.from({length: 3}, () => Array(101).fill(20)), wavelength_A: 1.540593 };
  const data = xrayPayloadToPlotData(p), csv = data.map(p => ({...p}));
  assert.equal(rsmMeshShape(csv).cols, 101);
  const args = [50, 50, [2, 3], [7, 8], true, 'median', 50];
  assert.equal(JSON.stringify(resampleRSM(data, ...args)), JSON.stringify(resampleRSM(csv, ...args)));
  assert.equal(rsmMeshShape([{x:0,y:0,z:1},{x:1,y:1,z:2},{x:2,y:3,z:3}]), null);
});
test('subplot zoom and pan update the viewport, unrelated events do not, reset clears it', () => {
  const view = rsmRelayoutWindow({'xaxis2.range[0]':2.5,'xaxis2.range[1]':2.55}, null);
  assert.equal(view.x[0], 2.5);
  const panned = rsmRelayoutWindow({'yaxis3.range':[7.3,7.6]}, view);
  assert.equal(panned.y[0], 7.3); assert.equal(panned.x, view.x);
  assert.equal(rsmRelayoutWindow({'autosize':true}, panned), panned);
  assert.equal(rsmRelayoutWindow({'xaxis.range':[2.5,2.55]}, view), view);
  assert.equal(rsmRelayoutWindow({'xaxis.range':[3,2]}, view), view);
  assert.equal(rsmRelayoutWindow({'xaxis.autorange':true}, view), null);
});
