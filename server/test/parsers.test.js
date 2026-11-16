import { test } from 'node:test';
import assert from 'node:assert/strict';
process.env.DB_PATH = ':memory:';
const { detectBlock } = await import('../src/collector/http.js');
const { parseManufacturer, parseSellerProfile } = await import('../src/collector/amazon.js');
const { flagCode, toIso } = await import('../src/countries.js');

test('block detection', () => {
  assert.equal(detectBlock(503, 'https://www.amazon.de/s?k=x', '', /s-search-result/), 'http_503');
  assert.equal(detectBlock(429, 'https://www.amazon.de/', '', null), 'http_429');
  assert.equal(detectBlock(200, 'https://www.amazon.de/errors/validateCaptcha', '', null), 'captcha');
  assert.equal(detectBlock(200, 'https://www.amazon.de/dp/X', '<p>Geben Sie die unten angezeigten Zeichen ein</p>', /productTitle/), 'captcha');
  assert.equal(detectBlock(200, 'https://www.amazon.de/dp/X', '<html></html>', /productTitle/), 'empty_page');
  assert.equal(detectBlock(200, 'https://www.tmdn.org/x', '<title>Request Rejected</title>', /tradeMarks/), 'robot_page');
  assert.equal(detectBlock(200, 'https://www.amazon.de/dp/X', '<span id="productTitle">ok</span>', /productTitle/), null);
});

test('GPSR manufacturer block', () => {
  const html = `<div id="buffet-sidesheet-manufacturer-content-container"><div class="a-box"><span class="a-text-bold">Gebr. Schröder GmbH</span>
    <ul><li><span class="a-list-item"><li><span class="a-list-item a-size-base">Konrad-Zuse-Ring 3</span></li>
    <li><span class="a-list-item a-size-base">Flintbek<span>, </span>DE<span>, </span>24220</span></li></span></li>
    <li><span class="a-list-item"><span>info@example.de</span></span></li></ul></div></div>`;
  const m = parseManufacturer(html);
  assert.equal(m.name, 'Gebr. Schröder GmbH');
  assert.equal(m.country, 'DE');
});

test('seller profile business address', () => {
  const html = `<div class="a-row"><span class="a-text-bold">Geschäftsname:</span><span>ACME Ltd</span></div>
    <div class="a-row"><span class="a-text-bold">Geschäftsadresse:</span></div>
    <div class="a-row indent-left"><span>Street 1</span></div><div class="a-row indent-left"><span>Shenzhen</span></div>
    <div class="a-row indent-left"><span>CN</span></div>`;
  const s = parseSellerProfile(html);
  assert.equal(s.company, 'ACME Ltd');
  assert.equal(s.country, 'CN');
});

test('flag codes', () => {
  assert.equal(flagCode('DE'), 'DE');
  assert.equal(flagCode('FR'), 'EU');
  assert.equal(flagCode('HK'), 'CN');
  assert.equal(flagCode('US'), 'US');
  assert.equal(flagCode('GB'), 'OTHER');
  assert.equal(flagCode(null), 'UNKNOWN');
  assert.equal(toIso('CNcountry'), 'CN');
  assert.equal(toIso('Deutschland'), 'DE');
});
