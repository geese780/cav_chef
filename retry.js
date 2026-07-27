/**
 * Bounded exponential backoff for transient failures (FR-08). Scoped to the
 * Amazon Ordering API's raw fetch() calls (orderingClient.js/amazonAuth.js),
 * which have no retry of their own. Slack needs nothing here: @slack/web-api's
 * WebClient (used everywhere in this app — both Bolt's app.client and every
 * script's own `new WebClient(token)`) already retries automatically on 429s
 * (honoring Retry-After) and transient errors via its own default retry
 * policy (`tenRetriesInAboutThirtyMinutes`, see node_modules/@slack/web-api's
 * retry-policies.js) — nothing in this codebase overrides that default, so
 * every Slack call already gets it for free.
 *
 * Retrying an Amazon order-placement call is only safe because every live
 * call already carries a stable idempotency key (FR-07's
 * buildIdempotencyKey, threaded through as externalId/PurchaseOrderNumber) —
 * a retried placeOrderLive can't double-place on Amazon's side even if the
 * first attempt's response was merely lost to a network blip, not because
 * the order itself failed.
 */

const DEFAULT_RETRIES = 4;
const DEFAULT_BASE_DELAY_MS = 500;

function retryCount() {
  const raw = Number(process.env.AMAZON_RETRY_COUNT);
  return Number.isFinite(raw) && raw >= 0 ? raw : DEFAULT_RETRIES;
}

function retryBaseDelayMs() {
  const raw = Number(process.env.AMAZON_RETRY_BASE_DELAY_MS);
  return Number.isFinite(raw) && raw >= 0 ? raw : DEFAULT_BASE_DELAY_MS;
}

function delayMs(attempt, baseDelayMs) {
  const exponential = baseDelayMs * 2 ** attempt;
  const jitter = Math.random() * baseDelayMs;
  return exponential + jitter;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/** 429 (rate-limited) and 5xx (server-side) are worth retrying; any other
 * 4xx is a permanent request/business problem that retrying won't fix. */
function isRetryableStatus(status) {
  return status === 429 || status >= 500;
}

/**
 * Retries an async operation on transient failure with exponential backoff
 * plus jitter. `isRetryable(error)` decides whether a given thrown error
 * should be retried at all — a permanent error (bad credentials, a rejected
 * order) should fail immediately rather than retry pointlessly up to the
 * bound. Defaults to retrying everything, since a bare network-level throw
 * (DNS failure, connection reset) is exactly the transient case this exists
 * for.
 */
async function withRetry(fn, { isRetryable = () => true } = {}) {
  const retries = retryCount();
  const baseDelayMs = retryBaseDelayMs();

  let attempt = 0;
  for (;;) {
    try {
      return await fn();
    } catch (err) {
      if (attempt >= retries || !isRetryable(err)) throw err;
      await sleep(delayMs(attempt, baseDelayMs));
      attempt += 1;
    }
  }
}

module.exports = { withRetry, isRetryableStatus, retryCount, retryBaseDelayMs, DEFAULT_RETRIES, DEFAULT_BASE_DELAY_MS };
