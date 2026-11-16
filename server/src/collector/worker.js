// Queue worker: takes jobs from the SQLite queue and turns pages into facts.
// Jobs: search (term → ASINs), product (ASIN → brand, seller, GPSR manufacturer),
// seller (id → business address country), brand (name → owner + country).
import { db, enqueue, log, now } from '../db.js';
import { fetchSearch, fetchProduct, fetchSeller } from './amazon.js';
import { lookupBrandOwner } from './trademarks.js';
import { BlockedError, HostPausedError } from './http.js';
import { AMAZON_SELLER_IDS, isAmazonBrand, isAmazonSellerName } from '../countries.js';

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
  const m = p.manufacturer;
  db.prepare(`INSERT INTO products (asin, title, brand, seller_id, seller_name, manufacturer, manufacturer_address,
      manufacturer_country, updated_at, source) VALUES (?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(asin) DO UPDATE SET title=excluded.title, brand=excluded.brand, seller_id=excluded.seller_id,
      seller_name=excluded.seller_name, manufacturer=excluded.manufacturer,
      manufacturer_address=excluded.manufacturer_address, manufacturer_country=excluded.manufacturer_country,
      updated_at=excluded.updated_at, source=excluded.source`)
    .run(asin, p.title, p.brand, p.seller.id, p.seller.name, m?.name ?? null, m?.address ?? null, m?.country ?? null,
      now(), `amazon.de product page (${p.via})${m ? ' + GPSR manufacturer block' : ''}`);
  log('info', 'product_saved', { asin, brand: p.brand, seller: p.seller.name, manufacturer: m?.name, mfr_country: m?.country });

  if (p.seller.id && !AMAZON_SELLER_IDS.has(p.seller.id) && !isAmazonSellerName(p.seller.name)) {
    const known = db.prepare('SELECT country FROM sellers WHERE seller_id=?').get(p.seller.id);
    if (!known?.country) enqueue('seller', p.seller.id, { priority: 5, rearm: true });
  }
  if (p.brand) {
    const known = db.prepare('SELECT owner_country FROM brands WHERE name=?').get(p.brand);
    if (!known?.owner_country) enqueue('brand', p.brand, { priority: 4, rearm: true });
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
 * Brand owner country, in order of preference:
 *  1. Amazon's own brands → AMAZON
 *  2. EU trade mark owner (TMview + EUIPO) when exactly one company holds live EU marks for this name
 *     — the legal brand owner; also catches GPSR blocks that list an EU agent as "manufacturer"
 *  3. GPSR manufacturer from this brand's amazon.de product pages
 *  4. EU trade mark owner when the name is shared by several applicants (best match)
 */
async function doBrand(name) {
  const save = (owner, country, source, url) => {
    db.prepare(`INSERT INTO brands (name, owner_name, owner_country, source, evidence_url, checked_at) VALUES (?,?,?,?,?,?)
      ON CONFLICT(name) DO UPDATE SET owner_name=excluded.owner_name, owner_country=excluded.owner_country,
        source=excluded.source, evidence_url=excluded.evidence_url, checked_at=excluded.checked_at`)
      .run(name, owner, country, source, url, now());
    log('info', 'brand_saved', { brand: name, owner, country, source });
  };
  if (isAmazonBrand(name)) return save('Amazon', null, 'known Amazon private label', null);

  const mfr = db.prepare(`SELECT manufacturer, manufacturer_country c, asin, count(*) n FROM products
    WHERE brand = ? COLLATE NOCASE AND manufacturer_country IS NOT NULL GROUP BY manufacturer, manufacturer_country
    ORDER BY n DESC LIMIT 1`).get(name);
  if (mfr && /amazon/i.test(mfr.manufacturer)) return save('Amazon', mfr.c, 'GPSR manufacturer is Amazon', null);

  let tm = null;
  try {
    tm = await lookupBrandOwner(name, mfr?.manufacturer);
  } catch (err) {
    if (!mfr) throw err; // no other evidence → let the queue retry later
    log('warn', 'trademark_lookup_failed', { brand: name, error: err.message });
  }

  const tmSource = tm && `EU trade mark "${tm.mark}" (${tm.status}) via TMview/EUIPO`;
  if (tm?.country && tm.live && tm.unique) {
    const agrees = mfr && mfr.c === tm.country;
    return save(tm.name, tm.country, tmSource + (agrees ? ' + GPSR manufacturer agrees' : ''), tm.evidence_url);
  }
  if (mfr) {
    const agrees = tm?.country && tm.country === mfr.c;
    return save(mfr.manufacturer, mfr.c, `GPSR manufacturer on amazon.de${agrees ? ' (confirmed by EU trade mark)' : ''}`,
      `https://www.amazon.de/dp/${mfr.asin}`);
  }
  if (tm?.country) return save(tm.name, tm.country, tmSource, tm.evidence_url);
  save(null, null, 'no evidence yet', null);
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
