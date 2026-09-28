import { ShapeOverlay, eventPixel, api, shapeBounds } from './overlay.js';
import * as T from './tree.js';
import { FadeController } from './fade.js';
import { renderOutliner } from './outliner.js';
import { renderMarkdown } from './markdown.js';

const $ = (sel) => document.querySelector(sel);
const params = new URLSearchParams(location.search);
const PREVIEW = params.get('preview') === '1';

const viewer = OpenSeadragon({
  id: 'viewer',
  prefixUrl: '/vendor/osd/images/',
  showNavigator: true,
  navigatorPosition: 'BOTTOM_RIGHT',
  showRotationControl: true,
  showFullPageControl: true,
  crossOriginPolicy: 'Anonymous',
  visibilityRatio: 0.2,
  minZoomImageRatio: 0.5,
  maxZoomPixelRatio: 4,
  animationTime: 0.8,
  gestureSettingsTouch: { dblClickToZoom: false },
  preserveViewport: true, // we choose the starting view ourselves (saved view, shared link or fit)
  debugMode: params.get('debug') === '1', // ?debug=1 draws tile borders and pyramid levels
});
const overlay = new ShapeOverlay(viewer);

let current = null;       // the loaded map
let loadToken = 0;
let hoverId = null;
let focusIds = null;
let focusedNodeId = null;
const collapsed = new Map();

// [{ layer, hidden: false, item }] bottom first (hidden images never reach the viewer).
const drawOrder = () => (current ? T.layersTopFirst(current.tree).reverse().map((e) => ({ ...e, item: e.layer.item })) : []);
const fade = new FadeController(viewer, drawOrder);
fade.onApply = () => { if (current) overlay.setOpacities(fade.shapeOpacities(current.shapes, current.tree)); };

// The home button (and goHome) go to the map's saved starting view when it has one.
const fitAll = viewer.viewport.goHome.bind(viewer.viewport);
viewer.viewport.goHome = (immediately) => {
  const v = current?.home_view;
  if (v) viewer.viewport.fitBounds(new OpenSeadragon.Rect(v.x, v.y, v.w, v.h), immediately);
  else fitAll(immediately);
};

const mapSelect = $('#map-select');
const tooltip = $('#tooltip');
const popup = $('#popup');

async function loadMapList() {
  const maps = await api('/api/maps');
  mapSelect.replaceChildren(...maps.map((m) => new Option(m.name, m.id)));
  mapSelect.hidden = maps.length < 2;
  return maps;
}

function showEmpty(msg) {
  const e = $('#empty');
  e.textContent = msg || '';
  e.hidden = !msg;
}

function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { t.hidden = true; }, 2600);
}

// ---------- loading maps ----------

