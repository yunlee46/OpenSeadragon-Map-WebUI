import { ShapeOverlay, eventPixel, rectFromPoints, translateShape, moveVertex } from '/js/overlay.js';
import * as T from '/js/tree.js';
import { FadeController } from '/js/fade.js';
import { renderOutliner, ICONS } from '/js/outliner.js';
import { showMenu } from '/js/contextmenu.js';
import { $, h, newId, adminApi, uploadFiles, typeLabel } from './common.js';

const Pt = (x, y) => new OpenSeadragon.Point(x, y);

export const editor = {
  viewer: null,
  overlay: null,
  fade: null,
  session: 0,        // bumps on every open, so background work for a previous map stops
  map: null,
  maps: [],          // all maps (hitbox targets)
  images: [],        // ready images in the library
  types: [],
  tree: [],          // groups and layers; layers carry their OpenSeadragon `item`
  shapes: [],        // { id, kind, geometry, target_map_id, title, body, color }
  pending: [],       // uploads started from the editor: { name, status, progress, id, error }
  tool: 'pan',
  drawKind: 'hitbox',
  selected: null,    // { type: 'layer' | 'group' | 'shape', id }
  focusIds: null,    // Set of focused node ids (layers + the focused group)
  drag: null,
  draft: null,
  cursor: null,
  dirty: false,
};

// ======================================================================
// Setup
// ======================================================================

function initViewer() {
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
  editor.fade = new FadeController(viewer, drawOrder);

  viewer.addHandler('canvas-press', onPress);
  viewer.addHandler('canvas-drag', onDrag);
  viewer.addHandler('canvas-drag-end', (e) => { if (editor.drag) e.preventDefaultAction = true; });
  viewer.addHandler('canvas-release', onRelease);
  viewer.addHandler('canvas-click', onClick);
  viewer.addHandler('canvas-double-click', onDoubleClick);
  viewer.container.addEventListener('pointermove', onHover);
  viewer.container.addEventListener('contextmenu', onCanvasContextMenu);

  for (const btn of ['add-from-library', 'upload-to-map', 'new-group']) {
    $(`#${btn}`).innerHTML = { 'add-from-library': ICONS.library, 'upload-to-map': ICONS.upload, 'new-group': ICONS.newGroup }[btn];
  }
}

export async function openEditor(id) {
  $('#editor-view').hidden = false;
  initViewer();
  const session = ++editor.session;
  let map, maps, images;
  try {
    [map, maps, images] = await Promise.all([
      adminApi(`/api/admin/maps/${id}`), adminApi('/api/maps'), adminApi('/api/admin/images'),
    ]);
  } catch (err) {
    alert(err.status === 404 ? 'That map does not exist.' : err.message);
    location.hash = '#/maps';
    return;
  }
  if (session !== editor.session) return;

  Object.assign(editor, {
    map, maps,
    images: images.filter((i) => i.status === 'ready'),
    types: map.types,
    tree: map.tree,
    shapes: map.shapes.map(({ target_name, ...s }) => s),
    pending: [],
    selected: null, drag: null, draft: null, focusIds: null,
  });
  T.walk(editor.tree, (n) => { if (n.kind === 'layer') n.item = null; });

  $('#map-name-input').value = map.name;
  $('#map-bg-input').value = map.background;
  $('#map-default-input').checked = map.is_default;
  $('#view-map-link').href = `/?map=${map.id}`;
  editor.viewer.container.style.background = map.background;

  const fade = editor.fade;
  fade.setTypes(editor.types);
  fade.focusOpacity = map.settings.focus_opacity;
  fade.setFocus(null);
  fade.setZoomReveal(false);
  $('#focus-toggle').checked = false;
  $('#zoom-toggle').checked = false;
  setFocusOpacityUi(map.settings.focus_opacity);

  editor.viewer.world.removeAll();
  await Promise.all(drawOrder().map(({ layer }) => addLayerItem(layer)));
  if (session !== editor.session) return;
  syncWorld();
  editor.viewer.viewport.goHome(true);
  setTool('pan');
  setDirty(false);
  renderAll();
}

function addLayerItem(layer) {
  return new Promise((resolve) => {
    editor.viewer.addTiledImage({
      tileSource: layer.dzi_url, x: layer.x, y: layer.y, width: layer.width, opacity: 0,
      success: (e) => { layer.item = e.item; resolve(); },
      error: (e) => { console.error('Could not load', layer.dzi_url, e); resolve(); },
    });
  });
}

