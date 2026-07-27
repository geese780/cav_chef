/**
 * Boot-time reconciliation (FR-09). A draft in 'placing' means some prior
 * process claimed it (approve_reorder/confirm_price_drift/deny_reorder) but
 * crashed or was killed before finishing — before placeOrder, chat.update,
 * and pendingStore.remove all completed. We can't safely tell from here
 * whether the underlying order actually went through (mock or live), and
 * guessing wrong is bad either way: reverting it to 'pending' risks a second,
 * duplicate order if a user re-approves one that already placed; silently
 * dropping it risks losing a real order that never got confirmed/logged. So
 * this doesn't auto-resolve anything — it surfaces every such draft loudly
 * (log + Slack alert) so a human checks Amazon Business/Slack history and
 * resolves it by hand.
 *
 * Only meaningful to run once, immediately at boot, before app.start()
 * starts dispatching any Slack actions: at that exact moment nothing in this
 * process could have legitimately claimed a draft yet, so any 'placing' row
 * found must be left over from a previous process's crash, not a currently
 * in-flight approval.
 */

const pendingStore = require('./pendingStore');
const { alertOnFailure } = require('./alerts');

/** Pure: filter to drafts stuck mid-approval. */
function stuckDrafts(drafts) {
  return drafts.filter(d => d.status === 'placing');
}

async function reconcilePlacingDrafts({ client, logger }) {
  const log = logger || console;
  const stuck = stuckDrafts(pendingStore.list());

  for (const draft of stuck) {
    const msg =
      'Draft stuck in "placing" at boot — a previous process likely crashed mid-approval. ' +
      'Not auto-resolved; check Amazon Business/Slack history and resolve by hand.';
    const context = { draftId: draft.draftId, locationName: draft.locationName };
    log.warn ? log.warn(msg, context) : log.log(msg, context);
    await alertOnFailure(client, msg, context);
  }

  return stuck;
}

module.exports = { stuckDrafts, reconcilePlacingDrafts };
