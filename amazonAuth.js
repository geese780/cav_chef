/**
 * Login with Amazon (LWA) OAuth token exchange + caching for the Amazon
 * Business Ordering API (FR-14/FR-15). UNVERIFIED — built from public docs
 * (https://amazon-business-group-2.readme.io/docs/website-authorization-workflow)
 * with no live credentials to test against yet. Must be verified against a
 * real account before AMAZON_MODE=live ever places a real order.
 */

const { withRetry, isRetryableStatus } = require('./retry');

let cachedToken; // { accessToken, expiresAt } — module-level, one process-wide cache

/** Exchanges the long-lived refresh token for a short-lived access token.
 * Retried on 429/5xx and on the fetch call itself throwing (FR-08) — a
 * missing-credentials config error and a 4xx like invalid_grant are
 * permanent and fail on the first attempt. */
async function fetchAccessToken() {
  const clientId = (process.env.AMAZON_CLIENT_ID || '').trim();
  const clientSecret = (process.env.AMAZON_CLIENT_SECRET || '').trim();
  const refreshToken = (process.env.AMAZON_REFRESH_TOKEN || '').trim();
  if (!clientId || !clientSecret || !refreshToken) {
    throw new Error(
      'AMAZON_CLIENT_ID, AMAZON_CLIENT_SECRET, and AMAZON_REFRESH_TOKEN must all be set for AMAZON_MODE=live'
    );
  }

  return withRetry(
    async () => {
      const res = await fetch('https://api.amazon.com/auth/o2/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'refresh_token',
          refresh_token: refreshToken,
          client_id: clientId,
          client_secret: clientSecret
        })
      });

      if (!res.ok) {
        const err = new Error(`LWA token exchange failed: ${res.status} ${await res.text()}`);
        err.retryable = isRetryableStatus(res.status);
        throw err;
      }

      const body = await res.json();
      return { accessToken: body.access_token, expiresIn: body.expires_in };
    },
    { isRetryable: err => err.retryable !== false }
  );
}

/** Returns a cached access token, refreshing it if missing or within 60s of
 * expiry (FR-15) — avoids exchanging the refresh token on every order call. */
async function getAccessToken() {
  const now = Date.now();
  if (cachedToken && cachedToken.expiresAt > now + 60_000) {
    return cachedToken.accessToken;
  }

  const { accessToken, expiresIn } = await fetchAccessToken();
  cachedToken = { accessToken, expiresAt: now + expiresIn * 1000 };
  return accessToken;
}

/** Test-only: clears the module-level cache between test cases. */
function resetTokenCache() {
  cachedToken = undefined;
}

module.exports = { getAccessToken, resetTokenCache };