// [{ layer, hidden, item }] bottom first.
function drawOrder() {
  return T.layersTopFirst(editor.tree).reverse().map((e) => ({ ...e, item: e.layer.item }));
}

// Put OpenSeadragon's stacking in the tree's order and reapply opacity.
function syncWorld() {
  const world = editor.viewer.world;
  drawOrder().filter((e) => e.item).forEach((e, i) => {
    if (world.getIndexOfItem(e.item) !== i) world.setItemIndex(e.item, i);
  });
  editor.fade.refresh();
}

export function setDirty(v = true) {
  editor.dirty = v;
  $('#dirty').hidden = !v;
}

// ======================================================================
// Selection & focus
// ======================================================================

const findNode = (id) => T.find(editor.tree, id)?.node || null;
const selectedNode = () => (editor.selected && editor.selected.type !== 'shape' ? findNode(editor.selected.id) : null);
const selectedLayer = () => { const n = selectedNode(); return n?.kind === 'layer' ? n : null; };
const selectedShape = () => editor.selected?.type === 'shape' && editor.shapes.find((s) => s.id === editor.selected.id);

function select(type, id) {
  editor.selected = type ? { type, id } : null;
  // In focus mode, the focus follows the selection.
  const n = selectedNode();
  if ($('#focus-toggle').checked && n) focusNode(n, { fly: false });
  renderAll();
}

function focusNode(n, { fly = true } = {}) {
  const layers = T.descendantLayers(n);
  editor.focusIds = new Set([n.id, ...layers.map((l) => l.id)]);
  editor.fade.setFocus(editor.focusIds);
  $('#focus-toggle').checked = true;
  if (fly) flyTo(n);
  renderOutlinerView();
}

function clearFocus() {
  editor.focusIds = null;
  editor.fade.setFocus(null);
  $('#focus-toggle').checked = false;
  renderOutlinerView();
}

function flyTo(n) {
  const b = T.unionBounds(T.descendantLayers(n));
  if (!b) return;
  const pad = Math.max(b.w, b.h) * 0.08;
  editor.viewer.viewport.fitBounds(new OpenSeadragon.Rect(b.x - pad, b.y - pad, b.w + pad * 2, b.h + pad * 2));
}

// ======================================================================
// Rendering
// ======================================================================

function renderOverlay() {
  let draft = editor.draft;
  if (draft && draft.open && editor.cursor) {
    draft = { ...draft, geometry: { type: 'polygon', points: [...draft.geometry.points, [editor.cursor.x, editor.cursor.y]] } };
  }
  const n = selectedNode();
  const b = n && T.unionBounds(T.descendantLayers(n));
  editor.overlay.render(editor.shapes, {
    selectedId: editor.selected?.type === 'shape' ? editor.selected.id : null,
    handles: editor.tool === 'select',
    outline: b ? { x: b.x, y: b.y, width: b.w, height: b.h } : null,
    draft,
  });
}

function renderOutlinerView() {
  const sel = editor.selected;
  renderOutliner($('#outliner'), editor.tree, {
    selectedId: sel && sel.type !== 'shape' ? sel.id : null,
    focusIds: editor.focusIds,
    emptyText: 'No images yet. Use the buttons above to add some.',
    isCollapsed: (n) => n.collapsed,
    onToggleCollapse: (n) => { n.collapsed = !n.collapsed; renderOutlinerView(); },
    typeName: (l) => typeLabel(editor.types, T.effectiveTypeId(l)),
    onSelect: (n) => select(n.kind, n.id),
    onDblClick: (n) => focusNode(n),
    onToggleHidden: (n) => toggleHidden(n),
    onContext: (n, e) => { select(n.kind, n.id); nodeMenu(n, e.clientX, e.clientY); },
    canDrop: (dragId, targetId) => {
      const d = findNode(dragId);
      return !!d && (!targetId || !T.contains(d, targetId));
    },
    onDrop: moveNode,
  });
}

function renderPending() {
  const ul = $('#pending-uploads');
  ul.replaceChildren(...editor.pending.map((p) => h('li', { class: p.status },
    h('span', { class: 'name' }, p.name),
    h('span', { class: 'state' },
      p.status === 'uploading' ? `Uploading ${Math.round(p.progress * 100)}%`
        : p.status === 'tiling' ? 'Tiling…' : `Failed: ${p.error}`),
    p.status === 'error' ? h('button', {
      class: 'btn small ghost', title: 'Dismiss',
      onclick: () => { editor.pending.splice(editor.pending.indexOf(p), 1); renderPending(); },
    }, '✕') : null,
  )));
}

