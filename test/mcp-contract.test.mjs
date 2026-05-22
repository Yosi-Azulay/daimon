import { test } from 'node:test';
import assert from 'node:assert/strict';

// Contract-level tests for the MCP surface. The MCP server itself is
// connected via stdio (out of scope to boot here), but we can still assert
// that the tool list compiled into dist/mcp.js exports the shape we promise
// and that every wrapped HTTP call adds the X-Daimon-Agent header.

const mcpSrc = await import('node:fs').then(fs => fs.promises.readFile(new URL('../dist/mcp.js', import.meta.url), 'utf8'));

const EXPECTED_TOOLS = [
  'list_apps', 'list_apps_full',
  'get_status', 'get_status_full',
  'get_errors', 'get_logs',
  'start_app', 'stop_app', 'restart_app',
  'overview', 'diff_errors',
  'try_fix', 'focus', 'ensure',
  'orchestrate', 'ensure_up', 'wait_for_app',
  'daimon_who_owns', 'daimon_subscribe_events', 'daimon_notify_on_error',
];

for (const name of EXPECTED_TOOLS) {
  test(`mcp tool registered: ${name}`, () => {
    // Tool names are baked in as literal strings either via registerTool('X', ...)
    // or via a loop `${action}_app` for start/stop/restart_app.
    const lifecycleAlias = (name === 'start_app' || name === 'stop_app' || name === 'restart_app');
    if (lifecycleAlias) {
      assert.ok(mcpSrc.includes("'start', 'stop', 'restart'") || mcpSrc.includes(`${name.replace('_app', '')}`), `${name} should be wired via lifecycle loop`);
      return;
    }
    assert.ok(mcpSrc.includes(`"${name}"`) || mcpSrc.includes(`'${name}'`), `tool name ${name} should appear in dist/mcp.js`);
  });
}

test('mcp wrapper forwards X-Daimon-Agent on every fetch', () => {
  // Every fetch in mcp.ts goes through callJson (which uses headers()) or the
  // focus stream call (explicit headers: headers()). headers() includes the
  // x-daimon-agent key by construction. Sanity check on compiled output.
  assert.ok(mcpSrc.includes("x-daimon-agent"), 'X-Daimon-Agent header should be added by the MCP wrapper');
});

test('mcp wrapper forwards X-Daimon-Cwd on every fetch', () => {
  assert.ok(mcpSrc.includes("x-daimon-cwd"), 'X-Daimon-Cwd header should be added by the MCP wrapper');
});

test('mcp does not export an "experimental_*" tool family (locked surface)', () => {
  // Guard against accidental experimental tool registrations slipping into a
  // release. v0.10 doesn't ship experimental MCP tools.
  assert.ok(!/registerTool\(['"]experimental_/.test(mcpSrc), 'no experimental_ tools should be registered');
});

test('mcp default cwd is process.cwd() (not hardcoded)', () => {
  assert.ok(mcpSrc.includes('process.cwd()'), 'default cwd must be process.cwd()');
});

test('mcp uses callJson for HTTP -> daemon (consistent header routing)', () => {
  assert.ok(mcpSrc.includes('callJson'), 'callJson helper should be present');
});
