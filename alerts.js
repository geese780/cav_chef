/**
 * Error alerting (FR-19). Routes unhandled errors and failed orders to the
 * same channel as reorder prompts (APPROVAL_CHANNEL_ID / cav_labz), per user
 * direction, rather than a separate on-call channel.
 */

async function alertOnFailure(client, message, context = {}) {
  try {
    const channel = (process.env.APPROVAL_CHANNEL_ID || '').trim();
    if (!channel) return; // can't alert without a channel — startupCheck already requires this in normal operation

    const detailLines = Object.entries(context)
      .map(([key, value]) => `${key}: ${value}`)
      .join('\n');

    await client.chat.postMessage({
      channel,
      text: `🚨 ${message}`,
      blocks: [
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: `🚨 *${message}*` + (detailLines ? `\n\`\`\`${detailLines}\`\`\`` : '')
          }
        }
      ]
    });
  } catch (err) {
    // Alerting itself failing shouldn't throw and mask the original error.
    console.error('Failed to post alert', err);
  }
}

module.exports = { alertOnFailure };
