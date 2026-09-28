// Backup: one zip with a consistent copy of the database plus all tiles and planner reference images.
// Restore: unpack a backup next to the live data, then restart; restore.js swaps it in on startup.

const path = require('path');
const fs = require('fs');
const fsp = require('fs/promises');
const express = require('express');
const multer = require('multer');
const yazl = require('yazl');
const Database = require('better-sqlite3');
const config = require('../config');
const { db } = require('../db');
const { extractZip, isZip } = require('../tiler');
const { RESTORE_ITEMS } = require('../restore');
const { HttpError, wrap } = require('../util');

const admin = express.Router();
const restoreUpload = multer({ dest: config.UPLOAD_TMP, limits: { fileSize: config.MAX_UPLOAD_MB * 1024 * 1024, files: 1 } });

async function addDir(zip, dir, prefix) {
  let entries;
  try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    const name = `${prefix}/${e.name}`;
    if (e.isDirectory()) await addDir(zip, full, name);
    else if (e.isFile()) zip.addFile(full, name, { compress: false }); // tiles are already compressed
  }
}

admin.get('/backup', wrap(async (req, res) => {
  const tmp = path.join(config.UPLOAD_TMP, `backup-${Date.now()}.db`);
  await db.backup(tmp);
  const zip = new yazl.ZipFile();
  zip.addFile(tmp, 'app.db');
  await addDir(zip, config.TILES_DIR, 'tiles');
  await addDir(zip, path.join(config.DATA_DIR, 'refs'), 'refs');
  zip.end();

  const date = new Date().toISOString().slice(0, 10);
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="map-webui-backup-${date}.zip"`);
  const cleanup = () => fsp.rm(tmp, { force: true }).catch(() => {});
  zip.outputStream.on('end', cleanup);
  res.on('close', cleanup);
  zip.outputStream.pipe(res);
}));

admin.post('/restore', restoreUpload.single('file'), wrap(async (req, res) => {
  if (!req.file) throw new HttpError(400, 'No file uploaded');
  const staging = path.join(config.DATA_DIR, 'restore-staging');
  try {
    if (!(await isZip(req.file.path))) throw new HttpError(400, 'That is not a zip file');
    await fsp.rm(staging, { recursive: true, force: true });
    await fsp.mkdir(staging, { recursive: true });
    await extractZip(req.file.path, staging);

    // Only keep what a backup contains, and check the database is one of ours.
    for (const name of await fsp.readdir(staging)) {
      if (!RESTORE_ITEMS.includes(name)) await fsp.rm(path.join(staging, name), { recursive: true, force: true });
    }
    const dbFile = path.join(staging, 'app.db');
    if (!fs.existsSync(dbFile)) throw new HttpError(400, 'This zip is not a backup from this app (app.db is missing)');
    try {
      const check = new Database(dbFile, { readonly: true, fileMustExist: true });
      const tables = check.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all().map((t) => t.name);
      check.close();
      if (!['maps', 'images', 'layers'].every((t) => tables.includes(t))) throw new Error('missing tables');
    } catch {
      throw new HttpError(400, 'The database in this backup could not be read');
    }

    const pending = path.join(config.DATA_DIR, 'restore-pending');
    await fsp.rm(pending, { recursive: true, force: true });
    await fsp.rename(staging, pending);
  } catch (err) {
    await fsp.rm(staging, { recursive: true, force: true }).catch(() => {});
    throw err;
  } finally {
    await fsp.rm(req.file.path, { force: true }).catch(() => {});
  }

  res.json({ ok: true, restarting: true });
  // Docker's restart policy starts the server again; the swap happens before the database opens.
  console.log('Backup uploaded; restarting to restore it.');
  setTimeout(() => process.exit(0), 500);
}));

module.exports = { admin };
