import { api } from '/js/overlay.js';
import { $, h, iconBtn, newId, adminApi, uploadFiles } from './common.js';
import * as T from '/js/tree.js';
import { renderOutliner } from '/js/outliner.js';
import { showMenu } from '/js/contextmenu.js';
import { icon, hydrateIcons, initTooltips } from '/js/icons.js';
import { editor, openEditor } from './editor.js';
import { showPlanner, stopPlanner } from './planner.js';

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

// ======================================================================
// Routing: #/maps, #/images, #/planner, #/settings, #/edit/<id>
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
  for (const v of ['maps', 'images', 'planner', 'settings', 'editor']) $(`#${v}-view`).hidden = true;
  document.querySelectorAll('[data-nav]').forEach((a) => a.classList.toggle('active', a.dataset.nav === page));
  stopImagePolling();
  stopPlanner();
  editor.dirty = false;
  editor.session++;
  if (page === 'images') { currentRoute = 'images'; showImages(); }
  else if (page === 'settings') { currentRoute = 'settings'; showSettings(); }
  else if (page === 'planner') { currentRoute = 'planner'; showPlanner(); }
  else if (page === 'edit' && id) { currentRoute = `edit:${id}`; openEditor(id); }
  else { currentRoute = 'maps'; showMaps(); }
}

// ======================================================================
// Maps list
// ======================================================================

// The maps list is a tree of folders (kind 'group') and maps (kind 'map'), saved as soon as it changes.
const mapsView = { tree: [], selectedId: null };

async function showMaps() {
  $('#maps-view').hidden = false;
  mapsView.tree = await adminApi('/api/admin/map-tree');
  renderMaps();
}

const viewerLink = (m) => (m.published_at ? `/?map=${m.id}` : `/?map=${m.id}&preview=1`);

function mapExtras(n) {
  if (n.kind === 'group') {
    return [h('span', { class: 'row-actions' },
      iconBtn('mapPlus', 'New map in this folder', { onclick: () => newMapIn(n) }, 'small ghost'),
      iconBtn('folderPlus', 'New folder inside', { onclick: () => newFolder(n) }, 'small ghost'),
      iconBtn('rename', 'Rename folder', { onclick: () => renameFolder(n) }, 'small ghost'),
      iconBtn('trash', 'Delete folder (its maps move up a level)', { onclick: () => deleteFolder(n, false) }, 'small danger'),
    )];
  }
  const status = !n.published_at ? h('span', { class: 'ol-badge warn' }, 'not published')
    : n.unpublished ? h('span', { class: 'ol-badge warn' }, 'unpublished changes') : null;
  return [
    status,
    h('span', { class: 'ol-badge muted-badge' }, `${n.layer_count} img · ${n.shape_count} shapes`),
    h('span', { class: 'row-actions' },
      iconBtn('edit', 'Edit map', { href: `#/edit/${n.id}` }, 'small'),
      n.unpublished
        ? iconBtn('publish', 'Publish: make the saved draft visible to visitors', { onclick: () => publishMap(n) }, 'small primary-outline')
        : h('span', { class: 'icon-slot' }), // keeps the action columns lined up
      iconBtn('eye', n.published_at ? 'View the published map' : 'Preview (not published yet)', { href: viewerLink(n), target: '_blank' }, 'small ghost'),
      iconBtn('star', n.is_default ? 'Default map (opens first)' : 'Make this the default map', { onclick: () => setDefault(n), class: n.is_default ? 'on' : '' }, 'small ghost'),
      iconBtn('rename', 'Rename map', { onclick: () => renameMap(n) }, 'small ghost'),
      iconBtn('trash', 'Delete map', { onclick: () => deleteMap(n) }, 'small danger'),
    ),
  ].filter(Boolean);
}

function renderMaps() {
  renderOutliner($('#maps-tree'), mapsView.tree, {
    showEye: false,
    selectedId: mapsView.selectedId,
    emptyText: 'No maps yet. Create one above.',
    leafIcon: () => icon('map'),
    extras: mapExtras,
    isCollapsed: (n) => n.collapsed,
    onToggleCollapse: (n) => { n.collapsed = !n.collapsed; renderMaps(); saveMapTree(); },
    onSelect: (n) => { mapsView.selectedId = mapsView.selectedId === n.id ? null : n.id; renderMaps(); },
    onDblClick: (n) => { if (n.kind === 'map') location.hash = `#/edit/${n.id}`; else renameFolder(n); },
    onContext: (n, e) => mapMenu(n, e.clientX, e.clientY),
    canDrop: (dragId, targetId) => {
      const d = T.find(mapsView.tree, dragId)?.node;
      return !!d && (!targetId || !T.contains(d, targetId));
    },
    onDrop: (dragId, targetId, where) => {
      const d = T.find(mapsView.tree, dragId)?.node;
      if (!d || (targetId && T.contains(d, targetId))) return;
      T.remove(mapsView.tree, dragId);
      T.insert(mapsView.tree, d, targetId, where);
      if (where === 'inside') { const t = T.find(mapsView.tree, targetId)?.node; if (t) t.collapsed = false; }
      renderMaps();
      saveMapTree();
    },
  });
}

