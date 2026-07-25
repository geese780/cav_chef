/**
 * Block Kit builders for reorder prompts and their resolved (approved/denied) state.
 */

function formatCharge(expectedCharge) {
  return expectedCharge !== undefined ? `$${expectedCharge.toFixed(2)}` : '(no unit price on file)';
}

function buildReorderBlocks({ draftId, item, qty, expectedCharge }) {
  return [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text:
          `*Reorder needed: ${item.name || item.asin}*\n` +
          `ASIN: \`${item.asin}\` · On hand: ${item.onHand} · Threshold: ${item.threshold}\n` +
          `Qty: *${qty}* · Expected charge: *${formatCharge(expectedCharge)}*`
      }
    },
    {
      type: 'actions',
      elements: [
        {
          type: 'button',
          text: { type: 'plain_text', text: 'Approve' },
          style: 'primary',
          action_id: 'approve_reorder',
          value: draftId
        },
        {
          type: 'button',
          text: { type: 'plain_text', text: 'Deny' },
          style: 'danger',
          action_id: 'deny_reorder',
          value: draftId
        }
      ]
    }
  ];
}

function buildResolvedBlocks({ item, qty, decision, byUserId, orderId }) {
  const line =
    decision === 'approved'
      ? `✅ Approved by <@${byUserId}> — mock order placed (${orderId})`
      : `🚫 Denied by <@${byUserId}>`;

  return [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*Reorder: ${item.name || item.asin}* (qty ${qty})\n${line}`
      }
    }
  ];
}

module.exports = { buildReorderBlocks, buildResolvedBlocks };
