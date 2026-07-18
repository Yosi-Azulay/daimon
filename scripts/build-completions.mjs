#!/usr/bin/env node
// Regenerates completions/ from the live CLI surface (src/cliSurface.ts via
// dist/cliHelp.js). Same idempotence style as build-docs.mjs: run `npm run
// build` first so dist/ reflects the current source, then run this. The
// committed completions/*.bash /_daimon /*.ps1 files are drift-tested against
// this exact output in test/completion.test.mjs.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const dist = p => pathToFileURL(path.resolve(repoRoot, 'dist', p)).href;

const { completionBash, completionZsh, completionPowershell } = await import(dist('cliHelp.js'));

const outDir = path.join(repoRoot, 'completions');
fs.mkdirSync(outDir, { recursive: true });

// LF endings, no BOM, regardless of platform — see .gitattributes, which
// pins completions/* to `text eol=lf` so a Windows checkout can't reintroduce
// CRLF and break the drift test.
const targets = [
  ['daimon.bash', completionBash()],
  ['_daimon', completionZsh()],
  ['daimon.ps1', completionPowershell()],
];

for (const [name, content] of targets) {
  const normalized = content.replace(/\r\n/g, '\n');
  fs.writeFileSync(path.join(outDir, name), normalized, 'utf8');
  console.log(`[build-completions] wrote completions/${name} (${normalized.length} bytes)`);
}
