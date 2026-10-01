// Add this to any Express app on the same server to count its requests in the panel.
//
// Copy this file into your app folder, then:
//   const panelTracker = require('./panel-tracker.cjs');      // CommonJS
//   import panelTracker from './panel-tracker.cjs';           // ESM / TypeScript
//   app.use(panelTracker({ app: 'gyannportal-api' }));        // put it near the top
//
// Set PANEL_TOKEN in that app's .env to the same value as INGEST_TOKEN in the panel.
// Needs Node 18+ (uses built-in fetch).

function panelTracker({
  app,
  url = process.env.PANEL_URL || 'http://127.0.0.1:4000/api/ingest',
  token = process.env.PANEL_TOKEN,
  intervalMs = 5000,
} = {}) {
  if (!app) throw new Error('panelTracker: give your app a name, e.g. { app: "gyannportal-api" }');

  let count = 0;
  let errors = 0;
  let totalMs = 0;

  const timer = setInterval(async () => {
    if (!count) return;
    const body = { app, count, errors, totalMs };
    count = 0;
    errors = 0;
    totalMs = 0;
    try {
      await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-panel-token': token || '' },
        body: JSON.stringify(body),
      });
    } catch {
      // Panel is down: skip this batch, never break the app
    }
  }, intervalMs);
  timer.unref();

  return (req, res, next) => {
    const start = process.hrtime.bigint();
    res.on('finish', () => {
      count += 1;
      if (res.statusCode >= 500) errors += 1;
      totalMs += Number(process.hrtime.bigint() - start) / 1e6;
    });
    next();
  };
}

module.exports = panelTracker;
module.exports.default = panelTracker;
