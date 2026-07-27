/**
 * Auto-expire stale pending-approval drafts (FR-12). A draft posted at one
 * price shouldn't still be approvable days later against a since-drifted
 * price — expiring it forces a fresh cycle (and a fresh price check) instead.
 * Runs on the same poll cadence as scheduler.js/pollDueLocations and
 * checkin.js/pollCheckins, but isn't calendar-driven itself — it applies to
 * any location's open draft regardless of whether that location has a
 * calendarId configured.
 */

const pendingStore = require('./pendingStore');
const auditLog = require('./auditLog');
const { buildResolvedBlocks } = require('./blockKit');

const DEFAULT_EXPIRY_HOURS = 24;

function pendingApprovalExpiryHours() {
  const raw = Number(process.env.PENDING_APPROVAL_EXPIRY_HOURS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_EXPIRY_HOURS;
}

/** Pure: has a draft posted at postedAt aged past the expiry window? A draft
 * with no postedAt (predates this feature) never expires rather than being
 * treated as infinitely stale. */
function isExpired({ postedAt, now, expiryHours }) {
  if (postedAt === undefined) return false;
  return now.getTime() - postedAt >= expiryHours * 60 * 60 * 1000;
}

/** Check every still-open draft and expire any that have aged out. Only
 * 'pending'/'awaiting_second_approval' drafts are eligible — a draft
 * mid-'placing' is already resolving elsewhere and is left alone. Reuses
 * claimForResolution (same atomic guard Deny uses) so a real approve/deny
 * click landing at the same moment always wins the race, not this poll. */
async function pollExpiry({ client, logger }) {
  const log = logger || console;
  const expiryHours = pendingApprovalExpiryHours();
  const now = new Date();

  const candidates = pendingStore
    .list()
    .filter(d => d.status === 'pending' || d.status === 'awaiting_second_approval')
    .filter(d => isExpired({ postedAt: d.postedAt, now, expiryHours }));

  for (const draft of candidates) {
    const claimed = pendingStore.claimForResolution(draft.draftId);
    if (!claimed) continue; // lost the race to a real approve/deny click — no-op

    pendingStore.remove(claimed.draftId);

    await client.chat.update({
      channel: claimed.channel,
      ts: claimed.ts,
      text: `[${claimed.locationName}] Reorder expired: ${claimed.items.length} item(s)`,
      blocks: buildResolvedBlocks({ draftItems: claimed.items, decision: 'expired', locationName: claimed.locationName })
    });

    auditLog.log('expired', {
      draftId: claimed.draftId,
      locationName: claimed.locationName,
      data: { items: claimed.items.map(({ item, qty }) => ({ asin: item.asin, name: item.name, qty })) }
    });

    const msg = 'Reorder draft expired — approval window passed';
    const context = { draftId: claimed.draftId, locationName: claimed.locationName, expiryHours };
    log.info ? log.info(msg, context) : log.log(msg, context);
  }
}

module.exports = { isExpired, pollExpiry, pendingApprovalExpiryHours, DEFAULT_EXPIRY_HOURS };
