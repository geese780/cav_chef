const test = require('node:test');
const assert = require('node:assert/strict');
const { parseApproverAllowlist, isApprover } = require('../approvers');

function withAllowlist(value, fn) {
  const saved = process.env.APPROVER_ALLOWLIST;
  try {
    if (value === undefined) delete process.env.APPROVER_ALLOWLIST;
    else process.env.APPROVER_ALLOWLIST = value;
    fn();
  } finally {
    if (saved === undefined) delete process.env.APPROVER_ALLOWLIST;
    else process.env.APPROVER_ALLOWLIST = saved;
  }
}

test('parseApproverAllowlist', async t => {
  await t.test('throws when unset', () => {
    withAllowlist(undefined, () => {
      assert.throws(() => parseApproverAllowlist(), /APPROVER_ALLOWLIST is not set/);
    });
  });

  await t.test('throws when set but empty', () => {
    withAllowlist('   ', () => {
      assert.throws(() => parseApproverAllowlist(), /APPROVER_ALLOWLIST is not set/);
    });
  });

  await t.test('parses a single user id', () => {
    withAllowlist('U1', () => {
      assert.deepEqual(parseApproverAllowlist(), ['U1']);
    });
  });

  await t.test('parses and trims multiple comma-separated ids', () => {
    withAllowlist(' U1 , U2,U3 ', () => {
      assert.deepEqual(parseApproverAllowlist(), ['U1', 'U2', 'U3']);
    });
  });

  await t.test('filters out empty entries from a trailing comma', () => {
    withAllowlist('U1,U2,', () => {
      assert.deepEqual(parseApproverAllowlist(), ['U1', 'U2']);
    });
  });

  await t.test('throws when only commas/whitespace are present', () => {
    withAllowlist(' , , ', () => {
      assert.throws(() => parseApproverAllowlist(), /contains no user ids/);
    });
  });
});

test('isApprover', async t => {
  await t.test('true for a listed user', () => {
    withAllowlist('U1,U2', () => {
      assert.equal(isApprover('U1'), true);
      assert.equal(isApprover('U2'), true);
    });
  });

  await t.test('false for an unlisted user', () => {
    withAllowlist('U1,U2', () => {
      assert.equal(isApprover('U3'), false);
    });
  });
});
