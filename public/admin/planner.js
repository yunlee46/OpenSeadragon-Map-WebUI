// Planner page: a to-do list of images still to be made.

import * as T from '/js/tree.js';
import { $, h, iconBtn, adminApi, uploadFiles } from './common.js';
import { icon } from '/js/icons.js';

const STATUS = { idea: 'Idea', progress: 'In progress', done: 'Done' };
const PRIORITY = { 2: 'High', 1: 'Normal', 0: 'Low' };

const plan = {
  items: [],
  types: [],
  maps: [],
  groupsByMap: new Map(), // map id -> [{ id, label }]
  expanded: new Set(),
  poll: null,
  active: false,
};

export function stopPlanner() {
  plan.active = false;
  clearTimeout(plan.poll);
}

export async function showPlanner() {
  plan.active = true;
  $('#planner-view').hidden = false;
  const [items, types, maps] = await Promise.all([
    adminApi('/api/admin/planner'), adminApi('/api/types'), adminApi('/api/admin/maps'),
  ]);
  Object.assign(plan, { items, types, maps });
  const typeFilter = $('#plan-type');
  const keep = typeFilter.value;
  typeFilter.replaceChildren(h('option', { value: '' }, 'Any type'), ...types.map((t) => h('option', { value: t.id }, t.name)));
  typeFilter.value = keep;
  render();
  schedulePoll();
}

// While a planner image is still being tiled, refresh now and then.
function schedulePoll() {
  clearTimeout(plan.poll);
  if (!plan.active || !plan.items.some((i) => i.image?.status === 'processing')) return;
  plan.poll = setTimeout(async () => {
    if (!plan.active) return;
    plan.items = await adminApi('/api/admin/planner');
    render();
    schedulePoll();
  }, 2000);
}

function visibleItems() {
  const q = $('#plan-search').value.trim().toLowerCase();
  const status = $('#plan-status').value;
  const priority = $('#plan-priority').value;
  const type = $('#plan-type').value;
  return plan.items.filter((i) => (!q || i.title.toLowerCase().includes(q) || i.notes.toLowerCase().includes(q))
    && (!status || (status === 'open' ? i.status !== 'done' : i.status === status))
    && (priority === '' || i.priority === +priority)
    && (!type || i.type_id === type));
}

function render() {
  const list = $('#plan-list');
  const items = visibleItems();
  $('#plan-count').textContent = `${items.length} of ${plan.items.length}`;
  list.replaceChildren(...(items.length ? items.map(itemCard)
    : [h('p', { class: 'muted' }, plan.items.length ? 'Nothing matches these filters.' : 'Nothing planned yet. Add the first image you want to make above.')]));
}

async function patch(item, body, rerender = true) {
  const updated = await adminApi(`/api/admin/planner/${item.id}`, { method: 'PATCH', body });
  Object.assign(item, updated);
  if (rerender) render();
  schedulePoll();
}

async function groupOptions(mapId) {
  if (!mapId) return [];
  if (!plan.groupsByMap.has(mapId)) {
    const m = await adminApi(`/api/admin/maps/${mapId}`);
    const groups = [];
    T.walk(m.tree, (n, parent, depth) => { if (n.kind === 'group') groups.push({ id: n.id, label: `${'  '.repeat(depth)}${n.name}` }); });
    plan.groupsByMap.set(mapId, groups);
  }
  return plan.groupsByMap.get(mapId);
}

