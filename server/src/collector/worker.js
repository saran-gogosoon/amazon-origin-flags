// Queue worker: takes jobs from the SQLite queue and turns pages into facts.
// Jobs: search (term → ASINs), product (ASIN → brand, seller, GPSR manufacturer),
// seller (id → business address country), brand (name → owner + country).
import { db, enqueue, log, now } from '../db.js';
import { fetchSearch, fetchProduct, fetchSeller } from './amazon.js';
import { lookupBrandOwner } from './trademarks.js';
import { BlockedError, HostPausedError } from './http.js';
import { AMAZON_SELLER_IDS, isAmazonBrand, isAmazonSellerName } from '../countries.js';

// Priorities: seller (12) and brand (11) follow-ups run before new products (<= 10), so every product
// that was crawled gets both flags quickly instead of waiting for the whole product backlog.
const MAX_ATTEMPTS = Number(process.env.MAX_ATTEMPTS ?? 8);
const DAY = 86_400_000;

export async function runSearch(term, pages = 2, origin = 'cli') {
  let found = 0;
  for (let p = 1; p <= pages; p++) {
    const { items, via } = await fetchSearch(term, p);
    for (const it of items) {
      enqueue('product', it.asin, { priority: 10 - p, origin: `search:${term}` });
      found++;
      db.prepare(`INSERT INTO products (asin, title, updated_at, source) VALUES (?,?,?,?)
        ON CONFLICT(asin) DO NOTHING`).run(it.asin, it.title, now(), 'amazon.de search');
    }
    log('info', 'search_page', { term, page: p, asins: items.length, via, origin });
  }
  return found;
}

async function doProduct(asin) {
  const p = await fetchProduct(asin);
  if (p.notFound) { log('warn', 'product_not_found', { asin }); return; }
  saveProduct(p);
}

/** Store a fetched product page and queue its seller / brand follow-ups. */
export function saveProduct(p) {
  const { asin } = p;
  const m = p.manufacturer;
  // The EU responsible person shown for this product's seller (stored and shown, never used as owner country).
  const sellerKey = (p.seller.name ?? '').toLowerCase();
  const rsp = p.responsible.find((r) => r.seller?.toLowerCase() === sellerKey) ?? p.responsible[0] ?? null;
  db.prepare(`INSERT INTO products (asin, title, brand, seller_id, seller_name, manufacturer, manufacturer_address,
      manufacturer_country, manufacturer_note, responsible_name, responsible_address, responsible_country, gpsr_json,
      updated_at, source) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(asin) DO UPDATE SET title=excluded.title, brand=excluded.brand, seller_id=excluded.seller_id,
      seller_name=excluded.seller_name, manufacturer=excluded.manufacturer,
      manufacturer_address=excluded.manufacturer_address, manufacturer_country=excluded.manufacturer_country,
      manufacturer_note=excluded.manufacturer_note, responsible_name=excluded.responsible_name,
      responsible_address=excluded.responsible_address, responsible_country=excluded.responsible_country,
      gpsr_json=excluded.gpsr_json, updated_at=excluded.updated_at, source=excluded.source`)
    .run(asin, p.title, p.brand, p.seller.id, p.seller.name, m?.name ?? null, m?.address ?? null, m?.country ?? null,
      m?.note ?? null, rsp?.name ?? null, rsp?.address ?? null, rsp?.country ?? null,
      m || p.responsible.length ? JSON.stringify({ manufacturer: m, responsible: p.responsible }) : null,
      now(), `amazon.de product page (${p.via})${m ? ' + GPSR manufacturer block' : ''}`);
  log('info', 'product_saved', { asin, brand: p.brand, seller: p.seller.name, manufacturer: m?.name, mfr_country: m?.country,
    ...(m?.note ? { mfr_note: m.note } : {}), eu_responsible: rsp?.name });

  if (p.seller.id && !AMAZON_SELLER_IDS.has(p.seller.id) && !isAmazonSellerName(p.seller.name)) {
    const known = db.prepare('SELECT country FROM sellers WHERE seller_id=?').get(p.seller.id);
    if (!known?.country) enqueue('seller', p.seller.id, { priority: 12, rearm: true });
  }
  if (p.brand) {
    const known = db.prepare('SELECT owner_country FROM brands WHERE name=?').get(p.brand);
    if (!known?.owner_country) enqueue('brand', p.brand, { priority: 11, rearm: true });
  }
}

async function doSeller(id) {
  const s = await fetchSeller(id);
  db.prepare(`INSERT INTO sellers (seller_id, name, address, country, source, updated_at) VALUES (?,?,?,?,?,?)
    ON CONFLICT(seller_id) DO UPDATE SET name=excluded.name, address=excluded.address, country=excluded.country,
      source=excluded.source, updated_at=excluded.updated_at`)
    .run(id, s.name ?? s.company, s.address, s.country, `amazon.de seller profile Geschäftsadresse (${s.via})`, now());
  log('info', 'seller_saved', { seller_id: id, name: s.name, company: s.company, country: s.country });
}

/**
 * Brand owner country:
 *  1. Amazon's own brands → AMAZON
 *  2. GPSR manufacturer, country from the manufacturer's OWN address only (never the EU responsible person)
 *  3. EU trade mark owner — only when the owner's name matches the GPSR manufacturer. Confirms 2, or supplies
 *     the country when the manufacturer's address turned out to be the EU responsible person's.
 *  Otherwise unknown (no guessing from namesake trade marks or EU importers).
 */
