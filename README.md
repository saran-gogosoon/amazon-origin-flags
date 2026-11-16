# Origin Flags for amazon.de

A Chrome extension shows **where the brand owner and the seller of every amazon.de product come from**.
It puts two small round flags on each product picture. The answers come from **our own server**. A **collector** keeps
filling the server's database from amazon.de and the EU trade mark register. It notices when it is being blocked and works around it.

![Search results for "Gartenschere" with origin flags](docs/screenshot-search.png)

| Close-up with tooltip | Popup |
|---|---|
| ![close-up](docs/screenshot-closeup.png) | ![popup](docs/screenshot-popup.png) |

**Left badge = brand owner, right badge = seller.**

| Flag | Meaning |
|---|---|
| Amazon logo | Amazon itself (Amazon's own brand / sold by Amazon) |
| 🇩🇪 | Germany |
| 🇪🇺 | Another EU country |
| 🇨🇳 | China (incl. Hong Kong) |
| 🇺🇸 | USA |
| Globe | Any other country |
| Empty dashed circle | Not known yet. The ASIN is already queued for the collector |

Hover a badge to see the brand, the owner company, the seller, and **the source of each fact**.

---

## Architecture

```mermaid
flowchart LR
  subgraph Browser
    CS[content script<br/>amazon.de pages] -->|message| BG[service worker]
    P[popup<br/>on/off · size · legend · server URL]
  end
  BG -->|GET /api/lookup?asins=…| API
  BG -->|POST /api/queue  unknown ASINs| API
  P -->|GET /api/stats| API
  subgraph Server [server: Node 24 + Express + SQLite]
    API[REST API + status page] --- DB[(SQLite<br/>products · brands · sellers<br/>queue · collector_log)]
    W[collector worker] --- DB
  end
  W -->|search, product page,<br/>GPSR block, seller profile| AMZ[amazon.de]
  W -->|trade mark owner| TM[TMview + EUIPO]
```

* `extension/`: Chrome MV3 extension. The content script finds search tiles (`[data-component-type="s-search-result"][data-asin]`)
  and the main picture on product pages (`/dp/ASIN`). It asks the server in batches and draws inline SVG flags. A `MutationObserver` handles infinite scroll and page
  updates. Unknown ASINs go to `POST /api/queue`, so **the database grows from real usage**. Unknown flags are re-checked every
  minute while the tab is open.
* `server/`: Express API, a status page and the collector, which can run in the same process (`COLLECTOR=1`) or on its own.
* `scripts/screenshot.mjs`: an end-to-end check. It loads the unpacked extension into Playwright Chromium (headed), opens
  `amazon.de/s?k=Gartenschere`, counts the badges and takes the screenshots in `docs/`.

### API

| Endpoint | Purpose |
|---|---|
| `GET /api/lookup?asins=A,B,C` | `{ results: { ASIN: { brand:{name,owner,country,code,source}, seller:{name,country,code,source} } }, unknown:[…] }` |
| `POST /api/queue` `{asins:[…], search?}` | Report unknown ASINs (and the search term) to the collector |
| `GET /api/stats` | DB counts, queue state, flag code distribution, blocks in the last 24 h |
| `GET /api/collector/log` | Recent collector events |
| `GET /api/queue` | Active and recent queue items |
| `GET /api/health` | Liveness |
| `GET /` | Status page: DB counts, queue, live collector log |

All URLs on the status page are relative, so it works behind Caddy at `/origin-flags/` (`handle_path` strips the prefix).

## The collector

![Collector status page](docs/screenshot-collector.png)

### Data sources and fallback order

| Fact | Source (in order) | Recorded as |
|---|---|---|
| ASINs for a search | amazon.de search page `/s?k=…` (all result pages requested) | `products.source` |
| Brand, seller name + seller id | amazon.de product page: product overview / `Marke`, `#bylineInfo`; `#sellerProfileTriggerId` or the "Versender / Verkäufer" box | `products.source` |
| Manufacturer name + address | **EU GPSR "Herstellerinformationen" block** on the product page. It is lazy-loaded, so the collector calls the same `getRspManufacturerContent` endpoint the page uses, with the page's own `x-amz-acp-params` token | `products.manufacturer*` |
| Seller country | amazon.de seller profile `/sp?seller=ID`, "Geschäftsadresse" (last line = country) | `sellers.source` |
| Brand owner country | 1. Amazon private label → AMAZON<br>2. **EU trade mark owner** if exactly one company holds live EU marks for that exact name (TMview search API → EUIPO eSearch record → applicant nationality)<br>3. **GPSR manufacturer** address country<br>4. EU trade mark owner when several companies share the name (best match to the manufacturer) | `brands.source` + `brands.evidence_url` |

Why the trade mark owner comes first: Chinese brands often list an EU agent (e.g. "VAT SPEED SL", Spain) as the GPSR "manufacturer".
The EU trade mark shows the real legal owner. The two sources usually agree, and when they do the source says so.

Trade mark register, as tested in November 2026 (no API key needed):
* TMview `POST https://www.tmdn.org/tmview/api/search/results` works. It needs a browser-like request: header names in browser case and a `Referer`.
  Its detail endpoint is behind a WAF (403), and headless browsers get "Request Rejected".
* EUIPO eSearch `GET https://euipo.europa.eu/copla/trademark/data/{number}` returns applicant name, address and nationality as JSON.
* So the lookup is: TMview finds the EU marks with the exact brand name, then EUIPO gives each owner's country.

### Blocking: detection and response

| Detects | How |
|---|---|
| Captcha | Redirect to `/errors/validateCaptcha`, or the text "Geben Sie die unten angezeigten Zeichen ein" / "Enter the characters you see below" |
| Throttling / IP block | HTTP 503, 429, 403 |
| Robot or empty pages | Amazon's "automated access" page, WAF "Request Rejected", tiny or unexpected pages (every request states which marker a real page must have) |
| Network trouble | Timeouts, resets |

| Response | Details |
|---|---|
| Per-host rate limit | amazon.de: random 8–15 s between requests (`AMAZON_DELAY_MS`); other hosts 3–6 s |
| Exponential backoff + jitter | 30 s → 1 min → 2 min … up to 20 min, ±30 % jitter, per host |
| Session rotation | On each block: new realistic user agent with matching `sec-ch-ua` headers, fresh cookie jar, next proxy |
| Proxy pool | `PROXY_URLS=http://user:pass@host:port,…`, rotated on each new session |
| Circuit breaker | After 3 blocks in a row the host is paused for ~30 min (`CIRCUIT_PAUSE_MINUTES`). Jobs for that host wait without using up retries; other hosts keep working |
| Headless browser fallback | From the 2nd block in a row, GET pages are retried in Playwright Chromium when it is installed (`BROWSER_FALLBACK=1`, the local default) |
| Resume-safe queue | Every job is a SQLite row (`pending/running/done/failed`, `attempts`, `next_try_at`, `last_error`). A crash or restart re-arms `running` jobs; nothing is lost |

Every event (`blocked`, `session_rotated`, `circuit_open`, `recovered`, `browser_fallback`, `job_retry`, …) goes to
`collector_log` and appears live on the status page.

`npm run blocking-demo` shows the whole chain on demand without hammering a real site. It points the real HTTP client at a local
mock server that answers with a captcha redirect, a 503 and an Amazon robot page, then a normal page. The log shows
detection → backoff → session rotation → circuit open → recovered. These events are marked with host `127.0.0.1:<port>` and
are not counted in the "blocks (24h)" figure.

## Run it

Requires Node 24.

```bash
cd server
npm install
PORT=5180 npm start                                   # API + status page on http://localhost:5180/
npm run collect -- --search Gartenschere --pages 2    # seed from a search, then work the queue until empty
npm run collector                                     # long-running worker (or start the API with COLLECTOR=1)
npm test                                              # parser / block-detection tests
```

Docker (the API container listens on 8080, SQLite in `./data`, joins the external `edge` network):

```bash
cd server && docker compose up -d --build
```

Caddy: `handle_path /origin-flags/* { reverse_proxy api:8080 }`.

### Install the extension

1. Open `chrome://extensions`, switch on **Developer mode**.
2. Click **Load unpacked** and select the `extension/` folder.
3. Search amazon.de for **Gartenschere**. The flags appear on the product pictures.
4. Toolbar icon → popup: on/off, badge size S/M/L, legend, server URL (default `https://code-demos.gogosoon.com/origin-flags`)
   and DB stats.

### Screenshots / end-to-end check

```bash
npm install && npx playwright install chromium   # repo root
API_BASE=http://localhost:5180 node scripts/screenshot.mjs
```

The script prints how many tiles show badges and how many have known flags. It exits non-zero if no badges appear.

## Done vs. next steps

**Done**
* Extension (search tiles + product page, infinite scroll, tooltips, popup with all settings) talking only to our server
* Server API, SQLite schema, status page, Docker + compose
* Collector with four sources (search, product + GPSR, seller profile, EU trade mark register), source recorded per fact
* Block detection + backoff + session/UA/cookie rotation + proxy pool + circuit breaker + browser fallback + resume-safe queue
* Seeded with real amazon.de data for "Gartenschere" (see `REPORT.md` for numbers)

**Next**
* Scheduled refresh of old facts (sellers change, brands get sold); a `refresh_after` per table
* Use the EUIPO "Verantwortliche Person" and the seller's "Handelsregisternummer" / VAT ID as extra evidence
* National registers (DPMA for DE-only marks, WIPO Madrid) for brands without an EU trade mark
* Manual override table + a small admin view for wrong flags reported by users
* Product pages: also flag "Other sellers" offers; amazon.at/.fr/.it once DE is solid

## How we built this with AI (Claude Code)

The prototype was built in one session with Claude Code, working as an autonomous agent in a terminal on a Mac:

1. **Research against the live sites first.** Before writing parsers, the agent fetched real amazon.de search, product and seller pages.
   It found that the GPSR manufacturer block is lazy-loaded, then watched the page's network traffic in Playwright and found the
   `getRspManufacturerContent` call and the `x-amz-acp-params` token it needs. It then reproduced that call over plain HTTP.
2. **Trade mark register.** It tried TMview and EUIPO endpoints one by one and found that TMview's WAF rejects lowercase HTTP header names. It then chose
   TMview search + EUIPO record as the no-key route.
3. **Data quality check.** In the first real results the agent noticed EU agents ("… SL", Spain) listed as manufacturers of Chinese
   brands. It changed the fallback order so a unique EU trade mark owner wins.
4. **Verified end to end:** real seed run → API → extension loaded in Chromium on the real amazon.de → screenshots, with badge counts
   printed by the script.

A human set the brief and the quality bar ("a working core is worth more than many half-finished extras"); the agent did the
research, code, tests and documentation.
