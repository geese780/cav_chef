const { App, LogLevel } = require('@slack/bolt');
const { config } = require('dotenv');

config();

const pendingStore = require('./pendingStore');
const checkinStore = require('./checkinStore');
const { placeOrder, buildIdempotencyKey } = require('./orderingClient');
const { buildResolvedBlocks, buildCheckinResolvedBlocks } = require('./blockKit');
const { validateStartupConfig } = require('./startupCheck');
const { buildCalendarClient } = require('./googleCalendar');
const { pollDueLocations, leadTimeHours, pollIntervalMinutes } = require('./scheduler');
const { pollCheckins, checkinLeadTimeHours, checkinRepingHours } = require('./checkin');

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

/** Pre-booking inventory check-in (FR-29) — Done/Confirmed only, no ordering
 * action. Any of the original post or its re-ping messages resolves the same
 * underlying record (all share the same checkinId as the button value). A
 * click on a copy that isn't the one that resolved it still updates *that*
 * message to show the already-acknowledged state, rather than doing nothing —
 * otherwise a user clicking a stale re-ping gets no feedback at all. */
app.action('confirm_checkin', async ({ ack, action, body, client, logger }) => {
  await ack();

  const byUserId = body.user.id;
  const claimed = checkinStore.claim(action.value, { byUserId, now: Date.now() });
  const record = claimed || checkinStore.get(action.value);
  if (!record) return; // unknown checkinId — no-op

  await client.chat.update({
    channel: body.channel.id,
    ts: body.message.ts,
    text: `[${record.locationName}] Inventory check-in confirmed`,
    blocks: buildCheckinResolvedBlocks({
      locationName: record.locationName,
      bookingStart: new Date(record.bookingStart),
      byUserId: record.acknowledgedBy || byUserId
    })
  });

  if (claimed) {
    logger.info(`[${record.locationName}] Check-in ${record.checkinId} confirmed by ${byUserId}`);
  }
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
    // Pre-booking inventory check-in (FR-29): same calendar/poll cadence, a
    // separate 216h-out heads-up that re-pings every 24h until Done is
    // clicked — independent of the 48h auto-reorder trigger above.
    const calendar = buildCalendarClient();
    const intervalMinutes = pollIntervalMinutes();
    const poll = () =>
      Promise.all([
        pollDueLocations({ client: app.client, calendar, logger: app.logger }),
        pollCheckins({ client: app.client, calendar, logger: app.logger })
      ]).catch(err => app.logger.error('Calendar poll failed', err));

    await poll();
    setInterval(poll, intervalMinutes * 60 * 1000);
    app.logger.info(
      `Polling every ${intervalMinutes}min — reorder lead time ${leadTimeHours()}h, ` +
        `check-in lead time ${checkinLeadTimeHours()}h (re-ping every ${checkinRepingHours()}h).`
    );
  } catch (error) {
    app.logger.error('Failed to start the app', error);
    process.exit(1);
  }
})();