function renderShapesList() {
  const sel = editor.selected;
  const list = $('#shapes-list');
  list.replaceChildren();
  if (!editor.shapes.length) list.append(h('li', { class: 'muted' }, 'Use Rect or Polygon to draw one.'));
  editor.shapes.forEach((s) => {
    const target = editor.maps.find((m) => m.id === s.target_map_id);
    const label = s.kind === 'hitbox'
      ? `${s.title || 'Hitbox'} → ${target ? target.name : '(no target)'}`
      : `📝 ${s.title || 'Untitled note'}`;
    list.append(h('li', {
      class: sel?.type === 'shape' && sel.id === s.id ? 'active' : '',
      onclick: () => { select('shape', s.id); panToShape(s); },
    }, h('span', { class: 'dot', style: `background:${s.color}` }), label));
  });
}

function renderProps() {
  const props = $('#props');
  props.replaceChildren();
  const add = (...nodes) => props.append(...nodes.filter(Boolean));
  const n = selectedNode();
  const shape = selectedShape();
  if (n?.kind === 'layer') add(...layerProps(n));
  else if (n?.kind === 'group') add(...groupProps(n));
  else if (shape) add(...shapeProps(shape));
  else add(h('p', { class: 'hint small' }, 'Select an image, group or shape to edit it.'));
}

function layerProps(layer) {
  const libType = typeLabel(editor.types, layer.image_type_id);
  const inheritFades = (feature) => {
    const t = editor.types.find((x) => x.id === T.effectiveTypeId(layer));
    return t ? t[`fade_${feature}`] : true;
  };
  const num = (key, label, step) => h('label', { class: 'row' }, label, h('input', {
    type: 'number', step, value: +layer[key].toFixed(4), 'data-key': key,
    oninput: (e) => { const v = parseFloat(e.target.value); if (Number.isFinite(v) && (key !== 'width' || v > 0)) updateLayer(layer, { [key]: v }); },
  }));
  const zoomText = layer.zoom_fade ? `Starts at zoom ×${layer.zoom_fade.toFixed(2)}` : 'Starts automatically when it fills the screen';
  return [
    h('h3', {}, 'Selected image'),
    h('p', { class: 'muted small' }, layer.image_name, ` (${layer.px_width} × ${layer.px_height} px)`),
    h('label', {}, 'Name on this map', h('input', {
      value: layer.name || '', placeholder: layer.image_name, maxLength: 200,
      oninput: (e) => { layer.name = e.target.value.trim() || null; setDirty(); renderOutlinerView(); },
    })),
    h('label', { class: 'row' }, 'Type', h('select', {
      onchange: (e) => { setLayerType(layer, e.target.value || null); },
    },
    h('option', { value: '', selected: !layer.type_override }, `Library default (${libType || 'none'})`),
    ...editor.types.map((t) => h('option', { value: t.id, selected: layer.type_override === t.id }, t.name)))),
    h('label', { class: 'row' }, 'Fading', h('select', {
      onchange: (e) => { layer.fade_mode = e.target.value; setDirty(); editor.fade.refresh(); renderProps(); },
    },
    h('option', { value: 'inherit', selected: layer.fade_mode === 'inherit' },
      `Follow type (focus: ${inheritFades('focus') ? 'yes' : 'no'}, zoom: ${inheritFades('zoom') ? 'yes' : 'no'})`),
    h('option', { value: 'always', selected: layer.fade_mode === 'always' }, 'Always fade'),
    h('option', { value: 'never', selected: layer.fade_mode === 'never' }, 'Never fade'))),
    h('div', { class: 'subsection' },
      h('div', { class: 'small' }, h('b', {}, 'Zoom-reveal: '), zoomText),
      h('div', { class: 'btn-row' },
        h('button', { class: 'btn small', onclick: () => setZoomFade(layer, editor.viewer.viewport.getZoom()) }, 'Use current zoom'),
        layer.zoom_fade ? h('button', { class: 'btn small ghost', onclick: () => setZoomFade(layer, null) }, 'Automatic') : null,
      )),
    num('x', 'X', 0.01), num('y', 'Y', 0.01), num('width', 'Width', 0.01),
    h('div', { class: 'btn-row' },
      h('button', { class: 'btn small', onclick: () => updateLayer(layer, { width: layer.width * 0.8 }, true) }, '− Smaller'),
      h('button', { class: 'btn small', onclick: () => updateLayer(layer, { width: layer.width * 1.25 }, true) }, '+ Bigger'),
    ),
    h('label', { class: 'row' }, 'Opacity', h('input', {
      type: 'range', min: 0, max: 1, step: 0.05, value: layer.opacity,
      oninput: (e) => updateLayer(layer, { opacity: parseFloat(e.target.value) }),
    })),
    h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: !layer.hidden, onchange: () => toggleHidden(layer) }), 'Visible'),
    h('div', { class: 'btn-row' },
      h('button', { class: 'btn small', onclick: () => focusNode(layer) }, 'Focus'),
      h('button', { class: 'btn small danger', onclick: () => removeNode(layer) }, 'Remove from map'),
    ),
  ];
}