// opts.push: add a history entry. opts.trail: breadcrumb list to use (defaults to extending the current one).
// opts.view: {cx, cy, zoom} to start at. opts.focus: layer/group id to fly to and focus. opts.shape: shape id to fly to.
async function loadMap(id, opts = {}) {
  hidePopup();
  tooltip.hidden = true;
  viewer.canvas.style.cursor = '';
  const token = ++loadToken;
  let map;
  try {
    map = await api(`/api/maps/${encodeURIComponent(id)}${PREVIEW ? '?preview=1' : ''}`);
  } catch (err) {
    if (token !== loadToken) return;
    current = null;
    renderCrumbs([{ id, name: 'Map not found' }]);
    viewer.world.removeAll();
    overlay.render([]);
    renderPanel();
    showEmpty(err.status === 404 ? err.message || 'This map does not exist.' : err.message);
    return;
  }
  if (token !== loadToken) return;
  current = map;
  document.title = map.name;
  mapSelect.value = map.id;
  viewer.container.style.background = map.background;
  $('#preview-banner').hidden = !map.preview;
  $('#preview-edit').href = `/admin/#/edit/${map.id}`;

  // Breadcrumbs: going to a map that's already in the trail cuts the trail back to it.
  let trail = [...(opts.trail || history.state?.trail || [])];
  const at = trail.findIndex((c) => c.id === map.id);
  if (at >= 0) trail = trail.slice(0, at + 1);
  else trail.push(null);
  trail[trail.length - 1] = { id: map.id, name: map.name };
  const state = { id: map.id, depth: (history.state?.depth || 0) + (opts.push ? 1 : 0), trail };
  const url = `?map=${map.id}${PREVIEW ? '&preview=1' : ''}`;
  if (opts.push) history.pushState(state, '', url); else history.replaceState(state, '', url);
  renderCrumbs(trail);
  $('#back').hidden = !(state.depth > 0);

  focusIds = null;
  focusedNodeId = null;
  fade.setFocus(null);
  fade.setTypes(map.types);
  if (!focusOpacityTouched) setFocusOpacity(map.settings.focus_opacity);
  $('#focus-toggle').checked = false;
  collapsed.clear();
  T.walk(map.tree, (n) => { if (n.kind === 'group') collapsed.set(n.id, n.collapsed); });

  viewer.world.removeAll();
  const layers = drawOrder();
  showEmpty(layers.length ? '' : 'This map has no images yet.');
  hoverId = null;
  overlay.render(map.shapes);
  await Promise.all(layers.map(({ layer }) => new Promise((resolve) => {
    viewer.addTiledImage({
      tileSource: layer.dzi_url, x: layer.x, y: layer.y, width: layer.width, opacity: 0,
      success: (e) => { layer.item = e.item; resolve(); },
      error: () => resolve(),
    });
  })));
  if (token !== loadToken) return;

  // Let OpenSeadragon finish adding the images before setting the view.
  await new Promise((r) => setTimeout(r, 0)); // not requestAnimationFrame: that pauses in background tabs
  if (token !== loadToken) return;
  if (opts.view) {
    viewer.viewport.zoomTo(opts.view.zoom, null, true);
    viewer.viewport.panTo(new OpenSeadragon.Point(opts.view.cx, opts.view.cy), true);
  } else {
    viewer.viewport.goHome(true);
  }
  fade.refresh();
  renderPanel();

  if (opts.focus) {
    const node = T.find(map.tree, opts.focus)?.node;
    if (node) {
      focus(node);
      if (!opts.view) flyTo(node); // a shared link keeps its exact view
    }
  }
  if (opts.shape) {
    const s = map.shapes.find((x) => x.id === opts.shape);
    if (s) {
      flyToShape(s);
      if (s.kind === 'annotation') setTimeout(() => showPopupCentered(s), 700);
    }
  }
}

function renderCrumbs(trail) {
  const nav = $('#crumbs');
  nav.replaceChildren();
  trail.forEach((c, i) => {
    if (i) nav.append(Object.assign(document.createElement('span'), { className: 'sep', textContent: '›' }));
    const last = i === trail.length - 1;
    const el = document.createElement(last ? 'h1' : 'a');
    el.textContent = c.name;
    if (!last) {
      el.href = `?map=${c.id}`;
      el.addEventListener('click', (e) => {
        e.preventDefault();
        loadMap(c.id, { push: true, trail: trail.slice(0, i + 1) });
      });
    }
    nav.append(el);
  });
  // On narrow screens only the last two crumbs fit.
  nav.classList.toggle('long', trail.length > 2);
}

// ---------- side panel ----------

let focusOpacityTouched = false;

function setFocusOpacity(v) {
  $('#focus-opacity').value = v;
  $('#focus-opacity-out').textContent = `${Math.round(v * 100)}%`;
  fade.setFocusOpacity(v);
}

function renderPanel() {
  if ($('#side-panel').hidden) return;
  renderOutliner($('#viewer-outliner'), current?.tree || [], {
    readOnly: true,
    focusIds,
    emptyText: 'No images on this map.',
    isCollapsed: (n) => collapsed.get(n.id),
    onToggleCollapse: (n) => { collapsed.set(n.id, !collapsed.get(n.id)); renderPanel(); },
    onSelect: (n) => {
      flyTo(n);
      if ($('#focus-toggle').checked) focus(n);
      if (window.matchMedia('(max-width: 700px)').matches) togglePanel(false);
    },
    onDblClick: (n) => focus(n),
  });
}

function focus(n) {
  focusedNodeId = n.id;
  focusIds = new Set([n.id, ...T.descendantLayers(n).map((l) => l.id)]);
  fade.setFocus(focusIds);
  $('#focus-toggle').checked = true;
  renderPanel();
}