const serializeMapTree = (list) => list.map((n) => (n.kind === 'group'
  ? { kind: 'group', id: n.id, name: n.name, collapsed: n.collapsed, children: serializeMapTree(n.children) }
  : { kind: 'map', id: n.id }));

// Saves go out one at a time, in order. The page's own tree stays the source of truth
// (new folder ids are made here and kept by the server), so a slow reply can't undo a newer change.
let mapTreeSaving = Promise.resolve();
function saveMapTree() {
  const tree = serializeMapTree(mapsView.tree);
  renderMaps();
  mapTreeSaving = mapTreeSaving
    .then(() => adminApi('/api/admin/map-tree', { method: 'PUT', body: { tree } }))
    .catch((err) => {
      alert(`Could not save the maps list: ${err.message}`);
      showMaps();
    });
  return mapTreeSaving;
}

function mapMenu(n, x, y) {
  if (n.kind === 'group') {
    const count = countMaps(n);
    showMenu(x, y, [
      { label: 'New map here…', onClick: () => newMapIn(n) },
      { label: 'New folder inside…', onClick: () => newFolder(n) },
      { label: 'Rename…', onClick: () => renameFolder(n) },
      { separator: true },
      { label: 'Delete folder (keep its maps)', onClick: () => deleteFolder(n, false) },
      { label: `Delete folder and its ${count} map${count === 1 ? '' : 's'}…`, danger: true, disabled: !count, onClick: () => deleteFolder(n, true) },
    ]);
    return;
  }
  showMenu(x, y, [
    { label: 'Edit', onClick: () => { location.hash = `#/edit/${n.id}`; } },
    { label: n.published_at ? 'View' : 'Preview', onClick: () => window.open(viewerLink(n), '_blank') },
    n.unpublished ? { label: 'Publish', onClick: () => publishMap(n) } : null,
    { label: 'Make default', checked: n.is_default, disabled: n.is_default, onClick: () => setDefault(n) },
    { label: 'Rename…', onClick: () => renameMap(n) },
    { separator: true },
    { label: 'Delete…', danger: true, onClick: () => deleteMap(n) },
  ].filter(Boolean));
}

function countMaps(folder) {
  let c = 0;
  T.walk(folder.children, (x) => { if (x.kind === 'map') c++; });
  return c;
}

// New things go into the selected folder (or the folder of the selected map).
function targetFolder() {
  const r = mapsView.selectedId && T.find(mapsView.tree, mapsView.selectedId);
  if (!r) return null;
  return r.node.kind === 'group' ? r.node : r.parent;
}

$('#new-map-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const name = e.target.name.value.trim();
  if (!name) return;
  const { id } = await adminApi('/api/admin/maps', { method: 'POST', body: { name, folder_id: targetFolder()?.id || null } });
  e.target.reset();
  location.hash = `#/edit/${id}`;
});

$('#new-folder').addEventListener('click', () => newFolder(targetFolder()));

async function newMapIn(folder) {
  const name = prompt(`Name of the new map in "${folder.name}":`);
  if (!name?.trim()) return;
  const { id } = await adminApi('/api/admin/maps', { method: 'POST', body: { name, folder_id: folder.id } });
  location.hash = `#/edit/${id}`;
}

function newFolder(parent) {
  const name = prompt(parent ? `Name of the new folder inside "${parent.name}":` : 'Name of the new folder:');
  if (!name?.trim()) return;
  const folder = { kind: 'group', id: newId(), name: name.trim(), collapsed: false, children: [] };
  if (parent) { parent.children.unshift(folder); parent.collapsed = false; } else mapsView.tree.unshift(folder);
  mapsView.selectedId = folder.id;
  saveMapTree();
}

function renameFolder(folder) {
  const name = prompt('Folder name:', folder.name);
  if (!name?.trim()) return;
  folder.name = name.trim();
  saveMapTree();
}

