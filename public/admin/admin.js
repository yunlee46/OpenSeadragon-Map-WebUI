import {
  ShapeOverlay, api, eventPixel, rectFromPoints, translateShape, moveVertex,
} from '/js/overlay.js';

const $ = (sel, root = document) => root.querySelector(sel);
const h = (tag, props = {}, ...children) => {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else if (k === 'class') n.className = v;
    else if (k in n && k !== 'list') n[k] = v;
    else n.setAttribute(k, v);
  }
  n.append(...children.flat().filter((c) => c != null && c !== false));
  return n;
};
const newId = () => [...crypto.getRandomValues(new Uint8Array(8))].map((b) => b.toString(16).padStart(2, '0')).join('');
const Pt = (x, y) => new OpenSeadragon.Point(x, y);

// ======================================================================
// Auth
// ======================================================================

async function start() {
  const { admin } = await api('/api/me');
  $('#login-view').hidden = admin;
  $('#app').hidden = !admin;
  if (admin) route();
}

$('#login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = new FormData(e.target);
  try {
    await api('/api/login', { method: 'POST', body: { username: form.get('username'), password: form.get('password') } });
    $('#login-error').textContent = '';
    e.target.reset();
    start();
  } catch (err) {
    $('#login-error').textContent = err.message;
  }
});

$('#logout').addEventListener('click', async () => {
  if (!confirmLeaveEditor()) return;
  editor.dirty = false;
  await api('/api/logout', { method: 'POST' });
  start();
});

// Any 401 means the session expired.
async function adminApi(url, opts) {
  try {
    return await api(url, opts);
  } catch (err) {
    if (err.status === 401) {
      alert('Your session has expired. Please log in again. (Unsaved editor changes are still on screen; log in in another tab to keep them.)');
    }
    throw err;
  }
}

// ======================================================================
// Routing: #/maps, #/images, #/edit/<id>
// ======================================================================

let currentRoute = null;
let skipHashChange = false;

function confirmLeaveEditor() {
  return !(currentRoute?.startsWith('edit') && editor.dirty) || confirm('You have unsaved changes on this map. Leave anyway?');
}

window.addEventListener('hashchange', () => {
  if (skipHashChange) { skipHashChange = false; return; }
  if (!confirmLeaveEditor()) {
    skipHashChange = true;
    location.hash = `#/${currentRoute.replace(':', '/')}`;
    return;
  }
  route();
});
window.addEventListener('beforeunload', (e) => {
  if (editor.dirty) { e.preventDefault(); e.returnValue = ''; }
});

function route() {
  const [, page, id] = location.hash.match(/^#\/(\w+)(?:\/(\w+))?/) || [null, 'maps'];
  for (const v of ['maps', 'images', 'editor']) $(`#${v}-view`).hidden = true;
  document.querySelectorAll('[data-nav]').forEach((a) => a.classList.toggle('active', a.dataset.nav === page));
  stopImagePolling();
  editor.dirty = false;
  if (page === 'images') { currentRoute = 'images'; showImages(); }
  else if (page === 'edit' && id) { currentRoute = `edit:${id}`; openEditor(id); }
  else { currentRoute = 'maps'; showMaps(); }
}

// ======================================================================
// Maps list
// ======================================================================

async function showMaps() {
  $('#maps-view').hidden = false;
  const maps = await adminApi('/api/maps');
  const tbody = $('#maps-list');
  tbody.replaceChildren();
  if (!maps.length) tbody.append(h('tr', {}, h('td', { colSpan: 3, class: 'muted' }, 'No maps yet. Create one above.')));
  for (const m of maps) {
    tbody.append(h('tr', {},
      h('td', {}, h('a', { href: `#/edit/${m.id}` }, m.name), m.is_default ? h('span', { class: 'badge' }, 'default') : null),
      h('td', { class: 'muted' }, `${m.layer_count} image${m.layer_count === 1 ? '' : 's'}, ${m.shape_count} shape${m.shape_count === 1 ? '' : 's'}`),
      h('td', { class: 'actions' },
        h('a', { class: 'btn small', href: `#/edit/${m.id}` }, 'Edit'),
        h('a', { class: 'btn small ghost', href: `/?map=${m.id}`, target: '_blank' }, 'View'),
        m.is_default ? null : h('button', { class: 'btn small ghost', onclick: () => setDefault(m) }, 'Make default'),
        h('button', { class: 'btn small ghost', onclick: () => renameMap(m) }, 'Rename'),
        h('button', { class: 'btn small danger', onclick: () => deleteMap(m) }, 'Delete'),
      ),
    ));
  }
}

$('#new-map-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const name = e.target.name.value.trim();
  if (!name) return;
  const { id } = await adminApi('/api/admin/maps', { method: 'POST', body: { name } });
  e.target.reset();
  location.hash = `#/edit/${id}`;
});