function itemCard(item) {
  const open = plan.expanded.has(item.id);
  const img = item.image;

  const imageArea = img
    ? h('div', { class: 'plan-image' },
      img.thumb_url ? h('img', { src: img.thumb_url, alt: '' }) : h('div', { class: `thumb-status ${img.status}` }, img.status === 'processing' ? 'Tiling…' : 'Failed'),
      h('div', {},
        h('div', { class: 'name' }, img.name),
        img.status === 'ready' ? h('div', { class: 'muted small' }, `${img.width} × ${img.height} px`) : null,
        img.status === 'error' ? h('div', { class: 'error small' }, img.error) : null,
        iconBtn('unlink', 'Unlink this image from the item (the image stays in the library)', { onclick: () => patch(item, { image_id: null }) }, 'small ghost')))
    : h('div', { class: 'plan-actions' },
      iconBtn('upload', 'Upload the finished image', { onclick: () => pickImage(item) }, 'primary'),
      iconBtn('link', 'Link an image that is already in the library', { onclick: () => openLinkDialog(item) }, 'ghost'));

  const card = h('div', { class: `card plan-item status-${item.status} prio-${item.priority}`, 'data-id': item.id },
    h('div', { class: 'plan-main' },
      h('button', { class: 'plan-expand', 'data-tip': open ? 'Hide details' : 'Show details', onclick: () => {
        if (open) plan.expanded.delete(item.id); else plan.expanded.add(item.id);
        render();
      } }, open ? '▾' : '▸'),
      h('input', {
        class: 'plan-title', value: item.title, maxLength: 200,
        onchange: (e) => { if (e.target.value.trim()) patch(item, { title: e.target.value }); else e.target.value = item.title; },
      }),
      h('select', { class: 'pill', 'data-tip': 'Status', onchange: (e) => patch(item, { status: e.target.value }) },
        ...Object.entries(STATUS).map(([v, l]) => h('option', { value: v, selected: item.status === v }, l))),
      h('select', { class: 'pill prio', 'data-tip': 'Priority', onchange: (e) => patch(item, { priority: +e.target.value }) },
        ...Object.entries(PRIORITY).map(([v, l]) => h('option', { value: v, selected: item.priority === +v }, l))),
      h('select', { class: 'pill', 'data-tip': 'Type the image will get', onchange: (e) => patch(item, { type_id: e.target.value || null }) },
        h('option', { value: '', selected: !item.type_id }, 'No type'),
        ...plan.types.map((t) => h('option', { value: t.id, selected: item.type_id === t.id }, t.name))),
      imageArea,
    ),
    item.map_name && !open ? h('div', { class: 'muted small plan-sub' }, `For ${item.map_name}${item.group_name ? ` › ${item.group_name}` : ''}`) : null,
    item.refs.length && !open ? h('div', { class: 'plan-refs mini' }, ...item.refs.slice(0, 6).map((r) => h('img', { src: r.thumb_url, alt: r.name, title: r.name }))) : null,
  );
  if (open) card.append(details(item));
  return card;
}

function details(item) {
  let notesTimer;
  const groupSelect = h('select', { onchange: (e) => patch(item, { group_id: e.target.value || null }) },
    h('option', { value: '' }, item.map_id ? 'Any group' : '—'));
  groupSelect.disabled = !item.map_id;
  groupOptions(item.map_id).then((groups) => {
    groupSelect.append(...groups.map((g) => h('option', { value: g.id, selected: g.id === item.group_id }, g.label)));
  }).catch(() => {});

  return h('div', { class: 'plan-details' },
    h('label', {}, 'Notes', h('textarea', {
      rows: 4, value: item.notes, maxLength: 20000, placeholder: 'What should the image show? Ideas, references, sizes…',
      oninput: (e) => {
        clearTimeout(notesTimer);
        notesTimer = setTimeout(() => patch(item, { notes: e.target.value }, false), 500);
      },
    })),
    h('div', { class: 'plan-for' },
      h('label', {}, 'Planned for map', h('select', { onchange: (e) => patch(item, { map_id: e.target.value || null, group_id: null }) },
        h('option', { value: '' }, 'No particular map'),
        ...plan.maps.map((m) => h('option', { value: m.id, selected: m.id === item.map_id }, [...(m.path || []), m.name].join(' › '))))),
      h('label', {}, 'Group on that map', groupSelect),
    ),
    h('div', {},
      h('div', { class: 'small muted' }, 'Reference images'),
      h('div', { class: 'plan-refs' },
        ...item.refs.map((r) => h('div', { class: 'ref' },
          h('img', { src: r.thumb_url, alt: r.name, title: `${r.name} (click to enlarge)`, onclick: () => openRef(r) }),
          h('button', { class: 'ref-del', 'data-tip': 'Remove this reference', 'aria-label': 'Remove this reference', html: icon('x'), onclick: () => deleteRef(item, r) }))),
        h('button', { class: 'ref add', 'data-tip': 'Add reference images', 'aria-label': 'Add reference images', html: icon('plus'), onclick: () => pickRefs(item) })),
    ),
    h('div', { class: 'btn-row' },
      iconBtn('trash', 'Delete this planner item', { onclick: () => deleteItem(item) }, 'small danger'),
      item.image ? h('span', { class: 'muted small' }, 'Deleting the item keeps its image in the library.') : null),
  );
}

