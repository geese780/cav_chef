const { App, LogLevel } = require('@slack/bolt');
const { config } = require('dotenv');

config();

const pendingStore = require('./pendingStore');
const { placeOrder } = require('./orderingClient');
const { buildResolvedBlocks } = require('./blockKit');

/** CAV Slackbot — inventory reorder approvals (see FEATURE_REQUESTS.md). */
const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  socketMode: true,
  appToken: process.env.SLACK_APP_TOKEN,
  logLevel: LogLevel.DEBUG,
});

/** No authorization check yet — anyone who can click approves. See FR-10. */
app.action('approve_reorder', async ({ ack, action, body, client, logger }) => {
  await ack();

  const draft = pendingStore.get(action.value);
  if (!draft) return; // already resolved or expired — no-op

  const byUserId = body.user.id;
  const { orderId } = await placeOrder({ item: draft.item, qty: draft.qty, expectedCharge: draft.expectedCharge });

  await client.chat.update({
    channel: draft.channel,
    ts: draft.ts,
    text: `Reorder approved: ${draft.item.name || draft.item.asin}`,
    blocks: buildResolvedBlocks({ item: draft.item, qty: draft.qty, decision: 'approved', byUserId, orderId })
  });

  pendingStore.remove(action.value);
  logger.info(`Approved ${draft.draftId} by ${byUserId} — mock order ${orderId}`);
});

app.action('deny_reorder', async ({ ack, action, body, client, logger }) => {
  await ack();

  const draft = pendingStore.get(action.value);
  if (!draft) return; // already resolved or expired — no-op

  const byUserId = body.user.id;

  await client.chat.update({
    channel: draft.channel,
    ts: draft.ts,
    text: `Reorder denied: ${draft.item.name || draft.item.asin}`,
    blocks: buildResolvedBlocks({ item: draft.item, qty: draft.qty, decision: 'denied', byUserId })
  });

  pendingStore.remove(action.value);
  logger.info(`Denied ${draft.draftId} by ${byUserId}`);
});

(async () => {
  try {
    await app.start();
    app.logger.info('⚡️ CAV_Chef is running!');
    // No scheduler yet — trigger a cycle with `npm run run-reorder-cycle`.
  } catch (error) {
    app.logger.error('Failed to start the app', error);
  }
})();