async function setDefault(m) {
  await adminApi(`/api/admin/maps/${m.id}`, { method: 'PATCH', body: { is_default: true } });
  showMaps();
}
async function renameMap(m) {
  const name = prompt('New name for this map:', m.name);
  if (!name?.trim()) return;
  await adminApi(`/api/admin/maps/${m.id}`, { method: 'PATCH', body: { name } });
  showMaps();
}
async function deleteMap(m) {
  if (!confirm(`Delete the map "${m.name}"?\n\nIts placements, hitboxes and notes are deleted. Hitboxes on other maps that link here become unlinked. The images stay in the library.`)) return;
  await adminApi(`/api/admin/maps/${m.id}`, { method: 'DELETE' });
  showMaps();
}

// ======================================================================
// Image library
// ======================================================================

let imagePoll = null;
const stopImagePolling = () => { clearTimeout(imagePoll); imagePoll = null; };

async function showImages() {
  $('#images-view').hidden = false;
  const images = await adminApi('/api/admin/images');
  const grid = $('#images-list');
  grid.replaceChildren();
  if (!images.length) grid.append(h('p', { class: 'muted' }, 'No images yet.'));
  for (const img of images) grid.append(imageCard(img));

  stopImagePolling();
  if (images.some((i) => i.status === 'processing') && currentRoute === 'images') {
    imagePoll = setTimeout(showImages, 2000);
  }
}

function imageCard(img) {
  const thumb = img.status === 'ready'
    ? h('img', { src: img.thumb_url, alt: '', loading: 'lazy', onerror: (e) => e.target.replaceWith(h('div', { class: 'thumb-missing' }, 'no preview')) })
    : h('div', { class: `thumb-status ${img.status}` }, img.status === 'processing' ? 'Tiling…' : 'Failed');
  return h('div', { class: 'card image-card' },
    h('div', { class: 'thumb' }, thumb),
    h('div', { class: 'name', title: img.name }, img.name),
    img.status === 'ready' ? h('div', { class: 'muted small' }, `${img.width.toLocaleString()} × ${img.height.toLocaleString()} px`) : null,
    img.status === 'error' ? h('div', { class: 'error small' }, img.error) : null,
    img.used_in.length ? h('div', { class: 'muted small' }, 'On: ', img.used_in.map((m) => m.name).join(', ')) : null,
    h('div', { class: 'actions' },
      h('button', { class: 'btn small ghost', onclick: () => renameImage(img) }, 'Rename'),
      h('button', { class: 'btn small danger', onclick: () => deleteImage(img) }, 'Delete'),
    ),
  );
}

async function renameImage(img) {
  const name = prompt('New name for this image:', img.name);
  if (!name?.trim()) return;
  await adminApi(`/api/admin/images/${img.id}`, { method: 'PATCH', body: { name } });
  showImages();
}

async function deleteImage(img) {
  const used = img.used_in.length ? `\n\nIt is placed on: ${img.used_in.map((m) => m.name).join(', ')}. It will be removed from those maps.` : '';
  if (!confirm(`Delete "${img.name}" and its tiles permanently?${used}`)) return;
  await adminApi(`/api/admin/images/${img.id}`, { method: 'DELETE' });
  showImages();
}

