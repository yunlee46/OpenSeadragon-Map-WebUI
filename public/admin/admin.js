import { api } from '/js/overlay.js';
import { $, h, adminApi, uploadFiles } from './common.js';
import { editor, openEditor } from './editor.js';

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
// Routing: #/maps, #/images, #/settings, #/edit/<id>
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
  for (const v of ['maps', 'images', 'settings', 'editor']) $(`#${v}-view`).hidden = true;
  document.querySelectorAll('[data-nav]').forEach((a) => a.classList.toggle('active', a.dataset.nav === page));
  stopImagePolling();
  editor.dirty = false;
  editor.session++;
  if (page === 'images') { currentRoute = 'images'; showImages(); }
  else if (page === 'settings') { currentRoute = 'settings'; showSettings(); }
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
  if (!confirm(`Delete the map "${m.name}"?\n\nIts placements, groups, hitboxes and notes are deleted. Hitboxes on other maps that link here become unlinked. The images stay in the library.`)) return;
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
  const [images, types] = await Promise.all([adminApi('/api/admin/images'), adminApi('/api/types')]);
  const grid = $('#images-list');
  grid.replaceChildren();
  if (!images.length) grid.append(h('p', { class: 'muted' }, 'No images yet.'));
  for (const img of images) grid.append(imageCard(img, types));

  stopImagePolling();
  if (images.some((i) => i.status === 'processing') && currentRoute === 'images') {
    imagePoll = setTimeout(showImages, 2000);
  }
}

function imageCard(img, types) {
  const thumb = img.status === 'ready'
    ? h('img', { src: img.thumb_url, alt: '', loading: 'lazy', onerror: (e) => e.target.replaceWith(h('div', { class: 'thumb-missing' }, 'no preview')) })
    : h('div', { class: `thumb-status ${img.status}` }, img.status === 'processing' ? 'Tiling…' : 'Failed');
  const typeSelect = h('select', {
    class: 'type-select',
    title: 'Image type',
    onchange: async (e) => {
      await adminApi(`/api/admin/images/${img.id}`, { method: 'PATCH', body: { type_id: e.target.value || null } });
    },
  },
  h('option', { value: '', selected: !img.type_id }, 'No type'),
  ...types.map((t) => h('option', { value: t.id, selected: img.type_id === t.id }, t.name)));

  return h('div', { class: 'card image-card' },
    h('div', { class: 'thumb' }, thumb),
    h('div', { class: 'name', title: img.name }, img.name),
    img.status === 'ready' ? h('div', { class: 'muted small' }, `${img.width.toLocaleString()} × ${img.height.toLocaleString()} px`) : null,
    img.status === 'error' ? h('div', { class: 'error small' }, img.error) : null,
    img.used_in.length ? h('div', { class: 'muted small' }, 'On: ', img.used_in.map((m) => m.name).join(', ')) : null,
    h('label', { class: 'row small' }, 'Type', typeSelect),
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
  if (!types.length) tbody.append(h('tr', {}, h('td', { colSpan: 5, class: 'muted' }, 'No types. Add one below.')));
  for (const t of types) {
    const patch = (body) => adminApi(`/api/admin/types/${t.id}`, { method: 'PATCH', body });
    tbody.append(h('tr', {},
      h('td', {}, h('input', {
        value: t.name, maxLength: 60, class: 'inline-input',
        onchange: async (e) => { if (e.target.value.trim()) await patch({ name: e.target.value }); else e.target.value = t.name; },
      })),
      h('td', {}, h('label', { class: 'switch' }, h('input', { type: 'checkbox', checked: t.fade_focus, onchange: (e) => patch({ fade_focus: e.target.checked }) }))),
      h('td', {}, h('label', { class: 'switch' }, h('input', { type: 'checkbox', checked: t.fade_zoom, onchange: (e) => patch({ fade_zoom: e.target.checked }) }))),
      h('td', { class: 'muted' }, String(t.image_count)),
      h('td', { class: 'actions' }, h('button', {
        class: 'btn small danger',
        onclick: async () => {
          const msg = t.image_count
            ? `Delete the type "${t.name}"? ${t.image_count} image(s) using it will have no type. The images themselves are kept.`
            : `Delete the type "${t.name}"?`;
          if (!confirm(msg)) return;
          await adminApi(`/api/admin/types/${t.id}`, { method: 'DELETE' });
          showSettings();
        },
      }, 'Delete')),
    ));
  }

  const slider = $('#focus-default');
  slider.value = settings.focus_opacity;
  $('#focus-default-out').textContent = `${Math.round(settings.focus_opacity * 100)}%`;
}

$('#new-type-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const name = e.target.name.value.trim();
  if (!name) return;
  await adminApi('/api/admin/types', { method: 'POST', body: { name, fade_focus: true, fade_zoom: true } });
  e.target.reset();
  showSettings();
});

$('#focus-default').addEventListener('input', (e) => {
  $('#focus-default-out').textContent = `${Math.round(e.target.value * 100)}%`;
});
$('#focus-default').addEventListener('change', (e) => {
  adminApi('/api/admin/settings', { method: 'PATCH', body: { focus_opacity: parseFloat(e.target.value) } });
});

start();
