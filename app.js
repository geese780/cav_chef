const { App, LogLevel } = require('@slack/bolt');
const { config } = require('dotenv');

config();

const pendingStore = require('./pendingStore');
const { placeOrder } = require('./orderingClient');
const { buildResolvedBlocks } = require('./blockKit');
const { runAllLocationCycles } = require('./reorderCycle');
const { validateStartupConfig } = require('./startupCheck');

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
    text: `[${draft.locationName}] Reorder approved: ${draft.items.length} item(s)`,
    blocks: buildResolvedBlocks({ draftItems: draft.items, decision: 'approved', byUserId, orderResults, locationName: draft.locationName })
  });

  pendingStore.remove(action.value);
  logger.info(`[${draft.locationName}] Approved batch ${draft.draftId} by ${byUserId} — ${orderResults.length} mock order(s)`);
});

app.action('deny_reorder', async ({ ack, action, body, client, logger }) => {
  await ack();

  const draft = pendingStore.get(action.value);
  if (!draft) return; // already resolved or expired — no-op

  const byUserId = body.user.id;

  await client.chat.update({
    channel: draft.channel,
    ts: draft.ts,
    text: `[${draft.locationName}] Reorder denied: ${draft.items.length} item(s)`,
    blocks: buildResolvedBlocks({ draftItems: draft.items, decision: 'denied', byUserId, locationName: draft.locationName })
  });

  pendingStore.remove(action.value);
  logger.info(`[${draft.locationName}] Denied batch ${draft.draftId} by ${byUserId}`);
});

(async () => {
  try {
    await validateStartupConfig({ client: app.client, logger: app.logger });
    await app.start();
    app.logger.info('⚡️ CAV_Chef is running!');

    // No scheduler yet (see FR-28) — run one cycle per location on startup so
    // posted drafts live in this same process and their Approve/Deny buttons resolve.
    const results = await runAllLocationCycles({ client: app.client, logger: app.logger });
    for (const { location, posted } of results) {
      app.logger.info(`[${location}] Startup reorder cycle posted ${posted.length} prompt(s).`);
    }
  } catch (error) {
    app.logger.error('Failed to start the app', error);
    process.exit(1);
  }
})();