// ---------- actions ----------

let fileTarget = null;

function pickImage(item) {
  fileTarget = item;
  $('#plan-image-input').click();
}

$('#plan-image-input').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  const item = fileTarget;
  if (!file || !item) return;
  const card = document.querySelector(`.plan-item[data-id="${item.id}"]`);
  const actions = card?.querySelector('.plan-actions');
  if (actions) actions.replaceChildren(h('span', { class: 'muted small' }, 'Uploading…'));
  try {
    await uploadFiles([file], (p) => { if (actions) actions.firstChild.textContent = `Uploading ${Math.round(p * 100)}%`; }, { planner_item_id: item.id });
  } catch (err) {
    alert(err.message);
  }
  plan.items = await adminApi('/api/admin/planner');
  render();
  schedulePoll();
});

function pickRefs(item) {
  fileTarget = item;
  $('#plan-ref-input').click();
}

$('#plan-ref-input').addEventListener('change', async (e) => {
  const files = [...e.target.files];
  e.target.value = '';
  const item = fileTarget;
  if (!files.length || !item) return;
  const form = new FormData();
  for (const f of files) form.append('files', f);
  const out = await adminApi(`/api/admin/planner/${item.id}/refs`, { method: 'POST', body: form });
  Object.assign(item, out.item);
  if (out.failed.length) alert(`These files aren't images and were skipped: ${out.failed.join(', ')}`);
  render();
});

async function deleteRef(item, ref) {
  await adminApi(`/api/admin/planner/refs/${ref.id}`, { method: 'DELETE' });
  item.refs = item.refs.filter((r) => r.id !== ref.id);
  render();
}

function openRef(ref) {
  $('#ref-title').textContent = ref.name;
  $('#ref-full').src = ref.full_url;
  $('#ref-dialog').showModal();
}
$('#ref-close').addEventListener('click', () => $('#ref-dialog').close());
$('#ref-dialog').addEventListener('click', (e) => { if (e.target === $('#ref-dialog')) $('#ref-dialog').close(); });

async function deleteItem(item) {
  if (!confirm(`Delete the planner item "${item.title}"?${item.image ? ' Its image stays in the library.' : ''}`)) return;
  await adminApi(`/api/admin/planner/${item.id}`, { method: 'DELETE' });
  plan.items = plan.items.filter((i) => i.id !== item.id);
  render();
}

async function openLinkDialog(item) {
  const dialog = $('#link-dialog');
  const grid = $('#link-grid');
  grid.replaceChildren(h('p', { class: 'muted' }, 'Loading…'));
  dialog.showModal();
  const images = (await adminApi('/api/admin/images')).filter((i) => i.status === 'ready');
  const draw = () => {
    const q = $('#link-search').value.trim().toLowerCase();
    const shown = images.filter((i) => !q || i.name.toLowerCase().includes(q));
    grid.replaceChildren(...(shown.length ? shown.map((img) => h('button', {
      class: 'card image-card pick',
      onclick: async () => { dialog.close(); await patch(item, { image_id: img.id }); },
    },
    h('div', { class: 'thumb' }, h('img', { src: img.thumb_url, alt: '', loading: 'lazy' })),
    h('div', { class: 'name' }, img.name),
    img.planner_item ? h('div', { class: 'muted small' }, `Already linked to “${img.planner_item.title}”`) : null,
    )) : [h('p', { class: 'muted' }, 'No images.')]));
  };
  $('#link-search').value = '';
  $('#link-search').oninput = draw;
  draw();
}
$('#link-close').addEventListener('click', () => $('#link-dialog').close());

$('#new-plan-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const title = e.target.title.value.trim();
  if (!title) return;
  const item = await adminApi('/api/admin/planner', { method: 'POST', body: { title } });
  plan.items.unshift(item);
  plan.expanded.add(item.id);
  e.target.reset();
  render();
});

for (const id of ['plan-search', 'plan-status', 'plan-priority', 'plan-type']) {
  $(`#${id}`).addEventListener(id === 'plan-search' ? 'input' : 'change', render);
}
