// A map's image list is a tree: groups (folders) containing layers (placed images) and other groups.
// Siblings are stored with `pos` in list order, top of the list first. The top of the list is drawn on top.

const { db, newId } = require('./db');
const { dziUrl, thumbUrl } = require('./util');

const ID_RE = /^[0-9a-f]{16}$/;
const FADE_MODES = ['inherit', 'always', 'never'];
const MAX_DEPTH = 32;
const MAX_NODES = 5000;

const finite = (n) => typeof n === 'number' && Number.isFinite(n);
const str = (s, max) => (typeof s === 'string' ? s.slice(0, max) : '');

class TreeError extends Error {
  constructor(message) { super(message); this.status = 400; }
}

const imageById = db.prepare('SELECT * FROM images WHERE id = ?');

// Build the nested tree from group and layer rows (from the draft tables or a published snapshot).
// Layers whose image is missing or not ready are skipped.
function buildTree(groupRows, layerRows) {
  const nodes = new Map();
  for (const g of groupRows) {
    nodes.set(g.id, {
      kind: 'group', id: g.id, parent_id: g.parent_id, pos: g.pos,
      name: g.name, hidden: !!g.hidden, collapsed: !!g.collapsed, children: [],
    });
  }
  for (const l of layerRows) {
    const img = imageById.get(l.image_id);
    if (!img || img.status !== 'ready') continue;
    nodes.set(l.id, {
      kind: 'layer', id: l.id, parent_id: l.parent_id, pos: l.pos,
      image_id: l.image_id, image_name: img.name, name: l.name || null,
      x: l.x, y: l.y, width: l.width, opacity: l.opacity,
      px_width: img.width, px_height: img.height,
      dzi_url: dziUrl(img), thumb_url: thumbUrl(img),
      image_type_id: img.type_id, type_override: l.type_override,
      fade_mode: l.fade_mode, hidden: !!l.hidden, zoom_fade: l.zoom_fade,
    });
  }

  const roots = [];
  for (const n of nodes.values()) {
    const parent = n.parent_id && nodes.get(n.parent_id);
    (parent && parent.kind === 'group' ? parent.children : roots).push(n);
  }
  const sortRec = (list) => {
    list.sort((a, b) => a.pos - b.pos);
    for (const n of list) {
      delete n.parent_id;
      delete n.pos;
      if (n.children) sortRec(n.children);
    }
  };
  sortRec(roots);
  return roots;
}

const pruneHidden = (list) => list.filter((n) => !n.hidden).map((n) => (n.children ? { ...n, children: pruneHidden(n.children) } : n));

function treeIds(list, out = new Set()) {
  for (const n of list) {
    out.add(n.id);
    if (n.children) treeIds(n.children, out);
  }
  return out;
}

// Validate a tree from the editor and flatten it into rows.
function flattenTree(tree) {
  if (!Array.isArray(tree)) throw new TreeError('tree must be an array');
  const imageOk = db.prepare(`SELECT 1 FROM images WHERE id = ? AND status = 'ready'`);
  const typeOk = db.prepare('SELECT 1 FROM types WHERE id = ?');
  const groups = [];
  const layers = [];
  const seen = new Set();
  let count = 0;

  const walk = (list, parentId, depth) => {
    if (!Array.isArray(list)) throw new TreeError('children must be an array');
    if (depth > MAX_DEPTH) throw new TreeError('Groups are nested too deeply');
    list.forEach((n, pos) => {
      if (++count > MAX_NODES) throw new TreeError('Too many images and groups on one map');
      if (!n || typeof n !== 'object') throw new TreeError('Bad tree node');
      let id = ID_RE.test(n.id) ? n.id : newId();
      if (seen.has(id)) id = newId();
      seen.add(id);

      if (n.kind === 'group') {
        const name = str(n.name, 200).trim() || 'Group';
        groups.push({ id, parent_id: parentId, pos, name, hidden: n.hidden ? 1 : 0, collapsed: n.collapsed ? 1 : 0 });
        walk(n.children || [], id, depth + 1);
      } else if (n.kind === 'layer') {
        const label = n.name ? `"${str(n.name, 60)}"` : `#${count}`;
        if (!ID_RE.test(n.image_id) || !imageOk.get(n.image_id)) throw new TreeError(`Image ${label}: unknown image`);
        if (![n.x, n.y, n.width].every(finite) || n.width <= 0) throw new TreeError(`Image ${label}: bad position or size`);
        const typeOverride = n.type_override && ID_RE.test(n.type_override) && typeOk.get(n.type_override) ? n.type_override : null;
        const zoomFade = finite(n.zoom_fade) && n.zoom_fade > 0 ? n.zoom_fade : null;
        layers.push({
          id, parent_id: parentId, pos, image_id: n.image_id,
          x: n.x, y: n.y, width: n.width,
          opacity: finite(n.opacity) ? Math.min(1, Math.max(0, n.opacity)) : 1,
          name: str(n.name, 200).trim() || null,
          type_override: typeOverride,
          fade_mode: FADE_MODES.includes(n.fade_mode) ? n.fade_mode : 'inherit',
          hidden: n.hidden ? 1 : 0,
          zoom_fade: zoomFade,
        });
      } else {
        throw new TreeError('Tree nodes must be groups or layers');
      }
    });
  };
  walk(tree, null, 0);

  // Draw order: the list is top-first, so the last layer in list order is drawn first.
  layers.forEach((l, i) => { l.z = layers.length - 1 - i; });
  return { groups, layers };
}

function saveTree(mapId, rows) {
  const insGroup = db.prepare(`INSERT INTO layer_groups (id, map_id, parent_id, name, hidden, collapsed, pos)
                               VALUES (@id, @map_id, @parent_id, @name, @hidden, @collapsed, @pos)`);
  const insLayer = db.prepare(`INSERT INTO layers (id, map_id, image_id, x, y, width, opacity, z, parent_id, pos, name,
                                 type_override, fade_mode, hidden, zoom_fade)
                               VALUES (@id, @map_id, @image_id, @x, @y, @width, @opacity, @z, @parent_id, @pos, @name,
                                 @type_override, @fade_mode, @hidden, @zoom_fade)`);
  db.prepare('DELETE FROM layer_groups WHERE map_id = ?').run(mapId);
  db.prepare('DELETE FROM layers WHERE map_id = ?').run(mapId);
  for (const g of rows.groups) insGroup.run({ ...g, map_id: mapId });
  for (const l of rows.layers) insLayer.run({ ...l, map_id: mapId });
}

module.exports = { buildTree, pruneHidden, treeIds, flattenTree, saveTree };
