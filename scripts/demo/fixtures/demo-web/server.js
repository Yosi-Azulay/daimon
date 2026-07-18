// Fixture app for scripts/demo/run-demo.mjs. Plain node http server: binds
// the port daimon injects via PORT (legacy port-injection, see
// registry.ts/appProcess.ts) and announces readiness in a shape daimon's
// generic parser recognizes — parser.ts SERVING_PATTERNS matches
// /running on http/i (there is no generic "listening on" rule; readiness
// patterns are deliberately tight per-framework banners plus a handful of
// generic ones).
const http = require('http');

const port = Number(process.env.PORT);
if (!Number.isFinite(port) || port <= 0) {
  console.error('ERROR: demo-web did not receive a PORT from daimon');
  process.exit(1);
}

const server = http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/plain' });
  res.end('daimon demo: web ok\n');
});

server.listen(port, '127.0.0.1', () => {
  console.log(`Server running on http://127.0.0.1:${port}`);
});

// Keep the event loop alive; daimon owns the process lifecycle.
setInterval(() => {}, 60_000);
