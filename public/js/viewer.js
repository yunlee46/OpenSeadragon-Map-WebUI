import { ShapeOverlay, eventPixel, api } from './overlay.js';

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

let current = null;   // the loaded map
let hoverId = null;

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
  viewer.canvas.style.cursor = "";
  let map;
  try {
    map = await api(`/api/maps/${encodeURIComponent(id)}`);
  } catch (err) {
    $('#map-name').textContent = 'Map not found';
    viewer.close();
    overlay.render([]);
    showEmpty(err.status === 404 ? 'This map does not exist (it may have been deleted).' : err.message);
    return;
  }
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

  if (map.layers.length) {
    showEmpty('');
    viewer.open(map.layers.map((l) => ({
      tileSource: l.dzi_url, x: l.x, y: l.y, width: l.width, opacity: l.opacity,
    })));
  } else {
    viewer.close();
    showEmpty('This map has no images yet.');
  }
  hoverId = null;
  overlay.render(map.shapes);
}

// ---------- interaction ----------

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

viewer.addHandler('canvas-click', (e) => {
  if (!e.quick || !current || !shapesOn()) return hidePopup();
  const pt = viewer.viewport.pointFromPixel(e.position);
  const hit = overlay.hitTest(pt, clickable);
  if (!hit) return hidePopup();
  e.preventDefaultAction = true; // don't zoom
  if (hit.kind === 'hitbox') loadMap(hit.target_map_id, { push: true });
  else showPopup(hit, e.position);
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
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') hidePopup(); });

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