function uploadFiles(files) {
  if (!files.length) return;
  const form = new FormData();
  for (const f of files) form.append('files', f);
  const bar = $('#upload-progress');
  bar.hidden = false;
  const xhr = new XMLHttpRequest();
  xhr.open('POST', '/api/admin/images');
  xhr.upload.onprogress = (e) => {
    if (!e.lengthComputable) return;
    const pct = Math.round((e.loaded / e.total) * 100);
    bar.firstElementChild.style.width = `${pct}%`;
    bar.lastElementChild.textContent = pct < 100 ? `Uploading ${files.length} file(s)… ${pct}%` : 'Upload done, tiling…';
  };
  xhr.onload = () => {
    bar.hidden = true;
    if (xhr.status >= 400) {
      let msg = 'Upload failed';
      try { msg = JSON.parse(xhr.responseText).error || msg; } catch { /* keep default */ }
      alert(msg);
    }
    showImages();
  };
  xhr.onerror = () => { bar.hidden = true; alert('Upload failed (network error)'); };
  xhr.send(form);
}

const dz = $('#dropzone');
$('#file-input').addEventListener('change', (e) => { uploadFiles([...e.target.files]); e.target.value = ''; });
dz.addEventListener('dragover', (e) => { e.preventDefault(); dz.classList.add('over'); });
dz.addEventListener('dragleave', () => dz.classList.remove('over'));
dz.addEventListener('drop', (e) => { e.preventDefault(); dz.classList.remove('over'); uploadFiles([...e.dataTransfer.files]); });

// ======================================================================
// Map editor
// ======================================================================

const editor = {
  viewer: null,
  overlay: null,
  map: null,
  maps: [],          // all maps (hitbox targets)
  images: [],        // ready images in the library
  layers: [],        // { id, image_id, image_name, px_width, px_height, dzi_url, x, y, width, opacity, item }
  shapes: [],        // { id, kind, geometry, target_map_id, title, body, color }
  tool: 'pan',
  drawKind: 'hitbox',
  selected: null,    // { type: 'layer' | 'shape', id }
  drag: null,
  draft: null,       // { geometry, open } — shape being drawn
  cursor: null,      // viewport point under the mouse while drawing polygons
  dirty: false,
};

function initEditorViewer() {
  if (editor.viewer) return;
  const viewer = OpenSeadragon({
    id: 'editor-viewer',
    prefixUrl: '/vendor/osd/images/',
    showNavigator: true,
    navigatorPosition: 'BOTTOM_RIGHT',
    showRotationControl: false,
    gestureSettingsMouse: { clickToZoom: false, dblClickToZoom: false },
    visibilityRatio: 0,
    minZoomImageRatio: 0.1,
    maxZoomPixelRatio: 6,
    animationTime: 0.5,
  });
  editor.viewer = viewer;
  editor.overlay = new ShapeOverlay(viewer);

  viewer.addHandler('canvas-press', onPress);
  viewer.addHandler('canvas-drag', onDrag);
  viewer.addHandler('canvas-drag-end', (e) => { if (editor.drag) e.preventDefaultAction = true; });
  viewer.addHandler('canvas-release', onRelease);
  viewer.addHandler('canvas-click', onClick);
  viewer.addHandler('canvas-double-click', () => { if (editor.tool === 'polygon') finishPolygon(); });
  viewer.container.addEventListener('pointermove', onHover);
}

async function openEditor(id) {
  $('#editor-view').hidden = false;
  initEditorViewer();
  let map, maps, images;
  try {
    [map, maps, images] = await Promise.all([
      adminApi(`/api/maps/${id}`), adminApi('/api/maps'), adminApi('/api/admin/images'),
    ]);
  } catch (err) {
    alert(err.status === 404 ? 'That map does not exist.' : err.message);
    location.hash = '#/maps';
    return;
  }
  Object.assign(editor, {
    map, maps, images: images.filter((i) => i.status === 'ready'),
    shapes: map.shapes.map(({ target_name, ...s }) => s),
    layers: map.layers.map((l) => ({ ...l, item: null })),
    selected: null, drag: null, draft: null, dirty: false,
  });

  $('#map-name-input').value = map.name;
  $('#map-bg-input').value = map.background;
  $('#map-default-input').checked = map.is_default;
  $('#view-map-link').href = `/?map=${map.id}`;
  editor.viewer.container.style.background = map.background;

  const select = $('#add-image-select');
  select.replaceChildren(
    h('option', { value: '' }, editor.images.length ? 'Choose an image…' : 'Library is empty — upload images first'),
    ...editor.images.map((i) => h('option', { value: i.id }, i.name)),
  );

  const viewer = editor.viewer;
  viewer.world.removeAll();
  await Promise.all(editor.layers.map(addLayerItem));
  viewer.viewport.goHome(true);
  setTool('pan');
  setDirty(false);
  renderAll();
}

