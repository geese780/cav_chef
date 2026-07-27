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

// PII scrub: the audit log is retained long-term for governance, and our
// compliance stance (see DATA_HANDLING.md) is that it stores no buyer PII at
// all — no ship-to address, no buyer email, nothing from a raw Amazon order
// response. Allowlist, not blocklist, so a field we didn't anticipate (e.g.
// a raw Amazon response object passed into a `data` payload by mistake) is
// dropped by default instead of silently persisted. Reconciled against every
// real `log(...)` call site in reorderCycle.js and app.js — every key below
// is genuinely used by 'posted' / 'flagged_second_approval' / 'approved' /
// 'denied'; nothing here is speculative.
const ALLOWED_DATA_KEYS = new Set([
  'items', // array; each element sanitized to ALLOWED_ITEM_KEYS
  'expectedTotal',
  'currentTotal',
  'deltaTotal',
  'hasUnknown',
  'byUserId', // internal Slack user id — not Amazon buyer PII
  'firstApproverId' // internal Slack user id
]);

const ALLOWED_ITEM_KEYS = new Set(['asin', 'name', 'qty', 'expectedCharge', 'actualCharge', 'orderId']);

function sanitizeItem(item) {
  const clean = {};
  for (const k of Object.keys(item || {})) {
    if (ALLOWED_ITEM_KEYS.has(k)) clean[k] = item[k];
  }
  return clean;
}

function sanitizeData(data = {}) {
  const clean = {};
  for (const k of Object.keys(data || {})) {
    if (!ALLOWED_DATA_KEYS.has(k)) continue;
    clean[k] = k === 'items' && Array.isArray(data[k]) ? data[k].map(sanitizeItem) : data[k];
  }
  return clean;
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
    /** eventType: 'posted' | 'flagged_second_approval' | 'approved' | 'denied' | 'expired' */
    log(eventType, { draftId, locationName, at, data } = {}) {
      db.prepare(
        'INSERT INTO audit_log (event_type, draft_id, location_name, at, data) VALUES (?, ?, ?, ?, ?)'
      ).run(eventType, draftId || null, locationName || null, at ?? Date.now(), JSON.stringify(sanitizeData(data)));
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

// Lazy — see the matching comment in pendingStore.js: merely require()-ing
// this module must not touch disk, or parallel test files hitting the same
// default DB file cause real SQLITE_BUSY contention in CI.
let defaultLog;
function getDefaultLog() {
  if (!defaultLog) defaultLog = createAuditLog(resolveDbPath());
  return defaultLog;
}

module.exports = {
  log: (...args) => getDefaultLog().log(...args),
  forDraft: (...args) => getDefaultLog().forDraft(...args),
  recent: (...args) => getDefaultLog().recent(...args),
  createAuditLog,
  resolveDbPath,
  DEFAULT_DB_PATH
};
