// Blender-style image list: nested, collapsible groups; drag and drop to reorder or regroup;
// eye toggles; thumbnails. Used read-only by the public viewer.

import { displayName } from './tree.js';

export const ICONS = {
  folder: '<svg viewBox="0 0 16 16"><path d="M1.5 3.5h4l1.5 1.5h7.5v8h-13z" fill="currentColor" opacity=".85"/></svg>',
  eye: '<svg viewBox="0 0 16 16"><path d="M1 8s2.6-4.5 7-4.5S15 8 15 8s-2.6 4.5-7 4.5S1 8 1 8z" fill="none" stroke="currentColor" stroke-width="1.4"/><circle cx="8" cy="8" r="2.1" fill="currentColor"/></svg>',
  eyeOff: '<svg viewBox="0 0 16 16"><path d="M1 8s2.6-4.5 7-4.5S15 8 15 8s-2.6 4.5-7 4.5S1 8 1 8z" fill="none" stroke="currentColor" stroke-width="1.4" opacity=".45"/><path d="M2.5 13.5l11-11" stroke="currentColor" stroke-width="1.5"/></svg>',
  library: '<svg viewBox="0 0 16 16"><rect x="1.5" y="3" width="10" height="9" rx="1" fill="none" stroke="currentColor" stroke-width="1.3"/><path d="M3 10.5l2.5-3 2 2 1.2-1.3 1.8 2.3z" fill="currentColor"/><path d="M13.5 6v6.5a1 1 0 0 1-1 1H4" fill="none" stroke="currentColor" stroke-width="1.3"/></svg>',
  upload: '<svg viewBox="0 0 16 16"><path d="M8 11V2.5M4.5 6L8 2.5 11.5 6" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M2 10.5v3h12v-3" fill="none" stroke="currentColor" stroke-width="1.5"/></svg>',
  newGroup: '<svg viewBox="0 0 16 16"><path d="M1.5 3.5h4l1.5 1.5h7.5v8h-13z" fill="none" stroke="currentColor" stroke-width="1.3"/><path d="M8 7v4.5M5.75 9.25h4.5" stroke="currentColor" stroke-width="1.4"/></svg>',
  target: '<svg viewBox="0 0 16 16"><circle cx="8" cy="8" r="5.5" fill="none" stroke="currentColor" stroke-width="1.3"/><circle cx="8" cy="8" r="2" fill="currentColor"/></svg>',
};

let dragId = null;

export function renderOutliner(container, tree, opts) {
  container.replaceChildren();
  container.classList.add('outliner');
  const root = document.createElement('ul');
  root.className = 'ol-list';
  for (const n of tree) root.append(nodeEl(n, 0, opts));
  container.append(root);

  if (!tree.length) {
    const empty = document.createElement('div');
    empty.className = 'ol-empty';
    empty.textContent = opts.emptyText || 'Nothing here yet.';
    container.append(empty);
  }

  if (!opts.readOnly) {
    // Drop below the last row = move to the bottom of the top level.
    const tail = document.createElement('div');
    tail.className = 'ol-tail';
    tail.addEventListener('dragover', (e) => {
      if (!dragId || !(opts.canDrop?.(dragId, null, 'root') ?? true)) return;
      e.preventDefault();
      tail.classList.add('drop-root');
    });
    tail.addEventListener('dragleave', () => tail.classList.remove('drop-root'));
    tail.addEventListener('drop', (e) => {
      e.preventDefault();
      tail.classList.remove('drop-root');
      if (dragId) opts.onDrop(dragId, null, 'root');
    });
    container.append(tail);
  }
}

