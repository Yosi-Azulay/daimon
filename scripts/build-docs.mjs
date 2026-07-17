#!/usr/bin/env node
// Generates docs/index.html from the live surface catalogs. No JS framework —
// single self-contained HTML page so GitHub Pages can serve it straight from
// the docs/ folder. Every surface (CLI verb, HTTP endpoint, MCP tool, config
// key, event kind) renders with its stability tier (M87) — the tier data comes
// from each surface's source of truth, never from a hand-maintained copy here.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const dist = p => pathToFileURL(path.resolve(repoRoot, 'dist', p)).href;

const { CLI_SUBCOMMANDS, CLI_GROUPS } = await import(dist('cliSurface.js'));
const { DAIMON_VERSION } = await import(dist('version.js'));
const { HTTP_ENDPOINTS } = await import(dist('httpSurface.js'));
const { MCP_TOOL_STABILITY } = await import(dist('mcp.js'));
const { CONFIG_KEY_STABILITY } = await import(dist('config.js'));
const { EVENT_KIND_STABILITY } = await import(dist('types.js'));
const { DOCTOR_COVERAGE } = await import(dist('doctor.js'));

function esc(s = '') {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function tierBadge(tier) {
  return `<span class="tier tier-${esc(tier)}" title="${esc(tier)} — see STABILITY.md">${esc(tier)}</span>`;
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
      out.push(`<dt><code>daimon ${esc(c.name)} ${esc(c.args || '')}</code> ${tierBadge(c.stability)}</dt>`);
      out.push(`<dd>${esc(c.summary)}</dd>`);
    }
    out.push('</dl>');
  }
  return out.join('\n');
}

function renderHttp() {
  const out = ['<dl class="cli-grid">'];
  for (const e of HTTP_ENDPOINTS) {
    out.push(`<dt><code>${esc(e.method)} ${esc(e.path)}</code> ${tierBadge(e.stability)}</dt>`);
    out.push(`<dd>${esc(e.summary)}</dd>`);
  }
  out.push('</dl>');
  return out.join('\n');
}

// MCP tool descriptions live here (doc-facing prose); the NAME list and tiers
// come from src/mcp.ts's catalog. A tool without a description fails the build
// so the docs can't silently lag the surface.
const MCP_DESCRIPTIONS = {
  list_apps: 'Compact list of apps (name/status/port/health/errCount/lastChangeMs).',
  list_apps_full: 'Verbose v0.4-shape list.',
  get_status: 'Compact status for one app.',
  get_status_full: 'Verbose status for one app.',
  get_errors: 'Errors for an app — supports --since, --since-last, --level.',
  get_logs: 'Recent log lines for an app.',
  start_app: 'Start an app (cwd-scoped name resolution, soft-lock gated).',
  stop_app: 'Stop an app (soft-lock gated); a name matching only a v1.1 group stops the group.',
  restart_app: 'Restart an app (soft-lock gated).',
  overview: 'Decision-ready snapshot for first-call agent sessions.',
  diff_errors: 'Errors since last call (per-client cursor).',
  try_fix: 'Run permitted auto-fixes, restart, wait for target.',
  focus: 'Subscribe-then-act stream of status/error events.',
  ensure: 'One-call lifecycle: start if needed, wait for target.',
  orchestrate: 'Bring up a whole profile; one round of try-fix on stragglers.',
  ensure_up: 'Cascade-start a group (v1.1, depends-aware, readiness summary) or legacy profile; groups resolve first.',
  wait_for_app: 'Block until app reaches a target state.',
  daimon_who_owns: 'Lock holder + last 3 agent interactions for an app.',
  daimon_subscribe_events: 'Long-poll new events filtered by kind.',
  daimon_notify_on_error: 'Block until next error-new event (or timeout).',
  daimon_frameworks: 'List the framework adapter registry: built-in + custom profiles, match counts, badges.',
  daimon_context: 'The agent context pack: status, error groups, last crash, last test run, compile stats, suspect commits, locks — one call. Budgetable.',
  daimon_run_tests: "Run the app's own test suite once; parsed failures with file:line + totals. Soft-lock gated.",
  daimon_why: 'Crash forensics: last crash report, grouped errors, regressions, restart-storm state, suspect commit, doctor findings.',
  daimon_search: 'Full-text search over log lines, errors, and events (FTS5 with LIKE fallback).',
  daimon_report: 'The digest: uptime, errors (new/recurring/resolved), test pass-rate + flakiest, compile p50/p95 + regressions, crashes/storms, agents, env changes.',
  daimon_env: 'Read-only env awareness: convention files, key NAMES, snapshot age; diff=true compares the last two spawns. Values never included.',
  daimon_groups: 'Named app groups (v1.1): apps, autoStart, status counts, healthy/total per group.',
};