function groupProps(g) {
  const count = T.descendantLayers(g).length;
  return [
    h('h3', {}, 'Selected group'),
    h('label', {}, 'Name', h('input', {
      value: g.name, maxLength: 200, id: 'group-name-input',
      oninput: (e) => { g.name = e.target.value; setDirty(); renderOutlinerView(); },
    })),
    h('p', { class: 'muted small' }, `${count} image${count === 1 ? '' : 's'} inside. With the Move tool, drag any of them to move the whole group.`),
    h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: !g.hidden, onchange: () => toggleHidden(g) }), 'Visible'),
    h('div', { class: 'btn-row' },
      h('button', { class: 'btn small', onclick: () => focusNode(g) }, 'Focus'),
      h('button', { class: 'btn small', onclick: () => ungroup(g) }, 'Ungroup'),
      h('button', { class: 'btn small danger', onclick: () => removeNode(g) }, 'Delete group'),
    ),
  ];
}

function shapeProps(shape) {
  const isHit = shape.kind === 'hitbox';
  return [
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
  ];
}

function renderAll() {
  renderOverlay();
  renderOutlinerView();
  renderShapesList();
  renderProps();
}

// Refresh X/Y/width inputs while dragging without rebuilding the panel.
function syncLayerInputs(layer) {
  if (selectedLayer() !== layer) return;
  for (const input of document.querySelectorAll('#props input[data-key]')) {
    if (document.activeElement !== input) input.value = +layer[input.dataset.key].toFixed(4);
  }
}

function panToShape(s) {
  const g = s.geometry;
  const xs = g.type === 'rect' ? [g.x, g.x + g.w] : g.points.map((p) => p[0]);
  const ys = g.type === 'rect' ? [g.y, g.y + g.h] : g.points.map((p) => p[1]);
  editor.viewer.viewport.panTo(Pt((Math.min(...xs) + Math.max(...xs)) / 2, (Math.min(...ys) + Math.max(...ys)) / 2));
}

// ======================================================================
// Tree operations
// ======================================================================

function newGroupNode(name = 'New group') {
  return { kind: 'group', id: newId(), name, hidden: false, collapsed: false, children: [] };
}

// Where new things go: inside the selected group, above the selected image, or at the top.
function insertionPoint() {
  const n = selectedNode();
  if (n?.kind === 'group') return { targetId: n.id, where: 'inside' };
  if (n?.kind === 'layer') return { targetId: n.id, where: 'before' };
  return { targetId: editor.tree[0]?.id || null, where: editor.tree.length ? 'before' : 'root' };
}

function addGroup() {
  const g = newGroupNode();
  const { targetId, where } = insertionPoint();
  T.insert(editor.tree, g, targetId, where);
  const parent = where === 'inside' && findNode(targetId);
  if (parent) parent.collapsed = false;
  setDirty();
  select('group', g.id);
  const input = $('#group-name-input');
  input?.focus();
  input?.select();
}

function moveNode(dragId, targetId, where) {
  const d = findNode(dragId);
  if (!d || (targetId && T.contains(d, targetId))) return;
  T.remove(editor.tree, dragId);
  T.insert(editor.tree, d, targetId, where);
  if (where === 'inside') { const t = findNode(targetId); if (t) t.collapsed = false; }
  setDirty();
  syncWorld();
  renderAll();
}

