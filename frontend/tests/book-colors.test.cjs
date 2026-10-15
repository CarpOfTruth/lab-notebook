// Palette compatibility and grouping, without importing the React/Plotly UI.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createHash } = require('node:crypto');
const source = fs.readFileSync(path.join(__dirname, '../src/LabLog.jsx'), 'utf8');
function load(text) {
  const context = vm.createContext({});
  vm.runInContext(text.slice(text.indexOf('const COLOR_SCALES ='), text.indexOf('// ── CSV + data utilities'))
    + ';this.api = {sampleColorScale, ' + (text.includes('function colorScaleGradient(') ? 'colorScaleGradient, groupedShade, GROUPED_PALETTES' : '') + '};', context);
  return context.api;
}
const current = load(source);
const plain = value => JSON.parse(JSON.stringify(value));
test('existing palettes and unknown fallback retain exact colors', () => {
  // Golden digest of all these outputs before grouped palettes were introduced.
  const values = [];
  for (const name of ['viridis','cividis','inferno','magma','plasma','coolwarm','unknown'])
    for (const count of [0,1,2,8,12,35]) for (const trim of [undefined,0,5,25,49])
      values.push(current.sampleColorScale(name,count,trim));
  assert.equal(createHash('sha256').update(JSON.stringify(values)).digest('hex'),
    '86bfb9328189da558202226db31378d5da8c1c260ce67560ef85dbcbdc2bc3e1');
});
test('grouped palettes sample continuous hue ramps in consecutive balanced blocks', () => {
  for (const [name, palette] of Object.entries(current.GROUPED_PALETTES)) {
    for (const groups of [2,3,4]) for (const count of [0,1,2,8,12,17]) {
      const colors = current.sampleColorScale(name,count,0,groups);
      assert.equal(colors.length,count);
      if (!count) continue;
      const effective = Math.min(groups,count);
      let offset=0;
      for (let group=0; group<effective; group++) {
        const size=Math.floor(count/effective)+(group<count%effective?1:0);
        for (let i=0; i<size; i++) assert.equal(colors[offset+i], current.groupedShade(palette,group,size===1?0.5:i/(size-1)));
        offset+=size;
      }
    }
  }
});
test('grouped previews retain hard hue boundaries; invalid group counts default to three', () => {
  const gradient=current.colorScaleGradient('grouped_classic',5,2);
  assert.equal((gradient.match(/ 50%/g)||[]).length,2);
  assert.deepEqual(plain(current.sampleColorScale('grouped_classic',12,5,99)), plain(current.sampleColorScale('grouped_classic',12,5,3)));
  assert.equal(current.colorScaleGradient('viridis',5),`linear-gradient(to right, ${current.sampleColorScale('viridis',20,5).join(',')})`);
});