async function deleteFolder(folder, withMaps) {
  const r = T.find(mapsView.tree, folder.id);
  if (!r) return;
  const maps = [];
  T.walk(folder.children, (x) => { if (x.kind === 'map') maps.push(x); });
  if (withMaps) {
    if (!confirm(`Delete the folder "${folder.name}" and ALL ${maps.length} map(s) inside it?\n\n${maps.map((m) => `• ${m.name}`).join('\n')}\n\nTheir images stay in the library. This cannot be undone.`)) return;
    for (const m of maps) await adminApi(`/api/admin/maps/${m.id}`, { method: 'DELETE' });
    r.list.splice(r.index, 1);
  } else {
    if (maps.length && !confirm(`Delete the folder "${folder.name}"? Its ${maps.length} map(s) and subfolders move up a level.`)) return;
    r.list.splice(r.index, 1, ...folder.children);
  }
  if (mapsView.selectedId === folder.id) mapsView.selectedId = null;
  saveMapTree();
}

async function publishMap(m) {
  await adminApi(`/api/admin/maps/${m.id}/publish`, { method: 'POST' });
  showMaps();
}
async function setDefault(m) {
  if (m.is_default) return;
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
  if (!confirm(`Delete the map "${m.name}"?\n\nIts placements, groups, hitboxes and notes are deleted. Hitboxes on other maps that link here become unlinked. The images stay in the library.`)) return;
  await adminApi(`/api/admin/maps/${m.id}`, { method: 'DELETE' });
  showMaps();
}

// ======================================================================
// Image library
// ======================================================================

let imagePoll = null;
const stopImagePolling = () => { clearTimeout(imagePoll); imagePoll = null; };

let library = { images: [], types: [] };

async function showImages() {
  $('#images-view').hidden = false;
  const [images, types] = await Promise.all([adminApi('/api/admin/images'), adminApi('/api/types')]);
  library = { images, types };
  const typeFilter = $('#lib-type');
  const keep = typeFilter.value;
  typeFilter.replaceChildren(h('option', { value: '' }, 'All types'), h('option', { value: 'none' }, 'No type'),
    ...types.map((t) => h('option', { value: t.id }, t.name)));
  typeFilter.value = keep;
  renderLibrary();

  stopImagePolling();
  const busy = images.some((i) => i.status === 'processing' || i.replace_status === 'processing');
  if (busy && currentRoute === 'images') imagePoll = setTimeout(showImages, 2000);
}

function renderLibrary() {
  const q = $('#lib-search').value.trim().toLowerCase();
  const type = $('#lib-type').value;
  const status = $('#lib-status').value;
  const unused = $('#lib-unused').checked;
  const { images, types } = library;
  const shown = images.filter((i) => (!q || i.name.toLowerCase().includes(q))
    && (!type || (type === 'none' ? !i.type_id : i.type_id === type))
    && (!status || i.status === status)
    && (!unused || !i.used_in.length));
  $('#lib-count').textContent = images.length ? `${shown.length} of ${images.length}` : '';
  const grid = $('#images-list');
  grid.replaceChildren(...(shown.length ? shown.map((img) => imageCard(img, types))
    : [h('p', { class: 'muted' }, images.length ? 'No images match these filters.' : 'No images yet.')]));
}

for (const id of ['lib-search', 'lib-type', 'lib-status', 'lib-unused']) {
  $(`#${id}`).addEventListener(id === 'lib-search' ? 'input' : 'change', renderLibrary);
}

