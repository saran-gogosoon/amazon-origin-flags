import express from 'express';
import { db, enqueue } from './db.js';
import { flagCode, isAmazonBrand, isAmazonSellerName, AMAZON_SELLER_IDS } from './countries.js';
import { hostStates } from './collector/http.js';

const ASIN = /^[A-Z0-9]{10}$/;
const app = express();
app.disable('x-powered-by');
app.set('trust proxy', true);
app.use(express.json({ limit: '64kb' }));

// CORS: the extension's content script runs on amazon.de; the popup runs on chrome-extension://.
const ALLOWED = /^(chrome-extension:\/\/[a-p]{32}|https:\/\/www\.amazon\.de|http:\/\/localhost(:\d+)?)$/;
app.use((req, res, next) => {
  const origin = req.get('origin');
  if (origin && ALLOWED.test(origin)) {
    res.set({ 'Access-Control-Allow-Origin': origin, Vary: 'Origin', 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Max-Age': '86400' });
  }
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

const lookupStmt = db.prepare(`
  SELECT p.asin, p.title, p.brand, p.seller_id, p.seller_name, p.manufacturer, p.manufacturer_country, p.updated_at,
         p.responsible_name, p.responsible_country, b.name AS b_name, b.owner_name, b.owner_country, b.source AS brand_source, b.evidence_url,
         s.name AS s_name, s.country AS s_country, s.source AS seller_source,
         (SELECT status FROM queue q WHERE q.kind='product' AND q.target=p.asin) AS q_status
  FROM products p
  LEFT JOIN brands b ON b.name = p.brand COLLATE NOCASE
  LEFT JOIN sellers s ON s.seller_id = p.seller_id
  WHERE p.asin = ?`);

function toResult(r) {
  if (!r.brand && !r.seller_name) return null; // only seen in a search listing so far
  const amazonBrand = isAmazonBrand(r.brand) || /^amazon/i.test(r.owner_name ?? '');
  // Product-level GPSR country is only a stand-in until the brand has been resolved.
  const ownerCountry = r.b_name ? r.owner_country : r.manufacturer_country;
  const amazonSeller = AMAZON_SELLER_IDS.has(r.seller_id) || isAmazonSellerName(r.seller_name);
  return {
    brand: {
      name: r.brand, owner: r.owner_name ?? r.manufacturer, country: ownerCountry,
      code: amazonBrand ? 'AMAZON' : flagCode(ownerCountry),
      source: r.brand_source ?? (r.manufacturer_country ? 'GPSR manufacturer on amazon.de' : null), evidence: r.evidence_url,
      responsible: r.responsible_name ? { name: r.responsible_name, country: r.responsible_country } : null,
    },
    seller: {
      name: r.s_name ?? r.seller_name, id: r.seller_id, country: amazonSeller ? 'LU' : r.s_country,
      code: amazonSeller ? 'AMAZON' : flagCode(r.s_country),
      source: amazonSeller ? 'sold by Amazon' : r.seller_source,
    },
    updated_at: r.updated_at,
  };
}

app.get('/api/lookup', (req, res) => {
  const asins = String(req.query.asins ?? '').split(',').map((a) => a.trim().toUpperCase()).filter((a) => ASIN.test(a)).slice(0, 200);
  const results = {};
  const unknown = [];
  for (const asin of asins) {
    const row = lookupStmt.get(asin);
    const result = row && toResult(row);
    if (result) results[asin] = result;
    else unknown.push(asin);
  }
  res.set('Cache-Control', 'no-store').json({ results, unknown });
});

// The extension reports ASINs (and optionally the search term) it could not resolve.
app.post('/api/queue', (req, res) => {
  const asins = (Array.isArray(req.body?.asins) ? req.body.asins : []).map(String).filter((a) => ASIN.test(a)).slice(0, 200);
  for (const a of asins) enqueue('product', a, { priority: 8, origin: 'extension' });
  const term = typeof req.body?.search === 'string' ? req.body.search.trim().slice(0, 80) : '';
  if (term) enqueue('search', term, { priority: 1, origin: 'extension' });
  res.json({ queued: asins.length, search: term || null });
});

app.get('/api/stats', (_req, res) => {
  const c = (sql) => db.prepare(sql).get().n;
  const queue = Object.fromEntries(db.prepare(`SELECT status, count(*) n FROM queue GROUP BY status`).all().map((r) => [r.status, r.n]));
  const codes = { brand: {}, seller: {} };
  for (const r of db.prepare(`SELECT asin FROM products WHERE brand IS NOT NULL`).all()) {
    const x = toResult(lookupStmt.get(r.asin));
    if (!x) continue;
    codes.brand[x.brand.code] = (codes.brand[x.brand.code] ?? 0) + 1;
    codes.seller[x.seller.code] = (codes.seller[x.seller.code] ?? 0) + 1;
  }
  res.set('Cache-Control', 'no-store').json({
    products: c(`SELECT count(*) n FROM products WHERE brand IS NOT NULL OR seller_name IS NOT NULL`),
    products_seen: c(`SELECT count(*) n FROM products`),
    brands: c(`SELECT count(*) n FROM brands`),
    brands_with_country: c(`SELECT count(*) n FROM brands WHERE owner_country IS NOT NULL OR owner_name = 'Amazon'`),
    sellers: c(`SELECT count(*) n FROM sellers`),
    sellers_with_country: c(`SELECT count(*) n FROM sellers WHERE country IS NOT NULL`),
    queue, codes,
    blocks_24h: c(`SELECT count(*) n FROM collector_log WHERE event='blocked' AND detail NOT LIKE '%127.0.0.1%'
      AND ts > ${Date.now() - 86_400_000}`), // excludes the simulated blocking demo
    last_event_at: db.prepare(`SELECT max(ts) t FROM collector_log`).get().t,
  });
});

app.get('/api/collector/log', (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 100, 500);
  const after = Number(req.query.after) || 0;
  const rows = db.prepare(`SELECT id, ts, level, event, detail FROM collector_log WHERE id > ? ORDER BY id DESC LIMIT ?`).all(after, limit);
  res.set('Cache-Control', 'no-store').json({ events: rows, hosts: hostStates() });
});

app.get('/api/queue', (_req, res) => {
  res.set('Cache-Control', 'no-store').json(db.prepare(`SELECT kind, target, status, attempts, next_try_at, last_error, origin
    FROM queue ORDER BY CASE status WHEN 'running' THEN 0 WHEN 'pending' THEN 1 WHEN 'failed' THEN 2 ELSE 3 END,
    updated_at DESC LIMIT 50`).all());
});

app.get('/api/health', (_req, res) => res.json({ ok: true, time: new Date().toISOString() }));

app.use(express.static(new URL('../public', import.meta.url).pathname, { index: 'index.html' }));

export default app;
