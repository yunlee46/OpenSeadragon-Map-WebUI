const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const Database = require('better-sqlite3');
const { DATA_DIR } = require('./config');

fs.mkdirSync(DATA_DIR, { recursive: true });
const db = new Database(path.join(DATA_DIR, 'app.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS images (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  status      TEXT NOT NULL,          -- processing | ready | error
  error       TEXT,
  width       INTEGER,
  height      INTEGER,
  dzi_path    TEXT,                   -- path of the .dzi file relative to the image's tile folder
  created_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS maps (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  is_default  INTEGER NOT NULL DEFAULT 0,
  background  TEXT NOT NULL DEFAULT '#1b1d22',
  created_at  INTEGER NOT NULL
);

-- An image placed on a map. Positions are OpenSeadragon viewport coordinates.
CREATE TABLE IF NOT EXISTS layers (
  id        TEXT PRIMARY KEY,
  map_id    TEXT NOT NULL REFERENCES maps(id) ON DELETE CASCADE,
  image_id  TEXT NOT NULL REFERENCES images(id) ON DELETE CASCADE,
  x         REAL NOT NULL,
  y         REAL NOT NULL,
  width     REAL NOT NULL,
  opacity   REAL NOT NULL DEFAULT 1,
  z         INTEGER NOT NULL DEFAULT 0
);

-- Hitboxes and annotations. geometry is JSON in viewport coordinates:
--   {"type":"rect","x":..,"y":..,"w":..,"h":..} or {"type":"polygon","points":[[x,y],...]}
CREATE TABLE IF NOT EXISTS shapes (
  id             TEXT PRIMARY KEY,
  map_id         TEXT NOT NULL REFERENCES maps(id) ON DELETE CASCADE,
  kind           TEXT NOT NULL,       -- hitbox | annotation
  geometry       TEXT NOT NULL,
  target_map_id  TEXT REFERENCES maps(id) ON DELETE SET NULL,
  title          TEXT NOT NULL DEFAULT '',
  body           TEXT NOT NULL DEFAULT '',
  color          TEXT NOT NULL DEFAULT '#4da3ff'
);

CREATE INDEX IF NOT EXISTS layers_map ON layers(map_id);
CREATE INDEX IF NOT EXISTS shapes_map ON shapes(map_id);
`);

// Anything still "processing" at startup was interrupted by a restart.
db.prepare(`UPDATE images SET status = 'error', error = 'Interrupted by server restart; upload again'
            WHERE status = 'processing'`).run();

const newId = () => crypto.randomBytes(8).toString('hex');

module.exports = { db, newId };