function clearFocus() {
  focusIds = null;
  focusedNodeId = null;
  fade.setFocus(null);
  $('#focus-toggle').checked = false;
  renderPanel();
}

function fitRect(b) {
  const pad = Math.max(b.w, b.h) * 0.08;
  viewer.viewport.fitBounds(new OpenSeadragon.Rect(b.x - pad, b.y - pad, b.w + pad * 2, b.h + pad * 2));
}

function flyTo(n) {
  const b = T.unionBounds(T.descendantLayers(n));
  if (b) fitRect(b);
}

function flyToShape(s) {
  const b = shapeBounds(s.geometry);
  // Don't zoom in absurdly far on tiny shapes.
  const min = viewer.viewport.getBounds().width * 0.15;
  fitRect({ x: b.x + b.w / 2 - Math.max(b.w, min) / 2, y: b.y + b.h / 2 - Math.max(b.h, min) / 2, w: Math.max(b.w, min), h: Math.max(b.h, min) });
}

function togglePanel(open) {
  $('#side-panel').hidden = !open;
  $('#panel-btn').setAttribute('aria-expanded', String(open));
  $('#panel-btn').classList.toggle('active', open);
  renderPanel();
}

$('#panel-btn').addEventListener('click', () => togglePanel($('#side-panel').hidden));
$('#panel-close').addEventListener('click', () => togglePanel(false));
$('#focus-toggle').addEventListener('change', (e) => {
  if (!e.target.checked) clearFocus();
});
$('#focus-opacity').addEventListener('input', (e) => { focusOpacityTouched = true; setFocusOpacity(parseFloat(e.target.value)); });
const zoomToggle = $('#zoom-toggle');
zoomToggle.checked = localStorage.getItem('zoomReveal') === '1';
fade.setZoomReveal(zoomToggle.checked);
zoomToggle.addEventListener('change', (e) => {
  localStorage.setItem('zoomReveal', e.target.checked ? '1' : '0');
  fade.setZoomReveal(e.target.checked);
});

// ---------- notes & hitboxes ----------

const shapesOn = () => $('#show-shapes').checked;
const clickable = (s) => s.kind === 'annotation'
  || (s.kind === 'hitbox' && (s.action === 'url' ? !!s.url : !!s.target_map_id));

function hidePopup() { popup.hidden = true; }

function fillPopup(shape) {
  popup.querySelector('h3').textContent = shape.title || 'Note';
  const img = popup.querySelector('.note-image');
  img.hidden = !shape.image_thumb;
  if (shape.image_thumb) { img.src = shape.image_thumb; img.alt = shape.image_name || ''; }
  popup.querySelector('.note-body').innerHTML = renderMarkdown(shape.body);
  popup.hidden = false;
}

function showPopup(shape, pos) {
  fillPopup(shape);
  const box = viewer.container.getBoundingClientRect();
  const w = popup.offsetWidth, h = popup.offsetHeight;
  popup.style.left = `${Math.max(8, Math.min(box.left + pos.x + 12, window.innerWidth - w - 8))}px`;
  popup.style.top = `${Math.max(8, Math.min(box.top + pos.y + 12, window.innerHeight - h - 8))}px`;
}

function showPopupCentered(shape) {
  const size = viewer.viewport.getContainerSize();
  showPopup(shape, new OpenSeadragon.Point(size.x / 2 - 150, size.y / 2 - 60));
}

// Links inside notes to other maps (?map=…) navigate in place.
popup.addEventListener('click', (e) => {
  const a = e.target.closest('a[data-internal]');
  if (!a) return;
  e.preventDefault();
  const p = new URLSearchParams(a.getAttribute('href').split('?')[1] || '');
  if (p.get('map')) loadMap(p.get('map'), { push: true, focus: p.get('f') || undefined });
});

function activate(hit, pos) {
  if (hit.kind === 'annotation') return showPopup(hit, pos);
  if (hit.action === 'url') {
    window.open(hit.url, '_blank', 'noopener');
    return;
  }
  loadMap(hit.target_map_id, { push: true, focus: hit.target_layer_id || undefined });
}

