// Service worker: all network calls to our API go through here (extension origin + host permissions,
// so amazon.de's CSP and CORS never get in the way).
const DEFAULTS = { enabled: true, size: 'M', apiBase: 'https://code-demos.gogosoon.com/origin-flags' };
const cache = new Map(); // asin -> { data, at }
const TTL = 10 * 60 * 1000;

async function settings() {
  return { ...DEFAULTS, ...(await chrome.storage.sync.get(DEFAULTS)) };
}
const base = (s) => s.apiBase.replace(/\/+$/, '');

async function lookup(asins) {
  const s = await settings();
  const out = {};
  const missing = [];
  for (const a of asins) {
    const c = cache.get(a);
    if (c && Date.now() - c.at < TTL) out[a] = c.data; else missing.push(a);
  }
  for (let i = 0; i < missing.length; i += 50) {
    const chunk = missing.slice(i, i + 50);
    const res = await fetch(`${base(s)}/api/lookup?asins=${chunk.join(',')}`);
    if (!res.ok) throw new Error(`lookup ${res.status}`);
    const { results } = await res.json();
    for (const a of chunk) {
      const data = results[a] ?? null;
      // Only cache complete answers; unknown / half-known products are asked again later.
      if (data && data.brand.code !== 'UNKNOWN' && data.seller.code !== 'UNKNOWN') cache.set(a, { data, at: Date.now() });
      out[a] = data;
    }
  }
  return out;
}

async function queue(asins, search) {
  const s = await settings();
  const res = await fetch(`${base(s)}/api/queue`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ asins, search }),
  });
  return res.json();
}

chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  const run = msg.type === 'lookup' ? lookup(msg.asins) : msg.type === 'queue' ? queue(msg.asins, msg.search) : null;
  if (!run) return false;
  run.then((data) => reply({ ok: true, data }), (err) => reply({ ok: false, error: String(err.message ?? err) }));
  return true; // async reply
});
