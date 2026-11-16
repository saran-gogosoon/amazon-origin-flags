import { test } from 'node:test';
import assert from 'node:assert/strict';
process.env.DB_PATH = ':memory:';
const { detectBlock } = await import('../src/collector/http.js');
const { parseManufacturer, parseGpsr, parseSellerProfile } = await import('../src/collector/amazon.js');
const { namesSimilar } = await import('../src/collector/trademarks.js');
const { flagCode, toIso } = await import('../src/countries.js');

test('block detection', () => {
  assert.equal(detectBlock(503, 'https://www.amazon.de/s?k=x', '', /s-search-result/), 'http_503');
  assert.equal(detectBlock(429, 'https://www.amazon.de/', '', null), 'http_429');
  assert.equal(detectBlock(200, 'https://www.amazon.de/errors/validateCaptcha', '', null), 'captcha');
  assert.equal(detectBlock(200, 'https://www.amazon.de/dp/X', '<p>Geben Sie die unten angezeigten Zeichen ein</p>', /productTitle/), 'captcha');
  assert.equal(detectBlock(200, 'https://www.amazon.de/dp/X', '<html></html>', /productTitle/), 'empty_page');
  assert.equal(detectBlock(200, 'https://www.tmdn.org/x', '<title>Request Rejected</title>', /tradeMarks/), 'robot_page');
  assert.equal(detectBlock(200, 'https://www.tmdn.org/error/revise.html', '<html>…</html>', /tradeMarks/), 'ip_block');
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

// Synthetic GPSR fragment shaped like amazon.de's getRspManufacturerContent response.
const entry = (label, lines) => `<span class="a-size-base a-text-bold">${label}</span><ul class="a-unordered-list">` +
  lines.map((l) => `<li><span class="a-list-item a-size-base">${l}</span></li>`).join('') + '</ul><div class="a-divider"></div>';
const gpsr = (manufacturer, responsible) =>
  `<div id="buffet-sidesheet-rsp-content-container"><div class="a-box"><div class="a-box-inner">${responsible.map((r) => entry(...r)).join('')}</div></div></div>` +
  `<div id="buffet-sidesheet-manufacturer-content-container"><div class="a-box"><div class="a-box-inner">${entry(...manufacturer)}</div></div></div>`;

test('GPSR: country comes from the manufacturer, never from the EU responsible person (FELCO-like)', () => {
  const html = gpsr(
    ['FELCO SA', ['Case postale 85', 'Les Geneveys-sur-Coffrane<span>, </span>CH<span>, </span>2206', 'info@felco.com']],
    [['Amazon.de', ['Amazon EU SARL', '38 Avenue John F. Kennedy', 'Luxembourg<span>, </span>LU<span>, </span>']],
     ['die flora', ['FELCO Europe GmbH', 'Ludwigsburger Straße 71', 'Freiberg/Neckar<span>, </span>DE<span>, </span>71691', 'eshop_eu@felco.com']]]);
  const { manufacturer, responsible } = parseGpsr(html);
  assert.equal(manufacturer.name, 'FELCO SA');
  assert.equal(manufacturer.country, 'CH');
  assert.equal(flagCode(manufacturer.country), 'OTHER');
  assert.equal(responsible.length, 2);
  assert.deepEqual(responsible.map((r) => [r.name, r.country]), [['Amazon EU SARL', 'LU'], ['FELCO Europe GmbH', 'DE']]);
});

test('GPSR: manufacturer address identical to the EU responsible person is not trusted', () => {
  // Real amazon.de case: "FELCO SA" shown with the German importer's address.
  const html = gpsr(
    ['FELCO SA', ['Ludwigsburger Str. 71', 'Freiburg/Neckar<span>, </span>DE<span>, </span>71691', 'info@felco.com']],
    [['die flora', ['FELCO Europe GmbH', 'Ludwigsburger Straße 71', 'Freiberg/Neckar<span>, </span>DE<span>, </span>71691']]]);
  const { manufacturer } = parseGpsr(html);
  assert.equal(manufacturer.addressCountry, 'DE');
  assert.equal(manufacturer.country, null);
  assert.match(manufacturer.note, /EU responsible person/);
});

test('trade mark owner must match the manufacturer name', () => {
  assert.equal(namesSimilar('FELCO SA', 'FELCO MEDICAL SUPLLIES SDN BHD'), false);
  assert.equal(namesSimilar('FELCO SA', 'Flisch Holding SA'), false);
  assert.equal(namesSimilar('Gebr. Schröder GmbH Original LÖWE', 'Gebr. Schröder GmbH'), true);
  assert.equal(namesSimilar('Fiskars Finland Oy Ab / Iittala Group', 'Fiskars Brands Finland Oy Ab'), true);
  assert.equal(namesSimilar('Dongguanshiguoyankejiyouxiangongsi', 'Dongguan Shi Guoyan Keji Youxian Gongsi'), true);
  assert.equal(namesSimilar('GARDENA Deutschland GmbH', 'GARDENA GmbH'), false);
  assert.equal(namesSimilar('Husqvarna AB', 'HUSQVARNA AB'), true);
  assert.equal(namesSimilar('A.I.&E. B.V.', 'A.I.&E. B.V.'), true);
});

test('GPSR: a manufacturer that is its own EU responsible person keeps its country', () => {
  const html = gpsr(
    ['Gebr. Schröder GmbH Original LÖWE', ['Konrad-Zuse-Ring 3', 'Flintbek<span>, </span>DE<span>, </span>24220']],
    [['Amazon.de', ['Gebr. Schröder GmbH Original LÖWE', 'Konrad-Zuse-Ring 3', 'Flintbek<span>, </span>DE<span>, </span>24220']]]);
  assert.equal(parseGpsr(html).manufacturer.country, 'DE');
});

test('GPSR: a contact person at the manufacturer address does not make it an importer address', () => {
  const html = gpsr(
    ['Conmetall Meister GmbH', ['Petermannstr. 2', 'Celle<span>, </span>DE<span>, </span>29221']],
    [['Shop', ['Max Mustermann', 'Petermannstr. 2', 'Celle<span>, </span>DE<span>, </span>29221']]]);
  assert.equal(parseGpsr(html).manufacturer.country, 'DE');
});