function hitLabel(hit) {
  if (hit.kind === 'annotation') return hit.title;
  if (hit.title) return hit.title;
  if (hit.action === 'url') {
    try { return `Open ${new URL(hit.url).hostname} ↗`; } catch { return 'Open link ↗'; }
  }
  return `Go to ${hit.target_name}`;
}

// Topmost image that's actually visible under a viewport point.
function layerAt(pt) {
  if (!current) return null;
  for (const { layer } of T.layersTopFirst(current.tree)) {
    if (fade.opacityOf(layer.id) < 0.03) continue;
    if (pt.x >= layer.x && pt.x <= layer.x + layer.width && pt.y >= layer.y && pt.y <= layer.y + T.layerHeight(layer)) return layer;
  }
  return null;
}

viewer.addHandler('canvas-click', (e) => {
  if (!e.quick || !current || !shapesOn()) return hidePopup();
  const pt = viewer.viewport.pointFromPixel(e.position);
  const hit = overlay.hitTest(pt, clickable);
  if (!hit) return hidePopup();
  e.preventDefaultAction = true; // don't zoom
  activate(hit, e.position);
});

viewer.addHandler('canvas-double-click', (e) => {
  const layer = layerAt(viewer.viewport.pointFromPixel(e.position));
  if (!layer) return;
  e.preventDefaultAction = true;
  focus(layer);
  flyTo(layer);
});

function showTooltip(label, x, y) {
  tooltip.hidden = !label;
  if (!label) return;
  tooltip.textContent = label;
  tooltip.style.left = `${Math.min(x + 14, window.innerWidth - tooltip.offsetWidth - 8)}px`;
  tooltip.style.top = `${y + 14}px`;
}

viewer.container.addEventListener('pointermove', (e) => {
  if (e.pointerType === 'touch') return;
  if (!current || !shapesOn() || e.buttons) { tooltip.hidden = true; return; }
  const pos = eventPixel(viewer, e);
  const hit = overlay.hitTest(viewer.viewport.pointFromPixel(pos), clickable);
  viewer.canvas.style.cursor = hit ? 'pointer' : '';
  if ((hit?.id || null) !== hoverId) {
    hoverId = hit?.id || null;
    overlay.render(current.shapes, { hoverId });
    fade.onApply();
  }
  showTooltip(hit && hitLabel(hit), e.clientX, e.clientY);
});
viewer.container.addEventListener('pointerleave', () => { tooltip.hidden = true; });

// Touch: press and hold on a hitbox or note shows its label (a normal tap opens it).
let holdTimer = null;
viewer.container.addEventListener('pointerdown', (e) => {
  if (e.pointerType !== 'touch' || !current || !shapesOn()) return;
  clearTimeout(holdTimer);
  const { clientX, clientY } = e;
  const pt = viewer.viewport.pointFromPixel(eventPixel(viewer, e));
  holdTimer = setTimeout(() => {
    const hit = overlay.hitTest(pt, clickable);
    if (!hit) return;
    showTooltip(hitLabel(hit), clientX - 60, clientY - 70);
    setTimeout(() => { tooltip.hidden = true; }, 2200);
  }, 500);
});
for (const evt of ['pointerup', 'pointercancel', 'pointermove']) {
  viewer.container.addEventListener(evt, (e) => {
    if (e.pointerType === 'touch' && (evt !== 'pointermove' || e.movementX ** 2 + e.movementY ** 2 > 16)) clearTimeout(holdTimer);
  });
}

// ---------- search ----------

const searchBox = $('#search-box');
const searchInput = $('#search');
const results = $('#search-results');
let searchTimer = null;
let searchSeq = 0;

const KIND_ICON = { map: '🗺', image: '🖼', note: '📝', hitbox: '⬚' };

async function runSearch() {
  const q = searchInput.value.trim();
  const seq = ++searchSeq;
  if (q.length < 2) { results.hidden = true; return; }
  const list = await api(`/api/search?q=${encodeURIComponent(q)}`).catch(() => []);
  if (seq !== searchSeq) return;
  results.replaceChildren();
  if (!list.length) {
    results.append(Object.assign(document.createElement('li'), { className: 'none', textContent: 'No results' }));
  }
  for (const r of list) {
    const li = document.createElement('li');
    const icon = document.createElement('span');
    icon.className = 'kind';
    if (r.thumb) icon.append(Object.assign(document.createElement('img'), { src: r.thumb, alt: '' }));
    else icon.textContent = KIND_ICON[r.kind];
    const text = document.createElement('span');
    text.className = 'text';
    text.append(Object.assign(document.createElement('strong'), { textContent: r.label }));
    if (r.kind !== 'map') text.append(Object.assign(document.createElement('small'), { textContent: ` in ${r.map_name}` }));
    if (r.snippet) text.append(Object.assign(document.createElement('em'), { textContent: r.snippet }));
    li.append(icon, text);
    li.addEventListener('click', () => openResult(r));
    results.append(li);
  }
  results.hidden = false;
}

