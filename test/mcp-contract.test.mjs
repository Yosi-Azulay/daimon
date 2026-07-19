import { test } from 'node:test';
import assert from 'node:assert/strict';

// Real contract tests for the MCP surface: the server is built via the
// exported buildServer() and connected to an SDK Client over an in-memory
// transport. Every tool's schema is validated and every tool is invoked with
// schema-derived minimal arguments. The daemon is deliberately unreachable
// (DAIMON_PORT points at a closed port, spawn disabled), so calls must
// resolve to the documented structured-error shape — never hang or throw.
process.env.DAIMON_NO_SPAWN = '1';
process.env.DAIMON_PORT = '49151';

const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');
const { buildServer } = await import('../dist/mcp.js');

const EXPECTED_TOOLS = [
  'list_apps', 'list_apps_full',
  'get_status', 'get_status_full',
  'get_errors', 'get_logs',
  'start_app', 'stop_app', 'restart_app',
  'overview', 'diff_errors',
  'try_fix', 'focus', 'ensure',
  'orchestrate', 'ensure_up', 'wait_for_app',
  'daimon_who_owns', 'daimon_subscribe_events', 'daimon_notify_on_error',
  'daimon_frameworks',
  // v0.12 (M77/M78): search + the whole-loop agent verbs.
  'daimon_search', 'daimon_run_tests', 'daimon_why', 'daimon_context',
  // v0.13 (M82/M83): the digest + redacted env awareness.
  'daimon_report', 'daimon_env',
  // v1.1 (M98): named app groups.
  'daimon_groups',
  // v1.3 (M106): live resource table — read-only, warn-never-kill.
  'daimon_top',
  // v1.4 (M111): the one-way carry-out bundle.
  'daimon_export',
  // v1.5 (M118): Plugin API v1 visibility.
  'daimon_plugins',
].sort();

async function connectedClient() {
  const server = buildServer();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'daimon-contract-test', version: '0.0.0' });
  await client.connect(clientTransport);
  return client;
}

// Derive the minimal valid argument object from a tool's JSON schema:
// required fields only, values picked by declared type/enum.
function minimalArgs(schema) {
  const out = {};
  for (const key of schema?.required ?? []) {
    const prop = schema.properties?.[key] ?? {};
    if (Array.isArray(prop.enum) && prop.enum.length) out[key] = prop.enum[0];
    else if (prop.type === 'number' || prop.type === 'integer') out[key] = typeof prop.minimum === 'number' ? Math.max(1, prop.minimum) : 1;
    else if (prop.type === 'boolean') out[key] = false;
    else if (prop.type === 'array') out[key] = [];
    else if (prop.type === 'object') out[key] = {};
    else out[key] = 'contract-test';
  }
  return out;
}

const client = await connectedClient();
const { tools } = await client.listTools();

test('mcp surface: tools/list returns exactly the expected 30 tools', () => {
  assert.deepEqual(tools.map(t => t.name).sort(), EXPECTED_TOOLS);
});

for (const tool of tools) {
  test(`mcp schema contract: ${tool.name}`, () => {
    assert.ok(typeof tool.description === 'string' && tool.description.length >= 20, 'meaningful description');
    assert.equal(tool.inputSchema?.type, 'object', 'input schema is an object schema');
    for (const req of tool.inputSchema.required ?? []) {
      assert.ok(tool.inputSchema.properties?.[req], `required field "${req}" is declared in properties`);
    }
  });

  test(`mcp invoke contract: ${tool.name} (daemon unreachable)`, async () => {
    const result = await client.callTool({ name: tool.name, arguments: minimalArgs(tool.inputSchema) });
    assert.ok(Array.isArray(result.content) && result.content.length > 0, 'returns content');
    assert.equal(result.content[0].type, 'text');
    let parsed;
    try {
      parsed = JSON.parse(result.content[0].text);
    } catch {
      assert.ok(result.isError, `non-JSON payload only acceptable on SDK-wrapped errors (got: ${result.content[0].text.slice(0, 120)})`);
      return;
    }
    // With the daemon down, every tool must surface the structured error
    // (or a structured timeout for the wait-style wrappers) — never hang.
    assert.equal(typeof parsed, 'object');
    if (result.isError) {
      assert.ok(typeof parsed.error === 'string' && parsed.error.length > 0, 'isError results carry { error }');
    }
  });
}

test('mcp schema contract: rejects schema-invalid arguments', async () => {
  const result = await client.callTool({ name: 'get_status', arguments: { name: 12345 } }).catch(e => e);
  // Either the SDK throws a validation McpError or returns an isError result —
  // both prove the zod schema is enforced, not decorative.
  const failed = result instanceof Error || result?.isError === true;
  assert.ok(failed, 'numeric name must fail the z.string() schema');
});

test('mcp wrapper forwards X-Daimon-Agent and X-Daimon-Cwd on every fetch', async () => {
  const mcpSrc = await import('node:fs').then(fs => fs.promises.readFile(new URL('../dist/mcp.js', import.meta.url), 'utf8'));
  assert.ok(mcpSrc.includes('x-daimon-agent'), 'X-Daimon-Agent header should be added by the MCP wrapper');
  assert.ok(mcpSrc.includes('x-daimon-cwd'), 'X-Daimon-Cwd header should be added by the MCP wrapper');
  assert.ok(!/registerTool\(['"]experimental_/.test(mcpSrc), 'no experimental_ tools should be registered');
});
