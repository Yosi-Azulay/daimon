#!/usr/bin/env node
// Rewrites the chord table inside README.md from the ONE chord-map data module
// (src/tui/chords.ts → dist/tui/chords.js), the same way completions/ is
// generated from cliSurface.ts. The table lives between the marker comments
// below; everything outside them is hand-written prose and is left untouched.
//
// A chord is never hand-listed: add a row to chords.ts, run
// `npm run build && npm run build:readme-chords`, and the README follows.
// test/tui-chords.test.mjs fails if the table ever falls behind the map.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');

const { CHORDS } = await import(pathToFileURL(path.resolve(repoRoot, 'dist', 'tui', 'chords.js')).href);

const START = '<!-- chords:start (generated from src/tui/chords.ts — npm run build:readme-chords) -->';
const END = '<!-- chords:end -->';

const GROUP_TITLES = {
  global: 'Global — every pane',
  nav: 'Navigation',
  lifecycle: 'Lifecycle — acts on the selected app',
  inspect: 'Inspect',
  filter: 'Filter',
  log: 'Log pane',
  timeline: 'Timeline (`i`)',
  attach: '`daimon attach` (HTTP-client TUI)',
};

// Escape a display key for a markdown table cell: `|` would split the row.
const cell = s => String(s).replace(/\|/g, '\\|');

const order = [];
for (const c of CHORDS) if (!order.includes(c.group)) order.push(c.group);

const out = [];
for (const group of order) {
  const rows = CHORDS.filter(c => c.group === group);
  if (!rows.length) continue;
  out.push('');
  out.push(`**${GROUP_TITLES[group] ?? group}**`);
  out.push('');
  out.push('| Key | Does | Panes |');
  out.push('| --- | --- | --- |');
  for (const c of rows) {
    out.push(`| \`${cell(c.key)}\` | ${cell(c.desc)} | ${cell(c.panes.join(', '))} |`);
  }
}
out.push('');

const readmePath = path.join(repoRoot, 'README.md');
const readme = fs.readFileSync(readmePath, 'utf8');
const startAt = readme.indexOf(START);
const endAt = readme.indexOf(END);
if (startAt < 0 || endAt < 0) {
  throw new Error(`[build-readme-chords] markers not found in README.md — expected:\n${START}\n${END}`);
}

const next = readme.slice(0, startAt + START.length) + '\n' + out.join('\n') + readme.slice(endAt);
if (next === readme) {
  console.log('[build-readme-chords] README.md already up to date');
} else {
  fs.writeFileSync(readmePath, next, 'utf8');
  console.log(`[build-readme-chords] wrote ${CHORDS.length} chords into README.md`);
}
