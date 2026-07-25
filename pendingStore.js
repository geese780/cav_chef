/**
 * In-memory store for pending reorder drafts, keyed by draftId.
 * Lost on restart — FR-06 replaces this with SQLite/Redis behind the same
 * put/get/remove interface. No cross-cycle de-dup here — see FR-02.
 */

const drafts = new Map();

function put(draftId, draft) {
  drafts.set(draftId, draft);
}

function get(draftId) {
  return drafts.get(draftId);
}

function remove(draftId) {
  drafts.delete(draftId);
}

function list() {
  return Array.from(drafts.values());
}

module.exports = { put, get, remove, list };
