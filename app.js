const { App, LogLevel } = require('@slack/bolt');
const { config } = require('dotenv');

config();

const pendingStore = require('./pendingStore');
const checkinStore = require('./checkinStore');
const { placeOrder, buildIdempotencyKey, getCurrentPrice } = require('./orderingClient');
const { buildResolvedBlocks, buildPriceDriftBlocks, buildCheckinResolvedBlocks } = require('./blockKit');
const { validateStartupConfig } = require('./startupCheck');
const { buildCalendarClient } = require('./googleCalendar');
const { pollDueLocations, leadTimeHours, pollIntervalMinutes } = require('./scheduler');
const { pollCheckins, checkinLeadTimeHours, checkinRepingHours } = require('./checkin');
const { isApprover, allowSelfSecondApproval } = require('./approvers');
const { priceDriftThreshold, evaluateDraftTotal } = require('./budget');

/** CAV Slackbot — inventory reorder approvals (see FEATURE_REQUESTS.md). */
const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  socketMode: true,
  appToken: process.env.SLACK_APP_TOKEN,
  logLevel: LogLevel.DEBUG,
});

/** Approver allowlist (FR-10) — checked before claiming, so an unauthorized
 * click doesn't consume the draft; it stays open for a real approver. */
async function rejectUnlessApprover({ client, channel, byUserId, action }) {
  if (isApprover(byUserId)) return false;

  await client.chat.postEphemeral({
    channel,
    user: byUserId,
    text: `🚫 You're not authorized to ${action} reorders. Ask an admin to add you to APPROVER_ALLOWLIST.`
  });
  return true;
}

/** Places orders for a claimed/second-approved draft's already price-checked
 * items and resolves the message. Shared by the immediate-approve and
 * second-approval-confirmed paths. */
async function placeAndResolve({ client, logger, resolved, byUserId, firstApproverId, deltaTotal }) {
  const orderResults = [];
  for (const { item, qty, currentCharge } of resolved.items) {
    const idempotencyKey = buildIdempotencyKey(resolved.draftId, item.asin);
    const { orderId } = await placeOrder({ item, qty, expectedCharge: currentCharge, idempotencyKey });
    orderResults.push({ orderId });
  }

  await client.chat.update({
    channel: resolved.channel,
    ts: resolved.ts,
    text: `[${resolved.locationName}] Reorder approved: ${resolved.items.length} item(s)`,
    blocks: buildResolvedBlocks({
      draftItems: resolved.items,
      decision: 'approved',
      byUserId,
      orderResults,
      locationName: resolved.locationName,
      firstApproverId,
      deltaTotal
    })
  });

  pendingStore.remove(resolved.draftId);
  logger.info(`[${resolved.locationName}] Approved batch ${resolved.draftId} by ${byUserId} — ${orderResults.length} mock order(s)`);
}

/** FR-11: price-drift guardrail — checks the current price against what was
 * expected when the draft was posted; only escalates to a second approver
 * when the total increase hits PRICE_DRIFT_THRESHOLD (or can't be verified
 * at all), otherwise proceeds on the single click with a note if it crept
 * up but stayed under threshold. */
app.action('approve_reorder', async ({ ack, action, body, client, logger }) => {
  await ack();

  const byUserId = body.user.id;
  const rejected = await rejectUnlessApprover({ client, channel: body.channel.id, byUserId, action: 'approve' });
  if (rejected) return;

  // Peek (not claim yet) to compute drift; flagForSecondApproval/claim below
  // each guard atomically on status, so a stale/duplicate click here still
  // safely no-ops even though this read isn't itself the atomic step.
  const draft = pendingStore.get(action.value);
  if (!draft) return; // unknown/already resolved — no-op

  const pricedItems = draft.items.map(di => ({ ...di, currentCharge: getCurrentPrice({ item: di.item, qty: di.qty }) }));
  const evaluation = evaluateDraftTotal(pricedItems, priceDriftThreshold());

  if (evaluation.requiresSecondApproval) {
    const flagged = pendingStore.flagForSecondApproval(action.value, {
      firstApprover: byUserId,
      items: pricedItems,
      expectedTotal: evaluation.expectedTotal,
      currentTotal: evaluation.currentTotal,
      deltaTotal: evaluation.deltaTotal
    });
    if (!flagged) return; // lost the race (already resolved elsewhere) — no-op

    await client.chat.update({
      channel: draft.channel,
      ts: draft.ts,
      text: `[${draft.locationName}] Reorder needs a second approver`,
      blocks: buildPriceDriftBlocks({
        draftId: action.value,
        draftItems: pricedItems,
        locationName: draft.locationName,
        firstApproverId: byUserId,
        expectedTotal: evaluation.expectedTotal,
        currentTotal: evaluation.currentTotal,
        deltaTotal: evaluation.deltaTotal,
        hasUnknown: evaluation.hasUnknown
      })
    });
    logger.info(
      `[${draft.locationName}] Batch ${action.value} flagged for second approval by ${byUserId} ` +
        `(delta ${evaluation.deltaTotal}, hasUnknown=${evaluation.hasUnknown})`
    );
    return;
  }

  // Atomic claim (FR-07): guards against two concurrent approve_reorder
  // events for the same draft (double-click, redelivered event) both
  // placing orders — only one claim can succeed.
  const claimed = pendingStore.claim(action.value);
  if (!claimed) return; // already resolved, already claimed, or expired — no-op

  await placeAndResolve({
    client,
    logger,
    resolved: { ...claimed, items: pricedItems },
    byUserId,
    deltaTotal: evaluation.deltaTotal
  });
});

/** Second approver confirms a high-drift draft (FR-11) — normally must be a
 * different user than whoever flagged it, enforced atomically in
 * pendingStore.claimSecondApproval. ALLOW_SELF_SECOND_APPROVAL (small-team
 * override, see approvers.js) skips that check without touching the
 * underlying dual-control logic, so it's a one-line flip to re-enable later. */
app.action('confirm_price_drift', async ({ ack, action, body, client, logger }) => {
  await ack();

  const byUserId = body.user.id;
  const rejected = await rejectUnlessApprover({ client, channel: body.channel.id, byUserId, action: 'confirm' });
  if (rejected) return;

  const claimed = pendingStore.claimSecondApproval(action.value, {
    secondApprover: byUserId,
    allowSameUser: allowSelfSecondApproval()
  });
  if (!claimed) {
    const draft = pendingStore.get(action.value);
    if (draft && draft.firstApprover === byUserId) {
      await client.chat.postEphemeral({
        channel: body.channel.id,
        user: byUserId,
        text: `🚫 A different approver than the one who flagged this needs to confirm it.`
      });
    }
    return; // already resolved, or same-user attempt — no-op beyond the message above
  }

  await placeAndResolve({ client, logger, resolved: claimed, byUserId, firstApproverId: claimed.firstApprover });
});

// Denies from either 'pending' or 'awaiting_second_approval' (FR-11) —
// canceling a high-drift order shouldn't require a second approver to show
// up first.
app.action('deny_reorder', async ({ ack, action, body, client, logger }) => {
  await ack();

  const byUserId = body.user.id;
  const rejected = await rejectUnlessApprover({ client, channel: body.channel.id, byUserId, action: 'deny' });
  if (rejected) return;

  const draft = pendingStore.claimForResolution(action.value);
  if (!draft) return; // already resolved, already claimed, or expired — no-op

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