function toggleHidden(n) {
  n.hidden = !n.hidden;
  setDirty();
  editor.fade.refresh();
  renderAll();
}

function removeNode(n) {
  const layers = T.descendantLayers(n);
  if (n.kind === 'group' && layers.length &&
      !confirm(`Delete the group "${n.name}" and remove its ${layers.length} image(s) from this map? (They stay in the image library.)`)) return;
  for (const l of layers) if (l.item) editor.viewer.world.removeItem(l.item);
  T.remove(editor.tree, n.id);
  if (editor.focusIds?.has(n.id)) clearFocus();
  editor.selected = null;
  setDirty();
  syncWorld();
  renderAll();
}

function ungroup(g) {
  const r = T.find(editor.tree, g.id);
  if (!r) return;
  r.list.splice(r.index, 1, ...g.children);
  editor.selected = null;
  setDirty();
  syncWorld();
  renderAll();
}

function groupIntoNew(layer) {
  const r = T.find(editor.tree, layer.id);
  if (!r) return;
  const g = newGroupNode();
  g.children.push(layer);
  r.list.splice(r.index, 1, g);
  setDirty();
  select('group', g.id);
  $('#group-name-input')?.select();
}

function rename(n) {
  const current = n.kind === 'group' ? n.name : T.displayName(n);
  const name = prompt(n.kind === 'group' ? 'Group name:' : 'Name of this image on this map (leave empty to use the library name):', current);
  if (name === null) return;
  if (n.kind === 'group') n.name = name.trim() || n.name;
  else n.name = name.trim() && name.trim() !== n.image_name ? name.trim() : null;
  setDirty();
  renderAll();
}

function setLayerType(layer, typeId) {
  layer.type_override = typeId;
  setDirty();
  editor.fade.refresh();
  renderAll();
}

function setFadeMode(layer, mode) {
  layer.fade_mode = mode;
  setDirty();
  editor.fade.refresh();
  renderAll();
}

function setZoomFade(layer, zoom) {
  layer.zoom_fade = zoom;
  setDirty();
  editor.fade.refresh();
  renderProps();
}

// ---------- adding images ----------

function addImages(imgs) {
  if (!imgs.length) return;
  const vp = editor.viewer.viewport;
  const center = vp.getCenter();
  const view = vp.getBounds();
  const existing = T.layersTopFirst(editor.tree).map((e) => e.layer);
  // Keep the pixel density of the first image on the map, so sizes stay comparable.
  const ref = existing[0];
  const { targetId, where } = insertionPoint();
  let last = null;
  imgs.forEach((img, i) => {
    let width = ref ? img.width * (ref.width / ref.px_width) : 1;
    if (!existing.length && i === 0) width = 1;
    else if (width > view.width * 0.9) width = view.width * 0.6; // don't drop in something larger than the view
    const height = width * (img.height / img.width);
    const offset = i * width * 0.06;
    const layer = {
      kind: 'layer', id: newId(), image_id: img.id, image_name: img.name, name: null,
      px_width: img.width, px_height: img.height, dzi_url: img.dzi_url, thumb_url: img.thumb_url,
      image_type_id: img.type_id, type_override: null, fade_mode: 'inherit', hidden: false, zoom_fade: null,
      x: existing.length ? center.x - width / 2 + offset : i * 1.05,
      y: existing.length ? center.y - height / 2 + offset : 0,
      width, opacity: 1, item: null,
    };
    T.insert(editor.tree, layer, last ? last.id : targetId, last ? 'before' : where);
    last = layer;
    addLayerItem(layer).then(() => {
      syncWorld();
      if (!existing.length) editor.viewer.viewport.goHome();
    });
  });
  const parent = where === 'inside' && findNode(targetId);
  if (parent) parent.collapsed = false;
  setDirty();
  select('layer', last.id);
  if (editor.tool !== 'move') setTool('move');
}

