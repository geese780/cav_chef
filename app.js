const { App, LogLevel } = require('@slack/bolt');
const { config } = require('dotenv');

config();

const pendingStore = require('./pendingStore');
const checkinStore = require('./checkinStore');
const { placeOrder, buildIdempotencyKey, getCurrentPrice } = require('./orderingClient');
const { buildResolvedBlocks, buildPriceDriftBlocks, buildCheckinResolvedBlocks } = require('./blockKit');
const { validateStartupConfig, assertRequiredEnvVars } = require('./startupCheck');
const { buildCalendarClient } = require('./googleCalendar');
const { pollDueLocations, leadTimeHours, pollIntervalMinutes } = require('./scheduler');
const { pollCheckins, checkinLeadTimeHours, checkinRepingHours } = require('./checkin');
const { isApprover, allowSelfSecondApproval } = require('./approvers');
const { priceDriftThreshold, evaluateDraftTotal } = require('./budget');
const auditLog = require('./auditLog');
const appLogger = require('./logger');
const { alertOnFailure } = require('./alerts');
const { startHealthServer, recordPoll } = require('./health');

/** Bolt's own internal logger (its HTTP/socket debug noise) is separate from
 * our structured application logging (FR-18, see logger.js) — this only
 * controls Bolt's verbosity. Defaults to 'info' (DEBUG is very noisy: full
 * request/response bodies for every Slack API call); set LOG_LEVEL=debug to
 * troubleshoot Bolt/Slack-level issues. */
function boltLogLevel() {
  const raw = (process.env.LOG_LEVEL || 'info').trim().toLowerCase();
  const map = { debug: LogLevel.DEBUG, info: LogLevel.INFO, warn: LogLevel.WARN, error: LogLevel.ERROR };
  return map[raw] || LogLevel.INFO;
}

// Bolt's own App constructor throws a much less clear error if
// SLACK_BOT_TOKEN/SLACK_APP_TOKEN are missing, and it does so synchronously
// at module load — before validateStartupConfig() ever runs below. Check
// the required env vars first so a missing/blank .env fails closed with our
// own clear message (FR-01) instead of Bolt's internal one.
try {
  assertRequiredEnvVars();
} catch (error) {
  appLogger.error('Failed to start the app', { error: error.message });
  process.exit(1);
}

/** CAV Slackbot — inventory reorder approvals (see FEATURE_REQUESTS.md). */
const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  socketMode: true,
  appToken: process.env.SLACK_APP_TOKEN,
  logLevel: boltLogLevel(),
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
 * second-approval-confirmed paths. Failed placeOrder calls are alerted
 * (FR-19) and re-thrown — Bolt's own handler wraps this, so the message
 * never silently updates to "approved" if an order actually failed. */
