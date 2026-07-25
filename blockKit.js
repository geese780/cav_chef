/**
 * Block Kit builders for the batched reorder prompt (all items below
 * threshold in one cycle, one Approve/Deny) and its resolved state.
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

function buildReorderBlocks({ draftId, draftItems }) {
  return [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text:
          `*Reorder needed — ${draftItems.length} item(s)*\n` +
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

function buildResolvedBlocks({ draftItems, decision, byUserId, orderResults }) {
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
        text: `*Reorder — ${draftItems.length} item(s)*\n${header}\n${lines.join('\n')}`
      }
    }
  ];
}

module.exports = { buildReorderBlocks, buildResolvedBlocks };
