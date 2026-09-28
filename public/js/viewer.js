import { ShapeOverlay, eventPixel, api } from './overlay.js';
import * as T from './tree.js';
import { FadeController } from './fade.js';
import { renderOutliner } from './outliner.js';

const $ = (sel) => document.querySelector(sel);
const params = new URLSearchParams(location.search);

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
  debugMode: params.get('debug') === '1', // ?debug=1 draws tile borders and pyramid levels
});
const overlay = new ShapeOverlay(viewer);

let current = null;       // the loaded map
let loadToken = 0;
let hoverId = null;
let focusIds = null;
const collapsed = new Map();

// [{ layer, hidden: false, item }] bottom first (hidden images never reach the viewer).
const drawOrder = () => (current ? T.layersTopFirst(current.tree).reverse().map((e) => ({ ...e, item: e.layer.item })) : []);
const fade = new FadeController(viewer, drawOrder);

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

async function loadMap(id, { push = false } = {}) {
  hidePopup();
  tooltip.hidden = true;
  viewer.canvas.style.cursor = '';
  const token = ++loadToken;
  let map;
  try {
    map = await api(`/api/maps/${encodeURIComponent(id)}`);
  } catch (err) {
    if (token !== loadToken) return;
    $('#map-name').textContent = 'Map not found';
    current = null;
    viewer.world.removeAll();
    overlay.render([]);
    renderPanel();
    showEmpty(err.status === 404 ? 'This map does not exist (it may have been deleted).' : err.message);
    return;
  }
  if (token !== loadToken) return;
  current = map;
  document.title = map.name;
  $('#map-name').textContent = map.name;
  mapSelect.value = map.id;
  viewer.container.style.background = map.background;

  if (push) {
    const depth = (history.state?.depth || 0) + 1;
    history.pushState({ id: map.id, depth }, '', `?map=${map.id}`);
  } else {
    history.replaceState({ id: map.id, depth: history.state?.depth || 0 }, '', `?map=${map.id}`);
  }
  $('#back').hidden = !(history.state?.depth > 0);

  focusIds = null;
  fade.setFocus(null);
  fade.setTypes(map.types);
  if (!focusOpacityTouched) setFocusOpacity(map.settings.focus_opacity);
  $('#focus-toggle').checked = false;
  collapsed.clear();
  T.walk(map.tree, (n) => { if (n.kind === 'group') collapsed.set(n.id, n.collapsed); });

  viewer.world.removeAll();
  const layers = drawOrder();
  showEmpty(layers.length ? '' : 'This map has no images yet.');
  await Promise.all(layers.map(({ layer }) => new Promise((resolve) => {
    viewer.addTiledImage({
      tileSource: layer.dzi_url, x: layer.x, y: layer.y, width: layer.width, opacity: 0,
      success: (e) => { layer.item = e.item; resolve(); },
      error: () => resolve(),
    });
  })));
  if (token !== loadToken) return;
  viewer.viewport.goHome(true);
  fade.refresh();
  hoverId = null;
  overlay.render(map.shapes);
  renderPanel();
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
    },
    onDblClick: (n) => focus(n),
  });
}

function focus(n) {
  focusIds = new Set([n.id, ...T.descendantLayers(n).map((l) => l.id)]);
  fade.setFocus(focusIds);
  $('#focus-toggle').checked = true;
  renderPanel();
}

function clearFocus() {
  focusIds = null;
  fade.setFocus(null);
  $('#focus-toggle').checked = false;
  renderPanel();
}

function flyTo(n) {
  const b = T.unionBounds(T.descendantLayers(n));
  if (!b) return;
  const pad = Math.max(b.w, b.h) * 0.08;
  viewer.viewport.fitBounds(new OpenSeadragon.Rect(b.x - pad, b.y - pad, b.w + pad * 2, b.h + pad * 2));
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

// ---------- map interaction ----------

const shapesOn = () => $('#show-shapes').checked;
const clickable = (s) => s.kind === 'annotation' || (s.kind === 'hitbox' && s.target_map_id);

function hidePopup() { popup.hidden = true; }

function showPopup(shape, pos) {
  popup.querySelector('h3').textContent = shape.title || 'Note';
  popup.querySelector('p').textContent = shape.body || '';
  popup.hidden = false;
  const box = viewer.container.getBoundingClientRect();
  const w = popup.offsetWidth, h = popup.offsetHeight;
  popup.style.left = `${Math.min(box.left + pos.x + 12, window.innerWidth - w - 8)}px`;
  popup.style.top = `${Math.min(box.top + pos.y + 12, window.innerHeight - h - 8)}px`;
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
  if (hit.kind === 'hitbox') loadMap(hit.target_map_id, { push: true });
  else showPopup(hit, e.position);
});

viewer.addHandler('canvas-double-click', (e) => {
  const layer = layerAt(viewer.viewport.pointFromPixel(e.position));
  if (!layer) return;
  e.preventDefaultAction = true;
  focus(layer);
  flyTo(layer);
});

viewer.container.addEventListener('pointermove', (e) => {
  if (!current || !shapesOn() || e.buttons) { tooltip.hidden = true; return; }
  const pos = eventPixel(viewer, e);
  const hit = overlay.hitTest(viewer.viewport.pointFromPixel(pos), clickable);
  viewer.canvas.style.cursor = hit ? 'pointer' : '';
  if ((hit?.id || null) !== hoverId) {
    hoverId = hit?.id || null;
    overlay.render(current.shapes, { hoverId });
  }
  const label = hit && (hit.kind === 'hitbox' ? (hit.title || `Go to ${hit.target_name}`) : hit.title);
  tooltip.hidden = !label;
  if (label) {
    tooltip.textContent = label;
    tooltip.style.left = `${e.clientX + 14}px`;
    tooltip.style.top = `${e.clientY + 14}px`;
  }
});
viewer.container.addEventListener('pointerleave', () => { tooltip.hidden = true; });

$('#show-shapes').addEventListener('change', (e) => {
  overlay.setVisible(e.target.checked);
  hidePopup();
});
popup.querySelector('.close').addEventListener('click', hidePopup);
mapSelect.addEventListener('change', () => loadMap(mapSelect.value, { push: true }));
$('#back').addEventListener('click', () => history.back());
window.addEventListener('popstate', (e) => { if (e.state?.id) loadMap(e.state.id); });
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (!popup.hidden) hidePopup();
  else if (focusIds) clearFocus();
});

// ---------- start ----------

(async () => {
  const maps = await loadMapList();
  const start = params.get('map') || maps.find((m) => m.is_default)?.id || maps[0]?.id;
  if (!start) {
    $('#map-name').textContent = 'No maps yet';
    showEmpty('No maps have been created yet. Open the admin panel to add one.');
    return;
  }
  loadMap(start);
})();
