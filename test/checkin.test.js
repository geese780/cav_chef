const test = require('node:test');
const assert = require('node:assert/strict');
const {
  decideCheckinAction,
  checkinLeadTimeHours,
  checkinRepingHours,
  DEFAULT_LEAD_TIME_HOURS,
  DEFAULT_REPING_HOURS
} = require('../checkin');

test('decideCheckinAction', async t => {
  const now = new Date('2026-07-25T00:00:00Z');
  const leadTimeHours = 216;
  const repingHours = 24;

  await t.test('none when there is no next booking', () => {
    assert.equal(
      decideCheckinAction({ nextEventStart: undefined, now, leadTimeHours, existing: undefined, repingHours }),
      'none'
    );
  });

  await t.test('none when the booking is beyond the lead time', () => {
    const nextEventStart = new Date(now.getTime() + 300 * 60 * 60 * 1000); // 300h out
    assert.equal(
      decideCheckinAction({ nextEventStart, now, leadTimeHours, existing: undefined, repingHours }),
      'none'
    );
  });

  await t.test('create when the booking enters the lead time and there is no existing record', () => {
    const nextEventStart = new Date(now.getTime() + 200 * 60 * 60 * 1000); // 200h out, within 216h
    assert.equal(
      decideCheckinAction({ nextEventStart, now, leadTimeHours, existing: undefined, repingHours }),
      'create'
    );
  });

  await t.test('create exactly at the lead-time boundary', () => {
    const nextEventStart = new Date(now.getTime() + leadTimeHours * 60 * 60 * 1000);
    assert.equal(
      decideCheckinAction({ nextEventStart, now, leadTimeHours, existing: undefined, repingHours }),
      'create'
    );
  });

  await t.test('wait when an open record was notified recently', () => {
    const nextEventStart = new Date(now.getTime() + 100 * 60 * 60 * 1000);
    const existing = { status: 'open', lastNotifiedAt: now.getTime() - 5 * 60 * 60 * 1000 }; // 5h ago
    assert.equal(decideCheckinAction({ nextEventStart, now, leadTimeHours, existing, repingHours }), 'wait');
  });

  await t.test('reping when an open record is past the reping interval', () => {
    const nextEventStart = new Date(now.getTime() + 100 * 60 * 60 * 1000);
    const existing = { status: 'open', lastNotifiedAt: now.getTime() - 25 * 60 * 60 * 1000 }; // 25h ago
    assert.equal(decideCheckinAction({ nextEventStart, now, leadTimeHours, existing, repingHours }), 'reping');
  });

  await t.test('reping exactly at the reping-interval boundary', () => {
    const nextEventStart = new Date(now.getTime() + 100 * 60 * 60 * 1000);
    const existing = { status: 'open', lastNotifiedAt: now.getTime() - repingHours * 60 * 60 * 1000 };
    assert.equal(decideCheckinAction({ nextEventStart, now, leadTimeHours, existing, repingHours }), 'reping');
  });

  await t.test('none when the record for this exact booking is already acknowledged', () => {
    const nextEventStart = new Date(now.getTime() + 100 * 60 * 60 * 1000);
    const existing = { status: 'acknowledged', lastNotifiedAt: now.getTime() - 1000 * 60 * 60 * 1000 };
    assert.equal(decideCheckinAction({ nextEventStart, now, leadTimeHours, existing, repingHours }), 'none');
  });
});

test('checkinLeadTimeHours', async t => {
  const saved = process.env.CHECKIN_LEAD_TIME_HOURS;
  t.after(() => {
    if (saved === undefined) delete process.env.CHECKIN_LEAD_TIME_HOURS;
    else process.env.CHECKIN_LEAD_TIME_HOURS = saved;
  });

  await t.test('defaults when unset', () => {
    delete process.env.CHECKIN_LEAD_TIME_HOURS;
    assert.equal(checkinLeadTimeHours(), DEFAULT_LEAD_TIME_HOURS);
  });

  await t.test('honors a valid override', () => {
    process.env.CHECKIN_LEAD_TIME_HOURS = '100';
    assert.equal(checkinLeadTimeHours(), 100);
  });
});

test('checkinRepingHours', async t => {
  const saved = process.env.CHECKIN_REPING_HOURS;
  t.after(() => {
    if (saved === undefined) delete process.env.CHECKIN_REPING_HOURS;
    else process.env.CHECKIN_REPING_HOURS = saved;
  });

  await t.test('defaults when unset', () => {
    delete process.env.CHECKIN_REPING_HOURS;
    assert.equal(checkinRepingHours(), DEFAULT_REPING_HOURS);
  });

  await t.test('honors a valid override', () => {
    process.env.CHECKIN_REPING_HOURS = '12';
    assert.equal(checkinRepingHours(), 12);
  });
});
