const path = require('path');
const fs = require('fs');
const fsp = require('fs/promises');
const express = require('express');
const multer = require('multer');
const config = require('./config');
const { db, newId } = require('./db');
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

app.get('/api/maps/:id', wrap((req, res) => {
  const map = getMap(req.params.id);
  const layers = db.prepare(`
    SELECT l.*, i.name AS image_name, i.width AS px_width, i.height AS px_height, i.dzi_path, i.status
    FROM layers l JOIN images i ON i.id = l.image_id
    WHERE l.map_id = ? ORDER BY l.z, l.rowid`).all(map.id)
    .filter((l) => l.status === 'ready')
    .map((l) => ({
      id: l.id, image_id: l.image_id, image_name: l.image_name,
      x: l.x, y: l.y, width: l.width, opacity: l.opacity, z: l.z,
      px_width: l.px_width, px_height: l.px_height,
      dzi_url: dziUrl({ id: l.image_id, dzi_path: l.dzi_path }),
    }));
  const shapes = db.prepare(`
    SELECT s.*, t.name AS target_name FROM shapes s LEFT JOIN maps t ON t.id = s.target_map_id
    WHERE s.map_id = ? ORDER BY s.rowid`).all(map.id)
    .map((s) => ({ ...s, geometry: JSON.parse(s.geometry), map_id: undefined }));
  res.json({ id: map.id, name: map.name, background: map.background, is_default: !!map.is_default, layers, shapes });
}));

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

// Replace everything placed on a map (image layers, hitboxes, annotations) in one go.
admin.put('/maps/:id/content', wrap((req, res) => {
  const map = getMap(req.params.id);
  const { layers, shapes } = req.body;
  if (!Array.isArray(layers) || !Array.isArray(shapes)) throw new HttpError(400, 'layers and shapes must be arrays');

  const imageOk = db.prepare(`SELECT 1 FROM images WHERE id = ? AND status = 'ready'`);
  const mapExists = db.prepare('SELECT 1 FROM maps WHERE id = ?');

  const cleanLayers = layers.map((l, i) => {
    if (!l || !ID_RE.test(l.image_id) || !imageOk.get(l.image_id)) throw new HttpError(400, `Layer ${i + 1}: unknown image`);
    if (![l.x, l.y, l.width].every(finite) || l.width <= 0) throw new HttpError(400, `Layer ${i + 1}: bad position or size`);
    const opacity = finite(l.opacity) ? Math.min(1, Math.max(0, l.opacity)) : 1;
    return { id: ID_RE.test(l.id) ? l.id : newId(), image_id: l.image_id, x: l.x, y: l.y, width: l.width, opacity, z: i };
  });

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

  const insLayer = db.prepare('INSERT INTO layers (id, map_id, image_id, x, y, width, opacity, z) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
  const insShape = db.prepare('INSERT INTO shapes (id, map_id, kind, geometry, target_map_id, title, body, color) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
  db.transaction(() => {
    db.prepare('DELETE FROM layers WHERE map_id = ?').run(map.id);
    db.prepare('DELETE FROM shapes WHERE map_id = ?').run(map.id);
    for (const l of cleanLayers) insLayer.run(l.id, map.id, l.image_id, l.x, l.y, l.width, l.opacity, l.z);
    for (const s of cleanShapes) insShape.run(s.id, map.id, s.kind, s.geometry, s.target_map_id, s.title, s.body, s.color);
  })();
  res.json({ ok: true });
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
  const name = str(req.body.name, 200).trim();
  if (!name) throw new HttpError(400, 'Name cannot be empty');
  const r = db.prepare('UPDATE images SET name = ? WHERE id = ?').run(name, req.params.id);
  if (!r.changes) throw new HttpError(404, 'Image not found');
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