function imageCard(img, types) {
  const replacing = img.replace_status === 'processing';
  const thumb = img.status === 'ready'
    ? h('img', { src: img.thumb_url, alt: '', loading: 'lazy', onerror: (e) => e.target.replaceWith(h('div', { class: 'thumb-missing' }, 'no preview')) })
    : h('div', { class: `thumb-status ${img.status}` }, img.status === 'processing' ? 'Tiling…' : 'Failed');
  const typeSelect = h('select', {
    class: 'type-select',
    title: 'Image type',
    onchange: async (e) => {
      await adminApi(`/api/admin/images/${img.id}`, { method: 'PATCH', body: { type_id: e.target.value || null } });
      img.type_id = e.target.value || null;
    },
  },
  h('option', { value: '', selected: !img.type_id }, 'No type'),
  ...types.map((t) => h('option', { value: t.id, selected: img.type_id === t.id }, t.name)));

  return h('div', { class: 'card image-card' },
    h('div', { class: 'thumb' }, thumb, replacing ? h('div', { class: 'thumb-overlay' }, 'Replacing…') : null),
    h('div', { class: 'name', title: img.name }, img.name),
    img.status === 'ready' ? h('div', { class: 'muted small' }, `${img.width.toLocaleString()} × ${img.height.toLocaleString()} px`) : null,
    img.status === 'error' ? h('div', { class: 'error small' }, img.error) : null,
    img.replace_status === 'error' ? h('div', { class: 'error small' }, `Replacing failed: ${img.replace_error}`) : null,
    img.used_in.length ? h('div', { class: 'muted small' }, 'On: ', img.used_in.map((m) => m.name).join(', ')) : null,
    img.planner_item ? h('div', { class: 'small planned-note' }, h('a', { href: '#/planner' }, `From the planner: ${img.planner_item.title}`)) : null,
    h('label', { class: 'row small' }, 'Type', typeSelect),
    h('div', { class: 'actions' },
      iconBtn('rename', 'Rename image', { onclick: () => renameImage(img) }, 'small ghost'),
      iconBtn('upload', 'Replace file: upload a new version. Every map keeps its placement, type and hitboxes.', {
        disabled: img.status === 'processing' || replacing,
        onclick: () => replaceImage(img),
      }, 'small ghost'),
      iconBtn('trash', 'Delete image and its tiles', { onclick: () => deleteImage(img) }, 'small danger'),
    ),
  );
}

let replaceTarget = null;
function replaceImage(img) {
  replaceTarget = img;
  $('#replace-input').click();
}
$('#replace-input').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  const img = replaceTarget;
  if (!file || !img) return;
  if (img.used_in.length && !confirm(`Replace the file of "${img.name}"? It stays on ${img.used_in.map((m) => m.name).join(', ')} at the same place and width. If the new file has a different shape, its height changes.`)) return;
  const form = new FormData();
  form.append('file', file);
  const bar = $('#upload-progress');
  bar.hidden = false;
  bar.lastElementChild.textContent = `Uploading replacement for ${img.name}…`;
  try {
    await adminApi(`/api/admin/images/${img.id}/replace`, { method: 'POST', body: form });
  } catch (err) {
    alert(err.message);
  }
  bar.hidden = true;
  showImages();
});

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

async function uploadToLibrary(files) {
  if (!files.length) return;
  const bar = $('#upload-progress');
  bar.hidden = false;
  try {
    await uploadFiles(files, (p) => {
      const pct = Math.round(p * 100);
      bar.firstElementChild.style.width = `${pct}%`;
      bar.lastElementChild.textContent = pct < 100 ? `Uploading ${files.length} file(s)… ${pct}%` : 'Upload done, tiling…';
    });
  } catch (err) {
    alert(err.message);
  }
  bar.hidden = true;
  showImages();
}

const dz = $('#dropzone');
$('#file-input').addEventListener('change', (e) => { uploadToLibrary([...e.target.files]); e.target.value = ''; });
dz.addEventListener('dragover', (e) => { e.preventDefault(); dz.classList.add('over'); });
dz.addEventListener('dragleave', () => dz.classList.remove('over'));
dz.addEventListener('drop', (e) => { e.preventDefault(); dz.classList.remove('over'); uploadToLibrary([...e.dataTransfer.files]); });

// ======================================================================
// Types & settings
// ======================================================================

async function showSettings() {
  $('#settings-view').hidden = false;
  const [types, settings] = await Promise.all([adminApi('/api/types'), adminApi('/api/settings')]);
  const tbody = $('#types-list');
  tbody.replaceChildren();
  if (!types.length) tbody.append(h('tr', {}, h('td', { colSpan: 6, class: 'muted' }, 'No types. Add one below.')));
  for (const t of types) {
    const patch = (body) => adminApi(`/api/admin/types/${t.id}`, { method: 'PATCH', body });
    tbody.append(h('tr', {},
      h('td', {}, h('input', {
        value: t.name, maxLength: 60, class: 'inline-input',
        onchange: async (e) => { if (e.target.value.trim()) await patch({ name: e.target.value }); else e.target.value = t.name; },
      })),
      h('td', {}, h('label', { class: 'switch' }, h('input', { type: 'checkbox', checked: t.fade_focus, onchange: (e) => patch({ fade_focus: e.target.checked }) }))),
      h('td', {}, h('label', { class: 'switch' }, h('input', { type: 'checkbox', checked: t.fade_zoom, onchange: (e) => patch({ fade_zoom: e.target.checked }) }))),
      h('td', {}, h('label', { class: 'switch' }, h('input', { type: 'checkbox', checked: t.fade_small, onchange: (e) => patch({ fade_small: e.target.checked }) }))),
      h('td', { class: 'muted' }, String(t.image_count)),
      h('td', { class: 'actions' }, iconBtn('trash', `Delete the type "${t.name}"`, {
        onclick: async () => {
          const msg = t.image_count
            ? `Delete the type "${t.name}"? ${t.image_count} image(s) using it will have no type. The images themselves are kept.`
            : `Delete the type "${t.name}"?`;
          if (!confirm(msg)) return;
          await adminApi(`/api/admin/types/${t.id}`, { method: 'DELETE' });
          showSettings();
        },
      }, 'small danger')),
    ));
  }

  const slider = $('#focus-default');
  slider.value = settings.focus_opacity;
  $('#focus-default-out').textContent = `${Math.round(settings.focus_opacity * 100)}%`;
  $('#small-default').value = Math.log(settings.small_fade_percent / 0.1) / Math.log(100);
  $('#small-default-out').textContent = pctLabel(settings.small_fade_percent);
}

