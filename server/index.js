const path = require('path');
const fs = require('fs');
const fsp = require('fs/promises');
const express = require('express');
const multer = require('multer');
const config = require('./config');
const { db, newId, getSetting, setSetting } = require('./db');
const { loadTree, flattenTree, saveTree } = require('./maptree');
const auth = require('./auth');
const { queueUpload } = require('./tiler');

fs.mkdirSync(config.TILES_DIR, { recursive: true });
fs.mkdirSync(config.UPLOAD_TMP, { recursive: true });

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', process.env.TRUST_PROXY === 'true');
app.use(express.json({ limit: '10mb' }));

const PUBLIC = path.join(__dirname, '..', 'public');
const OSD_BUILD = path.join(path.dirname(require.resolve('openseadragon/package.json')), 'build', 'openseadragon');

app.use('/vendor/osd', express.static(OSD_BUILD, { maxAge: '7d' }));
app.use('/tiles', express.static(config.TILES_DIR, { maxAge: '30d', immutable: true, fallthrough: false }));
app.use(express.static(PUBLIC));

// ---------- helpers ----------

const ID_RE = /^[0-9a-f]{16}$/;
const COLOR_RE = /^#[0-9a-fA-F]{6}$/;
const finite = (n) => typeof n === 'number' && Number.isFinite(n);
const str = (s, max) => (typeof s === 'string' ? s.slice(0, max) : '');

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

const dziUrl = (img) => `/tiles/${img.id}/${img.dzi_path.split('/').map(encodeURIComponent).join('/')}`;

function publicImage(img) {
  return {
    id: img.id,
    name: img.name,
    status: img.status,
    error: img.error,
    width: img.width,
    height: img.height,
    dzi_url: img.status === 'ready' ? dziUrl(img) : null,
    thumb_url: img.status === 'ready' ? `/tiles/${img.id}/thumb.webp` : null,
    type_id: img.type_id || null,
    created_at: img.created_at,
  };
}

function getMap(id) {
  const map = db.prepare('SELECT * FROM maps WHERE id = ?').get(id);
  if (!map) throw new HttpError(404, 'Map not found');
  return map;
}

function validGeometry(g) {
  if (!g || typeof g !== 'object') return null;
  if (g.type === 'rect') {
    const { x, y, w, h } = g;
    if (![x, y, w, h].every(finite) || w <= 0 || h <= 0) return null;
    return { type: 'rect', x, y, w, h };
  }
  if (g.type === 'polygon') {
    if (!Array.isArray(g.points) || g.points.length < 3 || g.points.length > 2000) return null;
    const points = g.points.map((p) => (Array.isArray(p) && finite(p[0]) && finite(p[1]) ? [p[0], p[1]] : null));
    if (points.includes(null)) return null;
    return { type: 'polygon', points };
  }
  return null;
}

const wrap = (fn) => (req, res, next) => {
  try {
    const out = fn(req, res, next);
    if (out && typeof out.catch === 'function') out.catch(next);
  } catch (e) {
    next(e);
  }
};

// ---------- auth ----------

app.post('/api/login', auth.login);
app.post('/api/logout', auth.logout);
app.get('/api/me', (req, res) => res.json({ admin: auth.isAdmin(req) }));

// ---------- public read API ----------

app.get('/api/maps', (req, res) => {
  res.json(db.prepare(`
    SELECT id, name, is_default,
      (SELECT COUNT(*) FROM layers l WHERE l.map_id = m.id) AS layer_count,
      (SELECT COUNT(*) FROM shapes s WHERE s.map_id = m.id) AS shape_count
    FROM maps m ORDER BY name COLLATE NOCASE`).all()
    .map((m) => ({ ...m, is_default: !!m.is_default })));
});

const listTypes = () => db.prepare(`
  SELECT t.*, (SELECT COUNT(*) FROM images i WHERE i.type_id = t.id) AS image_count
  FROM types t ORDER BY t.pos, t.rowid`).all()
  .map((t) => ({ ...t, fade_focus: !!t.fade_focus, fade_zoom: !!t.fade_zoom }));

const appSettings = () => ({ focus_opacity: parseFloat(getSetting('focus_opacity', '0.3')) });

function mapPayload(map, includeHidden) {
  const shapes = db.prepare(`
    SELECT s.*, t.name AS target_name FROM shapes s LEFT JOIN maps t ON t.id = s.target_map_id
    WHERE s.map_id = ? ORDER BY s.rowid`).all(map.id)
    .map((s) => ({ ...s, geometry: JSON.parse(s.geometry), map_id: undefined }));
  return {
    id: map.id, name: map.name, background: map.background, is_default: !!map.is_default,
    tree: loadTree(map.id, { includeHidden }),
    shapes,
    types: listTypes(),
    settings: appSettings(),
  };
}

