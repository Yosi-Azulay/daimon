import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// M90 error-string audit, enforced: every user-facing error says what to do
// next. EADDRINUSE forensics (M81) is the model — identify, explain, name the
// remedy. This grep-style suite scans the SOURCE so a new bare error fails the
// build, mirroring the redaction suite's approach in env-awareness.test.mjs.
//
// What counts as a remedy in an error string:
//   - a usage line (`usage: ...`) — tells you exactly what to type
//   - named valid values (`must be a|b|c`, `looks like`, `required`)
//   - an explicit next step (run/pass/use/see/add/check/start/fix/open/list…)
// Dynamic passthroughs of upstream messages (err?.message) are exempt: the
// remedy obligation sits with whoever composed the original message.

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = rel => fs.readFileSync(path.join(repoRoot, rel), 'utf8');

const REMEDY_SIGNALS = /usage:|must be|looks? like|required|did you mean|\(max \d|max \d+ |run |pass |use |see |add |check |start |fix |open |list |install |remove |change |wait |retry |restart|--steal|daimon (doctor|init|list|daemon|config|frameworks|profiles|start|stop|why|free-port)/i;

test('cli.ts: every fail() error literal carries a remedy or is a passthrough', () => {
  const src = read('src/cli.ts');
  const bare = [];
  // Single-line fail(JSON.stringify({ error: <literal> ... })) sites.
  const rx = /fail\(JSON\.stringify\(\{ error: (?:'((?:[^'\\]|\\.)*)'|`((?:[^`\\]|\\.)*)`)/g;
  for (const m of [...src.matchAll(rx)]) {
    const text = m[1] ?? m[2] ?? '';
    if (REMEDY_SIGNALS.test(text)) continue;
    bare.push(text);
  }
  // Dynamic passthroughs are the only acceptable non-remedy fails.
  const passthroughs = [...src.matchAll(/fail\(JSON\.stringify\(\{ error: (err\?\.message|r\.body|[A-Za-z]+\.message)/g)].length;
  assert.ok(passthroughs > 0, 'sanity: passthrough sites exist and are exempt');
  assert.deepEqual(bare, [], `bare CLI errors without a next step (M90): ${bare.join(' | ')}`);
});

test('cli.ts: single-argument failHint calls are usage lines (the hint IS the usage)', () => {
  const src = read('src/cli.ts');
  const offenders = [];
  for (const m of [...src.matchAll(/failHint\('((?:[^'\\]|\\.)*)'\)/g)]) {
    if (!/usage:/.test(m[1])) offenders.push(m[1]);
  }
  assert.deepEqual(offenders, [], `failHint without a hint argument must be a usage line: ${offenders.join(' | ')}`);
});

test('server.ts: every 4xx error literal names valid input, carries a hint, or is self-explanatory', () => {
  const src = read('src/server.ts');
  const bare = [];
  const rx = /sendJson\(res, (4\d\d), (\{ error: '((?:[^'\\]|\\.)*)'[^}]*\})/g;
  for (const m of [...src.matchAll(rx)]) {
    const [, , obj, text] = m;
    if (obj.includes('hint')) continue; // explicit remedy
    if (obj.includes('candidates') || obj.includes('suggestion')) continue; // structured remedy
    if (REMEDY_SIGNALS.test(text)) continue; // names valid values / next step
    if (/\|/.test(text)) continue; // enumerates the accepted values
    bare.push(`${m[1]} ${text}`);
  }
  // The residue must be exactly the reviewed self-explanatory set — protocol
  // responses where the status code + message already IS the full story.
  const reviewed = new Set([
    '405 method not allowed', // wrong HTTP verb on a real route: the method list is the route docs' job
    '404 not found', // unroutable path: nothing app-specific to suggest
    '401 unauthorized', // bearer-token gate: intentionally terse, no oracle for attackers
    '403 forbidden: cross-origin or non-loopback request rejected', // CSRF gate names the exact cause
    '400 invalid action', // /api/session/record: accepted values documented on the verb
    '412 etag mismatch', // PATCH concurrency: response carries the current etag alongside
    '409 refusing: app is currently running', // clean gate: response carries the plan object
  ]);
  const unexpected = bare.filter(b => !reviewed.has(b));
  assert.deepEqual(unexpected, [], `unreviewed bare server errors (M90 — add a hint or review-list them with justification): ${unexpected.join(' | ')}`);
});

test('main.ts: fatal daemon errors name the next step', () => {
  const src = read('src/main.ts');
  assert.ok(src.includes("'daimon config validate' pinpoints the problem"), 'config parse fatal carries the remedy');
  assert.ok(src.includes('break the cycle in daimon.config.json'), 'depends-cycle fatal carries the remedy');
  assert.ok(src.includes('renderApiPortConflict'), 'EADDRINUSE path uses the forensics composer (the M90 model)');
});

test('unknown app / unknown profile 404s carry hints end to end', () => {
  const server = read('src/server.ts');
  assert.match(server, /UNKNOWN_APP = \{ error: 'unknown app', hint:/, 'server unknown-app 404 is hinted');
  assert.ok(!server.includes("sendJson(res, 404, { error: 'unknown app' })"), 'no bare unknown-app site slipped back in');
  const cli = read('src/cli.ts');
  assert.ok(!cli.includes("fail(JSON.stringify({ error: 'unknown app' }))"), 'CLI routes unknown-app through suggestUnknownApp');
});
