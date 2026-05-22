#!/usr/bin/env node
// Generates docs/index.html from the live CLI surface + MCP tool list. No JS
// framework — single self-contained HTML page so GitHub Pages can serve it
// straight from the docs/ folder.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');

import { pathToFileURL } from 'node:url';
const { CLI_SUBCOMMANDS, CLI_GROUPS } = await import(pathToFileURL(path.resolve(repoRoot, 'dist/cliSurface.js')).href);
const { DAIMON_VERSION } = await import(pathToFileURL(path.resolve(repoRoot, 'dist/version.js')).href);

function esc(s = '') {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function renderCli() {
  const byGroup = new Map();
  for (const g of CLI_GROUPS) byGroup.set(g.id, []);
  for (const c of CLI_SUBCOMMANDS) {
    const arr = byGroup.get(c.group) ?? [];
    arr.push(c);
    byGroup.set(c.group, arr);
  }
  const out = [];
  for (const g of CLI_GROUPS) {
    const items = byGroup.get(g.id) ?? [];
    if (!items.length) continue;
    out.push(`<h3>${esc(g.title)}</h3>`);
    out.push('<dl class="cli-grid">');
    for (const c of items) {
      out.push(`<dt><code>daimon ${esc(c.name)} ${esc(c.args || '')}</code></dt>`);
      out.push(`<dd>${esc(c.summary)}</dd>`);
    }
    out.push('</dl>');
  }
  return out.join('\n');
}

// MCP tools — pulled by name from mcp.ts since the SDK doesn't expose a static
// list. Keep this aligned with src/mcp.ts when adding new tools.
const MCP_TOOLS = [
  ['list_apps', 'Compact list of apps (name/status/port/health/errCount/lastChangeMs).'],
  ['list_apps_full', 'Verbose v0.4-shape list.'],
  ['get_status', 'Compact status for one app.'],
  ['get_status_full', 'Verbose status for one app.'],
  ['get_errors', 'Errors for an app — supports --since, --since-last, --level.'],
  ['get_logs', 'Recent log lines for an app.'],
  ['start_app / stop_app / restart_app', 'Lifecycle verbs with cwd-scoped name resolution.'],
  ['overview', 'Decision-ready snapshot for first-call agent sessions.'],
  ['diff_errors', 'Errors since last call (per-client cursor).'],
  ['try_fix', 'Run permitted auto-fixes, restart, wait for target.'],
  ['focus', 'Subscribe-then-act stream of status/error events.'],
  ['ensure', 'One-call lifecycle: start if needed, wait for target.'],
  ['orchestrate', 'Bring up a whole profile; one round of try-fix on stragglers.'],
  ['ensure_up', 'Cascade-start a profile, wait until each app is healthy.'],
  ['wait_for_app', 'Block until app reaches a target state.'],
  ['daimon_who_owns', 'Lock holder + last 3 agent interactions for an app.'],
  ['daimon_subscribe_events', 'Long-poll new events filtered by kind.'],
  ['daimon_notify_on_error', 'Block until next error-new event (or timeout).'],
];

function renderMcp() {
  const out = ['<dl class="cli-grid">'];
  for (const [name, desc] of MCP_TOOLS) {
    out.push(`<dt><code>${esc(name)}</code></dt><dd>${esc(desc)}</dd>`);
  }
  out.push('</dl>');
  return out.join('\n');
}

const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>daimon v${DAIMON_VERSION} — docs</title>
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="description" content="daimon — local dev-server manager for Angular/Nx/Vite/Storybook with TUI, HTTP API, CLI, and MCP server." />
<style>
  :root { --fg: #0f172a; --muted: #475569; --accent: #2563eb; --code-bg: #f1f5f9; --hr: #e2e8f0; }
  @media (prefers-color-scheme: dark) {
    :root { --fg: #e2e8f0; --muted: #94a3b8; --accent: #60a5fa; --code-bg: #1e293b; --hr: #334155; }
    body { background: #0f172a; }
  }
  html, body { color: var(--fg); font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; line-height: 1.55; }
  body { max-width: 920px; margin: 0 auto; padding: 2rem 1rem; }
  h1 { font-size: 2rem; margin: 0 0 0.25rem; }
  h2 { margin-top: 2.5rem; padding-bottom: 0.25rem; border-bottom: 1px solid var(--hr); }
  h3 { margin-top: 1.5rem; color: var(--accent); }
  code { background: var(--code-bg); padding: 1px 6px; border-radius: 4px; font-size: 0.92em; }
  pre code { display: block; padding: 0.75rem 1rem; overflow-x: auto; }
  .lede { color: var(--muted); font-size: 1.1rem; }
  .cli-grid { display: grid; grid-template-columns: minmax(220px, max-content) 1fr; gap: 0.25rem 1rem; margin: 0.5rem 0 1.5rem; }
  .cli-grid dt { font-weight: 400; }
  .cli-grid dd { margin: 0; color: var(--muted); }
  nav.toc { background: var(--code-bg); padding: 0.5rem 1.25rem; border-radius: 6px; margin: 1.5rem 0; }
  nav.toc ul { padding-left: 1.25rem; margin: 0.25rem 0; }
  hr { border: 0; border-top: 1px solid var(--hr); margin: 2rem 0; }
  a { color: var(--accent); }
  .badge { display: inline-block; background: var(--code-bg); padding: 2px 8px; border-radius: 10px; font-size: 0.8em; color: var(--muted); }
</style>
</head>
<body>

<h1>daimon <span class="badge">v${DAIMON_VERSION}</span></h1>
<p class="lede">Local dev-server manager for Angular / Nx / Vite / Storybook (+ polyglot) with a TUI, a 127.0.0.1 HTTP API, a JSON CLI, and an MCP server for Claude Code.</p>

<nav class="toc">
  <strong>Contents</strong>
  <ul>
    <li><a href="#install">Install</a></li>
    <li><a href="#quickstart">Quickstart (3 min)</a></li>
    <li><a href="#cli">CLI reference</a></li>
    <li><a href="#mcp">MCP reference</a></li>
    <li><a href="#config">Config reference</a></li>
    <li><a href="#faq">FAQ</a></li>
  </ul>
</nav>

<h2 id="install">Install</h2>
<pre><code>npm install -g daimon
# or
npx daimon init --auto</code></pre>

<h2 id="quickstart">Quickstart (3 min)</h2>
<ol>
  <li>Run <code>daimon init --auto</code> in a workspace that has <code>nx.json</code> / <code>angular.json</code> / <code>vite.config.*</code> / <code>.storybook</code> / <code>manage.py</code> / <code>Gemfile</code>.</li>
  <li>Run <code>daimon list</code> to see discovered apps.</li>
  <li>Run <code>daimon start &lt;app&gt;</code> (or <code>daimon up &lt;profile&gt;</code> for the whole stack).</li>
  <li>Open the dashboard: <code>daimon dashboard</code>.</li>
</ol>

<h2 id="cli">CLI reference</h2>
${renderCli()}

<h2 id="mcp">MCP reference</h2>
<p>Daimon's MCP server is installed via <code>daimon claude install --all</code>. It exposes the verbs below over stdio so Claude Code can call them.</p>
${renderMcp()}

<h2 id="config">Config reference</h2>
<p>The full annotated schema lives in <code>daimon.config.example.json</code>. Highlights:</p>
<ul>
  <li><code>searchRoots</code> — array of paths (or <code>{path, label}</code>) to scan for projects.</li>
  <li><code>autoStart</code> — apps to start when the daemon launches.</li>
  <li><code>profiles</code> — named sets of apps for <code>daimon up &lt;profile&gt;</code> / <code>daimon ci start &lt;profile&gt;</code>.</li>
  <li><code>healthProbe</code> — toggle and shape the per-app health probe.</li>
  <li><code>webhooks</code> — outbound notifications for error / regression / status events.</li>
  <li><code>history</code> — SQLite retention controls.</li>
</ul>

<h2 id="faq">FAQ</h2>
<dl>
  <dt><strong>Does daimon edit my code?</strong></dt>
  <dd>No. Daimon only touches <code>~/.daimon/*</code> and (if you opt in) the local <code>daimon.config.json</code>. <code>daimon doctor --auto-fix</code> repairs daemon state, never source.</dd>
  <dt><strong>Is it safe to run two Claudes against one daemon?</strong></dt>
  <dd>Yes — every CLI call sends an <code>X-Daimon-Agent</code> header and the daemon enforces a 30-second per-app soft-lock so two agents don't fight. Pass <code>--steal</code> to override.</dd>
  <dt><strong>How do I get a notification when an app errors?</strong></dt>
  <dd>Configure a <code>webhooks</code> entry pointing at Slack/Discord, or call <code>daimon_notify_on_error</code> from MCP.</dd>
  <dt><strong>Can I use daimon in CI?</strong></dt>
  <dd>Yes — <code>daimon ci start &lt;profile&gt; --until ready --timeout 5m --json</code> returns a structured report and exits 2 on timeout. See <code>docs/ci-integration.md</code>.</dd>
</dl>

<hr />
<footer>
  <p class="lede">© Yosi Azulay · <a href="https://flycotech.com">flycotech.com</a> · PolyForm Noncommercial 1.0.0</p>
</footer>

</body>
</html>
`;

const outPath = path.join(repoRoot, 'docs', 'index.html');
fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, html, 'utf8');
console.log(`[build-docs] wrote ${outPath} (${html.length} bytes)`);
