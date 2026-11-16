// EU trade mark register lookup, no API key needed:
//  1. TMview (tmdn.org) search API → EU trade marks (office EM) whose name equals the brand.
//  2. EUIPO eSearch data endpoint (euipo.europa.eu/copla) → applicant name + nationality/country.
// TMview's own detail endpoint sits behind a WAF (403), so step 2 uses the EUIPO record instead.
import { getPage } from './http.js';
import { toIso } from '../countries.js';

const TMVIEW = 'https://www.tmdn.org/tmview/api/search/results?translate=true';
const COPLA = 'https://euipo.europa.eu/copla/trademark/data/';
const LIVE = /Registered|Filed|published|Application|Opposition|Appeal|Eingetragen|Anmeldung|veröffentlicht|Widerspruch|Beschwerde/i;

const norm = (s) => (s ?? '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]/g, '');

export async function searchEutm(brand) {
  const res = await getPage(TMVIEW, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json', referer: 'https://www.tmdn.org/tmview/' },
    body: JSON.stringify({ page: '1', pageSize: '30', criteria: 'C', basicSearch: brand, fOffices: ['EM'],
      fields: ['ST13', 'tmName', 'tmOffice', 'applicationNumber', 'applicationDate', 'tradeMarkStatus', 'applicantName'] }),
    expect: /"tradeMarks"|"totalResults"/,
    allowBrowser: false,
  });
  const { tradeMarks = [] } = JSON.parse(res.body);
  return tradeMarks.filter((t) => norm(t.tmName) === norm(brand) && t.tmOffice === 'EM');
}

export async function eutmOwner(applicationNumber) {
  const url = COPLA + applicationNumber;
  const res = await getPage(url, { headers: { accept: 'application/json' }, expect: /"applicants"/, allowBrowser: false });
  const data = JSON.parse(res.body);
  const a = data.applicants?.[0];
  if (!a) return null;
  return {
    name: a.name ?? a.orga ?? null,
    country: toIso(a.address?.countryCode) ?? toIso(a.nationality),
    evidence_url: `https://euipo.europa.eu/eSearch/#details/trademarks/${applicationNumber}`,
  };
}

/**
 * Best EU trade mark owner for a brand. If we know the product's manufacturer, prefer a mark
 * whose applicant resembles it (same brand name can be registered by unrelated companies).
 */
export async function lookupBrandOwner(brand, manufacturerName) {
  const marks = await searchEutm(brand);
  if (!marks.length) return null;
  const m = norm(manufacturerName);
  const score = (t) => {
    const applicant = norm(t.applicantName?.[0]);
    let s = LIVE.test(t.tradeMarkStatus ?? '') ? 2 : 0;
    if (m && applicant && (applicant.includes(m.slice(0, 8)) || m.includes(applicant.slice(0, 8)))) s += 5;
    return s + (Date.parse(t.applicationDate) || 0) / 1e14; // tie-break: newest
  };
  const best = marks.sort((a, b) => score(b) - score(a))[0];
  const owner = await eutmOwner(best.applicationNumber);
  // "unique": every live EU mark with exactly this name belongs to the same applicant → no namesake doubt.
  const liveOwners = new Set(marks.filter((t) => LIVE.test(t.tradeMarkStatus ?? '')).map((t) => norm(t.applicantName?.[0])));
  return owner && { ...owner, mark: best.tmName, status: best.tradeMarkStatus, candidates: marks.length,
    live: LIVE.test(best.tradeMarkStatus ?? ''), unique: liveOwners.size === 1 };
}
