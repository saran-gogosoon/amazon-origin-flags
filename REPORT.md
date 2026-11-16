# Origin Flags: build report

Date: 2026-11-16, updated after the FELCO data-quality fix (see "Data-quality fix" below). All numbers come from the
local SQLite DB (`data/origin-flags.db`) and from the output of `scripts/screenshot.mjs`.

## What works (verified end to end)

1. **Collector on real amazon.de.** The "Gartenschere" search (2 result pages, 99 unique ASINs) → product pages → GPSR
   manufacturer block → seller profile pages → EU trade mark register. All requests were plain HTTP at about 1 request / 8–15 s on amazon.de.
2. **Server.** Express + `node:sqlite`. It serves `/api/lookup`, `/api/queue`, `/api/stats`, `/api/collector/log`, `/api/health` and the status page.
3. **Extension in a real browser.** Playwright's bundled Chromium (headed) loaded the unpacked extension. It set the delivery address
   to 20095 Hamburg (EUR prices), searched amazon.de for "Gartenschere" and every result tile got its two badges from the local server.
4. **Unknown ASINs flow back.** The extension posts unseen ASINs to `/api/queue`, and the collector picks them up.
5. **Blocking defences.** These were triggered for real (tmdn.org, below) and on demand with `npm run blocking-demo`
   (captcha → 503 → robot page → circuit open → recovered).
6. `npm test`: 9/9 pass (block detection, GPSR manufacturer vs EU responsible person, seller address parser, trade mark name
   matching, country → flag mapping).

## Data-quality fix: FELCO / EU responsible person / namesake trade marks

**Bug (manager QA):** FELCO showed brand owner "FELCO SA" with country DE, but FELCO SA is Swiss. The trade mark cross-check
had also picked "FELCO MEDICAL SUPLLIES SDN BHD" (Malaysia), an unrelated company.

**Cause:** for FELCO, amazon.de's "Herstellerinformationen" box itself shows *FELCO SA* with *Ludwigsburger Str. 71, Freiberg/Neckar,
DE*. That is the address of **FELCO Europe GmbH**, the EU responsible person listed in the same GPSR block. The old parser read
the manufacturer box correctly, but it had no way to tell that the address wasn't the manufacturer's own. The trade mark step accepted any
owner of an exact-name mark.

**Fix:**
1. **GPSR parser** (`parseGpsr`). The manufacturer and the EU responsible persons (one per seller) are parsed separately.
   The owner country comes **only from the manufacturer's own address**. If that address is identical (street + postcode) to the
   address of a responsible person that is a *different company*, the address is treated as the importer's and its country is not
   used. A company that is its own responsible person (e.g. Gebr. Schröder / Original LÖWE), or a named contact person at the
   manufacturer's address, keeps its country. The responsible person is stored (`products.responsible_*`, raw entries in
   `products.gpsr_json`), returned by `/api/lookup` and shown in the tooltip as "EU responsible person – not used for the flag".
2. **Trade mark matching.** EUIPO eSearch (`copla/ctmsearch/json`, applicant name + country + Nice classes in one call) is now the
   primary source, with TMview as the fallback. An owner is accepted **only if its name matches the GPSR manufacturer**: legal forms
   (GmbH, SA, Ltd, Co, Oy, AB, …) are ignored, and the rule needs equal or containing names or ≥ 2 shared tokens. Otherwise the result
   is recorded as `no matching EU mark (owners: …)`. Among matching marks, live marks in **Nice class 8** (hand tools) are preferred.
   A matching mark confirms the GPSR country, or supplies it when the GPSR address was an importer's. Without a match the brand is
   left UNKNOWN rather than guessed.
3. **Re-derived** all existing rows (`npm run rederive`). GPSR was re-fetched only where the answer could change: manufacturer
   addresses inside the EU, since only those can be an EU importer's address. That was 18 + 9 distinct addresses, about 54 polite amazon.de
   requests, with **no blocks**. Then every brand was re-resolved against EUIPO. Bellota (B00F2NHFOO), the second FELCO ASIN
   (B000NCWRRE) and one Bahco product (B003F67284) were crawled for the spot-check.
