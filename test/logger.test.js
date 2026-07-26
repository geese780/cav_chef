const test = require('node:test');
const assert = require('node:assert/strict');
const logger = require('../logger');

function captureConsole(method, fn) {
  const original = console[method];
  const lines = [];
  console[method] = (...args) => lines.push(args);
  try {
    fn();
  } finally {
    console[method] = original;
  }
  return lines;
}

test('logger', async t => {
  await t.test('info emits one JSON line on console.log with level/message/timestamp', () => {
    const lines = captureConsole('log', () => logger.info('Posted batch', { draftId: 'd1' }));
    assert.equal(lines.length, 1);
    const parsed = JSON.parse(lines[0][0]);
    assert.equal(parsed.level, 'info');
    assert.equal(parsed.message, 'Posted batch');
    assert.equal(parsed.draftId, 'd1');
    assert.ok(parsed.timestamp);
    assert.doesNotThrow(() => new Date(parsed.timestamp).toISOString());
  });

  await t.test('debug also goes to console.log', () => {
    const lines = captureConsole('log', () => logger.debug('Polling', { intervalMinutes: 60 }));
    assert.equal(lines.length, 1);
    assert.equal(JSON.parse(lines[0][0]).level, 'debug');
  });

  await t.test('warn and error go to console.error, not console.log', () => {
    const logLines = captureConsole('log', () => {
      captureConsole('error', () => {
        logger.warn('careful');
        logger.error('broken');
      });
    });
    assert.equal(logLines.length, 0);
  });

  await t.test('error entries land on console.error with the right level', () => {
    const errorLines = captureConsole('error', () => logger.error('placeOrder failed', { draftId: 'd2' }));
    assert.equal(errorLines.length, 1);
    const parsed = JSON.parse(errorLines[0][0]);
    assert.equal(parsed.level, 'error');
    assert.equal(parsed.draftId, 'd2');
  });

  await t.test('omitting context still produces valid JSON with just level/message/timestamp', () => {
    const lines = captureConsole('log', () => logger.info('no context here'));
    const parsed = JSON.parse(lines[0][0]);
    assert.equal(parsed.message, 'no context here');
    assert.equal(Object.keys(parsed).sort().join(','), 'level,message,timestamp');
  });
});
