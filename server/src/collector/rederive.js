// Re-derive brand owner countries for the existing DB with the current rules.
//  1. GPSR re-fetch (politely, via the normal block-aware client) only where it can change the answer: manufacturer
//     addresses inside the EU that were stored before EU responsible persons were parsed (only an EU address can
//     be an EU importer's address). One product per distinct manufacturer address; siblings get the same verdict.
//  2. Every brand is re-resolved (GPSR manufacturer country + name-matched EU trade mark).
//   npm run rederive
import { db, log } from '../db.js';
import { EU } from '../countries.js';
import { fetchProduct } from './amazon.js';
import { doBrand, saveProduct } from './worker.js';
import { closeBrowser } from './http.js';

const eu = [...EU].map((c) => `'${c}'`).join(',');
const groups = db.prepare(`SELECT manufacturer, manufacturer_address, min(asin) asin, count(*) n FROM products
  WHERE manufacturer IS NOT NULL AND manufacturer_country IN (${eu})
  GROUP BY manufacturer, manufacturer_address HAVING max(gpsr_json IS NOT NULL) = 0`).all();
log('info', 'rederive_start', { gpsr_refetch: groups.length, brands: db.prepare('SELECT count(*) n FROM brands').get().n });

for (const g of groups) {
  try {
    const p = await fetchProduct(g.asin);
    saveProduct(p);
    const m = p.manufacturer;
    if (m && m.name === g.manufacturer && m.address === g.manufacturer_address) {
      db.prepare(`UPDATE products SET manufacturer_country=?, manufacturer_note=? WHERE manufacturer=? AND manufacturer_address=?`)
        .run(m.country, m.note, g.manufacturer, g.manufacturer_address);
    }
    log('info', 'rederive_gpsr', { manufacturer: g.manufacturer, products: g.n, country: m?.country ?? null, note: m?.note ?? undefined });
  } catch (err) {
    log('warn', 'rederive_gpsr_failed', { manufacturer: g.manufacturer, error: err.message }); // keep stored data
  }
}

for (const { name } of db.prepare('SELECT name FROM brands ORDER BY name').all()) {
  try { await doBrand(name); } catch (err) { log('warn', 'rederive_brand_failed', { brand: name, error: err.message }); }
}
log('info', 'rederive_done', {});
await closeBrowser();
