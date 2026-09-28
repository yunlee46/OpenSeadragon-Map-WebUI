const express = require('express');
const { db, newId, setSetting } = require('../db');
const { listTypes, appSettings } = require('../content');
const { finite, str, HttpError, wrap } = require('../util');

const pub = express.Router();
const admin = express.Router();

pub.get('/types', (req, res) => res.json(listTypes()));
pub.get('/settings', (req, res) => res.json(appSettings()));

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

// Images, placements and planner items that used the type fall back to "no type" (ON DELETE SET NULL).
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

module.exports = { pub, admin };