async function placeAndResolve({ client, resolved, byUserId, firstApproverId, deltaTotal }) {
  const orderResults = [];
  for (const { item, qty, currentCharge } of resolved.items) {
    const idempotencyKey = buildIdempotencyKey(resolved.draftId, item.asin);
    try {
      const { orderId } = await placeOrder({ item, qty, expectedCharge: currentCharge, idempotencyKey });
      orderResults.push({ orderId });
    } catch (err) {
      await alertOnFailure(client, 'placeOrder failed', {
        draftId: resolved.draftId,
        locationName: resolved.locationName,
        asin: item.asin,
        error: err.message
      });
      throw err;
    }
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

  auditLog.log('approved', {
    draftId: resolved.draftId,
    locationName: resolved.locationName,
    data: {
      byUserId,
      firstApproverId,
      deltaTotal,
      items: resolved.items.map(({ item, qty, expectedCharge, currentCharge }, i) => ({
        asin: item.asin,
        name: item.name,
        qty,
        expectedCharge,
        actualCharge: currentCharge,
        orderId: orderResults[i] && orderResults[i].orderId
      }))
    }
  });

  appLogger.info('Approved batch', {
    draftId: resolved.draftId,
    locationName: resolved.locationName,
    byUserId,
    orderCount: orderResults.length
  });
}

/** FR-11: price-drift guardrail — checks the current price against what was
 * expected when the draft was posted; only escalates to a second approver
 * when the total increase hits PRICE_DRIFT_THRESHOLD (or can't be verified
 * at all), otherwise proceeds on the single click with a note if it crept
 * up but stayed under threshold. */
app.action('approve_reorder', async ({ ack, action, body, client }) => {
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

    auditLog.log('flagged_second_approval', {
      draftId: action.value,
      locationName: draft.locationName,
      data: {
        byUserId,
        expectedTotal: evaluation.expectedTotal,
        currentTotal: evaluation.currentTotal,
        deltaTotal: evaluation.deltaTotal,
        hasUnknown: evaluation.hasUnknown
      }
    });

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
    appLogger.info('Batch flagged for second approval', {
      draftId: action.value,
      locationName: draft.locationName,
      byUserId,
      deltaTotal: evaluation.deltaTotal,
      hasUnknown: evaluation.hasUnknown
    });
    return;
  }

  // Atomic claim (FR-07): guards against two concurrent approve_reorder
  // events for the same draft (double-click, redelivered event) both
  // placing orders — only one claim can succeed.
  const claimed = pendingStore.claim(action.value);
  if (!claimed) return; // already resolved, already claimed, or expired — no-op

  await placeAndResolve({
    client,
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
app.action('confirm_price_drift', async ({ ack, action, body, client }) => {
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

  await placeAndResolve({ client, resolved: claimed, byUserId, firstApproverId: claimed.firstApprover });
});

// Denies from either 'pending' or 'awaiting_second_approval' (FR-11) —
// canceling a high-drift order shouldn't require a second approver to show
// up first.
app.action('deny_reorder', async ({ ack, action, body, client }) => {
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

  auditLog.log('denied', {
    draftId: draft.draftId,
    locationName: draft.locationName,
    data: {
      byUserId,
      items: draft.items.map(({ item, qty }) => ({ asin: item.asin, name: item.name, qty }))
    }
  });

  appLogger.info('Denied batch', { draftId: draft.draftId, locationName: draft.locationName, byUserId });
});

/** Pre-booking inventory check-in (FR-29) — Done/Confirmed only, no ordering
 * action. Any of the original post or its re-ping messages resolves the same
 * underlying record (all share the same checkinId as the button value). A
 * click on a copy that isn't the one that resolved it still updates *that*
 * message to show the already-acknowledged state, rather than doing nothing —
 * otherwise a user clicking a stale re-ping gets no feedback at all. */
app.action('confirm_checkin', async ({ ack, action, body, client }) => {
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
    appLogger.info('Check-in confirmed', { checkinId: record.checkinId, locationName: record.locationName, byUserId });
  }
});

(async () => {
  try {
    await validateStartupConfig({ client: app.client, logger: appLogger });
    await app.start();
    appLogger.info('CAV_Chef is running');

    // FR-20: health check HTTP server — required by Cloud Run (FR-23), which
    // needs the container to bind to $PORT and respond, or it's considered
    // unhealthy and killed. Also useful for any external uptime monitor.
    startHealthServer();

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
        pollDueLocations({ client: app.client, calendar, logger: appLogger }),
        pollCheckins({ client: app.client, calendar, logger: appLogger })
      ])
        .then(() => recordPoll())
        .catch(async err => {
          appLogger.error('Calendar poll failed', { error: err.message });
          await alertOnFailure(app.client, 'Calendar poll failed', { error: err.message });
        });

    await poll();
    setInterval(poll, intervalMinutes * 60 * 1000);
    appLogger.info('Polling for due locations', {
      intervalMinutes,
      reorderLeadTimeHours: leadTimeHours(),
      checkinLeadTimeHours: checkinLeadTimeHours(),
      checkinRepingHours: checkinRepingHours()
    });
  } catch (error) {
    appLogger.error('Failed to start the app', { error: error.message });
    process.exit(1);
  }
})();

// FR-19: catch anything Bolt's own handlers don't (a thrown error inside an
// app.action callback surfaces here too), so a bug doesn't fail silently.
process.on('unhandledRejection', async err => {
  appLogger.error('Unhandled rejection', { error: err && err.message });
  await alertOnFailure(app.client, 'Unhandled rejection', { error: err && err.message }).catch(() => {});
});
