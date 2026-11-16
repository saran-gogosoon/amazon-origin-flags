// Country → flag code mapping used by both the API and the collector.
export const EU = new Set(['AT', 'BE', 'BG', 'HR', 'CY', 'CZ', 'DK', 'EE', 'FI', 'FR', 'DE', 'GR', 'HU', 'IE',
  'IT', 'LV', 'LT', 'LU', 'MT', 'NL', 'PL', 'PT', 'RO', 'SK', 'SI', 'ES', 'SE']);

// German / English country names that show up in Amazon addresses and EUIPO records.
const NAMES = {
  DEUTSCHLAND: 'DE', GERMANY: 'DE', CHINA: 'CN', 'VOLKSREPUBLIK CHINA': 'CN', 'REPÚBLICA POPULAR DE CHINA': 'CN',
  'HONG KONG': 'HK', HONGKONG: 'HK', 'VEREINIGTE STAATEN': 'US', USA: 'US', 'UNITED STATES': 'US',
  ÖSTERREICH: 'AT', AUSTRIA: 'AT', FRANKREICH: 'FR', FRANCE: 'FR', ITALIEN: 'IT', ITALY: 'IT', SPANIEN: 'ES',
  SPAIN: 'ES', NIEDERLANDE: 'NL', NETHERLANDS: 'NL', POLEN: 'PL', POLAND: 'PL', SCHWEIZ: 'CH', SWITZERLAND: 'CH',
  'VEREINIGTES KÖNIGREICH': 'GB', 'UNITED KINGDOM': 'GB', JAPAN: 'JP', TAIWAN: 'TW', SCHWEDEN: 'SE', SWEDEN: 'SE',
  FINNLAND: 'FI', FINLAND: 'FI', DÄNEMARK: 'DK', DENMARK: 'DK', BELGIEN: 'BE', BELGIUM: 'BE', TSCHECHIEN: 'CZ',
};

/** Normalise "DE", "de", "Deutschland", "CNcountry" … to an ISO-3166 alpha-2 code (or null). */
export function toIso(value) {
  if (!value) return null;
  const v = String(value).trim().toUpperCase().replace(/COUNTRY$/, '');
  if (/^[A-Z]{2}$/.test(v)) return v === 'UK' ? 'GB' : v;
  return NAMES[v] ?? null;
}

/** ISO country → badge code: DE, EU, CN, US, OTHER, UNKNOWN. Hong Kong / Macau count as CN. */
export function flagCode(iso) {
  if (!iso) return 'UNKNOWN';
  if (iso === 'DE') return 'DE';
  if (EU.has(iso)) return 'EU';
  if (['CN', 'HK', 'MO'].includes(iso)) return 'CN';
  if (iso === 'US') return 'US';
  return 'OTHER';
}

export const AMAZON_SELLER_IDS = new Set(['A3JWKAKR8XB7XF']); // Amazon EU S.à r.l. on amazon.de
const AMAZON_BRANDS = /^(amazon( basics| essentials| commercial)?|amazonbasics|solimo|find\.|eono|umi\.?)$/i;
export const isAmazonBrand = (name) => !!name && AMAZON_BRANDS.test(name.trim());
export const isAmazonSellerName = (name) => !!name && /^amazon(\.de| eu)?\b/i.test(name.trim());
