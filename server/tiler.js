const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const sharp = require('sharp');
const yauzl = require('yauzl');
const { db } = require('./db');
const { TILES_DIR, TILE_SIZE } = require('./config');

sharp.concurrency(0);
sharp.cache(false);

const MAX_ZIP_BYTES = 50 * 1024 ** 3; // refuse archives that claim to unpack to more than 50 GB

// Conversions are memory-hungry, so run them one at a time.
let queue = Promise.resolve();
function enqueue(job) {
  queue = queue.then(job, job);
  return queue;
}

async function isZip(file) {
  const fh = await fsp.open(file, 'r');
  try {
    const buf = Buffer.alloc(4);
    await fh.read(buf, 0, 4, 0);
    return buf.equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]));
  } finally {
    await fh.close();
  }
}

function extractZip(zipFile, destDir) {
  const root = path.resolve(destDir);
  return new Promise((resolve, reject) => {
    yauzl.open(zipFile, { lazyEntries: true, validateEntrySizes: true }, (err, zip) => {
      if (err) return reject(err);
      let total = 0;
      const fail = (e) => { zip.close(); reject(e); };
      zip.on('error', reject);
      zip.on('end', resolve);
      zip.on('entry', (entry) => {
        const mode = (entry.externalFileAttributes >>> 16) & 0o170000;
        if (mode === 0o120000) return fail(new Error(`Zip contains a symlink (${entry.fileName}); refusing it`));

        const name = entry.fileName.replace(/\\/g, '/');
        if (name.startsWith('__MACOSX/')) return zip.readEntry();
        const target = path.resolve(root, name);
        if (target !== root && !target.startsWith(root + path.sep)) {
          return fail(new Error(`Zip entry escapes the target folder: ${entry.fileName}`));
        }
        if (name.endsWith('/')) {
          fs.mkdir(target, { recursive: true }, (e) => (e ? fail(e) : zip.readEntry()));
          return;
        }
        total += entry.uncompressedSize;
        if (total > MAX_ZIP_BYTES) return fail(new Error('Zip is too large when unpacked'));

        fs.mkdir(path.dirname(target), { recursive: true }, (e) => {
          if (e) return fail(e);
          zip.openReadStream(entry, (e2, stream) => {
            if (e2) return fail(e2);
            const out = fs.createWriteStream(target);
            stream.on('error', fail);
            out.on('error', fail);
            out.on('finish', () => zip.readEntry());
            stream.pipe(out);
          });
        });
      });
      zip.readEntry();
    });
  });
}

async function findFiles(dir, ext, found = []) {
  for (const ent of await fsp.readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      if (!ent.name.endsWith('_files')) await findFiles(p, ext, found);
    } else if (ent.name.toLowerCase().endsWith(ext)) {
      found.push(p);
    }
  }
  return found;
}

async function readDzi(dziFile) {
  const xml = await fsp.readFile(dziFile, 'utf8');
  const attr = (name) => {
    const m = xml.match(new RegExp(`<Size[^>]*\\b${name}\\s*=\\s*"(\\d+)"`, 'i'));
    return m ? parseInt(m[1], 10) : null;
  };
  const width = attr('Width');
  const height = attr('Height');
  if (!width || !height) throw new Error('The .dzi file has no Width/Height');
  const filesDir = dziFile.replace(/\.dzi$/i, '_files');
  if (!fs.existsSync(filesDir)) throw new Error(`Missing tile folder next to the .dzi (${path.basename(filesDir)})`);
  const tileSize = parseInt((xml.match(/TileSize\s*=\s*"(\d+)"/i) || [])[1] || '254', 10);
  const format = (xml.match(/Format\s*=\s*"(\w+)"/i) || [])[1] || 'jpg';
  return { width, height, tileSize, format, filesDir };
}

// Thumbnail from the largest pyramid level that fits in a single tile.
async function makeThumb(dzi, outDir) {
  const maxDim = Math.max(dzi.width, dzi.height);
  const maxLevel = Math.ceil(Math.log2(maxDim));
  const level = Math.max(0, maxLevel - Math.max(0, Math.ceil(Math.log2(maxDim / dzi.tileSize))));
  const tile = path.join(dzi.filesDir, String(level), `0_0.${dzi.format}`);
  try {
    await sharp(tile).resize(320, 320, { fit: 'inside' }).webp({ quality: 80 }).toFile(path.join(outDir, 'thumb.webp'));
  } catch (err) {
    console.warn('Could not make thumbnail:', err.message);
  }
}

async function tileImage(input, outDir) {
  const meta = await sharp(input, { limitInputPixels: false }).metadata();
  let pipeline = sharp(input, { limitInputPixels: false }).rotate(); // apply EXIF orientation
  pipeline = meta.hasAlpha ? pipeline.png() : pipeline.jpeg({ quality: 88 });
  await pipeline
    .tile({ size: TILE_SIZE, overlap: 1, layout: 'dz' })
    .toFile(path.join(outDir, 'image.dz'));
  const dzi = (await findFiles(outDir, '.dzi'))[0];
  if (!dzi) throw new Error('Tiling produced no .dzi file');
  return dzi;
}

async function processUpload(imageId, uploadPath) {
  const outDir = path.join(TILES_DIR, imageId);
  try {
    await fsp.mkdir(outDir, { recursive: true });
    let dzi;
    if (await isZip(uploadPath)) {
      await extractZip(uploadPath, outDir);
      const dzis = await findFiles(outDir, '.dzi');
      if (dzis.length === 0) throw new Error('No .dzi file found in the zip');
      if (dzis.length > 1) throw new Error('The zip contains more than one .dzi file; upload them separately');
      dzi = dzis[0];
    } else {
      dzi = await tileImage(uploadPath, outDir);
    }
    const info = await readDzi(dzi);
    const { width, height } = info;
    await makeThumb(info, outDir);
    const rel = path.relative(outDir, dzi).split(path.sep).join('/');
    const res = db.prepare(`UPDATE images SET status='ready', error=NULL, width=?, height=?, dzi_path=? WHERE id=?`)
      .run(width, height, rel, imageId);
    // The image was deleted while it was being processed.
    if (res.changes === 0) await fsp.rm(outDir, { recursive: true, force: true });
  } catch (err) {
    console.error(`Processing image ${imageId} failed:`, err.message);
    await fsp.rm(outDir, { recursive: true, force: true }).catch(() => {});
    db.prepare(`UPDATE images SET status='error', error=? WHERE id=?`).run(String(err.message).slice(0, 500), imageId);
  } finally {
    await fsp.rm(uploadPath, { force: true }).catch(() => {});
  }
}

const queueUpload = (imageId, uploadPath) => enqueue(() => processUpload(imageId, uploadPath));

module.exports = { queueUpload };
