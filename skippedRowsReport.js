/**
 * Reports inventory List rows that can't be acted on — missing/unresolvable
 * ASIN, or a missing/non-numeric on_hand or threshold (FR-04). These rows
 * are silently excluded from itemsNeedingReorder today with zero visibility
 * anywhere, so a bad row just quietly never reorders forever unless someone
 * happens to notice.
 *
 * Posts to APPROVAL_CHANNEL_ID — same channel as everything else in this
 * app, per the same reasoning as FR-19's alerting: no separate maintenance
 * channel exists, and splitting a 3-person team's attention across two
 * channels adds friction for no real benefit.
 *
 * Low-noise by design: only posts when the *set* of skipped row ids for a
 * location differs from the set last posted for it (tracked in memory, per
 * process) — a list that's always clean posts nothing, ever, and a newly
 * bad row posts once rather than on every poll tick. Deliberately simple:
 * this state isn't persisted, so a restart forgets what was last posted and
 * a still-bad row could repost once after a restart — an acceptable gap
 * for a purely informational message (unlike a duplicate order, nothing
 * here has real consequences if it fires an extra time).
 */

const { buildSkippedRowsBlocks } = require('./blockKit');

/** Pure: which rows are missing data itemsNeedingReorder requires, and why. */
function findSkippedRows(items) {
  return (items || [])
    .filter(item => !item.asin || item.onHand === undefined || item.threshold === undefined)
    .map(item => ({
      rowId: item.rowId,
      name: item.name,
      reasons: [
        !item.asin && 'missing/unresolvable ASIN',
        item.onHand === undefined && 'missing or non-numeric on_hand',
        item.threshold === undefined && 'missing or non-numeric threshold'
      ].filter(Boolean)
    }));
}

const lastReportedIds = new Map(); // locationName -> sorted rowId[] last actually posted

function idsFor(skipped) {
  return skipped
    .map(s => s.rowId)
    .sort();
}

async function reportSkippedRows({ client, logger, locationName, items }) {
  const log = logger || console;
  const skipped = findSkippedRows(items);
  if (skipped.length === 0) return;

  const ids = idsFor(skipped);
  const prevIds = lastReportedIds.get(locationName) || [];
  if (JSON.stringify(ids) === JSON.stringify(prevIds)) return; // already reported, unchanged

  const channel = (process.env.APPROVAL_CHANNEL_ID || '').trim();
  if (!channel) return; // startupCheck already requires this in normal operation

  await client.chat.postMessage({
    channel,
    text: `[${locationName}] ${skipped.length} inventory row(s) need attention`,
    blocks: buildSkippedRowsBlocks({ locationName, skipped })
  });

  lastReportedIds.set(locationName, ids);

  const msg = 'Reported skipped inventory rows';
  const context = { locationName, skippedCount: skipped.length };
  log.info ? log.info(msg, context) : log.log(msg, context);
}

module.exports = { findSkippedRows, reportSkippedRows };
