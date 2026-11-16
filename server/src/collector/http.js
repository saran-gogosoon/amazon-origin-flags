// Polite, block-aware HTTP client for the collector.
//
// Per host it keeps: a rate limit (random delay between requests), an exponential backoff
// with jitter after blocks, a circuit breaker that pauses the host after repeated blocks,
// and a "session" (user agent + matching headers + cookie jar + optional proxy) that is
// rotated whenever we get blocked. If plain HTTP keeps failing, an optional headless
// browser (Playwright) is tried. Every decision is written to collector_log.
import http from 'node:http';
import https from 'node:https';
import zlib from 'node:zlib';
import { fetch, ProxyAgent } from 'undici';
import { log } from '../db.js';

const env = (k, d) => process.env[k] ?? d;
const range = (s) => s.split('-').map(Number);

const HOST_RULES = {
  'www.amazon.de': { delay: range(env('AMAZON_DELAY_MS', '8000-15000')) },
  default: { delay: range(env('DEFAULT_DELAY_MS', '3000-6000')) },
};
const BLOCKS_BEFORE_PAUSE = Number(env('BLOCKS_BEFORE_PAUSE', 3));
const PAUSE_MINUTES = Number(env('CIRCUIT_PAUSE_MINUTES', 30));
const BACKOFF_BASE_MS = Number(env('BACKOFF_BASE_MS', 30_000));
const BACKOFF_MAX_MS = 20 * 60_000;
const BROWSER_FALLBACK = env('BROWSER_FALLBACK', '1') !== '0';
const PROXIES = env('PROXY_URLS', '').split(',').map((s) => s.trim()).filter(Boolean);

