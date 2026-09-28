const path = require('path');
const fs = require('fs');
const express = require('express');
const multer = require('multer');
const config = require('./config');
require('./db');
const auth = require('./auth');
const { publishAllIfPending } = require('./content');
const maps = require('./routes/maps');
const images = require('./routes/images');
const types = require('./routes/types');
const planner = require('./routes/planner');
const backup = require('./routes/backup');

fs.mkdirSync(config.TILES_DIR, { recursive: true });
fs.mkdirSync(config.UPLOAD_TMP, { recursive: true });
publishAllIfPending();

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', process.env.TRUST_PROXY === 'true');
app.use(express.json({ limit: '10mb' }));

const PUBLIC = path.join(__dirname, '..', 'public');
const OSD_BUILD = path.join(path.dirname(require.resolve('openseadragon/package.json')), 'build', 'openseadragon');

app.use('/vendor/osd', express.static(OSD_BUILD, { maxAge: '7d' }));
app.use('/tiles', express.static(config.TILES_DIR, { maxAge: '30d', immutable: true, fallthrough: false }));
app.use(express.static(PUBLIC));

// ---------- API ----------

app.post('/api/login', auth.login);
app.post('/api/logout', auth.logout);
app.get('/api/me', (req, res) => res.json({ admin: auth.isAdmin(req) }));

app.use('/api', maps.pub, types.pub);

const admin = express.Router();
admin.use(auth.requireAdmin);
admin.use(maps.admin, images.admin, types.admin, planner.admin, backup.admin);
app.use('/api/admin', admin);

// ---------- errors ----------

app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    const msg = err.code === 'LIMIT_FILE_SIZE' ? 'That file is larger than the upload limit' : err.message;
    return res.status(413).json({ error: msg });
  }
  if (err.status === 404 && req.path.startsWith('/tiles')) return res.status(404).end();
  const status = err.status || 500;
  if (status >= 500) console.error(err);
  if (res.headersSent) return res.end();
  res.status(status).json({ error: status >= 500 ? 'Server error' : err.message });
});

app.listen(config.PORT, () => {
  console.log(`OpenSeadragon Map WebUI listening on http://0.0.0.0:${config.PORT}`);
  if (!config.ADMIN_PASSWORD) console.warn('WARNING: ADMIN_PASSWORD is not set; the admin panel cannot be used.');
  if (!process.env.SESSION_SECRET) console.warn('Note: SESSION_SECRET is not set; admin logins end whenever the server restarts.');
});