function addLayerItem(layer) {
  return new Promise((resolve) => {
    editor.viewer.addTiledImage({
      tileSource: layer.dzi_url, x: layer.x, y: layer.y, width: layer.width, opacity: layer.opacity,
      success: (e) => { layer.item = e.item; resolve(); },
      error: (e) => { console.error('Could not load', layer.dzi_url, e); resolve(); },
    });
  });
}

function setDirty(v = true) {
  editor.dirty = v;
  $('#dirty').hidden = !v;
}

// ---------- rendering ----------

const selectedLayer = () => editor.selected?.type === 'layer' && editor.layers.find((l) => l.id === editor.selected.id);
const selectedShape = () => editor.selected?.type === 'shape' && editor.shapes.find((s) => s.id === editor.selected.id);
const layerHeight = (l) => l.width * (l.px_height / l.px_width);

function renderOverlay() {
  const layer = selectedLayer();
  let draft = editor.draft;
  if (draft && draft.open && editor.cursor) {
    draft = { ...draft, geometry: { type: 'polygon', points: [...draft.geometry.points, [editor.cursor.x, editor.cursor.y]] } };
  }
  editor.overlay.render(editor.shapes, {
    selectedId: editor.selected?.type === 'shape' ? editor.selected.id : null,
    handles: editor.tool === 'select',
    outline: layer ? { x: layer.x, y: layer.y, width: layer.width, height: layerHeight(layer) } : null,
    draft,
  });
}

function renderLists() {
  const sel = editor.selected;
  const layersList = $('#layers-list');
  layersList.replaceChildren();
  if (!editor.layers.length) layersList.append(h('li', { class: 'muted' }, 'No images placed yet.'));
  // Topmost first.
  [...editor.layers].reverse().forEach((l) => {
    layersList.append(h('li', {
      class: sel?.type === 'layer' && sel.id === l.id ? 'active' : '',
      onclick: () => select('layer', l.id),
    }, h('span', { class: 'dot', style: 'background:#888' }), l.image_name));
  });

  const shapesList = $('#shapes-list');
  shapesList.replaceChildren();
  if (!editor.shapes.length) shapesList.append(h('li', { class: 'muted' }, 'Use Rect or Polygon to draw one.'));
  editor.shapes.forEach((s) => {
    const target = editor.maps.find((m) => m.id === s.target_map_id);
    const label = s.kind === 'hitbox'
      ? `${s.title || 'Hitbox'} → ${target ? target.name : '(no target)'}`
      : `📝 ${s.title || 'Untitled note'}`;
    shapesList.append(h('li', {
      class: sel?.type === 'shape' && sel.id === s.id ? 'active' : '',
      onclick: () => { select('shape', s.id); focusShape(s); },
    }, h('span', { class: 'dot', style: `background:${s.color}` }), label));
  });
}