function openResult(r) {
  results.hidden = true;
  searchBox.classList.remove('open');
  searchInput.blur();
  const sameMap = current && current.id === r.map_id;
  if (r.kind === 'map') {
    if (!sameMap) loadMap(r.map_id, { push: true });
  } else if (r.kind === 'image') {
    if (sameMap) {
      const node = T.find(current.tree, r.id)?.node;
      if (node) { flyTo(node); if ($('#focus-toggle').checked) focus(node); }
    } else {
      loadMap(r.map_id, { push: true, focus: r.id });
    }
  } else if (sameMap) {
    const s = current.shapes.find((x) => x.id === r.id);
    if (s) {
      flyToShape(s);
      if (s.kind === 'annotation') setTimeout(() => showPopupCentered(s), 700);
    }
  } else {
    loadMap(r.map_id, { push: true, shape: r.id });
  }
}

searchInput.addEventListener('input', () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(runSearch, 200);
});
searchInput.addEventListener('focus', () => { if (results.children.length && searchInput.value.trim().length >= 2) results.hidden = false; });
searchInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') results.querySelector('li:not(.none)')?.click();
  if (e.key === 'Escape') { results.hidden = true; searchInput.blur(); searchBox.classList.remove('open'); }
});
$('#search-open').addEventListener('click', () => { searchBox.classList.add('open'); searchInput.focus(); });
document.addEventListener('pointerdown', (e) => {
  if (!searchBox.contains(e.target)) { results.hidden = true; if (!searchInput.value) searchBox.classList.remove('open'); }
});

// ---------- share link ----------

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // The clipboard API needs HTTPS; fall back to the old way (works on plain-HTTP home servers).
    const ta = Object.assign(document.createElement('textarea'), { value: text });
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.append(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  }
}

$('#share-btn').addEventListener('click', async () => {
  if (!current) return;
  const vp = viewer.viewport;
  const c = vp.getCenter();
  let link = `${location.origin}/?map=${current.id}&v=${c.x.toFixed(5)},${c.y.toFixed(5)},${vp.getZoom().toFixed(4)}`;
  if (focusedNodeId) link += `&f=${focusedNodeId}`;
  if (await copyText(link)) toast('Link to this view copied');
  else prompt('Copy this link:', link);
});

function parseView(v) {
  const [cx, cy, zoom] = (v || '').split(',').map(Number);
  return [cx, cy, zoom].every(Number.isFinite) && zoom > 0 ? { cx, cy, zoom } : undefined;
}

// ---------- misc ----------

$('#show-shapes').addEventListener('change', (e) => {
  overlay.setVisible(e.target.checked);
  hidePopup();
});
popup.querySelector('.close').addEventListener('click', hidePopup);
mapSelect.addEventListener('change', () => loadMap(mapSelect.value, { push: true, trail: [] }));
$('#back').addEventListener('click', () => history.back());
window.addEventListener('popstate', (e) => {
  if (e.state?.id) loadMap(e.state.id, { trail: e.state.trail });
});
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape' || document.activeElement === searchInput) return;
  if (!popup.hidden) hidePopup();
  else if (focusIds) clearFocus();
});

// ---------- start ----------

(async () => {
  const maps = await loadMapList();
  const start = params.get('map') || maps.find((m) => m.is_default)?.id || maps[0]?.id;
  if (!start) {
    renderCrumbs([{ id: '', name: 'No maps yet' }]);
    showEmpty('No maps have been published yet. Open the admin panel to add one.');
    return;
  }
  loadMap(start, { trail: [], view: parseView(params.get('v')), focus: params.get('f') || undefined });
})();
