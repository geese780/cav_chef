const { App, LogLevel } = require('@slack/bolt');
const { config } = require('dotenv');

config();

const pendingStore = require('./pendingStore');
const { placeOrder, buildIdempotencyKey } = require('./orderingClient');
const { buildResolvedBlocks } = require('./blockKit');
const { validateStartupConfig } = require('./startupCheck');
const { buildCalendarClient } = require('./googleCalendar');
const { pollDueLocations, leadTimeHours, pollIntervalMinutes } = require('./scheduler');

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

  // Atomic claim (FR-07): guards against two concurrent approve_reorder
  // events for the same draft (double-click, redelivered event) both
  // placing orders — only one claim can succeed.
  const draft = pendingStore.claim(action.value);
  if (!draft) return; // already resolved, already claimed, or expired — no-op

  const byUserId = body.user.id;
  const orderResults = [];
  for (const { item, qty, expectedCharge } of draft.items) {
    const idempotencyKey = buildIdempotencyKey(draft.draftId, item.asin);
    const { orderId } = await placeOrder({ item, qty, expectedCharge, idempotencyKey });
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

  const draft = pendingStore.claim(action.value);
  if (!draft) return; // already resolved, already claimed, or expired — no-op

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

    // Calendar-driven trigger (FR-28): poll every location on a fixed cadence
    // and run a cycle only for those whose next booking is within the lead
    // time. Runs in this same process so posted drafts' Approve/Deny buttons
    // resolve. A location with no calendarId set is skipped here entirely —
    // use `npm run run-reorder-cycle` to trigger it manually.
    const calendar = buildCalendarClient();
    const intervalMinutes = pollIntervalMinutes();
    const poll = () =>
      pollDueLocations({ client: app.client, calendar, logger: app.logger }).catch(err =>
        app.logger.error('Calendar poll failed', err)
      );

    await poll();
    setInterval(poll, intervalMinutes * 60 * 1000);
    app.logger.info(`Polling for due locations every ${intervalMinutes}min (${leadTimeHours()}h lead time).`);
  } catch (error) {
    app.logger.error('Failed to start the app', error);
    process.exit(1);
  }
})();
