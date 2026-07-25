const { App, LogLevel } = require('@slack/bolt');
const { config } = require('dotenv');

config();

const pendingStore = require('./pendingStore');
const { placeOrder } = require('./orderingClient');
const { buildResolvedBlocks } = require('./blockKit');
const { runReorderCycle } = require('./reorderCycle');

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
  const orderResults = [];
  for (const { item, qty, expectedCharge } of draft.items) {
    const { orderId } = await placeOrder({ item, qty, expectedCharge });
    orderResults.push({ orderId });
  }

  await client.chat.update({
    channel: draft.channel,
    ts: draft.ts,
    text: `Reorder approved: ${draft.items.length} item(s)`,
    blocks: buildResolvedBlocks({ draftItems: draft.items, decision: 'approved', byUserId, orderResults })
  });

  pendingStore.remove(action.value);
  logger.info(`Approved batch ${draft.draftId} by ${byUserId} — ${orderResults.length} mock order(s)`);
});

app.action('deny_reorder', async ({ ack, action, body, client, logger }) => {
  await ack();

  const draft = pendingStore.get(action.value);
  if (!draft) return; // already resolved or expired — no-op

  const byUserId = body.user.id;

  await client.chat.update({
    channel: draft.channel,
    ts: draft.ts,
    text: `Reorder denied: ${draft.items.length} item(s)`,
    blocks: buildResolvedBlocks({ draftItems: draft.items, decision: 'denied', byUserId })
  });

  pendingStore.remove(action.value);
  logger.info(`Denied batch ${draft.draftId} by ${byUserId}`);
});

(async () => {
  try {
    await app.start();
    app.logger.info('⚡️ CAV_Chef is running!');

    // No scheduler yet (see FR-27/FR-28) — run one cycle on startup so posted
    // drafts live in this same process and their Approve/Deny buttons resolve.
    const posted = await runReorderCycle({ client: app.client, logger: app.logger });
    app.logger.info(`Startup reorder cycle posted ${posted.length} prompt(s).`);
  } catch (error) {
    app.logger.error('Failed to start the app', error);
  }
})();
