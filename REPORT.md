# Origin Flags: build report

Date: 2026-11-16. All numbers come from the local SQLite DB (`data/origin-flags.db`) and from the output of the
screenshot script (`logs/screenshot-run.log`, not committed).

## What works (verified end to end)

1. **Collector on real amazon.de.** The "Gartenschere" search (2 result pages, 99 unique ASINs) → product pages → GPSR
   manufacturer block → seller profile pages → EU trade mark register. All requests were plain HTTP at about 1 request / 8–15 s on amazon.de.
2. **Server.** Express + `node:sqlite`. It serves `/api/lookup`, `/api/queue`, `/api/stats`, `/api/collector/log`, `/api/health` and the status page.
3. **Extension in a real browser.** Playwright's bundled Chromium (headed) loaded the unpacked extension. It set the delivery address
   to 20095 Hamburg (EUR prices), searched amazon.de for "Gartenschere" and every result tile got its two badges from the local server.
4. **Unknown ASINs flow back.** The extension posts unseen ASINs to `/api/queue`, and the collector picks them up.
5. **Blocking defences.** These were triggered for real (tmdn.org, below) and on demand with `npm run blocking-demo`
   (captcha → 503 → robot page → circuit open → recovered).
6. `npm test`: 4/4 pass (block detection, GPSR parser, seller address parser, country → flag mapping).

## Database after the run

The collector ran 09:52–10:07 and 10:08–10:33 UTC, about 40 minutes in total. The second run was stopped after 25 min as instructed.

| | Count |
|---|---|
| Products with brand/seller data | **85** of 99 ASINs seen (23 product jobs still queued) |
| … with a GPSR manufacturer address | 80 |
| Brands | **40**, all 40 with an owner country |
| Sellers (third-party) | **35**, 33 with a country from the seller profile "Geschäftsadresse" |
| Queue | 160 done · 25 pending · **0 failed** |

Flag codes over the 85 products:

| Badge | AMAZON | DE | EU | CN | US | OTHER | UNKNOWN |
|---|---|---|---|---|---|---|---|
| Brand owner (left) | – | 24 | 31 | 22 | 1 | 6 | 1 |
| Seller (right) | 36 | 10 | 5 | 28 | 2 | 2 | 2 |

How the brand owner country was decided (GPSR first, EU trade mark as the second source):

| Evidence | Brands |
|---|---|
| GPSR manufacturer, **confirmed** by the EU trade mark owner's country | 18 |
| GPSR manufacturer only (TMview unavailable: blocked/paused, or no EU mark) | 12 |
| GPSR manufacturer, **EU trade mark owner differs** (kept GPSR, difference stored in `source` and shown in the tooltip) | 10 |

## Coverage on the "Gartenschere" search, page 1

From `scripts/screenshot.mjs`, delivery address 20095 Hamburg, 60 result tiles including sponsored ones:

| | Tiles | Share |
|---|---|---|
| Tiles with badges | 60 / 60 | 100 % |
| **Brand flag known** (left) | 59 / 60 | **98 %** |
| **Seller flag known** (right) | 58 / 60 | **97 %** |
| Both known | 58 / 60 | 97 % |

Page-1 brand codes: EU 23 · CN 19 · DE 14 · OTHER 2 · US 1 · UNKNOWN 1.
Seller codes: CN 25 · AMAZON 21 · DE 8 · EU 2 · US 2 · UNKNOWN 2.

## Blocking events seen

**amazon.de: no blocks.** About 210 requests (2 search pages, 85 product pages + 85 GPSR calls, 35 seller profiles) at 8–15 s
spacing. There were no captchas, no 503s and no robot pages.

**tmdn.org (TMview): a real IP block.** After about 40 trade mark searches, tmdn.org started redirecting every request from this IP,
plain `curl` included, to `/error/revise.html`:

| UTC | Event |
|---|---|
| 10:23:12 | `blocked` (1st), backoff 27 s, session rotated (new UA, headers, cookie jar) |
| 10:23:53 | `blocked` (2nd), backoff 42 s, session rotated |
| 10:24:55 | `blocked` (3rd), backoff 95 s → **`circuit_open`: tmdn.org paused until 10:56:58** |
| 10:24–10:33 | 10× `trademark_lookup_failed` (host paused). Each brand still got its **GPSR** value; nothing failed, amazon.de work continued |

How it was handled: backoff with jitter → session rotation → circuit breaker. The only work affected was the optional
second source, and the other host kept going. The one brand with no GPSR block stays `pending` and is retried after the pause, without
losing an attempt. **Recovery for tmdn.org itself was not observed**, because the collector was stopped at 10:33, before the pause ended.
The recovery path (`recovered` event after the circuit closes) was shown with the simulated `npm run blocking-demo`. Those events are
marked with host `127.0.0.1:<port>` and are excluded from the "Blocks (24h)" figure.

The block was first logged as `unexpected_page`. Detection now has an explicit `ip_block` rule for WAF redirects
like `/error/revise.html`, with a test.

## Known gaps

* **GPSR address ≠ brand owner's home country.** In 10 of 40 brands the EU trade mark owner differs from the GPSR "manufacturer". Examples:
  AebDerp and SOLODOTO list Spanish EU agents ("SUCCESS COURIER SL", "VAT SPEED SL") while the trade marks belong to Shenzhen companies.
  FELCO (Swiss) lists its German distributor's address, so the flag shows DE. WOLF Garten and BLACK+DECKER list EU subsidiaries of US groups.
  Per the brief, GPSR stays the primary source. Suggested next rule: when the GPSR "manufacturer" is a known EU-representative service, or
  a unique live EU trade mark points elsewhere, prefer the trade mark owner. A curated override table would help too.
* Namesake trade marks: an exact-name EU mark can belong to an unrelated company (e.g. "FELCO" → a Malaysian medical supplier).
  That is why the trade mark is only a cross-check, and the best-matching applicant is chosen.
* 2 sellers ("Onlinehandel Hinz", "present4friends") have a profile page without a parseable business address → right badge UNKNOWN.
* 23 Gartenschere product jobs (mostly page 2) and 1 brand job are still queued. The collector resumes them on the next start.
* TMview is now blocking this machine's IP. A proxy (`PROXY_URLS`) or the server's own IP is needed for further trade mark lookups.
* Some amazon.de tiles still say "Wird versendet nach Indien" even with the Hamburg address set, because the machine has an Indian IP. Prices are EUR.
* The Docker image and `compose.yml` were written but **not built or run here** (no Docker on this machine). Not deployed, as instructed.
* The headless-browser fallback is implemented, but it was never triggered in the real run (amazon.de did not block).

## How to reproduce

```bash
cd server && npm install && PORT=5180 npm start               # API + status page
npm run collect -- --search Gartenschere --pages 2            # or: npm run collector (loop)
cd .. && npm install && API_BASE=http://localhost:5180 node scripts/screenshot.mjs
```
