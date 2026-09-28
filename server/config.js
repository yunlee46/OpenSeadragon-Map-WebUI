const path = require('path');
const crypto = require('crypto');

const env = process.env;

const config = {
  PORT: parseInt(env.PORT || '8080', 10),
  DATA_DIR: path.resolve(env.DATA_DIR || path.join(__dirname, '..', 'data')),
  ADMIN_USER: env.ADMIN_USER || 'admin',
  ADMIN_PASSWORD: env.ADMIN_PASSWORD || '',
  // Sessions survive restarts only if SESSION_SECRET is set.
  SESSION_SECRET: env.SESSION_SECRET || crypto.randomBytes(32).toString('hex'),
  SESSION_HOURS: parseFloat(env.SESSION_HOURS || '24'),
  COOKIE_SECURE: env.COOKIE_SECURE === 'true',
  MAX_UPLOAD_MB: parseInt(env.MAX_UPLOAD_MB || '4096', 10),
  TILE_SIZE: parseInt(env.TILE_SIZE || '254', 10),
};

config.TILES_DIR = path.join(config.DATA_DIR, 'tiles');
config.UPLOAD_TMP = path.join(config.DATA_DIR, 'tmp');

module.exports = config;