function renderMcp() {
  const out = ['<dl class="cli-grid">'];
  for (const [name, tier] of Object.entries(MCP_TOOL_STABILITY)) {
    const desc = MCP_DESCRIPTIONS[name];
    if (!desc) throw new Error(`[build-docs] MCP tool "${name}" has no description — add one to MCP_DESCRIPTIONS`);
    out.push(`<dt><code>${esc(name)}</code> ${tierBadge(tier)}</dt><dd>${esc(desc)}</dd>`);
  }
  for (const name of Object.keys(MCP_DESCRIPTIONS)) {
    if (!(name in MCP_TOOL_STABILITY)) throw new Error(`[build-docs] MCP_DESCRIPTIONS has "${name}" but src/mcp.ts's catalog does not`);
  }
  out.push('</dl>');
  return out.join('\n');
}

function renderConfigKeys() {
  const out = ['<dl class="cli-grid">'];
  for (const [key, tier] of Object.entries(CONFIG_KEY_STABILITY)) {
    out.push(`<dt><code>${esc(key)}</code> ${tierBadge(tier)}</dt><dd></dd>`);
  }
  out.push('</dl>');
  return out.join('\n');
}

function renderEventKinds() {
  const out = ['<dl class="cli-grid">'];
  for (const [kind, tier] of Object.entries(EVENT_KIND_STABILITY)) {
    out.push(`<dt><code>${esc(kind)}</code> ${tierBadge(tier)}</dt><dd></dd>`);
  }
  out.push('</dl>');
  return out.join('\n');
}

