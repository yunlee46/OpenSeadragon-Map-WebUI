// A map's content (image tree, shapes, background, starting view) exists twice:
//  - the draft: the live tables the editor saves to
//  - the published snapshot (maps.published_json): what visitors see
// Publishing copies the draft into the snapshot; reverting copies the snapshot back.

const { db, getSetting, setSetting } = require('./db');
const { buildTree, pruneHidden, treeIds } = require('./maptree');
const { thumbUrl } = require('./util');

const strip = ({ map_id, ...rest }) => rest;

function draftRows(mapId) {
  return {
    groups: db.prepare('SELECT * FROM layer_groups WHERE map_id = ? ORDER BY pos, rowid').all(mapId).map(strip),
    layers: db.prepare('SELECT * FROM layers WHERE map_id = ? ORDER BY pos, rowid').all(mapId).map(strip),
    shapes: db.prepare('SELECT * FROM shapes WHERE map_id = ? ORDER BY rowid').all(mapId).map(strip),
  };
}

const parseView = (s) => { try { return s ? JSON.parse(s) : null; } catch { return null; } };

function draftContent(map) {
  return { background: map.background, home_view: parseView(map.home_view), ...draftRows(map.id) };
}

function publishedContent(map) {
  if (!map.published_json) return null;
  try { return JSON.parse(map.published_json); } catch { return null; }
}

function publish(mapId) {
  const map = db.prepare('SELECT * FROM maps WHERE id = ?').get(mapId);
  if (!map) return;
  const now = Date.now();
  db.prepare('UPDATE maps SET published_json = ?, published_at = ?, draft_at = COALESCE(draft_at, ?) WHERE id = ?')
    .run(JSON.stringify(draftContent(map)), now, now, mapId);
}

// Throw away draft changes: restore the tables from the published snapshot.
function revert(mapId) {
  const map = db.prepare('SELECT * FROM maps WHERE id = ?').get(mapId);
  const snap = map && publishedContent(map);
  if (!snap) return false;
  const insert = (table, row) => {
    const cols = Object.keys(row);
    db.prepare(`INSERT INTO ${table} (map_id, ${cols.join(', ')}) VALUES (@map_id, ${cols.map((c) => `@${c}`).join(', ')})`)
      .run({ ...row, map_id: mapId });
  };
  db.transaction(() => {
    db.prepare('DELETE FROM layer_groups WHERE map_id = ?').run(mapId);
    db.prepare('DELETE FROM layers WHERE map_id = ?').run(mapId);
    db.prepare('DELETE FROM shapes WHERE map_id = ?').run(mapId);
    const imageOk = db.prepare('SELECT 1 FROM images WHERE id = ?');
    const mapOk = db.prepare('SELECT 1 FROM maps WHERE id = ?');
    for (const g of snap.groups) insert('layer_groups', g);
    for (const l of snap.layers) if (imageOk.get(l.image_id)) insert('layers', l);
    for (const s of snap.shapes) {
      insert('shapes', {
        ...s,
        target_map_id: s.target_map_id && mapOk.get(s.target_map_id) ? s.target_map_id : null,
        image_id: s.image_id && imageOk.get(s.image_id) ? s.image_id : null,
      });
    }
    db.prepare('UPDATE maps SET background = ?, home_view = ?, draft_at = published_at WHERE id = ?')
      .run(snap.background, snap.home_view ? JSON.stringify(snap.home_view) : null, mapId);
  })();
  return true;
}

const hasUnpublished = (map) => !map.published_at || (map.draft_at || 0) > map.published_at;

function listTypes() {
  return db.prepare(`
    SELECT t.*, (SELECT COUNT(*) FROM images i WHERE i.type_id = t.id) AS image_count
    FROM types t ORDER BY t.pos, t.rowid`).all()
    .map((t) => ({ ...t, fade_focus: !!t.fade_focus, fade_zoom: !!t.fade_zoom, fade_small: !!t.fade_small }));
}

const appSettings = () => ({
  focus_opacity: parseFloat(getSetting('focus_opacity', '0.3')),
  small_fade_percent: parseFloat(getSetting('small_fade_percent', '1')), // images below this share of the screen fade out
});

// Everything the viewer or editor needs to show a map.
// forVisitors: hide hidden images/groups and their attached shapes, and only link to published maps.
function mapPayload(map, content, { forVisitors }) {
  const fullTree = buildTree(content.groups, content.layers);
  const tree = forVisitors ? pruneHidden(fullTree) : fullTree;
  const allIds = treeIds(fullTree);
  const visibleIds = treeIds(tree);

  const maps = new Map(db.prepare('SELECT id, name, published_at FROM maps').all().map((m) => [m.id, m]));
  const imageById = db.prepare(`SELECT * FROM images WHERE id = ? AND status = 'ready'`);

  const shapes = [];
  for (const s of content.shapes) {
    // Attached to something hidden: hide the shape too. (Attached to something deleted: keep it.)
    if (forVisitors && s.attach_id && allIds.has(s.attach_id) && !visibleIds.has(s.attach_id)) continue;
    let target = s.target_map_id ? maps.get(s.target_map_id) : null;
    if (target && forVisitors && !target.published_at) target = null;
    const img = s.image_id ? imageById.get(s.image_id) : null;
    shapes.push({
      id: s.id,
      kind: s.kind,
      geometry: typeof s.geometry === 'string' ? JSON.parse(s.geometry) : s.geometry,
      action: s.action || 'map',
      url: s.url || null,
      target_map_id: target ? s.target_map_id : null,
      target_name: target ? target.name : null,
      target_layer_id: target ? s.target_layer_id || null : null,
      title: s.title,
      body: s.body,
      color: s.color,
      attach_id: s.attach_id && allIds.has(s.attach_id) ? s.attach_id : null,
      image_id: img ? img.id : null,
      image_thumb: img ? thumbUrl(img) : null,
      image_name: img ? img.name : null,
    });
  }

  return {
    id: map.id,
    name: map.name,
    is_default: !!map.is_default,
    background: content.background,
    home_view: content.home_view || null,
    tree,
    shapes,
    types: listTypes(),
    settings: appSettings(),
  };
}

// Migration 2 asks for every existing map to be published once, so nothing disappears for visitors.
function publishAllIfPending() {
  if (getSetting('publish_all_pending', '0') !== '1') return;
  const ids = db.prepare('SELECT id FROM maps WHERE published_json IS NULL').all().map((m) => m.id);
  db.transaction(() => { for (const id of ids) publish(id); })();
  setSetting('publish_all_pending', '0');
  if (ids.length) console.log(`Published ${ids.length} existing map(s).`);
}

module.exports = {
  draftContent, publishedContent, publish, revert, hasUnpublished, mapPayload, listTypes, appSettings, publishAllIfPending,
};