async function openLibrary() {
  const dialog = $('#library-dialog');
  const grid = $('#library-grid');
  grid.replaceChildren(h('p', { class: 'muted' }, 'Loading…'));
  dialog.showModal();
  const images = (await adminApi('/api/admin/images')).filter((i) => i.status === 'ready');
  editor.images = images;
  const draw = () => {
    const q = $('#library-search').value.trim().toLowerCase();
    const shown = images.filter((i) => !q || i.name.toLowerCase().includes(q));
    grid.replaceChildren(...(shown.length ? shown.map((img) => h('button', {
      class: 'card image-card pick',
      title: `Add "${img.name}" to this map`,
      onclick: () => { dialog.close(); addImages([img]); },
    },
    h('div', { class: 'thumb' }, h('img', { src: img.thumb_url, alt: '', loading: 'lazy' })),
    h('div', { class: 'name' }, img.name),
    h('div', { class: 'muted small' }, `${img.width.toLocaleString()} × ${img.height.toLocaleString()} px`,
      typeLabel(editor.types, img.type_id) ? h('span', { class: 'badge' }, typeLabel(editor.types, img.type_id)) : null),
    )) : [h('p', { class: 'muted' }, images.length ? 'No matches.' : 'The library is empty. Use the upload button to add images.')]));
  };
  $('#library-search').value = '';
  $('#library-search').oninput = draw;
  draw();
  $('#library-search').focus();
}

async function uploadToMap(files) {
  if (!files.length) return;
  const session = editor.session;
  const entries = files.map((f) => ({ name: f.name, status: 'uploading', progress: 0 }));
  editor.pending.push(...entries);
  renderPending();
  let ids;
  try {
    ids = await uploadFiles(files, (p) => { entries.forEach((e) => { e.progress = p; }); renderPending(); });
  } catch (err) {
    entries.forEach((e) => { e.status = 'error'; e.error = err.message; });
    renderPending();
    return;
  }
  ids.forEach((id, i) => { entries[i].id = id; entries[i].status = 'tiling'; });
  renderPending();

  const poll = async () => {
    if (session !== editor.session) return;
    const images = await adminApi('/api/admin/images').catch(() => null);
    if (!images || session !== editor.session) return;
    const ready = [];
    for (const e of entries.filter((x) => x.status === 'tiling')) {
      const img = images.find((i) => i.id === e.id);
      if (!img) { e.status = 'error'; e.error = 'Image was deleted'; continue; }
      if (img.status === 'ready') {
        e.status = 'done';
        ready.push(img);
        editor.pending.splice(editor.pending.indexOf(e), 1);
      }
      if (img.status === 'error') { e.status = 'error'; e.error = img.error; }
    }
    editor.images = images.filter((i) => i.status === 'ready');
    renderPending();
    if (ready.length) addImages(ready);
    if (entries.some((x) => x.status === 'tiling')) setTimeout(poll, 1500);
  };
  setTimeout(poll, 1000);
}

// ---------- layer & shape edits ----------

function updateLayer(layer, changes, rerenderProps = false) {
  Object.assign(layer, changes);
  const item = layer.item;
  if (item) {
    if ('x' in changes || 'y' in changes) item.setPosition(Pt(layer.x, layer.y), true);
    if ('width' in changes) item.setWidth(layer.width, true);
  }
  setDirty();
  editor.fade.refresh();
  renderOverlay();
  if (rerenderProps) renderProps(); else syncLayerInputs(layer);
}

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
  renderShapesList();
}

function removeShape(shape) {
  editor.shapes.splice(editor.shapes.indexOf(shape), 1);
  editor.selected = null;
  setDirty();
  renderAll();
}

// ======================================================================
// Context menus
// ======================================================================

