const { config } = require('dotenv');
config();

const auditLog = require('../auditLog');

/** Read-only audit log query (FR-13). No args: recent entries across all
 * locations. One arg: full chronological timeline for that draft id (posted
 * -> flagged -> approved/denied), including who decided, when, the items,
 * expected vs actual charge, and order ids. */
function formatEntry({ id, eventType, draftId, locationName, at, data }) {
  const when = new Date(at).toISOString();
  const lines = [`#${id} [${when}] ${eventType} — ${locationName || '(no location)'} — draft ${draftId || '(none)'}`];

  if (eventType === 'posted') {
    for (const item of data.items || []) {
      lines.push(`    ${item.name || item.asin} x${item.qty} — expected ${formatMoney(item.expectedCharge)}`);
    }
    lines.push(`    total expected: ${formatMoney(data.expectedTotal)}`);
  } else if (eventType === 'flagged_second_approval') {
    lines.push(
      `    flagged by ${data.byUserId} — expected ${formatMoney(data.expectedTotal)} -> ` +
        `current ${formatMoney(data.currentTotal)} (delta ${formatMoney(data.deltaTotal)}, hasUnknown=${data.hasUnknown})`
    );
  } else if (eventType === 'approved') {
    const note = data.firstApproverId && data.firstApproverId !== data.byUserId ? ` (flagged by ${data.firstApproverId})` : '';
    lines.push(`    approved by ${data.byUserId}${note}`);
    for (const item of data.items || []) {
      lines.push(
        `    ${item.name || item.asin} x${item.qty} — expected ${formatMoney(item.expectedCharge)}, ` +
          `actual ${formatMoney(item.actualCharge)}, order ${item.orderId || '(none)'}`
      );
    }
  } else if (eventType === 'denied') {
    lines.push(`    denied by ${data.byUserId}`);
    for (const item of data.items || []) {
      lines.push(`    ${item.name || item.asin} x${item.qty}`);
    }
  } else if (eventType === 'expired') {
    lines.push(`    expired — approval window passed, no order placed`);
    for (const item of data.items || []) {
      lines.push(`    ${item.name || item.asin} x${item.qty}`);
    }
  }

  return lines.join('\n');
}

function formatMoney(n) {
  return n !== undefined ? `$${n.toFixed(2)}` : '(unknown)';
}

function main() {
  const draftId = process.argv[2];

  if (draftId) {
    const entries = auditLog.forDraft(draftId);
    if (entries.length === 0) {
      console.log(`No audit log entries for draft ${draftId}.`);
      return;
    }
    console.log(`Timeline for draft ${draftId}:\n`);
    for (const entry of entries) console.log(formatEntry(entry) + '\n');
    return;
  }

  const entries = auditLog.recent(50);
  if (entries.length === 0) {
    console.log('No audit log entries yet.');
    return;
  }
  console.log('Most recent 50 audit log entries:\n');
  for (const entry of entries) console.log(formatEntry(entry) + '\n');
}

main();