const PROFILES = [
  { ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36',
    extra: { 'sec-ch-ua': '"Google Chrome";v="141", "Not?A_Brand";v="8", "Chromium";v="141"', 'sec-ch-ua-mobile': '?0', 'sec-ch-ua-platform': '"Windows"' } },
  { ua: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36',
    extra: { 'sec-ch-ua': '"Google Chrome";v="141", "Not?A_Brand";v="8", "Chromium";v="141"', 'sec-ch-ua-mobile': '?0', 'sec-ch-ua-platform': '"macOS"' } },
  { ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:144.0) Gecko/20100101 Firefox/144.0', extra: {} },
  { ua: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Safari/605.1.15', extra: {} },
  { ua: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
    extra: { 'sec-ch-ua': '"Google Chrome";v="140", "Not?A_Brand";v="8", "Chromium";v="140"', 'sec-ch-ua-mobile': '?0', 'sec-ch-ua-platform': '"Linux"' } },
];

const CAPTCHA_PATTERNS = [/\/errors\/validateCaptcha/i, /Geben Sie die unten angezeigten Zeichen ein/i,
  /Enter the characters you see below/i, /captcha/i];
const ROBOT_PATTERNS = [/automatisierten Zugriff auf Amazon-Daten/i, /To discuss automated access to Amazon data/i,
  /Request Rejected/i, /api-services-support@amazon\.com/i];

export class BlockedError extends Error {
  constructor(reason, retryAt) { super(`blocked: ${reason}`); this.reason = reason; this.retryAt = retryAt; }
}
export class HostPausedError extends Error {
  constructor(host, until) { super(`host ${host} paused until ${new Date(until).toISOString()}`); this.retryAt = until; }
}

const hosts = new Map();
let proxyCursor = 0;
const rand = (a, b) => a + Math.random() * (b - a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function newSession(host) {
  const profile = PROFILES[Math.floor(Math.random() * PROFILES.length)];
  const proxy = PROXIES.length ? PROXIES[proxyCursor++ % PROXIES.length] : null;
  return { profile, proxy, dispatcher: proxy ? new ProxyAgent(proxy) : undefined, cookies: new Map(), host };
}

function state(host) {
  if (!hosts.has(host)) {
    hosts.set(host, { nextAt: 0, blocks: 0, pausedUntil: 0, session: newSession(host), requests: 0 });
  }
  return hosts.get(host);
}

export function hostStates() {
  return [...hosts.entries()].map(([host, s]) => ({
    host, requests: s.requests, consecutiveBlocks: s.blocks, pausedUntil: s.pausedUntil || null,
    ua: s.session.profile.ua, proxy: s.session.proxy ? s.session.proxy.replace(/\/\/.*@/, '//***@') : null,
  }));
}

function rotate(host, st, why) {
  st.session = newSession(host);
  log('info', 'session_rotated', { host, why, ua: st.session.profile.ua.slice(0, 60), proxy: !!st.session.proxy });
}

/** Wait for this host's rate-limit slot. Throws HostPausedError while the circuit is open. */
async function takeSlot(host) {
  const st = state(host);
  if (st.pausedUntil > Date.now()) throw new HostPausedError(host, st.pausedUntil);
  const [min, max] = (HOST_RULES[host] ?? HOST_RULES.default).delay;
  const wait = st.nextAt - Date.now();
  if (wait > 0) await sleep(wait);
  st.nextAt = Date.now() + rand(min, max);
  st.requests++;
  return st;
}

/** Decide whether a response is a block page. Returns a reason string or null. */
export function detectBlock(status, finalUrl, body, expect) {
  if (status === 503) return 'http_503';
  if (status === 429) return 'http_429';
  if (status === 403) return 'http_403';
  if (CAPTCHA_PATTERNS.slice(0, 3).some((re) => re.test(finalUrl) || re.test(body))) return 'captcha';
  if (status >= 200 && status < 300 && expect && !expect.test(body)) {
    if (CAPTCHA_PATTERNS[3].test(body) && body.length < 20_000) return 'captcha';
    if (ROBOT_PATTERNS.some((re) => re.test(body))) return 'robot_page';
    return body.length < 5_000 ? 'empty_page' : 'unexpected_page';
  }
  return null;
}

function onBlocked(host, st, reason, url) {
  st.blocks++;
  const backoff = Math.min(BACKOFF_BASE_MS * 2 ** (st.blocks - 1), BACKOFF_MAX_MS) * rand(0.7, 1.3);
  st.nextAt = Date.now() + backoff;
  log('warn', 'blocked', { host, reason, url, consecutive: st.blocks, backoff_s: Math.round(backoff / 1000) });
  rotate(host, st, reason);
  if (st.blocks >= BLOCKS_BEFORE_PAUSE) {
    st.pausedUntil = Date.now() + PAUSE_MINUTES * 60_000 * rand(0.9, 1.2);
    st.nextAt = st.pausedUntil;
    log('error', 'circuit_open', { host, paused_until: new Date(st.pausedUntil).toISOString(), after_blocks: st.blocks });
  }
  return st.nextAt;
}

function onSuccess(host, st, via) {
  if (st.blocks > 0) log('info', 'recovered', { host, via, after_blocks: st.blocks });
  st.blocks = 0;
  st.pausedUntil = 0;
}

/**
 * Fetch a page. `expect` is a regex a real (non-block) page must match.
 * Returns { status, url, body, via }. Throws BlockedError / HostPausedError.
 */
export async function getPage(url, { method = 'GET', body, headers = {}, expect, allowBrowser = true } = {}) {
  const host = new URL(url).host;
  const st = await takeSlot(host);
  const s = st.session;
  const reqHeaders = {
    'user-agent': s.profile.ua,
    accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
    'accept-language': 'de-DE,de;q=0.9,en-US;q=0.6,en;q=0.5',
    'upgrade-insecure-requests': '1',
    ...s.profile.extra,
    ...headers,
  };

  let res, reason;
  try {
    res = await send(url, { method, body, headers: reqHeaders, session: s });
    reason = detectBlock(res.status, res.url, res.body, expect);
  } catch (err) {
    reason = `network:${err.cause?.code ?? err.code ?? err.name}`;
  }

  if (!reason) {
    onSuccess(host, st, 'http');
    return { ...res, via: s.proxy ? 'http+proxy' : 'http' };
  }

  const retryAt = onBlocked(host, st, reason, url);
  if (BROWSER_FALLBACK && allowBrowser && method === 'GET' && st.blocks >= 2) {
    const viaBrowser = await browserFetch(url, expect);
    if (viaBrowser) { onSuccess(host, st, 'browser'); return viaBrowser; }
  }
  throw new BlockedError(reason, retryAt);
}

// ---- transport ---------------------------------------------------------------------------------
// Direct requests use node:https (some WAFs, e.g. tmdn.org, reject undici's fingerprint);
// proxied requests go through undici's ProxyAgent. Both keep the session cookie jar up to date.
function storeCookies(session, setCookies) {
  for (const c of setCookies ?? []) {
    const [pair] = c.split(';');
    const i = pair.indexOf('=');
    if (i > 0) session.cookies.set(pair.slice(0, i).trim(), pair.slice(i + 1).trim());
  }
}
// Browsers send Capitalised-Header-Names over HTTP/1.1; some WAFs reject lowercase ones as bots.
const browserCase = (h) => Object.fromEntries(Object.entries(h).filter(([, v]) => v !== undefined)
  .map(([k, v]) => [k.replace(/(^|-)([a-z])/g, (_, a, b) => a + b.toUpperCase()), v]));
const cookieHeader = (session) => [...session.cookies].map(([k, v]) => `${k}=${v}`).join('; ');

async function send(url, { method, body, headers, session }, hops = 0) {
  const h = { ...headers, ...(session.cookies.size ? { cookie: cookieHeader(session) } : {}) };
  if (session.dispatcher) {
    const res = await fetch(url, { method, body, headers: h, dispatcher: session.dispatcher, redirect: 'follow',
      signal: AbortSignal.timeout(30_000) });
    storeCookies(session, res.headers.getSetCookie());
    return { status: res.status, url: res.url, body: await res.text() };
  }
  const res = await new Promise((resolve, reject) => {
    const req = (url.startsWith('https:') ? https : http).request(url, { method, headers: browserCase({ ...h, 'accept-encoding': 'gzip, deflate, br',
      ...(body ? { 'content-length': Buffer.byteLength(body) } : {}) }), timeout: 30_000 }, resolve);
    req.on('timeout', () => req.destroy(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' })));
    req.on('error', reject);
    req.end(body);
  });
  storeCookies(session, res.headers['set-cookie']);
  if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && hops < 5) {
    res.resume();
    return send(new URL(res.headers.location, url).href, { method: 'GET', headers, session }, hops + 1);
  }
  const enc = res.headers['content-encoding'];
  const stream = enc === 'gzip' ? res.pipe(zlib.createGunzip()) : enc === 'br' ? res.pipe(zlib.createBrotliDecompress())
    : enc === 'deflate' ? res.pipe(zlib.createInflate()) : res;
  const chunks = [];
  for await (const c of stream) chunks.push(c);
  return { status: res.statusCode, url, body: Buffer.concat(chunks).toString('utf8') };
}

// ---- optional headless-browser fallback --------------------------------------------------
let browserPromise;
async function browserFetch(url, expect) {
  try {
    browserPromise ??= import('playwright').then(({ chromium }) => chromium.launch({ headless: true }));
    const browser = await browserPromise;
    const ctx = await browser.newContext({ locale: 'de-DE', userAgent: PROFILES[1].ua });
    const page = await ctx.newPage();
    log('info', 'browser_fallback', { url });
    const resp = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45_000 });
    await page.waitForTimeout(2_000);
    const body = await page.content();
    const status = resp?.status() ?? 0;
    const finalUrl = page.url();
    await ctx.close();
    const reason = detectBlock(status, finalUrl, body, expect);
    if (reason) { log('warn', 'browser_fallback_blocked', { url, reason }); return null; }
    return { status, url, body, via: 'browser' };
  } catch (err) {
    log('warn', 'browser_fallback_unavailable', { error: String(err.message).slice(0, 160) });
    browserPromise = undefined;
    return null;
  }
}

export async function closeBrowser() {
  if (browserPromise) (await browserPromise.catch(() => null))?.close();
}
