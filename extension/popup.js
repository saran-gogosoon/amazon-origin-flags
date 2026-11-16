const DEFAULTS = { enabled: true, size: 'M', apiBase: 'https://code-demos.gogosoon.com/origin-flags' };
const $ = (id) => document.getElementById(id);

$('logo').innerHTML = OriginFlags.svg('DE', 22) + OriginFlags.svg('CN', 22);
$('legend').innerHTML = OriginFlags.CODES.map((c) => `<li>${OriginFlags.svg(c, 18)}<span>${OriginFlags.LABELS[c]}</span></li>`).join('');

function showSize(v) { document.querySelectorAll('#size button').forEach((b) => b.classList.toggle('on', b.dataset.v === v)); }

async function loadStats(base) {
  const el = $('stats');
  el.className = 'stats';
  el.textContent = 'Loading DB stats…';
  try {
    const s = await (await fetch(`${base.replace(/\/+$/, '')}/api/stats`)).json();
    el.innerHTML = `DB: <b>${s.products}</b> products · <b>${s.brands}</b> brands · <b>${s.sellers}</b> sellers · queue ${s.queue.pending ?? 0}` +
      ` · <a href="${base.replace(/\/+$/, '')}/" target="_blank">collector status</a>`;
  } catch {
    el.className = 'stats err';
    el.textContent = 'Server not reachable at this URL.';
  }
}

chrome.storage.sync.get(DEFAULTS, (s) => {
  $('enabled').checked = s.enabled;
  showSize(s.size);
  $('apiBase').value = s.apiBase;
  loadStats(s.apiBase);
});

$('enabled').addEventListener('change', (e) => chrome.storage.sync.set({ enabled: e.target.checked }));
$('size').addEventListener('click', (e) => {
  const v = e.target.dataset?.v;
  if (v) { showSize(v); chrome.storage.sync.set({ size: v }); }
});
$('save').addEventListener('click', async () => {
  const apiBase = $('apiBase').value.trim().replace(/\/+$/, '') || DEFAULTS.apiBase;
  // Custom servers need a host permission; ask for it (must happen inside the click handler).
  try { await chrome.permissions.request({ origins: [`${new URL(apiBase).origin}/*`] }); } catch { /* invalid URL → stats shows the error */ }
  await chrome.storage.sync.set({ apiBase });
  loadStats(apiBase);
});
