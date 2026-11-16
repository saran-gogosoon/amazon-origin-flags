// amazon.de page fetchers + parsers (search results, product page, GPSR manufacturer block, seller profile).
import * as cheerio from 'cheerio';
import { getPage } from './http.js';
import { toIso } from '../countries.js';

const BASE = 'https://www.amazon.de';
const clean = (s) => (s ?? '').replace(/[‎‏]/g, '').replace(/\s+/g, ' ').trim();

// Amazon sometimes renders a name twice inside one link ("Yzona StoreYzona Store").
const undouble = (s) => (s.length % 2 === 0 && s.slice(0, s.length / 2) === s.slice(s.length / 2) ? s.slice(0, s.length / 2) : s);

// ---- search ---------------------------------------------------------------------------------
export function parseSearch(html) {
  const $ = cheerio.load(html);
  const items = [];
  $('[data-component-type="s-search-result"][data-asin]').each((_, el) => {
    const asin = $(el).attr('data-asin');
    if (!/^[A-Z0-9]{10}$/.test(asin ?? '')) return;
    items.push({ asin, title: clean($(el).find('h2').first().text()) || null });
  });
  return items;
}

export async function fetchSearch(term, page = 1) {
  const url = `${BASE}/s?k=${encodeURIComponent(term)}${page > 1 ? `&page=${page}` : ''}`;
  const res = await getPage(url, { expect: /s-search-result|s-result-list/ });
  return { url, via: res.via, items: parseSearch(res.body) };
}

// ---- product page -----------------------------------------------------------------------------
export function parseBrand($) {
  const fromTable = (label) => {
    let v = null;
    $('tr').each((_, tr) => {
      const th = clean($(tr).find('th, td.a-span3').first().text());
      if (!v && new RegExp(`^${label}$`, 'i').test(th)) v = clean($(tr).find('td').last().text());
    });
    return v;
  };
  const brand = clean($('tr.po-brand td.po-break-word').first().text()) || fromTable('Marke') || fromTable('Brand');
  if (brand) return brand;
  const byline = clean($('#bylineInfo').text());
  const m = byline.match(/^Besuche den (.+?)-Store$/i) || byline.match(/^Visit the (.+?) Store$/i)
    || byline.match(/^Marke:\s*(.+)$/i) || byline.match(/^Brand:\s*(.+)$/i);
  return m ? clean(m[1]) : (byline || null);
}

export function parseSeller($) {
  const link = $('#sellerProfileTriggerId');
  if (link.length) {
    const id = (link.attr('href') ?? '').match(/seller=([A-Z0-9]+)/)?.[1] ?? null;
    return { id, name: undouble(clean(link.text())) || null };
  }
  const odf = clean($('[offer-display-feature-name="desktop-merchant-info"] .offer-display-feature-text').first().text())
    || clean($('#merchantInfoFeature_feature_div .offer-display-feature-text').first().text());
  const merchantId = $('input#merchantID, input[name="merchantID"]').first().attr('value') || null;
  if (odf) return { id: /^amazon/i.test(odf) ? (merchantId ?? 'A3JWKAKR8XB7XF') : merchantId, name: odf };
  const soldBy = clean($('#merchant-info').text()).match(/Verkauf durch ([^,.]+)/i)?.[1];
  return { id: merchantId, name: soldBy ?? null };
}

export function parseProduct(html) {
  const $ = cheerio.load(html);
  const acp = $('[data-acp-path*="buffet-disclaimers-card"]').first();
  return {
    title: clean($('#productTitle').text()) || null,
    brand: parseBrand($),
    seller: parseSeller($),
    acp: acp.length ? { path: acp.attr('data-acp-path'), params: acp.attr('data-acp-params') } : null,
  };
}

/** Parse the GPSR "Herstellerinformationen" HTML fragment → { name, address, country }. */
export function parseManufacturer(html) {
  const $ = cheerio.load(html);
  const box = $('#buffet-sidesheet-manufacturer-content-container .a-box').first();
  if (!box.length) return null;
  const name = clean(box.find('.a-text-bold').first().text());
  const lines = box.find('li > span.a-list-item').map((_, el) => clean($(el).text())).get().filter(Boolean);
  const addressLines = lines.filter((l) => !/@|^\+?\d[\d\s/-]{6,}$|^https?:/i.test(l));
  let country = null;
  for (const line of addressLines) {
    for (const part of line.split(',').map((p) => p.trim()).reverse()) {
      const iso = toIso(part);
      if (iso) { country = iso; break; }
    }
    if (country) break;
  }
  return name ? { name, address: addressLines.join(', '), country } : null;
}

export async function fetchProduct(asin) {
  const url = `${BASE}/dp/${asin}`;
  const res = await getPage(url, { expect: /id="productTitle"|id="dp-container"|id="dp"/ });
  const product = { asin, url, via: res.via, notFound: res.status === 404, ...parseProduct(res.body) };
  product.manufacturer = null;
  if (product.acp?.path && product.acp?.params) {
    const r = await getPage(`${BASE}${product.acp.path}getRspManufacturerContent?page-type=Detail`, {
      method: 'POST',
      body: JSON.stringify({ asin }),
      headers: { 'content-type': 'application/json', accept: 'text/html,*/*', 'x-amz-acp-params': product.acp.params,
        'x-requested-with': 'XMLHttpRequest', referer: url },
      expect: /buffet-sidesheet|Herstellerinformationen|a-box/,
    });
    product.manufacturer = parseManufacturer(r.body);
  }
  return product;
}

// ---- seller profile ---------------------------------------------------------------------------
export function parseSellerProfile(html) {
  const $ = cheerio.load(html);
  // Rows look like <div class="a-row"><span class="a-text-bold">Label:</span><span>value</span></div>
  // followed (for addresses) by <div class="a-row indent-left"><span>line</span></div> siblings.
  const section = (label) => {
    const out = [];
    $('span.a-text-bold').each((_, el) => {
      if (out.length || !clean($(el).text()).startsWith(label)) return;
      const row = $(el).parent();
      const inline = clean(row.children('span').not(el).text());
      if (inline) out.push(inline);
      let next = row.next();
      while (next.length && next.hasClass('indent-left')) { out.push(clean(next.text())); next = next.next(); }
    });
    return out.filter(Boolean);
  };
  let addressLines = section('Geschäftsadresse');
  if (!addressLines.length) addressLines = section('Business Address');
  const companyName = section('Geschäftsname')[0] ?? section('Name des Unternehmens')[0] ?? section('Business Name')[0] ?? null;
  const displayName = clean($('#seller-name').text()) || clean($('h1').first().text()) || null;
  let country = null;
  for (const line of [...addressLines].reverse()) { country = toIso(line); if (country) break; }
  return { name: displayName, company: companyName, address: addressLines.join(', ') || null, country };
}

export async function fetchSeller(sellerId) {
  const url = `${BASE}/sp?seller=${sellerId}`;
  const res = await getPage(url, { expect: /seller-name|Verkäuferinformationen|Geschäftsadresse|spp-/ });
  return { url, via: res.via, ...parseSellerProfile(res.body) };
}
