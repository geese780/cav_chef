/**
 * Block Kit builders for the batched reorder prompt (all items below
 * threshold in one cycle, one Approve/Deny) and its resolved state, plus the
 * pre-booking inventory check-in notification (FR-29, Done/Confirmed only,
 * no ordering action). Every message is tagged with the location name since
 * all locations share one approval channel (see FR-27).
 */

function formatCharge(expectedCharge) {
  return expectedCharge !== undefined ? `$${expectedCharge.toFixed(2)}` : '(no unit price on file)';
}

function totalCharge(draftItems) {
  return draftItems.every(({ expectedCharge }) => expectedCharge !== undefined)
    ? draftItems.reduce((sum, { expectedCharge }) => sum + expectedCharge, 0)
    : undefined;
}

function itemLine({ item, qty, expectedCharge }) {
  return (
    `• *${item.name || item.asin}* — ASIN: \`${item.asin}\` · On hand: ${item.onHand} · ` +
    `Threshold: ${item.threshold} · Qty: *${qty}* · Expected charge: *${formatCharge(expectedCharge)}*`
  );
}

function buildReorderBlocks({ draftId, draftItems, locationName }) {
  return [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text:
          `*[${locationName}] Reorder needed — ${draftItems.length} item(s)*\n` +
          draftItems.map(itemLine).join('\n') +
          `\n\n*Total expected charge:* ${formatCharge(totalCharge(draftItems))}`
      }
    },
    {
      type: 'actions',
      elements: [
        {
          type: 'button',
          text: { type: 'plain_text', text: 'Approve All' },
          style: 'primary',
          action_id: 'approve_reorder',
          value: draftId
        },
        {
          type: 'button',
          text: { type: 'plain_text', text: 'Deny All' },
          style: 'danger',
          action_id: 'deny_reorder',
          value: draftId
        }
      ]
    }
  ];
}

function buildResolvedBlocks({ draftItems, decision, byUserId, orderResults, locationName }) {
  const header =
    decision === 'approved'
      ? `✅ Approved by <@${byUserId}> — mock orders placed`
      : `🚫 Denied by <@${byUserId}>`;

  const lines = draftItems.map(({ item, qty }, i) => {
    const orderId = orderResults && orderResults[i] && orderResults[i].orderId;
    return orderId
      ? `• ${item.name || item.asin} (qty ${qty}) — ${orderId}`
      : `• ${item.name || item.asin} (qty ${qty})`;
  });

  return [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*[${locationName}] Reorder — ${draftItems.length} item(s)*\n${header}\n${lines.join('\n')}`
      }
    }
  ];
}

function checkinItemLine(item) {
  return `• *${item.name || item.asin}* — On hand: ${item.onHand ?? '?'} · Threshold: ${item.threshold ?? '?'}`;
}

/** Initial pre-booking check-in notification (FR-29): current inventory, no
 * ordering action — a single Done/Confirmed button. */
function buildCheckinBlocks({ checkinId, locationName, bookingStart, items }) {
  return [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text:
          `*[${locationName}] Inventory check-in — booking on ${bookingStart.toISOString().slice(0, 10)}*\n` +
          `Please physically verify stock ahead of this booking.\n\n` +
          items.map(checkinItemLine).join('\n')
      }
    },
    {
      type: 'actions',
      elements: [
        {
          type: 'button',
          text: { type: 'plain_text', text: 'Done' },
          style: 'primary',
          action_id: 'confirm_checkin',
          value: checkinId
        }
      ]
    }
  ];
}

/** Lightweight re-ping (FR-29, every CHECKIN_REPING_HOURS while unacknowledged) —
 * no inventory re-fetch, just a nag with the same button/checkinId. */
function buildCheckinReminderBlocks({ checkinId, locationName, bookingStart }) {
  return [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text:
          `*[${locationName}] Inventory check-in — still awaiting confirmation*\n` +
          `Booking on ${bookingStart.toISOString().slice(0, 10)}.`
      }
    },
    {
      type: 'actions',
      elements: [
        {
          type: 'button',
          text: { type: 'plain_text', text: 'Done' },
          style: 'primary',
          action_id: 'confirm_checkin',
          value: checkinId
        }
      ]
    }
  ];
}

function buildCheckinResolvedBlocks({ locationName, bookingStart, byUserId }) {
  return [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text:
          `*[${locationName}] Inventory check-in — booking on ${bookingStart.toISOString().slice(0, 10)}*\n` +
          `✅ Confirmed by <@${byUserId}>`
      }
    }
  ];
}

module.exports = {
  buildReorderBlocks,
  buildResolvedBlocks,
  buildCheckinBlocks,
  buildCheckinReminderBlocks,
  buildCheckinResolvedBlocks
};
