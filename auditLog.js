/**
 * Durable audit log of every reorder trigger/prompt, decision, and order
 * result (FR-13). Append-only — unlike pendingStore.js/checkinStore.js,
 * entries are never updated or removed, so the full history survives even
 * after a draft is resolved and removed from pendingStore. Same SQLite file
 * as pendingStore (PENDING_STORE_DB_PATH), its own table.
 */

const { DatabaseSync } = require('node:sqlite');
const path = require('node:path');
const fs = require('node:fs');

const DEFAULT_DB_PATH = path.join(__dirname, 'data', 'cav_chef.sqlite');

function resolveDbPath() {
  return (process.env.PENDING_STORE_DB_PATH || '').trim() || DEFAULT_DB_PATH;
}

function rowToEntry(row) {
  return {
    id: row.id,
    eventType: row.event_type,
    draftId: row.draft_id,
    locationName: row.location_name,
    at: row.at,
    data: JSON.parse(row.data)
  };
}

function createAuditLog(filePath) {
  if (filePath !== ':memory:') {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
  }

  const db = new DatabaseSync(filePath);
  db.exec(`
    CREATE TABLE IF NOT EXISTS audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event_type TEXT NOT NULL,
      draft_id TEXT,
      location_name TEXT,
      at INTEGER NOT NULL,
      data TEXT NOT NULL
    )
  `);

  return {
    /** eventType: 'posted' | 'flagged_second_approval' | 'approved' | 'denied' */
    log(eventType, { draftId, locationName, at, data } = {}) {
      db.prepare(
        'INSERT INTO audit_log (event_type, draft_id, location_name, at, data) VALUES (?, ?, ?, ?, ?)'
      ).run(eventType, draftId || null, locationName || null, at ?? Date.now(), JSON.stringify(data || {}));
    },
    /** Full chronological timeline for one draft — e.g. posted -> flagged -> approved. */
    forDraft(draftId) {
      return db
        .prepare('SELECT * FROM audit_log WHERE draft_id = ? ORDER BY id ASC')
        .all(draftId)
        .map(rowToEntry);
    },
    recent(limit) {
      return db
        .prepare('SELECT * FROM audit_log ORDER BY id DESC LIMIT ?')
        .all(limit)
        .map(rowToEntry)
        .reverse();
    },
    close() {
      db.close();
    }
  };
}

const defaultLog = createAuditLog(resolveDbPath());

module.exports = {
  log: defaultLog.log,
  forDraft: defaultLog.forDraft,
  recent: defaultLog.recent,
  createAuditLog,
  resolveDbPath,
  DEFAULT_DB_PATH
};
