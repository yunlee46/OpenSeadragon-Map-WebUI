const path = require('path');
const fsp = require('fs/promises');
const express = require('express');
const multer = require('multer');
const config = require('../config');
const { db, newId } = require('../db');
const { queueUpload, queueReplace } = require('../tiler');
const { ID_RE, str, HttpError, wrap, dziUrl, thumbUrl } = require('../util');

const admin = express.Router();

const upload = multer({
  dest: config.UPLOAD_TMP,
  limits: { fileSize: config.MAX_UPLOAD_MB * 1024 * 1024, files: 50 },
});

const fileName = (f) => path.parse(Buffer.from(f.originalname, 'latin1').toString('utf8')).name.slice(0, 200) || 'Untitled';

function publicImage(img) {
  const ready = img.status === 'ready';
  return {
    id: img.id,
    name: img.name,
    status: img.status,
    error: img.error,
    width: img.width,
    height: img.height,
    dzi_url: ready ? dziUrl(img) : null,
    thumb_url: ready ? thumbUrl(img) : null,
    type_id: img.type_id || null,
    replace_status: img.replace_status || null,
    replace_error: img.replace_error || null,
    created_at: img.created_at,
  };
}

// Link a library image to a planner item: the item is done and the image gets the item's type.
function linkToPlanner(itemId, imageId) {
  const item = db.prepare('SELECT * FROM planner_items WHERE id = ?').get(itemId);
  if (!item) throw new HttpError(404, 'Planner item not found');
  db.prepare(`UPDATE planner_items SET image_id = ?, status = 'done', updated_at = ? WHERE id = ?`).run(imageId, Date.now(), item.id);
  if (item.type_id) db.prepare('UPDATE images SET type_id = ? WHERE id = ?').run(item.type_id, imageId);
  return item;
}

admin.get('/images', (req, res) => {
  const usage = db.prepare('SELECT l.image_id, m.id, m.name FROM layers l JOIN maps m ON m.id = l.map_id GROUP BY l.image_id, m.id').all();
  const byImage = {};
  for (const u of usage) (byImage[u.image_id] ||= []).push({ id: u.id, name: u.name });
  const planned = {};
  for (const p of db.prepare('SELECT id, title, image_id FROM planner_items WHERE image_id IS NOT NULL').all()) {
    planned[p.image_id] = { id: p.id, title: p.title };
  }
  res.json(db.prepare('SELECT * FROM images ORDER BY created_at DESC').all()
    .map((img) => ({ ...publicImage(img), used_in: byImage[img.id] || [], planner_item: planned[img.id] || null })));
});

// Optional form field planner_item_id: the (first) file becomes that planner item's image.
admin.post('/images', upload.array('files'), wrap((req, res) => {
  const files = req.files || [];
  if (files.length === 0) throw new HttpError(400, 'No files uploaded');
  const itemId = ID_RE.test(req.body?.planner_item_id) ? req.body.planner_item_id : null;
  const item = itemId ? db.prepare('SELECT * FROM planner_items WHERE id = ?').get(itemId) : null;
  if (itemId && !item) throw new HttpError(404, 'Planner item not found');

  const ids = [];
  db.transaction(() => {
    files.forEach((f, i) => {
      const id = newId();
      const name = item && i === 0 ? item.title.slice(0, 200) : fileName(f);
      db.prepare(`INSERT INTO images (id, name, status, created_at) VALUES (?, ?, 'processing', ?)`).run(id, name, Date.now());
      if (item && i === 0) linkToPlanner(item.id, id);
      ids.push(id);
    });
  })();
  files.forEach((f, i) => queueUpload(ids[i], f.path));
  res.status(202).json({ ids });
}));

// Swap in a new file: every placement, type and link to this image is kept.
admin.post('/images/:id/replace', upload.single('file'), wrap((req, res) => {
  const img = db.prepare('SELECT * FROM images WHERE id = ?').get(req.params.id);
  if (!img) throw new HttpError(404, 'Image not found');
  if (!req.file) throw new HttpError(400, 'No file uploaded');
  if (img.status === 'processing' || img.replace_status === 'processing') {
    fsp.rm(req.file.path, { force: true }).catch(() => {});
    throw new HttpError(409, 'This image is still being processed');
  }
  if (img.status === 'ready') {
    db.prepare(`UPDATE images SET replace_status = 'processing', replace_error = NULL WHERE id = ?`).run(img.id);
    queueReplace(img.id, req.file.path);
  } else {
    // A failed upload: just try again with the new file.
    db.prepare(`UPDATE images SET status = 'processing', error = NULL WHERE id = ?`).run(img.id);
    queueUpload(img.id, req.file.path);
  }
  res.status(202).json({ ok: true });
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
  const r = db.transaction(() => {
    // Planner items that used this image need an image again.
    db.prepare(`UPDATE planner_items SET status = 'progress', updated_at = ? WHERE image_id = ?`).run(Date.now(), req.params.id);
    return db.prepare('DELETE FROM images WHERE id = ?').run(req.params.id); // layers cascade, links set null
  })();
  if (!r.changes) throw new HttpError(404, 'Image not found');
  await fsp.rm(path.join(config.TILES_DIR, req.params.id), { recursive: true, force: true });
  res.json({ ok: true });
}));

module.exports = { admin, upload, linkToPlanner };
