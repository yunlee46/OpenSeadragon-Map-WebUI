// Planner: a to-do list of images still to be made. Admin only, including reference images.

const path = require('path');
const fs = require('fs');
const fsp = require('fs/promises');
const express = require('express');
const multer = require('multer');
const sharp = require('sharp');
const config = require('../config');
const { db, newId } = require('../db');
const { linkToPlanner } = require('./images');
const { ID_RE, str, HttpError, wrap, thumbUrl } = require('../util');

const admin = express.Router();
const REFS_DIR = path.join(config.DATA_DIR, 'refs');
fs.mkdirSync(REFS_DIR, { recursive: true });

const STATUSES = ['idea', 'progress', 'done'];
const refUpload = multer({ dest: config.UPLOAD_TMP, limits: { fileSize: 50 * 1024 * 1024, files: 20 } });

function itemPayload(item) {
  const refs = db.prepare('SELECT * FROM planner_refs WHERE item_id = ? ORDER BY created_at').all(item.id).map((r) => ({
    id: r.id,
    name: r.name,
    thumb_url: `/api/admin/planner/refs/${r.id}/thumb`,
    full_url: `/api/admin/planner/refs/${r.id}/full`,
  }));
  const img = item.image_id ? db.prepare('SELECT * FROM images WHERE id = ?').get(item.image_id) : null;
  const map = item.map_id ? db.prepare('SELECT id, name FROM maps WHERE id = ?').get(item.map_id) : null;
  const group = map && item.group_id ? db.prepare('SELECT id, name FROM layer_groups WHERE id = ? AND map_id = ?').get(item.group_id, map.id) : null;
  return {
    ...item,
    refs,
    image: img ? {
      id: img.id, name: img.name, status: img.status, error: img.error, width: img.width, height: img.height,
      thumb_url: img.status === 'ready' ? thumbUrl(img) : null, type_id: img.type_id,
    } : null,
    map_name: map ? map.name : null,
    group_id: group ? group.id : null,
    group_name: group ? group.name : null,
  };
}

function getItem(id) {
  const item = db.prepare('SELECT * FROM planner_items WHERE id = ?').get(id);
  if (!item) throw new HttpError(404, 'Planner item not found');
  return item;
}

function fields(body) {
  const out = {};
  if (body.title !== undefined) {
    const t = str(body.title, 200).trim();
    if (!t) throw new HttpError(400, 'Title cannot be empty');
    out.title = t;
  }
  if (body.notes !== undefined) out.notes = str(body.notes, 20000);
  if (body.status !== undefined) {
    if (!STATUSES.includes(body.status)) throw new HttpError(400, 'Bad status');
    out.status = body.status;
  }
  if (body.priority !== undefined) {
    if (![0, 1, 2].includes(body.priority)) throw new HttpError(400, 'Bad priority');
    out.priority = body.priority;
  }
  if (body.type_id !== undefined) {
    if (body.type_id !== null && !db.prepare('SELECT 1 FROM types WHERE id = ?').get(body.type_id)) throw new HttpError(400, 'Unknown type');
    out.type_id = body.type_id;
  }
  if (body.map_id !== undefined) {
    if (body.map_id !== null && !db.prepare('SELECT 1 FROM maps WHERE id = ?').get(body.map_id)) throw new HttpError(400, 'Unknown map');
    out.map_id = body.map_id;
    if (body.map_id === null) out.group_id = null;
  }
  if (body.group_id !== undefined) out.group_id = body.group_id && ID_RE.test(body.group_id) ? body.group_id : null;
  return out;
}

admin.get('/planner', (req, res) => {
  const items = db.prepare('SELECT * FROM planner_items ORDER BY priority DESC, created_at DESC').all();
  res.json(items.map(itemPayload));
});

admin.post('/planner', wrap((req, res) => {
  const f = fields({ status: 'idea', priority: 1, ...req.body });
  if (!f.title) throw new HttpError(400, 'Title is required');
  const id = newId();
  const now = Date.now();
  db.prepare(`INSERT INTO planner_items (id, title, notes, status, priority, type_id, map_id, group_id, created_at, updated_at)
              VALUES (@id, @title, @notes, @status, @priority, @type_id, @map_id, @group_id, @now, @now)`)
    .run({ notes: '', type_id: null, map_id: null, group_id: null, ...f, id, now });
  res.status(201).json(itemPayload(getItem(id)));
}));

