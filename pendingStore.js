/**
 * Persistent store for pending reorder drafts, keyed by draftId (FR-06).
 * Backed by SQLite via node:sqlite (built into Node, no new dependency) so a
 * restart mid-approval doesn't strand a draft. put/get/remove/list keep the
 * same interface reorderCycle.js and app.js already use. No cross-cycle
 * de-dup here — see FR-02.
 */

const { DatabaseSync } = require('node:sqlite');
const path = require('node:path');
const fs = require('node:fs');

const DEFAULT_DB_PATH = path.join(__dirname, 'data', 'cav_chef.sqlite');

function resolveDbPath() {
  return (process.env.PENDING_STORE_DB_PATH || '').trim() || DEFAULT_DB_PATH;
}

function createPendingStore(filePath) {
  if (filePath !== ':memory:') {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
  }

  const db = new DatabaseSync(filePath);
  db.exec('CREATE TABLE IF NOT EXISTS drafts (draft_id TEXT PRIMARY KEY, data TEXT NOT NULL)');

  return {
    put(draftId, draft) {
      db.prepare('INSERT OR REPLACE INTO drafts (draft_id, data) VALUES (?, ?)').run(draftId, JSON.stringify(draft));
    },
    get(draftId) {
      const row = db.prepare('SELECT data FROM drafts WHERE draft_id = ?').get(draftId);
      return row ? JSON.parse(row.data) : undefined;
    },
    remove(draftId) {
      db.prepare('DELETE FROM drafts WHERE draft_id = ?').run(draftId);
    },
    list() {
      return db.prepare('SELECT data FROM drafts').all().map(row => JSON.parse(row.data));
    },
    close() {
      db.close();
    }
  };
}

const defaultStore = createPendingStore(resolveDbPath());

module.exports = {
  put: defaultStore.put,
  get: defaultStore.get,
  remove: defaultStore.remove,
  list: defaultStore.list,
  createPendingStore,
  resolveDbPath,
  DEFAULT_DB_PATH
};
