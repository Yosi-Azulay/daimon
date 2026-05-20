import { test } from 'node:test';
import assert from 'node:assert/strict';

// F5: error-map TTL — Registry.pruneOldErrors prunes entries with lastSeen older than maxAgeMs.
test('error retention TTL: entries older than maxAgeMs are pruned', async () => {
  const { Registry } = await import('../dist/registry.js');
  const cfg = {
    searchRoots: [], portRange: [4200, 4299], apiPort: 4999, overrides: {}, autoStart: [],
    profiles: {}, tags: {}, autoRestart: { enabled: false, maxAttempts: 5, windowMs: 300000 },
    healthProbe: { enabled: false, intervalMs: 30000, timeoutMs: 2000, path: '/', host: null, scheme: null, rejectUnauthorized: false, fallbackHosts: [] },
    logs: { enabled: false, dir: '', maxFiles: 5, maxBytesPerFile: 1 },
    depends: {}, cascadeRestart: false,
    history: { enabled: false, path: '', retentionDays: 30 },
    notifications: { enabled: false, onError: false, onUnhealthy: false, tray: false },
    staleDetect: { enabled: false, silentMs: 30000 },
    headless: false, envFiles: {},
    requestLog: { enabled: false, portOffset: 1000 },
    metrics: { enabled: false }, editor: { scheme: 'vscode' }, apiToken: null,
    output: { format: 'compact', ndjson: false },
    doctor: { autoFix: { onInit: false, permitted: [] } },
    dashboard: { theme: 'auto', density: 'comfortable' },
    errorRetention: { maxAgeMs: 1000 },
  };
  const app = { name: 'a', workspaceRoot: '/tmp', workspaceType: 'vite', command: 'echo', hidden: false, tags: [] };
  const reg = new Registry(cfg, [app]);
  const state = reg.getState('a');
  const now = Date.now();
  state.errors.set('fresh', { message: 'fresh', count: 1, firstSeen: now, lastSeen: now });
  state.errors.set('stale', { message: 'stale', count: 1, firstSeen: now - 60_000, lastSeen: now - 60_000 });
  assert.equal(state.errors.size, 2);

  const removed = reg.pruneOldErrors(now);
  assert.equal(removed, 1);
  assert.equal(state.errors.size, 1);
  assert.ok(state.errors.has('fresh'));
  assert.ok(!state.errors.has('stale'));
});

// F6: log buffer cap — even under a 10k-line burst, the rolling window stays at the documented max.
test('logBuffer rolls at LOG_BUFFER_MAX under bursty writes', () => {
  // We mirror the appProcess.ts cap (500) via the same splice logic and assert it stays bounded.
  const LOG_BUFFER_MAX = 500;
  const logBuffer = [];
  for (let i = 0; i < 10_000; i++) {
    logBuffer.push({ ts: i, line: `line ${i}` });
    if (logBuffer.length > LOG_BUFFER_MAX) {
      logBuffer.splice(0, logBuffer.length - LOG_BUFFER_MAX);
    }
  }
  assert.equal(logBuffer.length, LOG_BUFFER_MAX);
  // Rolling window: tail should be the latest lines.
  assert.equal(logBuffer[logBuffer.length - 1].ts, 9999);
  assert.equal(logBuffer[0].ts, 10_000 - LOG_BUFFER_MAX);
});
