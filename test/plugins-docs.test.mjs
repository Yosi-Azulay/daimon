import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// M119 — PLUGINS.md drift gate: the manual must match the shipped API, embed
// the actual example sources (not paraphrases), state the trust model without
// euphemism, and never leak the personal email.

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = f => fs.readFileSync(path.join(repoRoot, f), 'utf8').replace(/\r\n/g, '\n');

const docs = read('PLUGINS.md');
const { PLUGIN_HOOK_NAMES, PLUGIN_API_VERSION } = await import('../dist/plugins.js');

test('PLUGINS.md documents every shipped hook, and no others', () => {
  for (const hook of PLUGIN_HOOK_NAMES) {
    assert.ok(docs.includes(`${hook}`), `PLUGINS.md mentions ${hook}`);
  }
  // Any onXxx(...) hook the doc's API reference declares must exist in the
  // shipped type — catches the doc growing hooks the code doesn't have.
  const declared = [...docs.matchAll(/^\s{2}(on[A-Z]\w+|registerDoctorRules)\??\(/gm)].map(m => m[1]);
  for (const d of declared) {
    assert.ok(PLUGIN_HOOK_NAMES.includes(d), `documented hook "${d}" exists in the shipped API`);
  }
});

test('PLUGINS.md states the trust model without euphemism', () => {
  assert.match(docs, /NOT sandboxed/i);
  assert.match(docs, /full Node privileges/);
  assert.match(docs, /no marketplace/i);
  assert.match(docs, /auto-install/i);
  assert.match(docs, /trusted code/i);
  // The explicit no-sandbox honesty statement (sandbox claims would be a lie).
  assert.match(docs, /security theater|would be a lie/i);
});

test('PLUGINS.md matches the shipped apiVersion and experimental tier', () => {
  assert.ok(docs.includes(`apiVersion: ${PLUGIN_API_VERSION}`));
  assert.match(docs, /experimental/);
  assert.match(docs, /STABILITY\.md/);
});

test('cookbook embeds both example sources verbatim', () => {
  for (const example of ['events-to-jsonl.mjs', 'custom-doctor-rule.mjs']) {
    const src = read(path.join('examples', 'plugins', example)).trim();
    assert.ok(docs.includes(src), `PLUGINS.md embeds examples/plugins/${example} byte-for-byte`);
  }
});

test('no personal email in PLUGINS.md, README plugin docs, or examples', () => {
  const files = ['PLUGINS.md', 'README.md', 'RELEASE-v1.5.0.md',
    path.join('examples', 'plugins', 'events-to-jsonl.mjs'),
    path.join('examples', 'plugins', 'custom-doctor-rule.mjs')];
  for (const f of files) {
    assert.ok(!read(f).includes('yosi@'), `${f} carries no personal email`);
  }
});

test('README links PLUGINS.md', () => {
  assert.match(read('README.md'), /PLUGINS\.md/);
});
