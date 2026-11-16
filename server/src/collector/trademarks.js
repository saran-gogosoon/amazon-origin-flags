// EU trade mark register lookup, no API key needed:
//  1. EUIPO eSearch search (euipo.europa.eu/copla/ctmsearch/json): marks with applicant name, applicant
//     country and Nice classes in one request.
//  2. Fallback: TMview (tmdn.org) search API + EUIPO record (copla/trademark/data) for the applicant's country.
// A mark's owner is only accepted when its name is similar to the GPSR manufacturer of the product
// (same brand word is often registered by unrelated companies, e.g. "FELCO" for medical supplies in MY).
import { getPage } from './http.js';
import { toIso } from '../countries.js';
import { namesSimilar } from '../names.js';

export { namesSimilar };

const ESEARCH = 'https://euipo.europa.eu/copla/ctmsearch/json';
const TMVIEW = 'https://www.tmdn.org/tmview/api/search/results?translate=true';
const COPLA = 'https://euipo.europa.eu/copla/trademark/data/';
const LIVE = /Registered|Filed|published|Application|Opposition|Appeal|IR accepted|Eingetragen|Anmeldung|veröffentlicht|Widerspruch|Beschwerde/i;

const fold = (s) => (s ?? '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '');
const norm = (s) => fold(s).replace(/[^a-z0-9]/g, '');

const niceList = (n) => String(n ?? '').split(/[,\s]+/).map(Number).filter(Boolean);

/** EUIPO eSearch: marks whose word element equals the brand → [{ number, name, applicant, country, nice[], status }]. */
export async function searchEuipo(brand) {
  const form = new URLSearchParams({ start: '0', rows: '100', searchMode: 'basic', criterion_1: 'MarkVerbalElementText',
    term_1: brand, operator_1: 'OR', condition_1: 'CONTAINS', sortField: 'ApplicationNumber', sortOrder: 'asc' });
  const res = await getPage(ESEARCH, {
    method: 'POST', body: form.toString(),
    headers: { 'content-type': 'application/x-www-form-urlencoded; charset=UTF-8', accept: 'application/json',
      referer: 'https://euipo.europa.eu/eSearch/', 'x-requested-with': 'XMLHttpRequest' },
    expect: /"items"/, allowBrowser: false,
  });
  return (JSON.parse(res.body).items ?? []).filter((t) => norm(t.name) === norm(brand)).map((t) => ({
    number: t.number ?? t.numberToShow, name: t.name, applicant: t.applicantname, country: toIso(t.applicantCountry),
    nice: niceList(t.nice), status: t.status, source: 'EUIPO eSearch',
  }));
}

/** TMview fallback (no Nice classes or countries in the result; country comes from the EUIPO record). */
export async function searchTmview(brand) {
  const res = await getPage(TMVIEW, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json', referer: 'https://www.tmdn.org/tmview/' },
    body: JSON.stringify({ page: '1', pageSize: '30', criteria: 'C', basicSearch: brand, fOffices: ['EM'],
      fields: ['ST13', 'tmName', 'tmOffice', 'applicationNumber', 'tradeMarkStatus', 'applicantName', 'niceClass'] }),
    expect: /"tradeMarks"|"totalResults"/, allowBrowser: false,
  });
  return (JSON.parse(res.body).tradeMarks ?? []).filter((t) => norm(t.tmName) === norm(brand) && t.tmOffice === 'EM')
    .map((t) => ({ number: t.applicationNumber, name: t.tmName, applicant: t.applicantName?.[0], country: null,
      nice: t.niceClass ?? [], status: t.tradeMarkStatus, source: 'TMview' }));
}

async function recordCountry(number) {
  const res = await getPage(COPLA + number, { headers: { accept: 'application/json' }, expect: /"applicants"/, allowBrowser: false });
  const a = JSON.parse(res.body).applicants?.[0];
  return toIso(a?.address?.countryCode) ?? toIso(a?.nationality);
}

/**
 * EU trade mark owner for a brand, accepted only if the owner's name matches the GPSR manufacturer.
 * Returns { matched: true, name, country, mark, nice, status, evidence_url, source }
 *      or { matched: false, reason, candidates }.
 */
export async function lookupBrandOwner(brand, manufacturerName) {
  let marks;
  try {
    marks = await searchEuipo(brand);
  } catch {
    marks = await searchTmview(brand);
  }
  if (!marks.length) return { matched: false, reason: 'no EU trade mark with this name', candidates: 0 };
  if (!manufacturerName) return { matched: false, reason: 'no GPSR manufacturer to compare with', candidates: marks.length };

  const matching = marks.filter((t) => namesSimilar(t.applicant, manufacturerName));
  if (!matching.length) {
    const owners = [...new Set(marks.map((t) => `${t.applicant}${t.country ? ` (${t.country})` : ''}`))].slice(0, 3);
    return { matched: false, reason: `no matching EU mark (owners: ${owners.join('; ')})`, candidates: marks.length };
  }
  // Prefer live marks covering Nice class 8 (hand tools), then any live mark.
  const score = (t) => (LIVE.test(t.status ?? '') ? 2 : 0) + (t.nice.includes(8) ? 3 : 0);
  const best = matching.sort((a, b) => score(b) - score(a))[0];
  const country = best.country ?? await recordCountry(best.number).catch(() => null);
  return {
    matched: true, name: best.applicant, country, mark: best.name, nice: best.nice, status: best.status, source: best.source,
    evidence_url: `https://euipo.europa.eu/eSearch/#details/trademarks/${best.number}`, candidates: marks.length,
  };
}