function renderProps() {
  const props = $('#props');
  props.replaceChildren();
  const add = (...nodes) => props.append(...nodes.filter(Boolean));
  const layer = selectedLayer();
  const shape = selectedShape();

  if (layer) {
    const num = (key, label, step) => h('label', { class: 'row' }, label, h('input', {
      type: 'number', step, value: +layer[key].toFixed(4), 'data-key': key,
      oninput: (e) => { const v = parseFloat(e.target.value); if (Number.isFinite(v)) updateLayer(layer, { [key]: v }); },
    }));
    const idx = editor.layers.indexOf(layer);
    add(
      h('h3', {}, 'Selected image'),
      h('p', { class: 'muted small' }, layer.image_name, ` (${layer.px_width} × ${layer.px_height} px)`),
      h('p', { class: 'hint small' }, 'Drag it with the Move tool, or type exact values.'),
      num('x', 'X', 0.01), num('y', 'Y', 0.01), num('width', 'Width', 0.01),
      h('div', { class: 'btn-row' },
        h('button', { class: 'btn small', onclick: () => updateLayer(layer, { width: layer.width * 0.8 }, true) }, '− Smaller'),
        h('button', { class: 'btn small', onclick: () => updateLayer(layer, { width: layer.width * 1.25 }, true) }, '+ Bigger'),
      ),
      h('label', { class: 'row' }, 'Opacity', h('input', {
        type: 'range', min: 0, max: 1, step: 0.05, value: layer.opacity,
        oninput: (e) => updateLayer(layer, { opacity: parseFloat(e.target.value) }),
      })),
      h('div', { class: 'btn-row' },
        h('button', { class: 'btn small', disabled: idx === editor.layers.length - 1, onclick: () => reorderLayer(layer, 1) }, 'Bring forward'),
        h('button', { class: 'btn small', disabled: idx === 0, onclick: () => reorderLayer(layer, -1) }, 'Send back'),
      ),
      h('button', { class: 'btn small danger', onclick: () => removeLayer(layer) }, 'Remove from map'),
    );
  } else if (shape) {
    const isHit = shape.kind === 'hitbox';
    add(
      h('h3', {}, isHit ? 'Hitbox' : 'Note'),
      h('label', { class: 'row' }, 'Type', h('select', {
        onchange: (e) => { updateShape(shape, { kind: e.target.value }); renderProps(); },
      }, h('option', { value: 'hitbox', selected: isHit }, 'Hitbox (link to map)'), h('option', { value: 'annotation', selected: !isHit }, 'Note (annotation)'))),
      isHit ? h('label', {}, 'Goes to map', h('select', {
        onchange: (e) => updateShape(shape, { target_map_id: e.target.value || null }),
      }, h('option', { value: '' }, '— choose a map —'),
      ...editor.maps.filter((m) => m.id !== editor.map.id).map((m) => h('option', { value: m.id, selected: m.id === shape.target_map_id }, m.name)))) : null,
      h('label', {}, isHit ? 'Label (shown on hover, optional)' : 'Title', h('input', {
        value: shape.title, maxLength: 300, oninput: (e) => updateShape(shape, { title: e.target.value }),
      })),
      isHit ? null : h('label', {}, 'Text', h('textarea', {
        rows: 6, value: shape.body, maxLength: 20000, oninput: (e) => updateShape(shape, { body: e.target.value }),
      })),
      h('label', { class: 'row' }, 'Colour', h('input', {
        type: 'color', value: shape.color, oninput: (e) => updateShape(shape, { color: e.target.value }),
      })),
      h('p', { class: 'hint small' }, 'With the Select tool: drag the shape to move it, drag its corner handles to reshape it.'),
      h('button', { class: 'btn small danger', onclick: () => removeShape(shape) }, 'Delete shape'),
    );
  } else {
    add(h('p', { class: 'hint small' }, 'Select an image or a shape to edit it.'));
  }
}

function renderAll() {
  renderOverlay();
  renderLists();
  renderProps();
}

// Refresh X/Y/width inputs while dragging without rebuilding the panel.
function syncLayerInputs(layer) {
  for (const input of document.querySelectorAll('#props input[data-key]')) {
    if (document.activeElement !== input) input.value = +layer[input.dataset.key].toFixed(4);
  }
}

function select(type, id) {
  editor.selected = type ? { type, id } : null;
  renderAll();
}

function focusShape(s) {
  const g = s.geometry;
  const xs = g.type === 'rect' ? [g.x, g.x + g.w] : g.points.map((p) => p[0]);
  const ys = g.type === 'rect' ? [g.y, g.y + g.h] : g.points.map((p) => p[1]);
  editor.viewer.viewport.panTo(Pt((Math.min(...xs) + Math.max(...xs)) / 2, (Math.min(...ys) + Math.max(...ys)) / 2));
}

// ---------- layer operations ----------

