/**
 * Persistent store for pending reorder drafts, keyed by draftId (FR-06).
 * Backed by SQLite via node:sqlite (built into Node, no new dependency) so a
 * restart mid-approval doesn't strand a draft. put/get/remove/list keep the
 * same interface reorderCycle.js and app.js already use. No cross-cycle
 * de-dup here — see FR-02.
 *
 * `claim` (FR-07) atomically transitions a draft from 'pending' to 'placing'
 * via a single conditional UPDATE, so two concurrent action handlers for the
 * same draftId (double-click, redelivered Slack event) can't both proceed —
 * only one UPDATE affects a row; the other sees 0 rows changed and no-ops.
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
  db.exec(
    "CREATE TABLE IF NOT EXISTS drafts (draft_id TEXT PRIMARY KEY, status TEXT NOT NULL DEFAULT 'pending', data TEXT NOT NULL)"
  );
  // Migrate a pre-FR-07 DB file that predates the status column.
  const columns = db.prepare('PRAGMA table_info(drafts)').all();
  if (!columns.some(c => c.name === 'status')) {
    db.exec("ALTER TABLE drafts ADD COLUMN status TEXT NOT NULL DEFAULT 'pending'");
  }

  return {
    put(draftId, draft) {
      db.prepare("INSERT OR REPLACE INTO drafts (draft_id, status, data) VALUES (?, 'pending', ?)").run(
        draftId,
        JSON.stringify(draft)
      );
    },
    get(draftId) {
      const row = db.prepare('SELECT data FROM drafts WHERE draft_id = ?').get(draftId);
      return row ? JSON.parse(row.data) : undefined;
    },
    /** Atomically claims a pending draft for processing. Returns the draft on
     * success, or undefined if it's missing or already claimed/resolved. */
    claim(draftId) {
      const result = db
        .prepare("UPDATE drafts SET status = 'placing' WHERE draft_id = ? AND status = 'pending'")
        .run(draftId);
      if (Number(result.changes) === 0) return undefined;

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
  claim: defaultStore.claim,
  remove: defaultStore.remove,
  list: defaultStore.list,
  createPendingStore,
  resolveDbPath,
  DEFAULT_DB_PATH
};