function nodeEl(n, depth, opts) {
  const li = document.createElement('li');
  li.className = 'ol-node';
  const row = document.createElement('div');
  const isGroup = n.kind === 'group';
  const collapsed = isGroup && opts.isCollapsed(n);
  row.className = [
    'ol-row',
    isGroup ? 'group' : 'layer',
    opts.selectedId === n.id && 'selected',
    opts.focusIds?.has(n.id) && 'focused',
    n.hidden && 'is-hidden',
  ].filter(Boolean).join(' ');
  row.style.setProperty('--depth', depth);
  row.dataset.id = n.id;

  const caret = document.createElement('span');
  caret.className = 'ol-caret';
  if (isGroup) {
    caret.textContent = collapsed ? '▸' : '▾';
    caret.addEventListener('click', (e) => { e.stopPropagation(); opts.onToggleCollapse(n); });
  }

  const icon = document.createElement('span');
  icon.className = 'ol-icon';
  if (isGroup) {
    icon.innerHTML = ICONS.folder;
  } else if (opts.leafIcon) {
    icon.innerHTML = opts.leafIcon(n);
    icon.classList.add('svg');
  } else {
    const img = document.createElement('img');
    img.src = n.thumb_url;
    img.alt = '';
    img.loading = 'lazy';
    img.draggable = false;
    icon.append(img);
  }

  const name = document.createElement('span');
  name.className = 'ol-name';
  name.textContent = isGroup ? n.name : displayName(n);
  name.title = name.textContent;

  row.append(caret, icon, name);

  if (isGroup) {
    const count = document.createElement('span');
    count.className = 'ol-badge';
    count.textContent = countLayers(n);
    row.append(count);
  } else {
    const type = opts.typeName?.(n);
    // (maps and other leaves pass their own badges through opts.extras)
    if (type) {
      const badge = document.createElement('span');
      badge.className = 'ol-badge type';
      badge.textContent = type;
      row.append(badge);
    }
  }

  // Extra per-row content (badges, action buttons); clicks on it don't select or drag the row.
  const extras = opts.extras?.(n) || [];
  for (const el of extras) {
    el.addEventListener('pointerdown', (e) => e.stopPropagation());
    el.addEventListener('click', (e) => e.stopPropagation());
    el.draggable = false;
    el.classList.add('ol-extra');
    row.append(el);
  }

  if (!opts.readOnly && (opts.showEye ?? true)) {
    const eye = document.createElement('button');
    eye.className = 'ol-eye';
    eye.dataset.tip = n.hidden ? 'Hidden (click to show)' : 'Visible (click to hide)';
    eye.innerHTML = n.hidden ? ICONS.eyeOff : ICONS.eye;
    eye.addEventListener('click', (e) => { e.stopPropagation(); opts.onToggleHidden(n); });
    row.append(eye);
  }

  if (!opts.readOnly) {
    row.draggable = true;
    row.addEventListener('dragstart', (e) => {
      dragId = n.id;
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', n.id);
      requestAnimationFrame(() => { if (dragId === n.id) row.classList.add('dragging'); });
    });
    row.addEventListener('dragend', () => { dragId = null; row.classList.remove('dragging'); clearDrop(); });
    row.addEventListener('dragover', (e) => {
      if (!dragId) return;
      const where = dropPosition(e, row, isGroup);
      if (dragId === n.id || !(opts.canDrop?.(dragId, n.id, where) ?? true)) return;
      e.preventDefault();
      clearDrop();
      row.classList.add(`drop-${where}`);
    });
    row.addEventListener('dragleave', () => row.classList.remove('drop-before', 'drop-after', 'drop-inside'));
    row.addEventListener('drop', (e) => {
      e.preventDefault();
      const where = dropPosition(e, row, isGroup);
      clearDrop();
      if (dragId && dragId !== n.id) opts.onDrop(dragId, n.id, where);
    });
  }

  row.addEventListener('click', (e) => opts.onSelect?.(n, e));
  row.addEventListener('dblclick', (e) => {
    if (e.target.closest('.ol-eye, .ol-caret, .ol-extra')) return;
    opts.onDblClick?.(n, e);
  });
  row.addEventListener('contextmenu', (e) => {
    if (!opts.onContext) return;
    e.preventDefault();
    opts.onContext(n, e);
  });

  li.append(row);
  if (isGroup && !collapsed && n.children.length) {
    const ul = document.createElement('ul');
    ul.className = 'ol-list';
    for (const c of n.children) ul.append(nodeEl(c, depth + 1, opts));
    li.append(ul);
  }
  return li;
}

function dropPosition(e, row, isGroup) {
  const r = row.getBoundingClientRect();
  const f = (e.clientY - r.top) / r.height;
  if (isGroup) return f < 0.28 ? 'before' : f > 0.72 ? 'after' : 'inside';
  return f < 0.5 ? 'before' : 'after';
}

function clearDrop() {
  document.querySelectorAll('.drop-before, .drop-after, .drop-inside, .drop-root')
    .forEach((el) => el.classList.remove('drop-before', 'drop-after', 'drop-inside', 'drop-root'));
}

function countLayers(g) {
  let n = 0;
  for (const c of g.children) n += c.kind === 'group' ? countLayers(c) : 1;
  return n;
}