function nodeMenu(n, x, y) {
  const isGroup = n.kind === 'group';
  const items = [
    { label: isGroup ? 'Focus group' : 'Focus', onClick: () => focusNode(n) },
    { label: 'Zoom to fit', onClick: () => flyTo(n) },
    { separator: true },
    { label: 'Rename…', onClick: () => rename(n) },
  ];
  if (isGroup) {
    items.push(
      { label: 'New group inside', onClick: () => { select('group', n.id); addGroup(); } },
      { label: n.hidden ? 'Show' : 'Hide', onClick: () => toggleHidden(n) },
      { separator: true },
      { label: 'Ungroup (keep images)', onClick: () => ungroup(n) },
      { label: 'Delete group and its images', danger: true, onClick: () => removeNode(n) },
    );
  } else {
    const libType = typeLabel(editor.types, n.image_type_id);
    items.push(
      {
        label: 'Type',
        submenu: [
          { label: `Library default (${libType || 'none'})`, checked: !n.type_override, onClick: () => setLayerType(n, null) },
          { separator: true },
          ...editor.types.map((t) => ({ label: t.name, checked: n.type_override === t.id, onClick: () => setLayerType(n, t.id) })),
        ],
      },
      {
        label: 'Fading',
        submenu: [
          { label: 'Follow type', checked: n.fade_mode === 'inherit', onClick: () => setFadeMode(n, 'inherit') },
          { label: 'Always fade', checked: n.fade_mode === 'always', onClick: () => setFadeMode(n, 'always') },
          { label: 'Never fade', checked: n.fade_mode === 'never', onClick: () => setFadeMode(n, 'never') },
        ],
      },
      {
        label: 'Zoom-reveal',
        submenu: [
          { label: 'Automatic', checked: !n.zoom_fade, onClick: () => setZoomFade(n, null) },
          { label: 'Start fading at current zoom', checked: !!n.zoom_fade, onClick: () => setZoomFade(n, editor.viewer.viewport.getZoom()) },
        ],
      },
      { separator: true },
      { label: n.hidden ? 'Show' : 'Hide', onClick: () => toggleHidden(n) },
      { label: 'Move into new group', onClick: () => groupIntoNew(n) },
      { separator: true },
      { label: 'Remove from map', danger: true, onClick: () => removeNode(n) },
    );
  }
  showMenu(x, y, items);
}

function onCanvasContextMenu(e) {
  e.preventDefault();
  if (editor.draft) return;
  const pt = toPoint(eventPixel(editor.viewer, e));
  const shape = editor.overlay.hitTest(pt);
  if (shape) {
    select('shape', shape.id);
    showMenu(e.clientX, e.clientY, [
      { label: 'Edit', onClick: () => setTool('select') },
      { label: 'Delete shape', danger: true, onClick: () => removeShape(shape) },
    ]);
    return;
  }
  const layer = layerAt(pt);
  if (layer) {
    select('layer', layer.id);
    nodeMenu(layer, e.clientX, e.clientY);
  }
}

// ======================================================================
// Tools & pointer handling
// ======================================================================

const HINTS = {
  pan: 'Drag to pan, scroll to zoom. Double-click an image to focus it.',
  move: 'Drag an image to move it. Select a group first to drag the whole group.',
  select: 'Click a shape to select it. Drag to move it; drag the square handles to reshape. Delete key removes it.',
  rect: 'Drag to draw a rectangle.',
  polygon: 'Click to add points. Click the first point, double-click, or press Enter to finish. Backspace removes the last point, Esc cancels.',
};

export function setTool(tool) {
  editor.tool = tool;
  editor.draft = null;
  editor.drag = null;
  document.querySelectorAll('#toolbar [data-tool]').forEach((b) => b.classList.toggle('active', b.dataset.tool === tool));
  $('#tool-hint').textContent = HINTS[tool];
  editor.viewer.canvas.style.cursor = { pan: '', move: 'move', select: 'default', rect: 'crosshair', polygon: 'crosshair' }[tool];
  renderOverlay();
}

const toPoint = (pos) => editor.viewer.viewport.pointFromPixel(pos);

// Topmost visible image under a viewport point.
function layerAt(pt) {
  for (const { layer, hidden } of T.layersTopFirst(editor.tree)) {
    if (hidden || editor.fade.opacityOf(layer.id) < 0.03) continue;
    if (pt.x >= layer.x && pt.x <= layer.x + layer.width && pt.y >= layer.y && pt.y <= layer.y + T.layerHeight(layer)) return layer;
  }
  return null;
}

