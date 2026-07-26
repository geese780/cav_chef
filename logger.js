/**
 * Structured logging (FR-18). Emits single-line JSON so logs are
 * grep/query-able by draftId, locationName, or event type end to end,
 * instead of ad-hoc interpolated strings — especially valuable once
 * deployed to Cloud Run (FR-23), where Cloud Logging auto-parses JSON
 * stdout into structured, filterable fields. Scoped to the long-running
 * service's own logging (app.js and the modules it drives); the CLI
 * scripts in scripts/ stay plain console.log — those are human-run
 * interactive tools, not a deployed service's log stream. Bolt's own
 * internal debug logging is a separate concern, controlled via LOG_LEVEL
 * (see app.js), not rewritten here.
 */

function emit(level, message, context) {
  const line = { level, message, timestamp: new Date().toISOString(), ...context };
  const out = level === 'error' || level === 'warn' ? console.error : console.log;
  out(JSON.stringify(line));
}

const logger = {
  debug: (message, context) => emit('debug', message, context),
  info: (message, context) => emit('info', message, context),
  warn: (message, context) => emit('warn', message, context),
  error: (message, context) => emit('error', message, context)
};

module.exports = logger;
