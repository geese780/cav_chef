/**
 * Persistent store for pre-booking inventory check-in notifications (FR-29).
 * Distinct lifecycle from pendingStore.js's reorder drafts: no
 * claim → place → remove, just posted → (re-pinged) → acknowledged. Keyed by
 * `${locationName}::${bookingStart ISO}` (buildCheckinId) so a new booking
 * for the same location gets its own fresh record instead of colliding with
 * an already-acknowledged one.
 */

const { DatabaseSync } = require('node:sqlite');
const path = require('node:path');
const fs = require('node:fs');

const DEFAULT_DB_PATH = path.join(__dirname, 'data', 'cav_chef.sqlite');

function resolveDbPath() {
  return (process.env.PENDING_STORE_DB_PATH || '').trim() || DEFAULT_DB_PATH;
}

function buildCheckinId(locationName, bookingStartIso) {
  return `${locationName}::${bookingStartIso}`;
}

function rowToRecord(row) {
  return {
    checkinId: row.checkin_id,
    locationName: row.location_name,
    bookingStart: row.booking_start,
    channel: row.channel,
    ts: row.ts,
    status: row.status,
    lastNotifiedAt: row.last_notified_at,
    acknowledgedBy: row.acknowledged_by,
    acknowledgedAt: row.acknowledged_at
  };
}

function createCheckinStore(filePath) {
  if (filePath !== ':memory:') {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
  }

  const db = new DatabaseSync(filePath);
  db.exec(`
    CREATE TABLE IF NOT EXISTS checkins (
      checkin_id TEXT PRIMARY KEY,
      location_name TEXT NOT NULL,
      booking_start TEXT NOT NULL,
      channel TEXT NOT NULL,
      ts TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'open',
      last_notified_at INTEGER NOT NULL,
      acknowledged_by TEXT,
      acknowledged_at INTEGER
    )
  `);

  return {
    get(checkinId) {
      const row = db.prepare('SELECT * FROM checkins WHERE checkin_id = ?').get(checkinId);
      return row ? rowToRecord(row) : undefined;
    },
    create(checkinId, { locationName, bookingStart, channel, ts, now }) {
      db.prepare(
        `INSERT INTO checkins (checkin_id, location_name, booking_start, channel, ts, status, last_notified_at)
         VALUES (?, ?, ?, ?, ?, 'open', ?)`
      ).run(checkinId, locationName, bookingStart, channel, ts, now);
    },
    recordReping(checkinId, { channel, ts, now }) {
      db.prepare('UPDATE checkins SET channel = ?, ts = ?, last_notified_at = ? WHERE checkin_id = ?').run(
        channel,
        ts,
        now,
        checkinId
      );
    },
    /** Atomically acknowledges an open checkin (same claim pattern as
     * pendingStore.js, FR-07) — a second click can't double-process.
     * Returns the record on success, or undefined if missing/already done. */
    claim(checkinId, { byUserId, now }) {
      const result = db
        .prepare(
          "UPDATE checkins SET status = 'acknowledged', acknowledged_by = ?, acknowledged_at = ? " +
            "WHERE checkin_id = ? AND status = 'open'"
        )
        .run(byUserId, now, checkinId);
      if (Number(result.changes) === 0) return undefined;

      const row = db.prepare('SELECT * FROM checkins WHERE checkin_id = ?').get(checkinId);
      return row ? rowToRecord(row) : undefined;
    },
    close() {
      db.close();
    }
  };
}

const defaultStore = createCheckinStore(resolveDbPath());

module.exports = {
  get: defaultStore.get,
  create: defaultStore.create,
  recordReping: defaultStore.recordReping,
  claim: defaultStore.claim,
  createCheckinStore,
  buildCheckinId,
  resolveDbPath,
  DEFAULT_DB_PATH
};