function onPress(e) {
  const pt = toPoint(e.position);
  editor.drag = null;
  switch (editor.tool) {
    case 'move': {
      const layer = layerAt(pt);
      if (!layer) break;
      const sel = selectedNode();
      const members = sel?.kind === 'group' && T.contains(sel, layer.id) ? T.descendantLayers(sel) : [layer];
      editor.drag = { type: 'layers', start: pt, members: members.map((l) => ({ l, ox: l.x, oy: l.y })) };
      if (members.length === 1 && selectedLayer() !== layer) select('layer', layer.id);
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
  if (d.type === 'layers') {
    const dx = pt.x - d.start.x, dy = pt.y - d.start.y;
    for (const m of d.members) {
      m.l.x = m.ox + dx;
      m.l.y = m.oy + dy;
      m.l.item?.setPosition(Pt(m.l.x, m.l.y), true);
    }
    d.moved = true;
    editor.fade.refresh();
    renderOverlay();
    if (d.members.length === 1) syncLayerInputs(d.members[0].l);
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
    const s = editor.overlay.scale;
    if (g.w * s >= 4 && g.h * s >= 4) addShape(g); else renderOverlay();
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

function onDoubleClick(e) {
  if (editor.tool === 'polygon') return finishPolygon();
  if (editor.tool === 'rect') return;
  const layer = layerAt(toPoint(e.position));
  if (layer) {
    editor.selected = { type: 'layer', id: layer.id };
    focusNode(layer);
    renderAll();
  }
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
  if ($('#editor-view').hidden || $('#library-dialog').open) return;
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
  if (e.key === 'Escape') {
    if (editor.focusIds) clearFocus(); else select(null);
    return;
  }
  if (e.key === 'Delete' || e.key === 'Backspace') {
    const shape = selectedShape();
    const n = selectedNode();
    if (shape) removeShape(shape);
    else if (n) removeNode(n);
    return;
  }
  if (e.key.toLowerCase() === 'f' && !e.ctrlKey && !e.metaKey) {
    const n = selectedNode();
    if (n) focusNode(n);
    return;
  }
  const tool = { h: 'pan', m: 'move', s: 'select', r: 'rect', p: 'polygon' }[e.key.toLowerCase()];
  if (tool && !e.ctrlKey && !e.metaKey && !e.altKey) setTool(tool);
});

// ======================================================================
// Panel wiring & saving
// ======================================================================

function setFocusOpacityUi(v) {
  $('#focus-opacity').value = v;
  $('#focus-opacity-out').textContent = `${Math.round(v * 100)}%`;
}

document.querySelectorAll('#toolbar [data-tool]').forEach((b) => b.addEventListener('click', () => setTool(b.dataset.tool)));
document.querySelectorAll('input[name="draw-kind"]').forEach((r) => r.addEventListener('change', (e) => { editor.drawKind = e.target.value; }));
$('#home-btn').addEventListener('click', () => editor.viewer.viewport.goHome());
$('#add-from-library').addEventListener('click', openLibrary);
$('#library-close').addEventListener('click', () => $('#library-dialog').close());
$('#upload-to-map').addEventListener('click', () => $('#editor-file-input').click());
$('#editor-file-input').addEventListener('change', (e) => { uploadToMap([...e.target.files]); e.target.value = ''; });
$('#new-group').addEventListener('click', addGroup);
$('#map-name-input').addEventListener('input', () => setDirty());
$('#map-default-input').addEventListener('change', () => setDirty());
$('#map-bg-input').addEventListener('input', (e) => { editor.viewer.container.style.background = e.target.value; setDirty(); });
$('#save-btn').addEventListener('click', () => save());

$('#focus-toggle').addEventListener('change', (e) => {
  if (!e.target.checked) return clearFocus();
  const n = selectedNode();
  if (n) focusNode(n);
  else {
    e.target.checked = false;
    $('#tool-hint').textContent = 'Select an image or group first, then turn on focus (or double-click an image).';
  }
});
$('#focus-opacity').addEventListener('input', (e) => {
  const v = parseFloat(e.target.value);
  setFocusOpacityUi(v);
  editor.fade.setFocusOpacity(v);
});
$('#focus-default-btn').addEventListener('click', async () => {
  const v = parseFloat($('#focus-opacity').value);
  await adminApi('/api/admin/settings', { method: 'PATCH', body: { focus_opacity: v } });
  $('#focus-default-btn').textContent = `Default set to ${Math.round(v * 100)}% ✓`;
  setTimeout(() => { $('#focus-default-btn').textContent = 'Make this the default'; }, 1800);
});
$('#zoom-toggle').addEventListener('change', (e) => editor.fade.setZoomReveal(e.target.checked));

function serializeTree(list) {
  return list.map((n) => (n.kind === 'group'
    ? { kind: 'group', id: n.id, name: n.name, hidden: n.hidden, collapsed: n.collapsed, children: serializeTree(n.children) }
    : {
      kind: 'layer', id: n.id, image_id: n.image_id, x: n.x, y: n.y, width: n.width, opacity: n.opacity,
      name: n.name, type_override: n.type_override, fade_mode: n.fade_mode, hidden: n.hidden, zoom_fade: n.zoom_fade,
    }));
}

export async function save() {
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
        tree: serializeTree(editor.tree),
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
