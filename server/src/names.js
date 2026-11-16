// Company-name comparison shared by the GPSR parser and the trade mark matcher.
const fold = (s) => (s ?? '').toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '');

// Legal forms and filler words that say nothing about who the company is.
const LEGAL = new Set(['gmbh', 'mbh', 'ag', 'kg', 'ohg', 'ug', 'gbr', 'ek', 'co', 'cokg', 'sa', 'sas', 'sarl', 'sl', 'slu', 'srl',
  'spa', 'sro', 'bv', 'nv', 'ltd', 'limited', 'inc', 'corp', 'corporation', 'company', 'llc', 'lp', 'plc', 'oy', 'oyj', 'ab',
  'as', 'aps', 'asa', 'se', 'sp', 'zoo', 'sdn', 'bhd', 'pty', 'kk', 'the', 'and', 'und', 'group', 'gruppe', 'holding',
  'international', 'trading', 'youxiangongsi', 'youxian', 'gongsi', 'ltda']);
const tokens = (s) => fold(s).split(/[^a-z0-9]+/).filter((t) => t.length > 1 && !LEGAL.has(t));
const compact = (s) => tokens(s).join('').replace(/(youxiangongsi|gongsi)$/, '');

/**
 * Are two company names the same company? Legal suffixes are ignored.
 * Yes if the compacted names are equal, one contains the other (≥ 8 chars, for pinyin names written
 * with/without spaces), or they share ≥ 2 tokens covering ≥ 60 % of the shorter name.
 */
export function namesSimilar(a, b) {
  const plain = (x) => fold(x).replace(/[^a-z0-9]/g, '');
  if (plain(a) && plain(a) === plain(b)) return true;
  const ca = compact(a), cb = compact(b);
  if (!ca || !cb) return false;
  if (ca === cb) return true;
  const [short, long] = ca.length <= cb.length ? [ca, cb] : [cb, ca];
  if (short.length >= 8 && long.includes(short)) return true;
  const ta = new Set(tokens(a)), tb = new Set(tokens(b));
  const shared = [...ta].filter((t) => tb.has(t)).length;
  return shared >= 2 && shared / Math.min(ta.size, tb.size) >= 0.6;
}

const FORMS = /\b(gmbh|mbh|ag|kg|ohg|ug|gbr|e\.?k|s\.?a\.?|sas|sarl|s\.?l\.?u?|srl|s\.?p\.?a|s\.?r\.?o|b\.?v|n\.?v|ltd|limited|inc|corp|corporation|company|llc|plc|oy|oyj|ab|aps|asa|sp\.? z\.?o\.?o|sdn|bhd|pty|co)\b\.?/i;
/** Does the name carry a legal form (i.e. it is a company, not a contact person)? */
export const isCompanyName = (s) => FORMS.test(fold(s));
