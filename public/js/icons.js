// Line icons (24px grid, drawn with currentColor) and hover tooltips for icon-only buttons.
//
// Static HTML: <button data-icon="save" data-tip="Save">  -> hydrateIcons() fills in the SVG.
// Tooltips: any element with data-tip shows it on hover or keyboard focus.

const P = (d) => `<path d="${d}"/>`;
const C = (cx, cy, r) => `<circle cx="${cx}" cy="${cy}" r="${r}"/>`;

const PATHS = {
  plus: P('M12 5v14M5 12h14'),
  x: P('M6 6l12 12M18 6L6 18'),
  check: P('M5 12.5l4.5 4.5L19 7'),
  back: P('M19 12H5M11 18l-6-6 6-6'),
  save: P('M5 3h11l5 5v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z') + P('M7 3v5h8V3M7 21v-7h10v7'),
  undo: P('M9 14L4 9l5-5') + P('M4 9h10.5a5.5 5.5 0 0 1 0 11H11'),
  redo: P('M15 14l5-5-5-5') + P('M20 9H9.5a5.5 5.5 0 0 0 0 11H13'),
  publish: C(12, 12, 9) + P('M3 12h18M12 3c2.8 2.6 4 5.6 4 9s-1.2 6.4-4 9c-2.8-2.6-4-5.6-4-9s1.2-6.4 4-9z'),
  eye: P('M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z') + C(12, 12, 3),
  external: P('M14 4h6v6M20 4l-9 9') + P('M19 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h5'),
  edit: P('M4 20h4L19 9a2.8 2.8 0 0 0-4-4L4 16v4z') + P('M13.5 6.5l4 4'),
  rename: P('M4 7V5h12v2M10 5v14M8 19h4') + P('M15 13h6M18 13v6M16.5 19h3'),
  trash: P('M4 7h16M10 11v6M14 11v6') + P('M6 7l1 13h10l1-13M9 7V4h6v3'),
  star: P('M12 3.5l2.6 5.4 5.9.8-4.3 4.1 1 5.8L12 16.8l-5.2 2.8 1-5.8-4.3-4.1 5.9-.8z'),
  upload: P('M12 15V4M7.5 8.5L12 4l4.5 4.5') + P('M4 15v4a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-4'),
  download: P('M12 4v11M7.5 10.5L12 15l4.5-4.5') + P('M4 15v4a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-4'),
  restore: P('M3.5 12a8.5 8.5 0 1 0 2.5-6L3.5 8.5') + P('M3.5 3.5v5h5M12 7.5V12l3 2'),
  link: P('M10 14a4.2 4.2 0 0 0 6 0l3-3a4.2 4.2 0 0 0-6-6l-1 1') + P('M14 10a4.2 4.2 0 0 0-6 0l-3 3a4.2 4.2 0 0 0 6 6l1-1'),
  unlink: P('M10 14a4.2 4.2 0 0 0 6 0l3-3a4.2 4.2 0 0 0-6-6l-1 1') + P('M14 10a4.2 4.2 0 0 0-6 0l-3 3a4.2 4.2 0 0 0 6 6l1-1') + P('M3 3l18 18'),
  logout: P('M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9'),
  folder: P('M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z'),
  folderPlus: P('M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z') + P('M12 10.5v6M9 13.5h6'),
  map: P('M9 4L3 6.5v13.5l6-2.5 6 2.5 6-2.5V4l-6 2.5z') + P('M9 4v13.5M15 6.5V20'),
  mapPlus: P('M9 4L3 6.5v13.5l6-2.5 3 1.2') + P('M9 4l6 2.5L21 4v8') + P('M9 4v13.5M15 6.5v5') + P('M18 15v6M15 18h6'),
  image: `<rect x="3" y="5" width="18" height="14" rx="2"/>` + C(8.5, 10, 1.5) + P('M21 16l-5-5-9 8'),
  library: `<rect x="3" y="6" width="14" height="12" rx="1.5"/>` + P('M6 15l3-3.5 2.5 2.5 1.5-1.5 2 2.5') + P('M20 9v10a1 1 0 0 1-1 1H7'),
  newGroup: P('M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z') + P('M12 10.5v6M9 13.5h6'),
  ungroup: `<rect x="3" y="3" width="9" height="9" rx="1.5"/><rect x="12" y="12" width="9" height="9" rx="1.5" stroke-dasharray="2.5 2"/>`,
  focus: C(12, 12, 8) + C(12, 12, 3) + P('M12 2v3M12 19v3M2 12h3M19 12h3'),
  zoomIn: C(11, 11, 7) + P('M20.5 20.5l-4.5-4.5M11 8v6M8 11h6'),
  zoomOut: C(11, 11, 7) + P('M20.5 20.5l-4.5-4.5M8 11h6'),
  crosshair: `<rect x="4" y="4" width="16" height="16" rx="2" stroke-dasharray="3 2.5"/>` + P('M12 9v6M9 12h6'),
  goTo: P('M3.5 11l17-7.5-7.5 17-2-7.5z'),
  reset: P('M3.5 12a8.5 8.5 0 1 0 2.5-6L3.5 8.5') + P('M3.5 3.5v5h5'),
  pin: P('M12 16v6M8 3h8l-1.5 6 3.5 4H6l3.5-4z'),
  search: C(11, 11, 7) + P('M20.5 20.5l-4.5-4.5'),
  share: P('M10 14a4.2 4.2 0 0 0 6 0l3-3a4.2 4.2 0 0 0-6-6l-1 1') + P('M14 10a4.2 4.2 0 0 0-6 0l-3 3a4.2 4.2 0 0 0 6 6l1-1'),
  layers: P('M12 3l9 5-9 5-9-5z') + P('M3 12.5l9 5 9-5M3 16.5l9 5 9-5'),
  key: C(8, 15, 4.5) + P('M11.2 11.8L20 3M16.5 6.5l3 3'),
  pointer: P('M5 3l14 7.5-6 1.8-2.5 6.2z') + P('M13 12.3l5 5'),
};