function addImageToMap(imageId) {
  const img = editor.images.find((i) => i.id === imageId);
  if (!img) return;
  // Keep the same pixel density as the first image on the map, so sizes stay comparable.
  const ref = editor.layers[0];
  const width = ref ? img.width * (ref.width / ref.px_width) : 1;
  let x = 0, y = 0;
  if (editor.layers.length) {
    const right = Math.max(...editor.layers.map((l) => l.x + l.width));
    const top = Math.min(...editor.layers.map((l) => l.y));
    x = right + width * 0.05;
    y = top;
  }
  const layer = {
    id: newId(), image_id: img.id, image_name: img.name, px_width: img.width, px_height: img.height,
    dzi_url: img.dzi_url, x, y, width, opacity: 1, item: null,
  };
  editor.layers.push(layer);
  addLayerItem(layer).then(() => editor.viewer.viewport.goHome());
  setDirty();
  select('layer', layer.id);
  if (editor.tool !== 'move') setTool('move');
}

function updateLayer(layer, changes, rerenderProps = false) {
  Object.assign(layer, changes);
  const item = layer.item;
  if (item) {
    if ('x' in changes || 'y' in changes) item.setPosition(Pt(layer.x, layer.y), true);
    if ('width' in changes) item.setWidth(layer.width, true);
    if ('opacity' in changes) item.setOpacity(layer.opacity);
  }
  setDirty();
  renderOverlay();
  if (rerenderProps) renderProps(); else syncLayerInputs(layer);
}

function reorderLayer(layer, dir) {
  const i = editor.layers.indexOf(layer);
  const j = i + dir;
  if (j < 0 || j >= editor.layers.length) return;
  [editor.layers[i], editor.layers[j]] = [editor.layers[j], editor.layers[i]];
  editor.layers.forEach((l, idx) => { if (l.item) editor.viewer.world.setItemIndex(l.item, Math.min(idx, editor.viewer.world.getItemCount() - 1)); });
  setDirty();
  renderAll();
}

function removeLayer(layer) {
  if (!confirm(`Remove "${layer.image_name}" from this map? (It stays in the image library.)`)) return;
  if (layer.item) editor.viewer.world.removeItem(layer.item);
  editor.layers.splice(editor.layers.indexOf(layer), 1);
  editor.selected = null;
  setDirty();
  renderAll();
}

// ---------- shape operations ----------

function addShape(geometry) {
  const kind = editor.drawKind;
  const shape = {
    id: newId(), kind, geometry, target_map_id: null, title: '', body: '',
    color: kind === 'hitbox' ? '#4da3ff' : '#ffb020',
  };
  editor.shapes.push(shape);
  setDirty();
  select('shape', shape.id);
}

function updateShape(shape, changes) {
  Object.assign(shape, changes);
  setDirty();
  renderOverlay();
  renderLists();
}

function removeShape(shape) {
  editor.shapes.splice(editor.shapes.indexOf(shape), 1);
  editor.selected = null;
  setDirty();
  renderAll();
}

// ---------- tools & pointer handling ----------

const HINTS = {
  pan: 'Drag to pan, scroll to zoom.',
  move: 'Drag an image to move it. Drag empty space to pan.',
  select: 'Click a shape to select it. Drag to move it; drag the square handles to reshape. Delete key removes it.',
  rect: 'Drag to draw a rectangle.',
  polygon: 'Click to add points. Click the first point, double-click, or press Enter to finish. Backspace removes the last point, Esc cancels.',
};

function setTool(tool) {
  editor.tool = tool;
  editor.draft = null;
  editor.drag = null;
  document.querySelectorAll('#toolbar [data-tool]').forEach((b) => b.classList.toggle('active', b.dataset.tool === tool));
  $('#tool-hint').textContent = HINTS[tool];
  editor.viewer.canvas.style.cursor = { pan: '', move: 'move', select: 'default', rect: 'crosshair', polygon: 'crosshair' }[tool];
  renderOverlay();
}

const toPoint = (pos) => editor.viewer.viewport.pointFromPixel(pos);

