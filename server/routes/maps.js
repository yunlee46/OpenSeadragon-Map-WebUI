const express = require('express');
const { db, newId } = require('../db');
const auth = require('../auth');
const { flattenTree, saveTree } = require('../maptree');
const content = require('../content');
const { ID_RE, COLOR_RE, URL_RE, str, HttpError, wrap, validGeometry, validView } = require('../util');

const pub = express.Router();
const admin = express.Router();

function getMap(id) {
  const map = db.prepare('SELECT * FROM maps WHERE id = ?').get(id);
  if (!map) throw new HttpError(404, 'Map not found');
  return map;
}

const touchDraft = (id) => db.prepare('UPDATE maps SET draft_at = ? WHERE id = ?').run(Date.now(), id);

// ---------- public ----------

pub.get('/maps', (req, res) => {
  const maps = db.prepare('SELECT id, name, is_default FROM maps WHERE published_at IS NOT NULL ORDER BY name COLLATE NOCASE').all()
    .map((m) => ({ ...m, is_default: !!m.is_default }));
  if (maps.length && !maps.some((m) => m.is_default)) maps[0].is_default = true;
  res.json(maps);
});

pub.get('/maps/:id', wrap((req, res) => {
  const map = getMap(req.params.id);
  // Admins can preview the draft exactly as visitors would see it after publishing.
  if (req.query.preview === '1' && auth.isAdmin(req)) {
    return res.json({ ...content.mapPayload(map, content.draftContent(map), { forVisitors: true }), preview: true });
  }
  const snap = content.publishedContent(map);
  if (!snap) throw new HttpError(404, 'This map has not been published yet');
  res.json(content.mapPayload(map, snap, { forVisitors: true }));
}));