admin.patch('/planner/:id', wrap((req, res) => {
  const item = getItem(req.params.id);
  const f = fields(req.body);
  db.transaction(() => {
    const keys = Object.keys(f);
    if (keys.length) {
      db.prepare(`UPDATE planner_items SET ${keys.map((k) => `${k} = @${k}`).join(', ')}, updated_at = @now WHERE id = @id`)
        .run({ ...f, now: Date.now(), id: item.id });
    }
    // Link an existing library image, or unlink with null.
    if (req.body.image_id !== undefined) {
      if (req.body.image_id === null) {
        db.prepare(`UPDATE planner_items SET image_id = NULL, status = CASE WHEN status = 'done' THEN 'progress' ELSE status END WHERE id = ?`).run(item.id);
      } else {
        if (!ID_RE.test(req.body.image_id) || !db.prepare('SELECT 1 FROM images WHERE id = ?').get(req.body.image_id)) throw new HttpError(400, 'Unknown image');
        linkToPlanner(item.id, req.body.image_id);
      }
    }
  })();
  res.json(itemPayload(getItem(item.id)));
}));

// The linked library image is kept.
admin.delete('/planner/:id', wrap(async (req, res) => {
  const item = getItem(req.params.id);
  const refs = db.prepare('SELECT id FROM planner_refs WHERE item_id = ?').all(item.id);
  db.prepare('DELETE FROM planner_items WHERE id = ?').run(item.id);
  for (const r of refs) await fsp.rm(path.join(REFS_DIR, r.id), { recursive: true, force: true });
  res.json({ ok: true });
}));

// ---------- reference images ----------

admin.post('/planner/:id/refs', refUpload.array('files'), wrap(async (req, res) => {
  const item = getItem(req.params.id);
  const files = req.files || [];
  const failed = [];
  for (const f of files) {
    const refId = newId();
    const dir = path.join(REFS_DIR, refId);
    try {
      const meta = await sharp(f.path).metadata();
      if (!meta.format) throw new Error('not an image');
      await fsp.mkdir(dir, { recursive: true });
      const file = `original.${meta.format === 'jpeg' ? 'jpg' : meta.format}`;
      await fsp.copyFile(f.path, path.join(dir, file));
      await sharp(f.path).rotate().resize(360, 360, { fit: 'inside', withoutEnlargement: true }).webp({ quality: 80 }).toFile(path.join(dir, 'thumb.webp'));
      const name = Buffer.from(f.originalname, 'latin1').toString('utf8').slice(0, 200);
      db.prepare('INSERT INTO planner_refs (id, item_id, name, file, mime, created_at) VALUES (?, ?, ?, ?, ?, ?)')
        .run(refId, item.id, name, file, `image/${meta.format}`, Date.now());
    } catch (err) {
      failed.push(f.originalname);
      await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
    } finally {
      await fsp.rm(f.path, { force: true }).catch(() => {});
    }
  }
  res.json({ item: itemPayload(getItem(item.id)), failed });
}));

admin.get('/planner/refs/:refId/:kind', wrap((req, res) => {
  const ref = ID_RE.test(req.params.refId) && db.prepare('SELECT * FROM planner_refs WHERE id = ?').get(req.params.refId);
  if (!ref) throw new HttpError(404, 'Reference image not found');
  const file = req.params.kind === 'thumb' ? 'thumb.webp' : ref.file;
  res.set('Cache-Control', 'private, max-age=86400');
  res.sendFile(path.join(REFS_DIR, ref.id, file));
}));

admin.delete('/planner/refs/:refId', wrap(async (req, res) => {
  const ref = ID_RE.test(req.params.refId) && db.prepare('SELECT * FROM planner_refs WHERE id = ?').get(req.params.refId);
  if (!ref) throw new HttpError(404, 'Reference image not found');
  db.prepare('DELETE FROM planner_refs WHERE id = ?').run(ref.id);
  await fsp.rm(path.join(REFS_DIR, ref.id), { recursive: true, force: true });
  res.json({ ok: true });
}));

module.exports = { admin, REFS_DIR };