function layerAt(pt) {
  for (let i = editor.layers.length - 1; i >= 0; i--) {
    const l = editor.layers[i];
    if (pt.x >= l.x && pt.x <= l.x + l.width && pt.y >= l.y && pt.y <= l.y + layerHeight(l)) return l;
  }
  return null;
}

function onPress(e) {
  const pt = toPoint(e.position);
  editor.drag = null;
  switch (editor.tool) {
    case 'move': {
      const layer = layerAt(pt);
      if (layer) {
        editor.drag = { type: 'layer', layer, start: pt, ox: layer.x, oy: layer.y };
        if (selectedLayer() !== layer) select('layer', layer.id);
      }
      break;
    }
    case 'select': {
      const sel = selectedShape();
      const handle = sel ? editor.overlay.handleAt(e.position) : -1;
      if (handle >= 0) {
        editor.drag = { type: 'vertex', shape: sel, index: handle, orig: sel.geometry };
        break;
      }
      const hit = editor.overlay.hitTest(pt);
      if (hit) {
        editor.drag = { type: 'shape', shape: hit, start: pt, orig: hit.geometry };
        if (sel !== hit) select('shape', hit.id);
      } else if (editor.selected) {
        select(null);
      }
      break;
    }
    case 'rect':
      editor.drag = { type: 'rect', start: pt };
      editor.draft = { geometry: rectFromPoints(pt, pt) };
      break;
    default:
  }
}

function onDrag(e) {
  const d = editor.drag;
  if (!d) return;
  e.preventDefaultAction = true; // no panning while editing
  const pt = toPoint(e.position);
  if (d.type === 'layer') {
    updateLayer(d.layer, { x: d.ox + pt.x - d.start.x, y: d.oy + pt.y - d.start.y });
  } else if (d.type === 'shape') {
    d.shape.geometry = translateShape(d.orig, pt.x - d.start.x, pt.y - d.start.y);
    d.moved = true;
    renderOverlay();
  } else if (d.type === 'vertex') {
    d.shape.geometry = moveVertex(d.orig, d.index, pt.x, pt.y);
    d.moved = true;
    renderOverlay();
  } else if (d.type === 'rect') {
    editor.draft = { geometry: rectFromPoints(d.start, pt) };
    renderOverlay();
  }
}

function onRelease() {
  const d = editor.drag;
  editor.drag = null;
  if (!d) return;
  if (d.moved) setDirty();
  if (d.type === 'rect') {
    const g = editor.draft.geometry;
    editor.draft = null;
    const px = g.w * editor.overlay.scale;
    const py = g.h * editor.overlay.scale;
    if (px >= 4 && py >= 4) addShape(g); else renderOverlay();
  }
}

function onClick(e) {
  if (editor.tool !== 'polygon' || !e.quick) return;
  const pt = toPoint(e.position);
  if (!editor.draft) {
    editor.draft = { open: true, geometry: { type: 'polygon', points: [[pt.x, pt.y]] } };
  } else {
    const pts = editor.draft.geometry.points;
    const first = editor.overlay.toPixel(pts[0][0], pts[0][1]);
    if (pts.length >= 3 && Math.hypot(first.x - e.position.x, first.y - e.position.y) < 10) return finishPolygon();
    pts.push([pt.x, pt.y]);
  }
  renderOverlay();
}

function finishPolygon() {
  const draft = editor.draft;
  if (!draft?.open) return;
  // Drop points that landed on top of each other (e.g. from a double-click).
  const pts = [];
  for (const p of draft.geometry.points) {
    const last = pts[pts.length - 1];
    if (!last) { pts.push(p); continue; }
    const a = editor.overlay.toPixel(last[0], last[1]);
    const b = editor.overlay.toPixel(p[0], p[1]);
    if (Math.hypot(a.x - b.x, a.y - b.y) > 3) pts.push(p);
  }
  editor.draft = null;
  editor.cursor = null;
  if (pts.length >= 3) addShape({ type: 'polygon', points: pts });
  else renderOverlay();
}

