/**
 * Health check HTTP server (FR-20). Required infrastructure for Cloud Run
 * (FR-23) — Cloud Run expects a container to listen on $PORT and respond, or
 * it's considered unhealthy and never marked ready / gets killed. Also
 * usable by any external uptime monitor pointed at this endpoint.
 */

const http = require('node:http');

let lastPollAt = Date.now();

/** Called after each poll tick completes, so /health reflects whether the
 * poll loop is actually still alive, not just that the process hasn't
 * crashed outright. */
function recordPoll() {
  lastPollAt = Date.now();
}

/** PORT=0 is a legitimate value (OS assigns a free port — used by tests),
 * not "unset"; only a truly missing/empty/non-numeric PORT falls back to
 * the default. `Number(process.env.PORT) || 8080` would be wrong here since
 * 0 is falsy in JS. */
function healthPort() {
  const raw = (process.env.PORT || '').trim();
  if (raw === '') return 8080;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : 8080;
}

function startHealthServer() {
  const port = healthPort();

  const server = http.createServer((req, res) => {
    if (req.url !== '/health' && req.url !== '/') {
      res.writeHead(404);
      res.end();
      return;
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', lastPollAt: new Date(lastPollAt).toISOString() }));
  });

  server.listen(port);
  return server;
}

module.exports = { startHealthServer, recordPoll, healthPort };