// Public: hidden images and groups are left out.
app.get('/api/maps/:id', wrap((req, res) => res.json(mapPayload(getMap(req.params.id), false))));
app.get('/api/types', (req, res) => res.json(listTypes()));
app.get('/api/settings', (req, res) => res.json(appSettings()));

// ---------- admin: maps ----------

const admin = express.Router();
admin.use(auth.requireAdmin);

admin.post('/maps', wrap((req, res) => {
  const name = str(req.body.name, 200).trim();
  if (!name) throw new HttpError(400, 'Name is required');
  const id = newId();
  const first = db.prepare('SELECT COUNT(*) AS n FROM maps').get().n === 0;
  db.prepare('INSERT INTO maps (id, name, is_default, created_at) VALUES (?, ?, ?, ?)').run(id, name, first ? 1 : 0, Date.now());
  res.status(201).json({ id });
}));

admin.patch('/maps/:id', wrap((req, res) => {
  const map = getMap(req.params.id);
  const { name, background, is_default } = req.body;
  db.transaction(() => {
    if (name !== undefined) {
      const n = str(name, 200).trim();
      if (!n) throw new HttpError(400, 'Name cannot be empty');
      db.prepare('UPDATE maps SET name = ? WHERE id = ?').run(n, map.id);
    }
    if (background !== undefined) {
      if (!COLOR_RE.test(background)) throw new HttpError(400, 'Background must be a #rrggbb colour');
      db.prepare('UPDATE maps SET background = ? WHERE id = ?').run(background, map.id);
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

// Everything, including hidden images and groups, for the editor.
admin.get('/maps/:id', wrap((req, res) => res.json(mapPayload(getMap(req.params.id), true))));

// Replace everything placed on a map (image tree, hitboxes, annotations) in one go.
admin.put('/maps/:id/content', wrap((req, res) => {
  const map = getMap(req.params.id);
  const { tree, shapes } = req.body;
  if (!Array.isArray(tree) || !Array.isArray(shapes)) throw new HttpError(400, 'tree and shapes must be arrays');

  const rows = flattenTree(tree);
  const mapExists = db.prepare('SELECT 1 FROM maps WHERE id = ?');
  const cleanShapes = shapes.map((s, i) => {
    if (!s || !['hitbox', 'annotation'].includes(s.kind)) throw new HttpError(400, `Shape ${i + 1}: bad kind`);
    const geometry = validGeometry(s.geometry);
    if (!geometry) throw new HttpError(400, `Shape ${i + 1}: bad geometry`);
    let target = null;
    if (s.kind === 'hitbox' && s.target_map_id) {
      if (!ID_RE.test(s.target_map_id) || !mapExists.get(s.target_map_id)) throw new HttpError(400, `Shape ${i + 1}: target map does not exist`);
      target = s.target_map_id;
    }
    return {
      id: ID_RE.test(s.id) ? s.id : newId(),
      kind: s.kind,
      geometry: JSON.stringify(geometry),
      target_map_id: target,
      title: str(s.title, 300),
      body: str(s.body, 20000),
      color: COLOR_RE.test(s.color) ? s.color : '#4da3ff',
    };
  });

  const insShape = db.prepare('INSERT INTO shapes (id, map_id, kind, geometry, target_map_id, title, body, color) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
  db.transaction(() => {
    saveTree(map.id, rows);
    db.prepare('DELETE FROM shapes WHERE map_id = ?').run(map.id);
    for (const s of cleanShapes) insShape.run(s.id, map.id, s.kind, s.geometry, s.target_map_id, s.title, s.body, s.color);
  })();
  res.json({ ok: true });
}));

// ---------- admin: types & settings ----------

function typeFields(body, partial) {
  const out = {};
  if (!partial || body.name !== undefined) {
    const name = str(body.name, 60).trim();
    if (!name) throw new HttpError(400, 'Type name cannot be empty');
    out.name = name;
  }
  if (body.fade_focus !== undefined) out.fade_focus = body.fade_focus ? 1 : 0;
  if (body.fade_zoom !== undefined) out.fade_zoom = body.fade_zoom ? 1 : 0;
  return out;
}

admin.post('/types', wrap((req, res) => {
  const f = typeFields(req.body, false);
  const id = newId();
  const pos = (db.prepare('SELECT MAX(pos) AS p FROM types').get().p ?? -1) + 1;
  db.prepare('INSERT INTO types (id, name, fade_focus, fade_zoom, pos) VALUES (?, ?, ?, ?, ?)')
    .run(id, f.name, f.fade_focus ?? 1, f.fade_zoom ?? 1, pos);
  res.status(201).json({ id });
}));

admin.patch('/types/:id', wrap((req, res) => {
  const f = typeFields(req.body, true);
  const keys = Object.keys(f);
  if (!keys.length) throw new HttpError(400, 'Nothing to change');
  const r = db.prepare(`UPDATE types SET ${keys.map((k) => `${k} = @${k}`).join(', ')} WHERE id = @id`).run({ ...f, id: req.params.id });
  if (!r.changes) throw new HttpError(404, 'Type not found');
  res.json({ ok: true });
}));

// Images and placements that used the type fall back to "no type" (ON DELETE SET NULL).
admin.delete('/types/:id', wrap((req, res) => {
  const r = db.prepare('DELETE FROM types WHERE id = ?').run(req.params.id);
  if (!r.changes) throw new HttpError(404, 'Type not found');
  res.json({ ok: true });
}));

admin.patch('/settings', wrap((req, res) => {
  const { focus_opacity } = req.body;
  if (focus_opacity !== undefined) {
    if (!finite(focus_opacity) || focus_opacity < 0 || focus_opacity > 1) throw new HttpError(400, 'focus_opacity must be between 0 and 1');
    setSetting('focus_opacity', focus_opacity);
  }
  res.json(appSettings());
}));

// ---------- admin: images ----------

const upload = multer({
  dest: config.UPLOAD_TMP,
  limits: { fileSize: config.MAX_UPLOAD_MB * 1024 * 1024, files: 50 },
});

admin.get('/images', (req, res) => {
  const usage = db.prepare(`SELECT l.image_id, m.id, m.name FROM layers l JOIN maps m ON m.id = l.map_id GROUP BY l.image_id, m.id`).all();
  const byImage = {};
  for (const u of usage) (byImage[u.image_id] ||= []).push({ id: u.id, name: u.name });
  res.json(db.prepare('SELECT * FROM images ORDER BY created_at DESC').all()
    .map((img) => ({ ...publicImage(img), used_in: byImage[img.id] || [] })));
});

admin.post('/images', upload.array('files'), wrap((req, res) => {
  const files = req.files || [];
  if (files.length === 0) throw new HttpError(400, 'No files uploaded');
  const ids = [];
  for (const f of files) {
    const id = newId();
    const name = path.parse(Buffer.from(f.originalname, 'latin1').toString('utf8')).name.slice(0, 200) || 'Untitled';
    db.prepare(`INSERT INTO images (id, name, status, created_at) VALUES (?, ?, 'processing', ?)`).run(id, name, Date.now());
    queueUpload(id, f.path);
    ids.push(id);
  }
  res.status(202).json({ ids });
}));

admin.patch('/images/:id', wrap((req, res) => {
  const img = db.prepare('SELECT id FROM images WHERE id = ?').get(req.params.id);
  if (!img) throw new HttpError(404, 'Image not found');
  const { name, type_id } = req.body;
  db.transaction(() => {
    if (name !== undefined) {
      const n = str(name, 200).trim();
      if (!n) throw new HttpError(400, 'Name cannot be empty');
      db.prepare('UPDATE images SET name = ? WHERE id = ?').run(n, img.id);
    }
    if (type_id !== undefined) {
      if (type_id !== null && !db.prepare('SELECT 1 FROM types WHERE id = ?').get(type_id)) throw new HttpError(400, 'Unknown type');
      db.prepare('UPDATE images SET type_id = ? WHERE id = ?').run(type_id, img.id);
    }
  })();
  res.json({ ok: true });
}));

admin.delete('/images/:id', wrap(async (req, res) => {
  if (!ID_RE.test(req.params.id)) throw new HttpError(404, 'Image not found');
  const r = db.prepare('DELETE FROM images WHERE id = ?').run(req.params.id); // layers cascade
  if (!r.changes) throw new HttpError(404, 'Image not found');
  await fsp.rm(path.join(config.TILES_DIR, req.params.id), { recursive: true, force: true });
  res.json({ ok: true });
}));

app.use('/api/admin', admin);

// ---------- errors ----------

app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    const msg = err.code === 'LIMIT_FILE_SIZE' ? `File is larger than ${config.MAX_UPLOAD_MB} MB` : err.message;
    return res.status(413).json({ error: msg });
  }
  if (err.status === 404 && req.path.startsWith('/tiles')) return res.status(404).end();
  const status = err.status || 500;
  if (status >= 500) console.error(err);
  res.status(status).json({ error: status >= 500 ? 'Server error' : err.message });
});

app.listen(config.PORT, () => {
  console.log(`OSD Maps listening on http://0.0.0.0:${config.PORT}`);
  if (!config.ADMIN_PASSWORD) console.warn('WARNING: ADMIN_PASSWORD is not set; the admin panel cannot be used.');
  if (!process.env.SESSION_SECRET) console.warn('Note: SESSION_SECRET is not set; admin logins end whenever the server restarts.');
});
