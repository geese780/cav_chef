const test = require('node:test');
const assert = require('node:assert/strict');
const { getAccessToken, resetTokenCache } = require('../amazonAuth');

const ENV_KEYS = ['AMAZON_CLIENT_ID', 'AMAZON_CLIENT_SECRET', 'AMAZON_REFRESH_TOKEN'];

function withCredentials(fn) {
  const saved = {};
  for (const key of ENV_KEYS) saved[key] = process.env[key];
  process.env.AMAZON_CLIENT_ID = 'client-1';
  process.env.AMAZON_CLIENT_SECRET = 'secret-1';
  process.env.AMAZON_REFRESH_TOKEN = 'refresh-1';
  return fn().finally(() => {
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });
}

function mockFetch(handler) {
  const original = global.fetch;
  global.fetch = handler;
  return () => {
    global.fetch = original;
  };
}

test('getAccessToken (FR-14/15, unverified live path)', async t => {
  t.beforeEach(() => resetTokenCache());

  await t.test('throws naming missing credentials', async () => {
    const saved = {};
    for (const key of ENV_KEYS) {
      saved[key] = process.env[key];
      delete process.env[key];
    }
    try {
      await assert.rejects(() => getAccessToken(), /AMAZON_CLIENT_ID.*AMAZON_CLIENT_SECRET.*AMAZON_REFRESH_TOKEN/);
    } finally {
      for (const key of ENV_KEYS) {
        if (saved[key] !== undefined) process.env[key] = saved[key];
      }
    }
  });

  await t.test('exchanges the refresh token and returns the access token', () =>
    withCredentials(async () => {
      let requestBody;
      const restore = mockFetch(async (url, options) => {
        requestBody = options.body.toString();
        return {
          ok: true,
          json: async () => ({ access_token: 'atoken-1', expires_in: 3600 })
        };
      });
      try {
        const token = await getAccessToken();
        assert.equal(token, 'atoken-1');
        assert.match(requestBody, /grant_type=refresh_token/);
        assert.match(requestBody, /refresh_token=refresh-1/);
        assert.match(requestBody, /client_id=client-1/);
      } finally {
        restore();
      }
    })
  );

  await t.test('caches the token and does not re-fetch while still valid', () =>
    withCredentials(async () => {
      let fetchCount = 0;
      const restore = mockFetch(async () => {
        fetchCount++;
        return { ok: true, json: async () => ({ access_token: 'atoken-1', expires_in: 3600 }) };
      });
      try {
        await getAccessToken();
        await getAccessToken();
        assert.equal(fetchCount, 1);
      } finally {
        restore();
      }
    })
  );

  await t.test('re-fetches once the cached token is within 60s of expiry', () =>
    withCredentials(async () => {
      let fetchCount = 0;
      const restore = mockFetch(async () => {
        fetchCount++;
        // expires_in of 30s is already inside the 60s safety margin, so the
        // very next call should trigger a fresh fetch instead of reusing it.
        return { ok: true, json: async () => ({ access_token: `atoken-${fetchCount}`, expires_in: 30 }) };
      });
      try {
        const first = await getAccessToken();
        const second = await getAccessToken();
        assert.equal(fetchCount, 2);
        assert.notEqual(first, second);
      } finally {
        restore();
      }
    })
  );

  await t.test('throws with the response body when the token exchange fails', () =>
    withCredentials(async () => {
      const restore = mockFetch(async () => ({
        ok: false,
        status: 401,
        text: async () => 'invalid_grant'
      }));
      try {
        await assert.rejects(() => getAccessToken(), /LWA token exchange failed: 401 invalid_grant/);
      } finally {
        restore();
      }
    })
  );

  await t.test('does not retry a permanent 401 (FR-08) — fails on the first attempt', () =>
    withCredentials(async () => {
      let calls = 0;
      const restore = mockFetch(async () => {
        calls++;
        return { ok: false, status: 401, text: async () => 'invalid_grant' };
      });
      try {
        await assert.rejects(() => getAccessToken(), /LWA token exchange failed: 401/);
        assert.equal(calls, 1);
      } finally {
        restore();
      }
    })
  );

  await t.test('retries a transient 503 (FR-08) and succeeds once it clears', () =>
    withCredentials(async () => {
      const savedCount = process.env.AMAZON_RETRY_COUNT;
      const savedDelay = process.env.AMAZON_RETRY_BASE_DELAY_MS;
      process.env.AMAZON_RETRY_COUNT = '3';
      process.env.AMAZON_RETRY_BASE_DELAY_MS = '1';

      let calls = 0;
      const restore = mockFetch(async () => {
        calls++;
        if (calls < 3) return { ok: false, status: 503, text: async () => 'unavailable' };
        return { ok: true, json: async () => ({ access_token: 'atoken-retry', expires_in: 3600 }) };
      });
      try {
        const token = await getAccessToken();
        assert.equal(token, 'atoken-retry');
        assert.equal(calls, 3);
      } finally {
        restore();
        if (savedCount === undefined) delete process.env.AMAZON_RETRY_COUNT;
        else process.env.AMAZON_RETRY_COUNT = savedCount;
        if (savedDelay === undefined) delete process.env.AMAZON_RETRY_BASE_DELAY_MS;
        else process.env.AMAZON_RETRY_BASE_DELAY_MS = savedDelay;
      }
    })
  );
});
