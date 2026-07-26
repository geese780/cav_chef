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
 *
 * `flagForSecondApproval`/`claimSecondApproval` (FR-11) add a third status,
 * 'awaiting_second_approval', for drafts whose price drifted enough to need
 * a second, distinct approver before placing. Each does a synchronous
 * read-modify-write (SELECT then UPDATE, no `await` between them) — still
 * atomic w.r.t. other action handlers, since node:sqlite is synchronous and
 * nothing else can run on Node's single thread between two sync statements
 * in the same function call; the UPDATE's status guard is the actual
 * correctness backstop, same reasoning as `claim`.
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
    /** Deny can resolve a draft from either 'pending' or
     * 'awaiting_second_approval' — canceling a high-drift order shouldn't
     * require the second approver to show up first. */
    claimForResolution(draftId) {
      const result = db
        .prepare(
          "UPDATE drafts SET status = 'placing' WHERE draft_id = ? AND status IN ('pending', 'awaiting_second_approval')"
        )
        .run(draftId);
      if (Number(result.changes) === 0) return undefined;

      const row = db.prepare('SELECT data FROM drafts WHERE draft_id = ?').get(draftId);
      return row ? JSON.parse(row.data) : undefined;
    },
    /** First approval on a high-drift draft: records who flagged it, the
     * drift totals, and the price-checked items (so confirming later reuses
     * the price found now instead of re-checking and risking further
     * drift) — merged into the JSON blob, not new columns. Only succeeds
     * from 'pending'. */
    flagForSecondApproval(draftId, { firstApprover, items, expectedTotal, currentTotal, deltaTotal }) {
      const row = db.prepare("SELECT data FROM drafts WHERE draft_id = ? AND status = 'pending'").get(draftId);
      if (!row) return undefined;

      const updated = { ...JSON.parse(row.data), items, firstApprover, expectedTotal, currentTotal, deltaTotal };
      const result = db
        .prepare("UPDATE drafts SET status = 'awaiting_second_approval', data = ? WHERE draft_id = ? AND status = 'pending'")
        .run(JSON.stringify(updated), draftId);
      if (Number(result.changes) === 0) return undefined;

      return updated;
    },
    /** Second approver confirms a high-drift draft. Fails if the same user
     * who flagged it tries to also confirm it — unless allowSameUser is set
     * (small-team override, see approvers.allowSelfSecondApproval), in which
     * case that check is skipped but everything else stays the same. */
    claimSecondApproval(draftId, { secondApprover, allowSameUser }) {
      const row = db
        .prepare("SELECT data FROM drafts WHERE draft_id = ? AND status = 'awaiting_second_approval'")
        .get(draftId);
      if (!row) return undefined;

      const draft = JSON.parse(row.data);
      if (!allowSameUser && draft.firstApprover === secondApprover) return undefined;

      const result = db
        .prepare("UPDATE drafts SET status = 'placing' WHERE draft_id = ? AND status = 'awaiting_second_approval'")
        .run(draftId);
      if (Number(result.changes) === 0) return undefined;

      return draft;
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
  claimForResolution: defaultStore.claimForResolution,
  flagForSecondApproval: defaultStore.flagForSecondApproval,
  claimSecondApproval: defaultStore.claimSecondApproval,
  remove: defaultStore.remove,
  list: defaultStore.list,
  createPendingStore,
  resolveDbPath,
  DEFAULT_DB_PATH
};
