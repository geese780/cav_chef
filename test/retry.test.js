const test = require('node:test');
const assert = require('node:assert/strict');
const { withRetry, isRetryableStatus, retryCount, retryBaseDelayMs, DEFAULT_RETRIES, DEFAULT_BASE_DELAY_MS } = require('../retry');

function withFastRetryEnv(fn) {
  const saved = { count: process.env.AMAZON_RETRY_COUNT, delay: process.env.AMAZON_RETRY_BASE_DELAY_MS };
  process.env.AMAZON_RETRY_COUNT = '3';
  process.env.AMAZON_RETRY_BASE_DELAY_MS = '1';
  return fn().finally(() => {
    if (saved.count === undefined) delete process.env.AMAZON_RETRY_COUNT;
    else process.env.AMAZON_RETRY_COUNT = saved.count;
    if (saved.delay === undefined) delete process.env.AMAZON_RETRY_BASE_DELAY_MS;
    else process.env.AMAZON_RETRY_BASE_DELAY_MS = saved.delay;
  });
}

test('isRetryableStatus', async t => {
  await t.test('retries 429', () => {
    assert.equal(isRetryableStatus(429), true);
  });

  await t.test('retries any 5xx', () => {
    assert.equal(isRetryableStatus(500), true);
    assert.equal(isRetryableStatus(503), true);
  });

  await t.test('does not retry other 4xx', () => {
    assert.equal(isRetryableStatus(400), false);
    assert.equal(isRetryableStatus(401), false);
    assert.equal(isRetryableStatus(404), false);
  });
});

test('retryCount / retryBaseDelayMs', async t => {
  const saved = { count: process.env.AMAZON_RETRY_COUNT, delay: process.env.AMAZON_RETRY_BASE_DELAY_MS };
  t.after(() => {
    if (saved.count === undefined) delete process.env.AMAZON_RETRY_COUNT;
    else process.env.AMAZON_RETRY_COUNT = saved.count;
    if (saved.delay === undefined) delete process.env.AMAZON_RETRY_BASE_DELAY_MS;
    else process.env.AMAZON_RETRY_BASE_DELAY_MS = saved.delay;
  });

  await t.test('default when unset', () => {
    delete process.env.AMAZON_RETRY_COUNT;
    delete process.env.AMAZON_RETRY_BASE_DELAY_MS;
    assert.equal(retryCount(), DEFAULT_RETRIES);
    assert.equal(retryBaseDelayMs(), DEFAULT_BASE_DELAY_MS);
  });

  await t.test('honors a valid override', () => {
    process.env.AMAZON_RETRY_COUNT = '2';
    process.env.AMAZON_RETRY_BASE_DELAY_MS = '10';
    assert.equal(retryCount(), 2);
    assert.equal(retryBaseDelayMs(), 10);
  });
});

test('withRetry', async t => {
  await t.test('returns the result on the first success without retrying', () =>
    withFastRetryEnv(async () => {
      let calls = 0;
      const result = await withRetry(async () => {
        calls++;
        return 'ok';
      });
      assert.equal(result, 'ok');
      assert.equal(calls, 1);
    })
  );

  await t.test('retries a retryable failure and eventually succeeds', () =>
    withFastRetryEnv(async () => {
      let calls = 0;
      const result = await withRetry(
        async () => {
          calls++;
          if (calls < 3) {
            const err = new Error('transient');
            err.retryable = true;
            throw err;
          }
          return 'ok';
        },
        { isRetryable: err => err.retryable !== false }
      );
      assert.equal(result, 'ok');
      assert.equal(calls, 3);
    })
  );

  await t.test('gives up after exhausting retries', () =>
    withFastRetryEnv(async () => {
      let calls = 0;
      await assert.rejects(
        () =>
          withRetry(async () => {
            calls++;
            throw new Error('always fails');
          }),
        /always fails/
      );
      assert.equal(calls, 4); // 1 initial attempt + 3 retries (AMAZON_RETRY_COUNT=3)
    })
  );

  await t.test('does not retry a non-retryable error at all', () =>
    withFastRetryEnv(async () => {
      let calls = 0;
      await assert.rejects(
        () =>
          withRetry(
            async () => {
              calls++;
              const err = new Error('permanent');
              err.retryable = false;
              throw err;
            },
            { isRetryable: err => err.retryable !== false }
          ),
        /permanent/
      );
      assert.equal(calls, 1);
    })
  );
});