function onHover(e) {
  if (editor.tool === 'polygon' && editor.draft?.open) {
    editor.cursor = toPoint(eventPixel(editor.viewer, e));
    renderOverlay();
  } else if (editor.tool === 'select') {
    const pos = eventPixel(editor.viewer, e);
    const onHandle = selectedShape() && editor.overlay.handleAt(pos) >= 0;
    const onShape = editor.overlay.hitTest(toPoint(pos));
    editor.viewer.canvas.style.cursor = onHandle ? 'crosshair' : onShape ? 'move' : 'default';
  } else if (editor.tool === 'move') {
    editor.viewer.canvas.style.cursor = layerAt(toPoint(eventPixel(editor.viewer, e))) ? 'move' : 'grab';
  }
}

document.addEventListener('keydown', (e) => {
  if ($('#editor-view').hidden) return;
  const typing = ['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName);
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); save(); return; }
  if (typing) return;
  if (editor.tool === 'polygon' && editor.draft) {
    if (e.key === 'Enter') { finishPolygon(); return; }
    if (e.key === 'Escape') { editor.draft = null; renderOverlay(); return; }
    if (e.key === 'Backspace') {
      e.preventDefault();
      editor.draft.geometry.points.pop();
      if (!editor.draft.geometry.points.length) editor.draft = null;
      renderOverlay();
      return;
    }
  }
  if (e.key === 'Escape') { select(null); return; }
  if (e.key === 'Delete' || e.key === 'Backspace') {
    const shape = selectedShape();
    const layer = selectedLayer();
    if (shape) removeShape(shape);
    else if (layer) removeLayer(layer);
    return;
  }
  const tool = { h: 'pan', m: 'move', s: 'select', r: 'rect', p: 'polygon' }[e.key.toLowerCase()];
  if (tool && !e.ctrlKey && !e.metaKey && !e.altKey) setTool(tool);
});

// ---------- toolbar & panel wiring ----------

document.querySelectorAll('#toolbar [data-tool]').forEach((b) => b.addEventListener('click', () => setTool(b.dataset.tool)));
document.querySelectorAll('input[name="draw-kind"]').forEach((r) => r.addEventListener('change', (e) => { editor.drawKind = e.target.value; }));
$('#home-btn').addEventListener('click', () => editor.viewer.viewport.goHome());
$('#add-image-btn').addEventListener('click', () => {
  const id = $('#add-image-select').value;
  if (id) addImageToMap(id);
  $('#add-image-select').value = '';
});
$('#map-name-input').addEventListener('input', () => setDirty());
$('#map-default-input').addEventListener('change', () => setDirty());
$('#map-bg-input').addEventListener('input', (e) => { editor.viewer.container.style.background = e.target.value; setDirty(); });
$('#save-btn').addEventListener('click', () => save());

async function save() {
  if (!editor.map) return;
  const unlinked = editor.shapes.filter((s) => s.kind === 'hitbox' && !s.target_map_id).length;
  const btn = $('#save-btn');
  btn.disabled = true;
  btn.textContent = 'Saving…';
  try {
    const name = $('#map-name-input').value.trim() || editor.map.name;
    const settings = { name, background: $('#map-bg-input').value };
    if ($('#map-default-input').checked) settings.is_default = true;
    await adminApi(`/api/admin/maps/${editor.map.id}`, { method: 'PATCH', body: settings });
    await adminApi(`/api/admin/maps/${editor.map.id}/content`, {
      method: 'PUT',
      body: {
        layers: editor.layers.map(({ id, image_id, x, y, width, opacity }) => ({ id, image_id, x, y, width, opacity })),
        shapes: editor.shapes.map(({ id, kind, geometry, target_map_id, title, body, color }) => ({ id, kind, geometry, target_map_id, title, body, color })),
      },
    });
    editor.map.name = name;
    setDirty(false);
    btn.textContent = 'Saved ✓';
    if (unlinked) setTimeout(() => alert(`Saved. Note: ${unlinked} hitbox(es) don't link to a map yet and won't be clickable in the viewer.`), 50);
  } catch (err) {
    btn.textContent = 'Save';
    alert(`Save failed: ${err.message}`);
    return;
  } finally {
    btn.disabled = false;
  }
  setTimeout(() => { btn.textContent = 'Save'; }, 1500);
}

start();
