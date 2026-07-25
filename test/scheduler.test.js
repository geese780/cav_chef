const test = require('node:test');
const assert = require('node:assert/strict');
const {
  shouldTriggerCycle,
  leadTimeHours,
  pollIntervalMinutes,
  DEFAULT_LEAD_TIME_HOURS,
  DEFAULT_POLL_INTERVAL_MINUTES
} = require('../scheduler');

test('shouldTriggerCycle', async t => {
  const now = new Date('2026-07-25T00:00:00Z');

  await t.test('false when there is no next event', () => {
    assert.equal(shouldTriggerCycle({ nextEventStart: undefined, now, leadTimeHours: 48 }), false);
  });

  await t.test('true when the event is already in progress (started in the past)', () => {
    const start = new Date('2026-07-24T12:00:00Z');
    assert.equal(shouldTriggerCycle({ nextEventStart: start, now, leadTimeHours: 48 }), true);
  });

  await t.test('true when the event starts exactly at the lead-time boundary', () => {
    const start = new Date(now.getTime() + 48 * 60 * 60 * 1000);
    assert.equal(shouldTriggerCycle({ nextEventStart: start, now, leadTimeHours: 48 }), true);
  });

  await t.test('true when the event is within the lead time', () => {
    const start = new Date(now.getTime() + 24 * 60 * 60 * 1000);
    assert.equal(shouldTriggerCycle({ nextEventStart: start, now, leadTimeHours: 48 }), true);
  });

  await t.test('false when the event is beyond the lead time', () => {
    const start = new Date(now.getTime() + 72 * 60 * 60 * 1000);
    assert.equal(shouldTriggerCycle({ nextEventStart: start, now, leadTimeHours: 48 }), false);
  });
});

test('leadTimeHours', async t => {
  const saved = process.env.CALENDAR_LEAD_TIME_HOURS;
  t.after(() => {
    if (saved === undefined) delete process.env.CALENDAR_LEAD_TIME_HOURS;
    else process.env.CALENDAR_LEAD_TIME_HOURS = saved;
  });

  await t.test('defaults when unset', () => {
    delete process.env.CALENDAR_LEAD_TIME_HOURS;
    assert.equal(leadTimeHours(), DEFAULT_LEAD_TIME_HOURS);
  });

  await t.test('defaults when non-numeric', () => {
    process.env.CALENDAR_LEAD_TIME_HOURS = 'abc';
    assert.equal(leadTimeHours(), DEFAULT_LEAD_TIME_HOURS);
  });

  await t.test('defaults when zero or negative', () => {
    process.env.CALENDAR_LEAD_TIME_HOURS = '0';
    assert.equal(leadTimeHours(), DEFAULT_LEAD_TIME_HOURS);
    process.env.CALENDAR_LEAD_TIME_HOURS = '-5';
    assert.equal(leadTimeHours(), DEFAULT_LEAD_TIME_HOURS);
  });

  await t.test('honors a valid override', () => {
    process.env.CALENDAR_LEAD_TIME_HOURS = '24';
    assert.equal(leadTimeHours(), 24);
  });
});

test('pollIntervalMinutes', async t => {
  const saved = process.env.CALENDAR_POLL_INTERVAL_MINUTES;
  t.after(() => {
    if (saved === undefined) delete process.env.CALENDAR_POLL_INTERVAL_MINUTES;
    else process.env.CALENDAR_POLL_INTERVAL_MINUTES = saved;
  });

  await t.test('defaults when unset', () => {
    delete process.env.CALENDAR_POLL_INTERVAL_MINUTES;
    assert.equal(pollIntervalMinutes(), DEFAULT_POLL_INTERVAL_MINUTES);
  });

  await t.test('honors a valid override', () => {
    process.env.CALENDAR_POLL_INTERVAL_MINUTES = '15';
    assert.equal(pollIntervalMinutes(), 15);
  });
});