// Inline code spans in coverage prose: `x` → <code>x</code> (esc() first).
function mdCode(s) {
  return esc(s).replace(/`([^`]+)`/g, '<code>$1</code>');
}

function renderDoctorCoverage() {
  const label = { rule: 'doctor rule', 'auto-fix': 'auto-fix', 'built-in': 'built-in', gap: 'by design: no rule' };
  const out = ['<table class="coverage"><thead><tr><th>Failure class</th><th>Covered by</th><th>How</th></tr></thead><tbody>'];
  for (const row of DOCTOR_COVERAGE) {
    out.push(`<tr><td>${esc(row.failure)}</td><td><span class="cov cov-${esc(row.kind)}">${esc(label[row.kind])}</span></td><td>${mdCode(row.coverage)}</td></tr>`);
  }
  out.push('</tbody></table>');
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
  :root { --fg: #0f172a; --muted: #475569; --accent: #2563eb; --code-bg: #f1f5f9; --hr: #e2e8f0;
          --tier-frozen-bg: #dbeafe; --tier-frozen-fg: #1e40af;
          --tier-stable-bg: #dcfce7; --tier-stable-fg: #166534;
          --tier-exp-bg: #fef3c7; --tier-exp-fg: #92400e; }
  @media (prefers-color-scheme: dark) {
    :root { --fg: #e2e8f0; --muted: #94a3b8; --accent: #60a5fa; --code-bg: #1e293b; --hr: #334155;
            --tier-frozen-bg: #1e3a8a; --tier-frozen-fg: #bfdbfe;
            --tier-stable-bg: #14532d; --tier-stable-fg: #bbf7d0;
            --tier-exp-bg: #78350f; --tier-exp-fg: #fde68a; }
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
  .tier { display: inline-block; padding: 1px 7px; border-radius: 9px; font-size: 0.72em; font-weight: 600; vertical-align: 1px; letter-spacing: 0.02em; }
  .tier-frozen { background: var(--tier-frozen-bg); color: var(--tier-frozen-fg); }
  .tier-stable { background: var(--tier-stable-bg); color: var(--tier-stable-fg); }
  .tier-experimental { background: var(--tier-exp-bg); color: var(--tier-exp-fg); }
  table.coverage { border-collapse: collapse; width: 100%; font-size: 0.92em; }
  table.coverage th, table.coverage td { text-align: left; padding: 6px 10px; border-bottom: 1px solid var(--hr); vertical-align: top; }
  .cov { white-space: nowrap; font-size: 0.85em; font-weight: 600; }
  .cov-rule, .cov-auto-fix { color: var(--tier-stable-fg); }
  .cov-built-in { color: var(--tier-frozen-fg); }
  .cov-gap { color: var(--tier-exp-fg); }
</style>
</head>
<body>

<h1>daimon <span class="badge">v${DAIMON_VERSION}</span></h1>
<p class="lede">Local dev-server manager for 20+ frameworks — Angular / Nx / Next.js / Vite / Django / Rails / .NET / Flutter and more — with a TUI, a 127.0.0.1 HTTP API, a JSON CLI, and an MCP server for Claude Code.</p>

<nav class="toc">
  <strong>Contents</strong>
  <ul>
    <li><a href="#install">Install</a></li>
    <li><a href="#quickstart">Quickstart (3 min)</a></li>
    <li><a href="#stability">Stability tiers</a></li>
    <li><a href="#cli">CLI reference</a></li>
    <li><a href="#http">HTTP API reference</a></li>
    <li><a href="#mcp">MCP reference</a></li>
    <li><a href="#config">Config reference</a></li>
    <li><a href="#events">Event kinds</a></li>
    <li><a href="#doctor">Doctor coverage</a></li>
    <li><a href="#faq">FAQ</a></li>
  </ul>
</nav>

<h2 id="install">Install</h2>
<pre><code>npm install -g daimon
# or
npx daimon init --auto</code></pre>

<h2 id="quickstart">Quickstart (3 min)</h2>
<ol>
  <li>Run <code>daimon init --auto</code> in a workspace with any supported framework marker — <code>nx.json</code>, <code>angular.json</code>, <code>next.config.*</code>, <code>vite.config.*</code>, <code>manage.py</code>, <code>Gemfile</code>, a <code>*.csproj</code>, <code>pubspec.yaml</code>, or just a <code>package.json</code> with a <code>dev</code> script. Run <code>daimon frameworks</code> to see the full registry.</li>
  <li>Run <code>daimon list</code> to see discovered apps.</li>
  <li>Run <code>daimon start &lt;app&gt;</code> (or <code>daimon up &lt;profile&gt;</code> for the whole stack).</li>
  <li>Open the dashboard: <code>daimon dashboard</code>.</li>
</ol>

<h2 id="stability">Stability tiers</h2>
<p>Every surface below carries a tier (full contract in <a href="https://github.com/Yosi-Azulay/daimon/blob/main/STABILITY.md">STABILITY.md</a>):</p>
<ul>
  <li>${tierBadge('frozen')} — the shape never breaks; changes are additive only. Guarded by golden-shape contract tests.</li>
  <li>${tierBadge('stable')} — breaks only with a major version bump and a migration note.</li>
  <li>${tierBadge('experimental')} — may change in any release (the v0.13 surfaces: report, env, ports, notifications, digest).</li>
</ul>
<p>Config files are a special case: <em>any</em> config that ever loaded keeps loading, regardless of tier — unknown or legacy keys warn, never fail.</p>

<h2 id="cli">CLI reference</h2>
${renderCli()}

<h2 id="http">HTTP API reference</h2>
<p>Loopback only — the daemon binds <code>127.0.0.1:&lt;apiPort&gt;</code> (default 4999) and rejects cross-origin mutation. <code>:name</code> takes an app name (add <code>?cwd=</code> to disambiguate across workspaces).</p>
${renderHttp()}

<h2 id="mcp">MCP reference</h2>
<p>Daimon's MCP server is installed via <code>daimon claude install --all</code>. It exposes the verbs below over stdio so Claude Code can call them.</p>
${renderMcp()}

<h2 id="config">Config reference</h2>
<p>The full annotated schema lives in <code>daimon.config.example.json</code>. Validate yours with <code>daimon doctor</code>. All keys with tiers:</p>
${renderConfigKeys()}
<p>Experimental sub-keys inside stable parents: <code>notifications.kinds</code> / <code>notifications.quietHours</code> / <code>notifications.batchMs</code> and <code>webhooks[].digest</code> (v0.13); <code>logs.storm</code> (v1.2).</p>
<p>Highlights:</p>
<ul>
  <li><code>searchRoots</code> — array of paths (or <code>{path, label}</code>) to scan for projects.</li>
  <li><code>autoStart</code> — apps to start when the daemon launches.</li>
  <li><code>profiles</code> — named sets of apps for <code>daimon up &lt;profile&gt;</code> / <code>daimon ci start &lt;profile&gt;</code>.</li>
  <li><code>healthProbe</code> — toggle and shape the per-app health probe.</li>
  <li><code>webhooks</code> — outbound notifications: <code>[{url, events?, headers?, filter?, apps?, digest?}]</code> with Slack/Discord shaping; <code>apps</code> scopes an entry to specific apps (v0.11); <code>digest: "HH:MM"</code> sends the daily report (v0.13).</li>
  <li><code>frameworks</code> — custom framework profiles (v0.11): data-only rows <code>[{id, detect, command, readiness?, url?, errorParser?}]</code> checked after the built-in registry. Detection markers and regex strings only — never loaded code.</li>
  <li><code>overrides.&lt;app&gt;</code> — per-app port / command / env / webhooks / <code>testCommand</code> (v0.12: explicit test runner, always wins) / <code>logIndex</code> (v0.12: opt this app's log lines out of search indexing), plus tuning knobs like <code>compileRegressionFactor</code>.</li>
  <li><code>history</code> — SQLite retention controls (also prunes v0.12 test runs, crash reports, and the search index).</li>
  <li><code>tests</code> — <code>{ flakyThreshold: 3 }</code> (v0.12): pass↔fail flips at the same git head before a test is flagged flaky.</li>
  <li><code>restartStorm</code> — <code>{ perHour: 20 }</code> (v0.12): unrequested exits per hour before a single <code>restart-storm</code> event fires.</li>
  <li><code>search</code> — <code>{ logIndex: true }</code> (v0.12): global default for per-app log-line indexing; errors/events are always indexed.</li>
  <li><code>ports</code> — <code>{ pool: "4200-4299" }</code> (v0.13): opt-in auto-assignment; only frameworks whose registry row documents <code>portFlag</code>/<code>portEnv</code> participate.</li>
  <li><code>logs.storm</code> — <code>{ multiplier: 10, windowSec: 60 }</code> (v1.2): tunes log-storm detection (a sustained spike vs the app's own lines/min baseline). Optional; detection always runs with the defaults and emits only self-events — the <code>log-storm</code> OS-notification kind is a separate opt-in via <code>notifications.kinds</code>. Custom framework profiles may also declare <code>logLevelPatterns</code> <code>[{pattern, level}]</code> rows (v1.2) for log-level classification — validated data, first match wins, invalid rows are ignored with a warning.</li>
</ul>

<h2 id="events">Event kinds</h2>
<p>Kinds emitted on the event log (<code>daimon events</code>, <code>GET /api/events</code>, webhooks, <code>daimon_subscribe_events</code>):</p>
${renderEventKinds()}

<h2 id="doctor">Doctor coverage</h2>
<p>When something breaks, <code>daimon doctor</code> is the first stop (<code>--auto-fix</code> applies the permitted repairs). Every recurring failure class and what covers it:</p>
${renderDoctorCoverage()}

<h2 id="faq">FAQ</h2>
<dl>
  <dt><strong>Does daimon edit my code?</strong></dt>
  <dd>No. Daimon only touches <code>~/.daimon/*</code> and (if you opt in) the local <code>daimon.config.json</code>. <code>daimon doctor --auto-fix</code> repairs daemon state, never source.</dd>
  <dt><strong>Is it safe to run two Claudes against one daemon?</strong></dt>
  <dd>Yes — every CLI call sends an <code>X-Daimon-Agent</code> header and the daemon enforces a 30-second per-app soft-lock so two agents don't fight. Pass <code>--steal</code> to override.</dd>
  <dt><strong>How do I get a notification when an app errors?</strong></dt>
  <dd>Configure a <code>webhooks</code> entry pointing at Slack/Discord, or call <code>daimon_notify_on_error</code> from MCP.</dd>
  <dt><strong>Can I use daimon in CI?</strong></dt>
  <dd>Yes — <code>daimon ci start &lt;profile&gt; --until ready --timeout 5m --json</code> returns a structured report and exits 2 on timeout. See the <a href="ci-integration.md">CI integration guide</a>.</dd>
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
