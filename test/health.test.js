const test = require('node:test');
const assert = require('node:assert/strict');
const { startHealthServer, recordPoll, healthPort } = require('../health');

function get(port, path) {
  return new Promise((resolve, reject) => {
    require('node:http')
      .get(`http://127.0.0.1:${port}${path}`, res => {
        let body = '';
        res.on('data', chunk => (body += chunk));
        res.on('end', () => resolve({ status: res.statusCode, body }));
      })
      .on('error', reject);
  });
}

test('health server', async t => {
  const savedPort = process.env.PORT;
  process.env.PORT = '0'; // let the OS pick a free port
  let server;
  t.after(() => {
    if (server) server.close();
    if (savedPort === undefined) delete process.env.PORT;
    else process.env.PORT = savedPort;
  });

  server = startHealthServer();
  const port = server.address().port;

  await t.test('GET /health returns 200 with status ok and a lastPollAt timestamp', async () => {
    const res = await get(port, '/health');
    assert.equal(res.status, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.status, 'ok');
    assert.doesNotThrow(() => new Date(body.lastPollAt).toISOString());
  });

  await t.test('GET / also returns 200 (same health payload)', async () => {
    const res = await get(port, '/');
    assert.equal(res.status, 200);
  });

  await t.test('an unknown path returns 404', async () => {
    const res = await get(port, '/nope');
    assert.equal(res.status, 404);
  });

  await t.test('recordPoll updates lastPollAt reflected in the next /health response', async () => {
    const before = JSON.parse((await get(port, '/health')).body).lastPollAt;
    await new Promise(resolve => setTimeout(resolve, 5));
    recordPoll();
    const after = JSON.parse((await get(port, '/health')).body).lastPollAt;
    assert.notEqual(before, after);
  });
});

test('healthPort', async t => {
  const saved = process.env.PORT;
  t.after(() => {
    if (saved === undefined) delete process.env.PORT;
    else process.env.PORT = saved;
  });

  await t.test('defaults to 8080 when unset', () => {
    delete process.env.PORT;
    assert.equal(healthPort(), 8080);
  });

  await t.test('treats PORT=0 as a real value, not "unset" (0 is falsy in JS)', () => {
    process.env.PORT = '0';
    assert.equal(healthPort(), 0);
  });

  await t.test('honors a real port number, e.g. what Cloud Run injects', () => {
    process.env.PORT = '8081';
    assert.equal(healthPort(), 8081);
  });

  await t.test('defaults on empty or non-numeric values', () => {
    process.env.PORT = '';
    assert.equal(healthPort(), 8080);
    process.env.PORT = 'abc';
    assert.equal(healthPort(), 8080);
  });
});
