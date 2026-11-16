// Content script: finds product pictures on amazon.de, asks our server where brand owner and
// seller come from, and overlays two round flag badges (left = brand owner, right = seller).
(() => {
  const DEFAULTS = { enabled: true, size: 'M', apiBase: 'https://code-demos.gogosoon.com/origin-flags' };
  const SIZES = { S: 20, M: 26, L: 34 };
  const RETRY_MS = 60_000;
  const MAX_RETRIES = 15;

  let settings = { ...DEFAULTS };
  const results = new Map(); // asin -> api result (null = unknown so far)
  const reported = new Set(); // asins already sent to /api/queue
  let retries = 0;
  let scanTimer = null;
  let retryTimer = null;

  const send = (msg) => new Promise((resolve) => {
    try { chrome.runtime.sendMessage(msg, (r) => resolve(chrome.runtime.lastError ? { ok: false } : r)); }
    catch { resolve({ ok: false }); } // extension reloaded while the tab stayed open
  });

  /** All product pictures on the page → [{ asin, host }]. */
  function findTargets() {
    const out = [];
    document.querySelectorAll('[data-component-type="s-search-result"][data-asin]').forEach((tile) => {
      const asin = tile.getAttribute('data-asin');
      if (!/^[A-Z0-9]{10}$/.test(asin)) return;
      const host = tile.querySelector('.s-product-image-container') || tile.querySelector('img.s-image')?.parentElement;
      if (host) out.push({ asin, host });
    });
    const m = location.pathname.match(/\/(?:dp|gp\/product)\/([A-Z0-9]{10})/);
    if (m) {
      const host = document.querySelector('#imgTagWrapperId') || document.querySelector('#main-image-container');
      if (host) out.push({ asin: m[1], host });
    }
    return out;
  }

  function tooltip(asin, r) {
    const tip = document.createElement('of-tip');
    const line = (label, text, sub) => {
      const row = document.createElement('of-row');
      const b = document.createElement('of-b'); b.textContent = label; row.append(b, ' ', text);
      if (sub) { const s = document.createElement('of-sub'); s.textContent = sub; row.append(s); }
      tip.append(row);
    };
    if (!r) {
      line('Not in database yet.', '', 'Queued for the collector – check back later.');
    } else {
      const b = r.brand, s = r.seller;
      line('Brand:', `${b.name ?? '?'} → ${OriginFlags.LABELS[b.code]}${b.country ? ` (${b.country})` : ''}`,
        [b.owner && `Owner: ${b.owner}`, b.source && `Source: ${b.source}`].filter(Boolean).join(' · '));
      line('Seller:', `${s.name ?? '?'} → ${OriginFlags.LABELS[s.code]}${s.country ? ` (${s.country})` : ''}`,
        s.source ? `Source: ${s.source}` : '');
    }
    const foot = document.createElement('of-sub'); foot.className = 'of-foot'; foot.textContent = `Origin Flags · ${asin}`;
    tip.append(foot);
    return tip;
  }

  function render({ asin, host }) {
    const r = results.get(asin);
    const brand = r?.brand.code ?? 'UNKNOWN';
    const seller = r?.seller.code ?? 'UNKNOWN';
    const stamp = `${asin}|${brand}|${seller}|${settings.size}`;
    let box = host.querySelector(':scope > of-badges');
    if (box?.dataset.stamp === stamp) return;
    box?.remove();
    if (getComputedStyle(host).position === 'static') host.classList.add('of-host');
    // Custom element names, so amazon.de's own `div` / `span` rules never style the overlay.
    box = document.createElement('of-badges');
    box.className = `of-badges of-${settings.size}`;
    box.dataset.stamp = stamp;
    box.dataset.brand = brand;
    box.dataset.seller = seller;
    const px = SIZES[settings.size] ?? SIZES.M;
    for (const [side, code] of [['left', brand], ['right', seller]]) {
      const span = document.createElement('of-badge');
      span.className = `of-badge of-${side}`;
      span.innerHTML = OriginFlags.svg(code, px); // static SVG built from our own constants
      box.append(span);
    }
    box.append(tooltip(asin, r));
    host.append(box);
  }

  function removeAll() {
    document.querySelectorAll('of-badges').forEach((n) => n.remove());
  }

  async function scan() {
    if (!settings.enabled) return removeAll();
    const targets = findTargets();
    const missing = [...new Set(targets.map((t) => t.asin))].filter((a) => !results.has(a));
    if (missing.length) {
      const res = await send({ type: 'lookup', asins: missing });
      if (res?.ok) for (const a of missing) results.set(a, res.data[a] ?? null);
      const unknown = missing.filter((a) => res?.ok && !res.data[a] && !reported.has(a));
      if (unknown.length) {
        unknown.forEach((a) => reported.add(a));
        send({ type: 'queue', asins: unknown, search: new URLSearchParams(location.search).get('k') || undefined });
      }
    }
    targets.forEach(render);
    scheduleRetry();
  }

  // Unknown / half-known products: ask the server again from time to time while the page is open.
  function scheduleRetry() {
    if (retryTimer || retries >= MAX_RETRIES) return;
    const open = [...results].filter(([, r]) => !r || r.brand.code === 'UNKNOWN' || r.seller.code === 'UNKNOWN');
    if (!open.length) return;
    retryTimer = setTimeout(() => {
      retryTimer = null; retries++;
      open.forEach(([a]) => results.delete(a));
      scan();
    }, RETRY_MS);
  }

  const queueScan = () => { clearTimeout(scanTimer); scanTimer = setTimeout(scan, 250); };

  chrome.storage.sync.get(DEFAULTS, (s) => {
    settings = { ...DEFAULTS, ...s };
    scan();
    // Infinite scroll / SPA-style updates: re-scan when the DOM changes (debounced).
    new MutationObserver((muts) => {
      if (muts.some((m) => [...m.addedNodes].some((n) => n.nodeType === 1 && !n.closest?.('of-badges')))) queueScan();
    }).observe(document.body, { childList: true, subtree: true });
  });
  chrome.storage.onChanged.addListener((changes) => {
    for (const [k, { newValue }] of Object.entries(changes)) settings[k] = newValue;
    if (changes.apiBase) results.clear();
    removeAll();
    scan();
  });
})();
