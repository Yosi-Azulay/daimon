// Fixture app for scripts/demo/run-demo.mjs. Serves successfully (same
// readiness shape as demo-web — see that file's comment), then logs one
// deterministic ERROR line that daimon's generic error parser recognizes
// (parser.ts ERROR_PATTERNS: /^\s*ERROR\b/) so `daimon errors demo-broken`
// has something to show. NOTE: matching an ERROR_PATTERNS line always flips
// the app's status to 'error' (parser.ts parseLine, unconditionally, even
// though the process is still up and serving) — so the demo script waits
// for THIS app with `--until error`, not `--until serving`.
const http = require('http');

const port = Number(process.env.PORT);
if (!Number.isFinite(port) || port <= 0) {
  console.error('ERROR: demo-broken did not receive a PORT from daimon');
  process.exit(1);
}

const server = http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/plain' });
  res.end('daimon demo: broken (but serving) ok\n');
});

server.listen(port, '127.0.0.1', () => {
  console.log(`Server running on http://127.0.0.1:${port}`);
  console.log('ERROR: demo-broken lost connection to payments-upstream (ECONNREFUSED 127.0.0.1:9); retrying in background');
});

// Keep the event loop alive; daimon owns the process lifecycle.
setInterval(() => {}, 60_000);
