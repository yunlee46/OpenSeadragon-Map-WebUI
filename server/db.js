const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const Database = require('better-sqlite3');
const { DATA_DIR } = require('./config');

fs.mkdirSync(DATA_DIR, { recursive: true });
require('./restore').applyPendingRestore(DATA_DIR);
const db = new Database(path.join(DATA_DIR, 'app.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

const newId = () => crypto.randomBytes(8).toString('hex');

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

// ---------- migrations (PRAGMA user_version) ----------

const migrations = [
  // 1: image types, nested layer groups, per-placement fade settings, app settings
  () => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS types (
        id          TEXT PRIMARY KEY,
        name        TEXT NOT NULL,
        fade_focus  INTEGER NOT NULL DEFAULT 1,   -- fades when another image is focused
        fade_zoom   INTEGER NOT NULL DEFAULT 1,   -- fades in zoom-reveal
        pos         INTEGER NOT NULL DEFAULT 0
      );
      -- Folders in a map's image list. parent_id is another group (NULL = top level).
      CREATE TABLE IF NOT EXISTS layer_groups (
        id         TEXT PRIMARY KEY,
        map_id     TEXT NOT NULL REFERENCES maps(id) ON DELETE CASCADE,
        parent_id  TEXT,
        name       TEXT NOT NULL,
        hidden     INTEGER NOT NULL DEFAULT 0,
        collapsed  INTEGER NOT NULL DEFAULT 0,
        pos        INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS groups_map ON layer_groups(map_id);
      CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);

      ALTER TABLE images ADD COLUMN type_id TEXT REFERENCES types(id) ON DELETE SET NULL;

      -- pos orders siblings in the list, top first; z is the resulting draw order.
      ALTER TABLE layers ADD COLUMN parent_id TEXT;
      ALTER TABLE layers ADD COLUMN pos INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE layers ADD COLUMN name TEXT;
      ALTER TABLE layers ADD COLUMN type_override TEXT REFERENCES types(id) ON DELETE SET NULL;
      ALTER TABLE layers ADD COLUMN fade_mode TEXT NOT NULL DEFAULT 'inherit';  -- inherit | always | never
      ALTER TABLE layers ADD COLUMN hidden INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE layers ADD COLUMN zoom_fade REAL;   -- manual zoom-reveal start (OpenSeadragon zoom); NULL = automatic
      UPDATE layers SET pos = -z;
    `);
    const add = db.prepare('INSERT INTO types (id, name, fade_focus, fade_zoom, pos) VALUES (?, ?, ?, ?, ?)');
    add.run(newId(), 'background', 0, 0, 0);
    add.run(newId(), 'object', 1, 1, 1);
    add.run(newId(), 'character', 1, 0, 2);
    db.prepare(`INSERT OR IGNORE INTO settings (key, value) VALUES ('focus_opacity', '0.3')`).run();
  },
  // 2: draft/publish, starting views, richer shapes, image replacement, planner
  () => {
    db.exec(`
      ALTER TABLE maps ADD COLUMN home_view TEXT;        -- JSON {x,y,w,h}: where the viewer starts
      ALTER TABLE maps ADD COLUMN published_json TEXT;   -- snapshot visitors see
      ALTER TABLE maps ADD COLUMN published_at INTEGER;
      ALTER TABLE maps ADD COLUMN draft_at INTEGER;      -- last saved change to the draft

      ALTER TABLE shapes ADD COLUMN attach_id TEXT;      -- layer or group the shape moves/hides with
      ALTER TABLE shapes ADD COLUMN action TEXT NOT NULL DEFAULT 'map';  -- hitbox: map | url
      ALTER TABLE shapes ADD COLUMN url TEXT;
      ALTER TABLE shapes ADD COLUMN target_layer_id TEXT; -- image to focus on the target map
      ALTER TABLE shapes ADD COLUMN image_id TEXT REFERENCES images(id) ON DELETE SET NULL; -- picture in a note

      ALTER TABLE images ADD COLUMN thumb_path TEXT;
      ALTER TABLE images ADD COLUMN replace_status TEXT;  -- processing | error while a new file is being tiled
      ALTER TABLE images ADD COLUMN replace_error TEXT;
      UPDATE images SET thumb_path = 'thumb.webp' WHERE thumb_path IS NULL;

      CREATE TABLE planner_items (
        id          TEXT PRIMARY KEY,
        title       TEXT NOT NULL,
        notes       TEXT NOT NULL DEFAULT '',
        status      TEXT NOT NULL DEFAULT 'idea',     -- idea | progress | done
        priority    INTEGER NOT NULL DEFAULT 1,         -- 0 low, 1 normal, 2 high
        type_id     TEXT REFERENCES types(id) ON DELETE SET NULL,
        map_id      TEXT REFERENCES maps(id) ON DELETE SET NULL,
        group_id    TEXT,
        image_id    TEXT REFERENCES images(id) ON DELETE SET NULL,
        created_at  INTEGER NOT NULL,
        updated_at  INTEGER NOT NULL
      );
      CREATE TABLE planner_refs (
        id          TEXT PRIMARY KEY,
        item_id     TEXT NOT NULL REFERENCES planner_items(id) ON DELETE CASCADE,
        name        TEXT NOT NULL,
        file        TEXT NOT NULL,     -- file name inside refs/<id>/
        mime        TEXT NOT NULL,
        created_at  INTEGER NOT NULL
      );
      CREATE INDEX planner_refs_item ON planner_refs(item_id);
    `);
    // Publish every existing map so visitors keep seeing them (done after startup; see content.js).
    db.prepare(`INSERT OR REPLACE INTO settings (key, value) VALUES ('publish_all_pending', '1')`).run();
  },
  // 3: fade images that become small on screen when zoomed out
  () => {
    db.exec(`ALTER TABLE types ADD COLUMN fade_small INTEGER NOT NULL DEFAULT 1;`);
    db.prepare(`UPDATE types SET fade_small = 0 WHERE name = 'background'`).run();
    db.prepare(`INSERT OR IGNORE INTO settings (key, value) VALUES ('small_fade_percent', '1')`).run();
  },
  // 4: folders for organising the maps list
  () => {
    db.exec(`
      CREATE TABLE map_folders (
        id         TEXT PRIMARY KEY,
        name       TEXT NOT NULL,
        parent_id  TEXT,
        pos        INTEGER NOT NULL DEFAULT 0,
        collapsed  INTEGER NOT NULL DEFAULT 0
      );
      ALTER TABLE maps ADD COLUMN folder_id TEXT;
      ALTER TABLE maps ADD COLUMN pos INTEGER NOT NULL DEFAULT 0;
    `);
    // Keep the old alphabetical order as the starting order.
    const maps = db.prepare('SELECT id FROM maps ORDER BY name COLLATE NOCASE').all();
    const setPos = db.prepare('UPDATE maps SET pos = ? WHERE id = ?');
    maps.forEach((m, i) => setPos.run(i, m.id));
  },
];

const version = db.pragma('user_version', { simple: true });
for (let v = version; v < migrations.length; v++) {
  db.transaction(() => {
    migrations[v]();
    db.pragma(`user_version = ${v + 1}`);
  })();
  console.log(`Database migrated to version ${v + 1}`);
}

function getSetting(key, fallback) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : fallback;
}
function setSetting(key, value) {
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, String(value));
}

// Anything still "processing" at startup was interrupted by a restart.
db.prepare(`UPDATE images SET status = 'error', error = 'Interrupted by server restart; upload again'
            WHERE status = 'processing'`).run();
db.prepare(`UPDATE images SET replace_status = 'error', replace_error = 'Interrupted by server restart; try again'
            WHERE replace_status = 'processing'`).run();


module.exports = { db, newId, getSetting, setSetting };
