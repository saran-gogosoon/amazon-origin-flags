// End-to-end check + screenshots: loads the unpacked extension into Playwright's bundled Chromium (headed),
// searches amazon.de for "Gartenschere", waits for the badges and saves screenshots to docs/.
//   API_BASE=http://localhost:5180 node scripts/screenshot.mjs
import { chromium } from 'playwright';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const EXT = join(ROOT, 'extension');
const DOCS = join(ROOT, 'docs');
const API_BASE = (process.env.API_BASE ?? 'http://localhost:5180').replace(/\/+$/, '');
const QUERY = process.env.QUERY ?? 'Gartenschere';
mkdirSync(DOCS, { recursive: true });

const ctx = await chromium.launchPersistentContext(mkdtempSync(join(tmpdir(), 'origin-flags-')), {
  headless: false,
  viewport: { width: 1440, height: 1000 },
  locale: 'de-DE',
  args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
});

let [sw] = ctx.serviceWorkers();
sw ??= await ctx.waitForEvent('serviceworker');
const extId = new URL(sw.url()).host;
await sw.evaluate((apiBase) => chrome.storage.sync.set({ apiBase, enabled: true, size: 'M' }), API_BASE);
console.log(`extension ${extId} loaded, API_BASE=${API_BASE}`);

// ---- amazon.de search ---------------------------------------------------------------------------
const page = ctx.pages()[0] ?? await ctx.newPage();
await page.goto(`https://www.amazon.de/s?k=${encodeURIComponent(QUERY)}`, { waitUntil: 'domcontentloaded' });
if (/validateCaptcha/.test(page.url()) || await page.locator('form[action*="validateCaptcha"]').count()) {
  console.error('amazon.de showed a captcha to the browser – stopping.');
  await page.screenshot({ path: join(DOCS, 'screenshot-captcha.png') });
  process.exit(2);
}
for (const sel of ['#sp-cc-accept', 'input[name="accept"]', 'button:has-text("Akzeptieren")']) {
  const btn = page.locator(sel).first();
  if (await btn.isVisible().catch(() => false)) { await btn.click(); console.log('cookie banner accepted'); break; }
}
// "Deliver to another country?" popover (shown to non-German IPs) covers the first row.
const dismiss = page.locator('input[data-action-type="DISMISS"], .glow-toaster-button-dismiss input').first();
if (await dismiss.isVisible().catch(() => false)) await dismiss.click().catch(() => {});
await page.waitForSelector('of-badge', { timeout: 30_000 });
await page.waitForTimeout(3_000); // let lazy tiles get their badges

const stats = await page.evaluate(() => {
  const tiles = [...document.querySelectorAll('[data-component-type="s-search-result"][data-asin]')]
    .filter((t) => /^[A-Z0-9]{10}$/.test(t.dataset.asin));
  const boxes = tiles.map((t) => t.querySelector('of-badges')).filter(Boolean);
  const count = (side) => boxes.reduce((m, b) => ({ ...m, [b.dataset[side]]: (m[b.dataset[side]] ?? 0) + 1 }), {});
  return {
    tiles: tiles.length,
    tilesWithBadges: boxes.length,
    brandKnown: boxes.filter((b) => b.dataset.brand !== 'UNKNOWN').length,
    sellerKnown: boxes.filter((b) => b.dataset.seller !== 'UNKNOWN').length,
    bothKnown: boxes.filter((b) => b.dataset.brand !== 'UNKNOWN' && b.dataset.seller !== 'UNKNOWN').length,
    brandCodes: count('brand'),
    sellerCodes: count('seller'),
  };
});
const pct = (n) => `${stats.tiles ? Math.round((100 * n) / stats.tiles) : 0}%`;
console.log(`tiles: ${stats.tiles}, with badges: ${stats.tilesWithBadges}`);
console.log(`brand flag known: ${stats.brandKnown} (${pct(stats.brandKnown)}), seller flag known: ${stats.sellerKnown} (${pct(stats.sellerKnown)}), both: ${stats.bothKnown} (${pct(stats.bothKnown)})`);
console.log('brand codes', JSON.stringify(stats.brandCodes), 'seller codes', JSON.stringify(stats.sellerCodes));

// Scroll so the first row of results is in view and take the full viewport.
const first = page.locator('[data-component-type="s-search-result"] of-badges').first();
await first.evaluate((el) => el.closest('[data-component-type="s-search-result"]').scrollIntoView({ block: 'start' }));
await page.evaluate(() => window.scrollBy(0, -120));
await page.waitForTimeout(800);
await page.screenshot({ path: join(DOCS, 'screenshot-search.png') });

// Close-up: hover a fully known tile so the tooltip is visible.
const known = page.locator('[data-component-type="s-search-result"] of-badges:not([data-brand="UNKNOWN"]):not([data-seller="UNKNOWN"])').first();
const target = (await known.count()) ? known : first;
const tile = target.locator('xpath=ancestor::*[@data-component-type="s-search-result"][1]');
await tile.scrollIntoViewIfNeeded();
await page.waitForTimeout(300);
await target.locator('of-badge.of-left').hover();
await page.waitForTimeout(400);
const box = await tile.boundingBox();
await page.screenshot({ path: join(DOCS, 'screenshot-closeup.png'),
  clip: { x: Math.max(0, box.x - 10), y: Math.max(0, box.y - 10), width: Math.min(box.width + 20, 1440), height: Math.min(box.height + 20, 700) } });

// ---- popup + collector status page ----------------------------------------------------------------
const popup = await ctx.newPage();
await popup.setViewportSize({ width: 320, height: 520 });
await popup.goto(`chrome-extension://${extId}/popup.html`);
await popup.waitForSelector('#stats b', { timeout: 10_000 }).catch(() => {});
await popup.locator('body').screenshot({ path: join(DOCS, 'screenshot-popup.png') });

const status = await ctx.newPage();
await status.setViewportSize({ width: 1280, height: 1100 });
await status.goto(`${API_BASE}/`);
await status.waitForSelector('#log tr', { timeout: 10_000 });
await status.waitForTimeout(500);
await status.screenshot({ path: join(DOCS, 'screenshot-collector.png') });

await ctx.close();
console.log(`screenshots written to ${DOCS}`);
if (!stats.tilesWithBadges) { console.error('FAIL: no badges rendered'); process.exit(1); }
console.log(`OK: ${stats.tilesWithBadges} tiles show badges, ${stats.bothKnown} with both flags known`);