4. Tests: FELCO-like fixture (CH manufacturer + DE responsible person), the real-world variant (FELCO SA shown with FELCO Europe
   GmbH's address), a company that is its own responsible person, a contact person at the same address, and name-matching cases.

### Spot-check

| Brand | Result now | Badge | Evidence |
|---|---|---|---|
| **FELCO** (B0001IOYX0, B000NCWRRE) | owner FELCO SA, **country unknown** | UNKNOWN (was DE) | GPSR address = FELCO Europe GmbH (EU responsible person) → ignored. EU marks for "FELCO": Flisch Holding SA (CH, class 8), FOSHAN ELECTRICAL… (CN), FELCO MEDICAL… (MY). None matches "FELCO SA" → not used |
| **Gardena** | GARDENA Germany AB, **SE** | EU | GPSR manufacturer address. The other GPSR variant "GARDENA Deutschland GmbH" uses GARDENA GmbH's address (a different company) → ignored. EU mark owner Husqvarna AB (SE) does not match the name → not used, same country anyway |
| **Fiskars** | Fiskars Finland Oy Ab / Iittala Group, **FI** | EU | GPSR manufacturer address. EU mark owner "FISKARS OYJ ABP" (FI) shares only one token → not counted as a match |
| **WOLF Garten** | Stanley Black & Decker Outdoor GmbH, **DE** | DE | GPSR manufacturer address. EU mark owners WOLF-GERAETE AG (CH) and MTD Products Inc (US) do not match → not used |
| **Bahco** (B003F67284) | SNA Europe SAS, **ES** | EU | GPSR manufacturer address (Spain). EU mark owner Kapman AB (SE) does not match → not used |
| **Bellota** (B00F2NHFOO) | BELLOTA HERRAMIENTAS S.L.U., **ES** | EU | GPSR manufacturer address, **confirmed** by EU mark "BELLOTA" (class 8), owner BELLOTA HERRAMIENTAS, S.L. (ES) |

**FELCO is UNKNOWN, not OTHER.** With the rules exactly as specified, no accepted source says CH. The Swiss owner of the
class-8 "FELCO" marks is registered as **Flisch Holding SA**, a name that doesn't resemble "FELCO SA". To get FELCO → CH → OTHER
automatically, one of these extra rules would be needed (your call):
(a) when the GPSR address was an importer's, accept the owner of exact-name **class-8** marks if all live class-8 marks belong
to one applicant (here: Flisch Holding SA, CH); or (b) a small manual override table for known brand groups.
Showing the empty badge is the honest default until then.

## Database now

The collector ran 09:52–10:07 and 10:08–10:33 UTC (stopped after 25 min as instructed). Then came the re-derive (10:45–11:02) and the
3-product spot-check crawl.

| | Count |
|---|---|
| Products with brand/seller data | **88** of 100 ASINs seen (22 product jobs still queued) |
| … with a GPSR manufacturer | 83. For 11 of them the GPSR address is a different company's EU importer address (country not used) |
| … with a stored EU responsible person | 28 (only products re-fetched after the fix; older rows get it on their next refresh) |
| Brands | **43**, 41 with an owner country (unknown: FELCO, and Linkgood, which has no GPSR block) |
| Sellers (third-party) | **35**, 33 with a country from the seller profile "Geschäftsadresse" |
| Queue | 165 done · 23 pending · **0 failed** |

Flag codes over the 88 products:

| Badge | AMAZON | DE | EU | CN | US | OTHER | UNKNOWN |
|---|---|---|---|---|---|---|---|
| Brand owner (left) | – | 17 | 33 | 22 | 1 | 6 | 9 (FELCO 8, Linkgood 1) |
| Seller (right) | 39 | 10 | 5 | 28 | 2 | 2 | 2 |

How each brand's owner country was decided (43 brands):

| Evidence | Brands |
|---|---|
| GPSR manufacturer address, **confirmed** by a name-matching EU mark | 7 |
| GPSR manufacturer address; EU marks exist but **none matches the manufacturer** (recorded, not used) | 31 |
| GPSR manufacturer address; no EU mark with this name | 3 |
| Unknown: GPSR address is an importer's and no matching EU mark (FELCO) | 1 |
| Unknown: no GPSR block (Linkgood) | 1 |

The stricter name rule cut "confirmed" from 18 to 7. Many owners are Chinese companies whose GPSR name (e.g. pinyin
"…youxiangongsi") and EU-register name (English "… Technology Co., Ltd.") differ. The country is unchanged in those cases.
The flag still comes from the GPSR address.

## Coverage on the "Gartenschere" search, page 1

From `scripts/screenshot.mjs` after the fix, delivery address 20095 Hamburg, 60 result tiles including sponsored ones:

| | Tiles | Share |
|---|---|---|
| Tiles with badges | 60 / 60 | 100 % |
| **Brand flag known** (left) | 56 / 60 | **93 %**. The 4 unknown tiles are all FELCO (deliberately unknown, see above) |
| **Seller flag known** (right) | 59 / 60 | **98 %**. The 1 unknown is "Onlinehandel Hinz" (no parseable business address) |
| Both known | 55 / 60 | 92 % |

Page-1 brand codes: EU 23 · CN 20 · DE 10 · OTHER 2 · US 1 · UNKNOWN 4. Seller codes: CN 26 · AMAZON 21 · DE 8 · EU 2 · US 2 · UNKNOWN 1.
Amazon's tile mix changes between page loads. One load a few minutes earlier had more sponsored tiles that the collector had not crawled yet,
and showed 78 % / 85 %. Those ASINs were reported to `/api/queue` by the extension. Before the fix, page 1 showed 98 % / 97 %, with
FELCO wrongly as DE.

## Blocking events seen

**amazon.de: no blocks.** About 210 requests (2 search pages, 85 product pages + 85 GPSR calls, 35 seller profiles) at 8–15 s
spacing. There were no captchas, no 503s and no robot pages.
The later re-derive and spot-check added about 60 more amazon.de requests and about 50 EUIPO eSearch requests, also with no blocks.

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

* **GPSR addresses of EU agents.** AebDerp and SOLODOTO list Spanish EU-agent services ("SUCCESS COURIER SL", "VAT SPEED SL")
  as *manufacturer* in their own GPSR box, with no separate responsible person at that address. They still show ES → EU. The EU marks
  belong to Shenzhen companies whose names don't match the agent, so under the name-match rule they are not used.
  Candidate rule: a list of known EU-representative services whose address is never an owner address.
* **FELCO-type holding names.** The real owner of a brand's marks can have an unrelated name (Flisch Holding SA for FELCO).
  See the options under "Spot-check".
* Groups owned from abroad show the GPSR company's country (WOLF Garten → DE via Stanley Black & Decker Outdoor GmbH; Bahco → ES
  via SNA Europe), which is the EU legal manufacturer, not the ultimate parent (US).
* Exact-name search on EUIPO misses brands written with symbols, e.g. "BLACK+DECKER" ("no EU trade mark with this name").
* EU responsible persons are stored for 28 products so far. Older rows get them on their next refresh.
* 2 sellers ("Onlinehandel Hinz", "present4friends") have a profile page without a parseable business address → right badge UNKNOWN.
* 22 Gartenschere product jobs (mostly page 2) are still queued. The collector resumes them on the next start.
* TMview is still blocking this machine's IP, so EUIPO eSearch (not blocked) is now the primary trade mark route and TMview the fallback.
* Some amazon.de tiles still say "Wird versendet nach Indien" even with the Hamburg address set, because the machine has an Indian IP. Prices are EUR.
* The Docker image and `compose.yml` were written but **not built or run here** (no Docker on this machine). Not deployed, as instructed.
* The headless-browser fallback is implemented, but it was never triggered in the real run (amazon.de did not block).

## How to reproduce

```bash
cd server && npm install && PORT=5180 npm start               # API + status page
npm run collect -- --search Gartenschere --pages 2            # or: npm run collector (loop)
npm run rederive                                              # re-apply brand rules to an existing DB
cd .. && npm install && API_BASE=http://localhost:5180 node scripts/screenshot.mjs
```