export async function doBrand(name) {
  const save = (owner, country, source, url) => {
    db.prepare(`INSERT INTO brands (name, owner_name, owner_country, source, evidence_url, checked_at) VALUES (?,?,?,?,?,?)
      ON CONFLICT(name) DO UPDATE SET owner_name=excluded.owner_name, owner_country=excluded.owner_country,
        source=excluded.source, evidence_url=excluded.evidence_url, checked_at=excluded.checked_at`)
      .run(name, owner, country, source, url, now());
    log('info', 'brand_saved', { brand: name, owner, country, source });
  };
  if (isAmazonBrand(name)) return save('Amazon', null, 'known Amazon private label', null);

  // Most common GPSR manufacturer for this brand; prefer rows whose address is the manufacturer's own.
  const mfr = db.prepare(`SELECT manufacturer, manufacturer_country c, manufacturer_note note, asin, count(*) n FROM products
    WHERE brand = ? COLLATE NOCASE AND manufacturer IS NOT NULL GROUP BY manufacturer, manufacturer_country
    ORDER BY (manufacturer_country IS NOT NULL) DESC, n DESC LIMIT 1`).get(name);
  if (mfr && /amazon/i.test(mfr.manufacturer)) return save('Amazon', mfr.c, 'GPSR manufacturer is Amazon', null);

  let tm = null;
  try {
    tm = await lookupBrandOwner(name, mfr?.manufacturer);
  } catch (err) {
    if (!mfr) throw err; // no other evidence → let the queue retry later
    log('warn', 'trademark_lookup_failed', { brand: name, error: err.message });
  }
  const tmText = tm?.matched && `EU trade mark "${tm.mark}"${tm.nice?.includes(8) ? ' (class 8)' : ''} owner ${tm.name} (${tm.country ?? '?'})`;
  const dp = mfr && `https://www.amazon.de/dp/${mfr.asin}`;

  if (mfr?.c) {
    const check = tm?.matched ? (tm.country === mfr.c ? `; confirmed by ${tmText}` : `; note: ${tmText} differs`)
      : tm ? `; EU trade mark: ${tm.reason}` : '';
    return save(mfr.manufacturer, mfr.c, `GPSR manufacturer address on amazon.de${check}`, dp);
  }
  if (mfr && tm?.matched && tm.country) {
    return save(tm.name, tm.country, `${tmText} via EUIPO; GPSR manufacturer ${mfr.manufacturer}: ${mfr.note ?? 'no country'}`, tm.evidence_url);
  }
  if (mfr) {
    return save(mfr.manufacturer, null, `GPSR manufacturer ${mfr.note ?? 'without country'}; EU trade mark: ${tm?.reason ?? 'lookup failed'}`, dp);
  }
  save(null, null, `no GPSR manufacturer; EU trade mark not used (${tm?.reason ?? 'lookup failed'})`, null);
}

const HANDLERS = { product: doProduct, seller: doSeller, brand: doBrand, search: (t) => runSearch(t, Number(process.env.SEARCH_PAGES ?? 2), 'queue') };

/** Take the next ready job (highest priority first) and run it. Returns false when nothing is ready. */
export async function processNext() {
  const job = db.prepare(`SELECT * FROM queue WHERE status='pending' AND next_try_at <= ?
    ORDER BY priority DESC, id LIMIT 1`).get(now());
  if (!job) return false;
  db.prepare(`UPDATE queue SET status='running', attempts=attempts+1, updated_at=? WHERE id=?`).run(now(), job.id);
  try {
    await HANDLERS[job.kind](job.target);
    db.prepare(`UPDATE queue SET status='done', last_error=NULL, updated_at=? WHERE id=?`).run(now(), job.id);
  } catch (err) {
    const blocked = err instanceof BlockedError || err instanceof HostPausedError;
    // Being paused by our own circuit breaker is not the job's fault: don't burn an attempt.
    const attempts = err instanceof HostPausedError ? job.attempts : job.attempts + 1;
    const retryAt = blocked ? err.retryAt : now() + Math.min(2 ** attempts * 60_000, DAY);
    const failed = attempts >= MAX_ATTEMPTS;
    db.prepare(`UPDATE queue SET status=?, attempts=?, next_try_at=?, last_error=?, updated_at=? WHERE id=?`)
      .run(failed ? 'failed' : 'pending', attempts, retryAt, String(err.message).slice(0, 300), now(), job.id);
    if (!(err instanceof HostPausedError)) {
      log(failed ? 'error' : 'warn', failed ? 'job_failed' : 'job_retry', { kind: job.kind, target: job.target,
        attempt: attempts, error: String(err.message).slice(0, 200), retry_at: new Date(retryAt).toISOString() });
    }
  }
  return true;
}

export function nextReadyAt() {
  return db.prepare(`SELECT min(next_try_at) t FROM queue WHERE status='pending'`).get()?.t ?? null;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let stopping = false;
export const stop = () => { stopping = true; };

/** Work the queue. untilEmpty: exit when no pending jobs remain; otherwise run forever (resume-safe). */
export async function loop({ untilEmpty = false } = {}) {
  log('info', 'collector_started', { mode: untilEmpty ? 'until-empty' : 'loop', pid: process.pid });
  while (!stopping) {
    if (await processNext()) continue;
    const next = nextReadyAt();
    if (untilEmpty && next === null) break;
    // Nothing ready: sleep until the earliest retry (max 30 s so new work from the extension is picked up).
    await sleep(Math.max(1_000, Math.min(30_000, (next ?? Date.now() + 30_000) - Date.now())));
  }
  log('info', 'collector_idle', { stopped: stopping });
}