export function icon(name) {
  return `<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${PATHS[name] || ''}</svg>`;
}

// Fill in <… data-icon="name"> elements and label them for screen readers from data-tip.
export function hydrateIcons(root = document) {
  for (const el of root.querySelectorAll('[data-icon]')) {
    if (el.dataset.iconDone) continue;
    el.insertAdjacentHTML('afterbegin', icon(el.dataset.icon));
    el.dataset.iconDone = '1';
    if (el.dataset.tip && !el.getAttribute('aria-label')) el.setAttribute('aria-label', el.dataset.tip);
  }
}

// ---------- tooltips ----------

let tipEl = null;
let tipTarget = null;
let tipTimer = null;

function showTip(target) {
  const text = target.dataset.tip;
  if (!text) return;
  if (!tipEl) {
    tipEl = document.createElement('div');
    tipEl.className = 'ui-tip';
    tipEl.setAttribute('role', 'tooltip');
    document.body.append(tipEl);
  }
  tipEl.textContent = text;
  tipEl.hidden = false;
  const r = target.getBoundingClientRect();
  const w = tipEl.offsetWidth, hgt = tipEl.offsetHeight;
  let top = r.bottom + 6;
  if (top + hgt > window.innerHeight - 4) top = r.top - hgt - 6;
  const left = Math.max(4, Math.min(r.left + r.width / 2 - w / 2, window.innerWidth - w - 4));
  tipEl.style.left = `${left}px`;
  tipEl.style.top = `${top}px`;
}

function hideTip() {
  clearTimeout(tipTimer);
  tipTarget = null;
  if (tipEl) tipEl.hidden = true;
}

export function initTooltips() {
  document.addEventListener('pointerover', (e) => {
    if (e.pointerType === 'touch') return;
    const t = e.target.closest?.('[data-tip]');
    if (t === tipTarget) return;
    hideTip();
    if (!t) return;
    tipTarget = t;
    tipTimer = setTimeout(() => showTip(t), 350);
  });
  document.addEventListener('focusin', (e) => {
    const t = e.target.closest?.('[data-tip]');
    if (t && t.matches(':focus-visible')) { hideTip(); tipTarget = t; showTip(t); }
  });
  for (const evt of ['pointerdown', 'focusout', 'scroll', 'keydown']) document.addEventListener(evt, hideTip, true);
}