const plain = (s) => s
  .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1') // [text](url) -> text
  .replace(/[*_`#>[\]()!]/g, '')
  .replace(/\s+/g, ' ')
  .trim();
function snippet(text, q) {
  const t = plain(text);
  const i = t.toLowerCase().indexOf(q);
  if (i < 0) return t.slice(0, 90);
  const start = Math.max(0, i - 35);
  return (start ? '…' : '') + t.slice(start, i + q.length + 55) + (i + q.length + 55 < t.length ? '…' : '');
}

// Search published maps: map names, image names, note titles/text and hitbox labels.
pub.get('/search', (req, res) => {
  const q = str(req.query.q, 100).trim().toLowerCase();
  if (q.length < 2) return res.json([]);
  const results = [];
  const maps = db.prepare('SELECT * FROM maps WHERE published_at IS NOT NULL ORDER BY name COLLATE NOCASE').all();
  for (const map of maps) {
    const snap = content.publishedContent(map);
    if (!snap) continue;
    const data = content.mapPayload(map, snap, { forVisitors: true });
    const base = { map_id: map.id, map_name: map.name };
    if (map.name.toLowerCase().includes(q)) results.push({ ...base, kind: 'map', id: map.id, label: map.name });
    const walk = (list) => {
      for (const n of list) {
        if (n.kind === 'group') walk(n.children);
        else if ((n.name || n.image_name).toLowerCase().includes(q)) {
          results.push({ ...base, kind: 'image', id: n.id, label: n.name || n.image_name, thumb: n.thumb_url });
        }
      }
    };
    walk(data.tree);
    for (const s of data.shapes) {
      const inTitle = s.title.toLowerCase().includes(q);
      const inBody = s.kind === 'annotation' && s.body.toLowerCase().includes(q);
      if (!inTitle && !inBody) continue;
      results.push({
        ...base,
        kind: s.kind === 'annotation' ? 'note' : 'hitbox',
        id: s.id,
        label: s.title || (s.kind === 'annotation' ? 'Note' : 'Hitbox'),
        snippet: inBody ? snippet(s.body, q) : null,
      });
    }
    if (results.length >= 60) break;
  }
  res.json(results.slice(0, 60));
});

// ---------- admin ----------

admin.get('/maps', (req, res) => {
  res.json(db.prepare(`
    SELECT id, name, is_default, published_at, draft_at,
      (SELECT COUNT(*) FROM layers l WHERE l.map_id = m.id) AS layer_count,
      (SELECT COUNT(*) FROM shapes s WHERE s.map_id = m.id) AS shape_count
    FROM maps m ORDER BY name COLLATE NOCASE`).all()
    .map((m) => ({ ...m, is_default: !!m.is_default, unpublished: content.hasUnpublished(m) })));
});

admin.post('/maps', wrap((req, res) => {
  const name = str(req.body.name, 200).trim();
  if (!name) throw new HttpError(400, 'Name is required');
  const id = newId();
  const first = db.prepare('SELECT COUNT(*) AS n FROM maps').get().n === 0;
  db.prepare('INSERT INTO maps (id, name, is_default, created_at, draft_at) VALUES (?, ?, ?, ?, ?)').run(id, name, first ? 1 : 0, Date.now(), Date.now());
  res.status(201).json({ id });
}));

// Name and "default" apply immediately; background and starting view are part of the draft.
admin.patch('/maps/:id', wrap((req, res) => {
  const map = getMap(req.params.id);
  const { name, background, is_default, home_view } = req.body;
  db.transaction(() => {
    if (name !== undefined) {
      const n = str(name, 200).trim();
      if (!n) throw new HttpError(400, 'Name cannot be empty');
      db.prepare('UPDATE maps SET name = ? WHERE id = ?').run(n, map.id);
    }
    if (background !== undefined && background !== map.background) {
      if (!COLOR_RE.test(background)) throw new HttpError(400, 'Background must be a #rrggbb colour');
      db.prepare('UPDATE maps SET background = ? WHERE id = ?').run(background, map.id);
      touchDraft(map.id);
    }
    if (home_view !== undefined) {
      const v = home_view === null ? null : validView(home_view);
      if (home_view !== null && !v) throw new HttpError(400, 'Bad starting view');
      const json = v ? JSON.stringify(v) : null;
      if (json !== map.home_view) {
        db.prepare('UPDATE maps SET home_view = ? WHERE id = ?').run(json, map.id);
        touchDraft(map.id);
      }
    }
    if (is_default === true) {
      db.prepare('UPDATE maps SET is_default = 0').run();
      db.prepare('UPDATE maps SET is_default = 1 WHERE id = ?').run(map.id);
    }
  })();
  res.json({ ok: true });
}));

admin.delete('/maps/:id', wrap((req, res) => {
  const map = getMap(req.params.id);
  db.transaction(() => {
    db.prepare('DELETE FROM maps WHERE id = ?').run(map.id);
    if (map.is_default) {
      const next = db.prepare('SELECT id FROM maps ORDER BY created_at LIMIT 1').get();
      if (next) db.prepare('UPDATE maps SET is_default = 1 WHERE id = ?').run(next.id);
    }
  })();
  res.json({ ok: true });
}));

// The draft, including hidden images and groups, for the editor.
admin.get('/maps/:id', wrap((req, res) => {
  const map = getMap(req.params.id);
  res.json({
    ...content.mapPayload(map, content.draftContent(map), { forVisitors: false }),
    published_at: map.published_at,
    unpublished: content.hasUnpublished(map),
  });
}));

// Save the draft: the image tree, hitboxes and notes, in one go.
admin.put('/maps/:id/content', wrap((req, res) => {
  const map = getMap(req.params.id);
  const { tree, shapes } = req.body;
  if (!Array.isArray(tree) || !Array.isArray(shapes)) throw new HttpError(400, 'tree and shapes must be arrays');

  const rows = flattenTree(tree);
  const nodeIds = new Set([...rows.groups, ...rows.layers].map((n) => n.id));
  const mapExists = db.prepare('SELECT 1 FROM maps WHERE id = ?');
  const imageExists = db.prepare('SELECT 1 FROM images WHERE id = ?');
  const cleanShapes = shapes.map((s, i) => {
    if (!s || !['hitbox', 'annotation'].includes(s.kind)) throw new HttpError(400, `Shape ${i + 1}: bad kind`);
    const geometry = validGeometry(s.geometry);
    if (!geometry) throw new HttpError(400, `Shape ${i + 1}: bad geometry`);
    const action = s.kind === 'hitbox' && s.action === 'url' ? 'url' : 'map';
    let target = null;
    if (s.kind === 'hitbox' && action === 'map' && s.target_map_id) {
      if (!ID_RE.test(s.target_map_id) || !mapExists.get(s.target_map_id)) throw new HttpError(400, `Shape ${i + 1}: target map does not exist`);
      target = s.target_map_id;
    }
    let url = null;
    if (action === 'url' && s.url) {
      url = str(s.url, 2000).trim();
      if (!URL_RE.test(url)) throw new HttpError(400, `Shape ${i + 1}: the link must start with http:// or https://`);
    }
    return {
      id: ID_RE.test(s.id) ? s.id : newId(),
      kind: s.kind,
      geometry: JSON.stringify(geometry),
      target_map_id: target,
      target_layer_id: target && ID_RE.test(s.target_layer_id) ? s.target_layer_id : null,
      action,
      url,
      title: str(s.title, 300),
      body: str(s.body, 20000),
      color: COLOR_RE.test(s.color) ? s.color : '#4da3ff',
      attach_id: s.attach_id && nodeIds.has(s.attach_id) ? s.attach_id : null,
      image_id: s.kind === 'annotation' && ID_RE.test(s.image_id) && imageExists.get(s.image_id) ? s.image_id : null,
    };
  });

  const insShape = db.prepare(`INSERT INTO shapes (id, map_id, kind, geometry, target_map_id, target_layer_id, action, url,
                                 title, body, color, attach_id, image_id)
                               VALUES (@id, @map_id, @kind, @geometry, @target_map_id, @target_layer_id, @action, @url,
                                 @title, @body, @color, @attach_id, @image_id)`);
  db.transaction(() => {
    saveTree(map.id, rows);
    db.prepare('DELETE FROM shapes WHERE map_id = ?').run(map.id);
    for (const s of cleanShapes) insShape.run({ ...s, map_id: map.id });
    touchDraft(map.id);
  })();
  res.json({ ok: true });
}));

admin.post('/maps/:id/publish', wrap((req, res) => {
  const map = getMap(req.params.id);
  content.publish(map.id);
  res.json({ ok: true });
}));

admin.post('/maps/:id/revert', wrap((req, res) => {
  const map = getMap(req.params.id);
  if (!content.revert(map.id)) throw new HttpError(400, 'This map has never been published, so there is nothing to go back to');
  res.json({ ok: true });
}));

module.exports = { pub, admin };
