// The maps list is a tree: folders { kind: 'group' } containing maps { kind: 'map' } and other folders.
// Siblings are ordered by `pos`. Maps whose folder no longer exists show at the top level.

const { db, newId } = require('./db');
const { hasUnpublished } = require('./content');

const ID_RE = /^[0-9a-f]{16}$/;
const str = (s, max) => (typeof s === 'string' ? s.slice(0, max) : '');

class TreeError extends Error {
  constructor(message) { super(message); this.status = 400; }
}

function mapRows() {
  return db.prepare(`
    SELECT id, name, is_default, published_at, draft_at, folder_id, pos,
      (SELECT COUNT(*) FROM layers l WHERE l.map_id = m.id) AS layer_count,
      (SELECT COUNT(*) FROM shapes s WHERE s.map_id = m.id) AS shape_count
    FROM maps m`).all();
}

function buildMapTree() {
  const folders = db.prepare('SELECT * FROM map_folders').all();
  const nodes = new Map();
  for (const f of folders) {
    nodes.set(f.id, { kind: 'group', id: f.id, name: f.name, collapsed: !!f.collapsed, parent: f.parent_id, pos: f.pos, children: [] });
  }
  const leaves = mapRows().map((m) => ({
    kind: 'map', id: m.id, name: m.name, is_default: !!m.is_default,
    published_at: m.published_at, unpublished: hasUnpublished(m),
    layer_count: m.layer_count, shape_count: m.shape_count, parent: m.folder_id, pos: m.pos,
  }));
  const roots = [];
  for (const n of [...nodes.values(), ...leaves]) {
    const parent = n.parent && nodes.get(n.parent);
    (parent ? parent.children : roots).push(n);
  }
  const sortRec = (list) => {
    list.sort((a, b) => a.pos - b.pos || a.name.localeCompare(b.name));
    for (const n of list) {
      delete n.parent;
      delete n.pos;
      if (n.children) sortRec(n.children);
    }
  };
  sortRec(roots);
  return roots;
}

// Maps in list order, each with the names of the folders it sits in.
function orderedMaps() {
  const out = [];
  const walk = (list, path) => {
    for (const n of list) {
      if (n.kind === 'group') walk(n.children, [...path, n.name]);
      else out.push({ ...n, path });
    }
  };
  walk(buildMapTree(), []);
  return out;
}

// Save the whole list from the admin page: folders are replaced, maps are moved into place.
function saveMapTree(tree) {
  if (!Array.isArray(tree)) throw new TreeError('tree must be an array');
  const mapExists = db.prepare('SELECT 1 FROM maps WHERE id = ?');
  const folders = [];
  const maps = [];
  const seen = new Set();
  let count = 0;
  const walk = (list, parentId, depth) => {
    if (!Array.isArray(list)) throw new TreeError('children must be an array');
    if (depth > 32) throw new TreeError('Folders are nested too deeply');
    list.forEach((n, pos) => {
      if (++count > 20000) throw new TreeError('Too many maps and folders');
      if (!n || typeof n !== 'object') throw new TreeError('Bad tree node');
      if (n.kind === 'group') {
        let id = ID_RE.test(n.id) ? n.id : newId();
        if (seen.has(id)) id = newId();
        seen.add(id);
        folders.push({ id, parent_id: parentId, pos, name: str(n.name, 200).trim() || 'Folder', collapsed: n.collapsed ? 1 : 0 });
        walk(n.children || [], id, depth + 1);
      } else if (n.kind === 'map' && ID_RE.test(n.id) && mapExists.get(n.id) && !seen.has(n.id)) {
        seen.add(n.id);
        maps.push({ id: n.id, folder_id: parentId, pos });
      }
    });
  };
  walk(tree, null, 0);

  const insFolder = db.prepare('INSERT INTO map_folders (id, name, parent_id, pos, collapsed) VALUES (@id, @name, @parent_id, @pos, @collapsed)');
  const moveMap = db.prepare('UPDATE maps SET folder_id = @folder_id, pos = @pos WHERE id = @id');
  db.transaction(() => {
    db.prepare('DELETE FROM map_folders').run();
    for (const f of folders) insFolder.run(f);
    for (const m of maps) moveMap.run(m);
  })();
}

function folderExists(id) {
  return !!(id && ID_RE.test(id) && db.prepare('SELECT 1 FROM map_folders WHERE id = ?').get(id));
}

module.exports = { buildMapTree, orderedMaps, saveMapTree, folderExists };