// The small-image slider is logarithmic: 0.1% to 10% of the screen.
const sliderToPct = (v) => +(0.1 * 100 ** v).toPrecision(2);
const pctLabel = (p) => `${p < 1 ? p.toFixed(2).replace(/0$/, '') : +p.toFixed(1)}%`;
$('#small-default').addEventListener('input', (e) => { $('#small-default-out').textContent = pctLabel(sliderToPct(+e.target.value)); });
$('#small-default').addEventListener('change', (e) => {
  adminApi('/api/admin/settings', { method: 'PATCH', body: { small_fade_percent: sliderToPct(+e.target.value) } });
});

$('#new-type-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const name = e.target.name.value.trim();
  if (!name) return;
  await adminApi('/api/admin/types', { method: 'POST', body: { name, fade_focus: true, fade_zoom: true, fade_small: true } });
  e.target.reset();
  showSettings();
});

$('#focus-default').addEventListener('input', (e) => {
  $('#focus-default-out').textContent = `${Math.round(e.target.value * 100)}%`;
});
$('#focus-default').addEventListener('change', (e) => {
  adminApi('/api/admin/settings', { method: 'PATCH', body: { focus_opacity: parseFloat(e.target.value) } });
});

// ---------- backup & restore ----------

$('#restore-btn').addEventListener('click', () => $('#restore-input').click());
$('#restore-input').addEventListener('change', (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  if (!confirm(`Restore "${file.name}"?\n\nEverything currently in the app (maps, images, planner) is replaced by the backup, and the server restarts. The current data is kept in a pre-restore folder in the data volume until the next restore.`)) return;
  const form = new FormData();
  form.append('file', file);
  const bar = $('#restore-progress');
  bar.hidden = false;
  const xhr = new XMLHttpRequest();
  xhr.open('POST', '/api/admin/restore');
  xhr.upload.onprogress = (ev) => {
    if (!ev.lengthComputable) return;
    const pct = Math.round((ev.loaded / ev.total) * 100);
    bar.firstElementChild.style.width = `${pct}%`;
    bar.lastElementChild.textContent = pct < 100 ? `Uploading backup… ${pct}%` : 'Checking the backup…';
  };
  xhr.onload = () => {
    let data = {};
    try { data = JSON.parse(xhr.responseText); } catch { /* keep empty */ }
    if (xhr.status >= 400) {
      bar.hidden = true;
      alert(`Restore failed: ${data.error || xhr.status}`);
      return;
    }
    bar.lastElementChild.textContent = 'Restoring… the server is restarting';
    waitForRestart();
  };
  xhr.onerror = () => { bar.hidden = true; alert('Restore failed (network error)'); };
  xhr.send(form);
});

// Poll until the server answers again after restarting, then reload.
function waitForRestart() {
  let seenDown = false;
  const started = Date.now();
  const tick = async () => {
    try {
      const r = await fetch('/api/me', { cache: 'no-store' });
      if (r.ok && (seenDown || Date.now() - started > 8000)) { location.hash = '#/maps'; location.reload(); return; }
    } catch {
      seenDown = true;
    }
    if (Date.now() - started > 120000) {
      $('#restore-progress').lastElementChild.textContent = 'The server has not come back yet. If you run it without Docker, start it again by hand.';
      return;
    }
    setTimeout(tick, 1000);
  };
  setTimeout(tick, 1000);
}

hydrateIcons();
initTooltips();
start();
