// @ts-check
const { chromium } = require('playwright');
const path = require('path');

const OUT = path.join(__dirname, '..', 'docs', 'screenshots');

async function waitForPlots(page) {
  await page.waitForSelector('.js-plotly-plot', { timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(3500); // let all traces finish rendering
}

// Find panel block by its label span text (2 levels up: span → header div → panel div)
async function shotPanel(page, labelText, filename) {
  const span = page.locator('span').filter({ hasText: labelText }).first();
  const count = await span.count();
  if (!count) { console.warn(`Panel not found: "${labelText}"`); return; }
  const panel = span.locator('xpath=../..').first();
  await panel.screenshot({ path: path.join(OUT, filename), type: 'png' });
  console.log(`Saved: ${filename}`);
}

(async () => {
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  const page = await ctx.newPage();

  // ── Samples page (dark) ────────────────────────────────────────
  await page.goto('http://localhost:5173/', { waitUntil: 'networkidle' });
  await page.waitForTimeout(1200);
  // Crop samples pages: remove 137px side margins and ~280px dead bottom
  // App container is max-width ~1100 centred in 1400px viewport; content ends ~y=618
  const SAMPLES_CROP = { x: 137, y: 0, width: 1126, height: 628 };

  await page.screenshot({ path: path.join(OUT, 'samples-dark.png'), type: 'png', clip: SAMPLES_CROP });
  console.log('Saved: samples-dark.png');

  // ── Samples page (light) ───────────────────────────────────────
  await page.locator('button[title*="light mode"]').click();
  await page.waitForTimeout(500);
  await page.screenshot({ path: path.join(OUT, 'samples-light.png'), type: 'png', clip: SAMPLES_CROP });
  console.log('Saved: samples-light.png');
  await page.locator('button[title*="dark mode"]').click(); // back to dark
  await page.waitForTimeout(300);

  // ── Analysis Book ──────────────────────────────────────────────
  await page.locator('text=Demo Analysis Book').click();
  // No URL change — wait for the book detail header and plots to render
  await page.waitForSelector('text=Demo Analysis Book', { timeout: 10000 });
  await waitForPlots(page);

  // Roster — "Samples" span → header div → roster block div
  await shotPanel(page, 'Samples', 'book-roster.png');

  // Panels
  await shotPanel(page, 'XRD',           'book-xrd.png');
  await shotPanel(page, 'RSM',           'book-rsm.png');
  await shotPanel(page, 'Hysteresis',    'book-pe.png');
  await shotPanel(page, 'vs E',          'book-de.png');
  await shotPanel(page, 'vs f',          'book-df.png');

  await browser.close();
  console.log('All done.');
})();
