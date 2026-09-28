// A restore uploads a backup into DATA_DIR/restore-pending and restarts the server.
// On the next start, before the database is opened, the pending data is swapped in.
// The previous data is kept in DATA_DIR/pre-restore-<time> (only the most recent one).

const fs = require('fs');
const path = require('path');

const ITEMS = ['app.db', 'app.db-wal', 'app.db-shm', 'tiles', 'refs'];

function applyPendingRestore(dataDir) {
  const pending = path.join(dataDir, 'restore-pending');
  if (!fs.existsSync(pending)) return;
  if (!fs.existsSync(path.join(pending, 'app.db'))) {
    fs.rmSync(pending, { recursive: true, force: true });
    return;
  }

  for (const name of fs.readdirSync(dataDir)) {
    if (name.startsWith('pre-restore-')) fs.rmSync(path.join(dataDir, name), { recursive: true, force: true });
  }
  const keep = path.join(dataDir, `pre-restore-${new Date().toISOString().replace(/[:.]/g, '-')}`);
  fs.mkdirSync(keep);
  for (const name of ITEMS) {
    const p = path.join(dataDir, name);
    if (fs.existsSync(p)) fs.renameSync(p, path.join(keep, name));
  }
  for (const name of fs.readdirSync(pending)) {
    if (ITEMS.includes(name)) fs.renameSync(path.join(pending, name), path.join(dataDir, name));
  }
  fs.rmSync(pending, { recursive: true, force: true });
  console.log(`Backup restored. The previous data was moved to ${keep}`);
}

module.exports = { applyPendingRestore, RESTORE_ITEMS: ITEMS };
