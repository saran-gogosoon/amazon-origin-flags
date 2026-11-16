// Inline SVG flags (no external assets). Shared by the content script and the popup.
(() => {
  const star = (cx, cy, r, rot = -90) => {
    const pts = [];
    for (let i = 0; i < 10; i++) {
      const a = ((rot + i * 36) * Math.PI) / 180;
      const rr = i % 2 ? r * 0.4 : r;
      pts.push(`${(cx + rr * Math.cos(a)).toFixed(2)},${(cy + rr * Math.sin(a)).toFixed(2)}`);
    }
    return `<polygon points="${pts.join(' ')}"/>`;
  };
  const euStars = Array.from({ length: 12 }, (_, i) => {
    const a = (i * 30 * Math.PI) / 180;
    return star(16 + 9 * Math.cos(a), 16 + 9 * Math.sin(a), 2.1);
  }).join('');
  const usStripes = Array.from({ length: 7 }, (_, i) => `<rect y="${i * 32 / 6.5}" width="32" height="${32 / 13}" fill="#b22234"/>`).join('');
  const usDots = Array.from({ length: 9 }, (_, i) => `<circle cx="${3 + (i % 3) * 5}" cy="${3 + Math.floor(i / 3) * 5}" r="1" fill="#fff"/>`).join('');

  const BODIES = {
    DE: '<rect width="32" height="11" fill="#000"/><rect y="10.6" width="32" height="10.8" fill="#dd0000"/><rect y="21.3" width="32" height="10.7" fill="#ffce00"/>',
    EU: `<rect width="32" height="32" fill="#003399"/><g fill="#ffcc00">${euStars}</g>`,
    CN: `<rect width="32" height="32" fill="#ee1c25"/><g fill="#ffff00">${star(10, 11, 5)}${star(17, 5, 1.6)}${star(20, 9, 1.6)}${star(20, 14, 1.6)}${star(17, 18, 1.6)}</g>`,
    US: `<rect width="32" height="32" fill="#fff"/>${usStripes}<rect width="16" height="17" fill="#3c3b6e"/>${usDots}`,
    AMAZON: '<rect width="32" height="32" fill="#232f3e"/><text x="16" y="19" text-anchor="middle" font-family="Arial,Helvetica,sans-serif" font-weight="700" font-size="15" fill="#fff">a</text><path d="M7 21.5 Q16 27 25 21.5" stroke="#ff9900" stroke-width="2.4" fill="none" stroke-linecap="round"/><path d="M22.2 20.2 L25.6 21.2 L24.4 24.4" stroke="#ff9900" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"/>',
    OTHER: '<rect width="32" height="32" fill="#0f766e"/><g fill="none" stroke="#ccfbf1" stroke-width="1.6"><circle cx="16" cy="16" r="9"/><ellipse cx="16" cy="16" rx="4" ry="9"/><path d="M7 16h18M8.5 11.5h15M8.5 20.5h15"/></g>',
    UNKNOWN: '<rect width="32" height="32" fill="#fff"/>',
  };
  const LABELS = { AMAZON: 'Amazon', DE: 'Germany', EU: 'EU (other country)', CN: 'China', US: 'USA', OTHER: 'Other country', UNKNOWN: 'Unknown' };

  let uid = 0;
  function svg(code, size = 22) {
    const body = BODIES[code] ?? BODIES.UNKNOWN;
    const id = `ofc${++uid}`;
    const ring = code === 'UNKNOWN' ? '#9ca3af' : 'rgba(0,0,0,.35)';
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 32 32" aria-label="${LABELS[code] ?? code}">` +
      `<defs><clipPath id="${id}"><circle cx="16" cy="16" r="15"/></clipPath></defs>` +
      `<g clip-path="url(#${id})">${body}</g><circle cx="16" cy="16" r="15" fill="none" stroke="${ring}" stroke-width="${code === 'UNKNOWN' ? 2 : 1.2}"${code === 'UNKNOWN' ? ' stroke-dasharray="3 2.5"' : ''}/></svg>`;
  }
  globalThis.OriginFlags = { svg, LABELS, CODES: Object.keys(BODIES) };
})();
