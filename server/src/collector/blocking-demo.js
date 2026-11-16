// Shows the blocking defences without hammering a real site: runs the real collector HTTP client
// against a local mock that answers like a blocking amazon.de (captcha, 503, robot page) and then recovers.
// Events land in collector_log (host "127.0.0.1:<port>") and show up on the status page.
//   npm run blocking-demo
process.env.DEFAULT_DELAY_MS ??= '500-1000';
process.env.BACKOFF_BASE_MS ??= '2000';
process.env.CIRCUIT_PAUSE_MINUTES ??= '0.1';
process.env.BROWSER_FALLBACK = '0';

const { createServer } = await import('node:http');
const { log } = await import('../db.js');
const { getPage, BlockedError, HostPausedError } = await import('./http.js');

// Scripted answers, one per request.
const script = [
  (res) => { res.writeHead(302, { location: '/errors/validateCaptcha?amzn=demo' }); res.end(); },
  (res) => { res.writeHead(503); res.end('Service Unavailable'); },
  (res) => res.end('<html><body>Um über den automatisierten Zugriff auf Amazon-Daten zu sprechen …</body></html>'),
  (res) => res.end('<html><span id="productTitle">Gartenschere</span></html>'),
];
let n = 0;
const server = createServer((req, res) => {
  if (req.url.startsWith('/errors/validateCaptcha')) return res.end('<form action="/errors/validateCaptcha">Geben Sie die unten angezeigten Zeichen ein</form>');
  script[Math.min(n++, script.length - 1)](res);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const url = `http://127.0.0.1:${server.address().port}/dp/B000DEMO00`;
log('info', 'blocking_demo_start', { note: 'SIMULATED blocking against a local mock server', url });

for (let i = 0; i < 8; i++) {
  try {
    const r = await getPage(url, { expect: /productTitle/ });
    log('info', 'blocking_demo_page_ok', { via: r.via, attempt: i + 1 });
    break;
  } catch (err) {
    if (!(err instanceof BlockedError || err instanceof HostPausedError)) throw err;
    const wait = Math.max(0, err.retryAt - Date.now());
    console.log(`  → ${err.message}; waiting ${Math.round(wait / 1000)} s as the collector would`);
    await new Promise((r) => setTimeout(r, wait + 50));
  }
}
log('info', 'blocking_demo_end', { requests: n });
server.close();
