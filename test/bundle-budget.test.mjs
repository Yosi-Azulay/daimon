import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

// M148 (v1.10) — the dashboard's initial-payload gate.
//
// The <150KB gzip figure had been quoted in release notes since v1.7 but was
// never ENFORCED: nothing failed if a stray eager import pushed it over. The
// Angular budgets in angular.json cap the RAW initial bundle at 800kB, which is
// a different (and much looser) thing than what a user actually downloads.
//
// This asserts the gzipped initial payload — the scripts and stylesheets
// index.html loads before the app can render. Lazy route chunks are deliberately
// excluded: they are the point of code-splitting, and counting them would
// punish moving work OFF the critical path.

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Angular 20 emits browser assets under dist/dashboard/browser/; older layouts
// put index.html directly in dist/dashboard. Resolve whichever exists so the
// gate does not silently skip after a builder upgrade moves the output.
const distDash = (() => {
  const base = path.join(repoRoot, 'dist', 'dashboard');
  const nested = path.join(base, 'browser');
  if (fs.existsSync(path.join(nested, 'index.html'))) return nested;
  return base;
})();

// THE 135.39KB IN THE RELEASE NOTES WAS NOT GZIP (found in v1.10).
//
// That figure is Angular's "Estimated transfer size" column, which since
// Angular 17 is a BROTLI estimate. Measured on this same build:
//   raw 492.7KB · gzip 148.5KB · brotli 132.0KB   (Angular printed 135.39KB)
// So every release note since v1.7 quoting "135.39 KB gz" was quoting brotli
// under a gzip label. The <150KB gzip claim still holds — but with ~1%
// headroom, not the ~10% everyone believed.
//
// The gate therefore measures REAL gzip and keeps the documented 150KB
// ceiling: the achieved figure (148.5KB) is already within ~1%, so ratcheting
// tighter would gate on compressor noise rather than on regressions. Brotli is
// asserted too, because that is what a modern browser actually downloads.
const BUDGET_KB = 150;
const BROTLI_BUDGET_KB = 140;

function gzipKB(file) {
  return zlib.gzipSync(fs.readFileSync(file), { level: 9 }).length / 1024;
}

function brotliKB(file) {
  return zlib.brotliCompressSync(fs.readFileSync(file)).length / 1024;
}

/**
 * Initial payload = everything the browser must fetch before first render:
 * index.html's own references, plus the STATIC import graph reachable from
 * them.
 *
 * The transitive walk is the part that matters. Counting only <script src>
 * measured 16KB, and adding <link rel="modulepreload"> reached 79KB, against
 * Angular's reported 135KB — because Angular preloads only some of the chunks
 * that main.js statically imports; the rest are still fetched before render,
 * just discovered a round-trip later. A gate that under-measured by 40% would
 * have waved through almost any regression.
 *
 * Dynamic imports — `import("./chunk-X.js")`, how lazy routes are loaded — are
 * deliberately NOT followed. Those are the payoff of code-splitting.
 */
function initialAssets() {
  const html = fs.readFileSync(path.join(distDash, 'index.html'), 'utf8');
  const seeds = new Set();
  for (const re of [
    /<script[^>]+src="([^"]+)"/g,
    /<link[^>]+rel="stylesheet"[^>]*href="([^"]+)"/g,
    /<link[^>]+rel="preload"[^>]+as="style"[^>]*href="([^"]+)"/g,
    /<link[^>]+rel="modulepreload"[^>]*href="([^"]+)"/g,
  ]) {
    for (const m of html.matchAll(re)) seeds.add(m[1].replace(/^\.?\//, ''));
  }

  const seen = new Set();
  const queue = [...seeds];
  while (queue.length) {
    const rel = queue.shift();
    if (seen.has(rel)) continue;
    const abs = path.join(distDash, rel);
    if (!fs.existsSync(abs)) continue;
    seen.add(rel);
    if (!rel.endsWith('.js')) continue;
    const src = fs.readFileSync(abs, 'utf8');
    // Static ESM edges only: `from"./chunk-X.js"`, `import"./chunk-X.js"`,
    // `export...from"./chunk-X.js"`. A dynamic `import("./x.js")` has a paren
    // before the quote and is skipped by these patterns.
    for (const m of src.matchAll(/(?:from|import)\s*"(\.\/[^"]+\.js)"/g)) {
      queue.push(m[1].replace(/^\.\//, ''));
    }
  }
  return [...seen].map(r => path.join(distDash, r));
}

test('dashboard initial payload stays inside its gzip budget', { skip: fs.existsSync(path.join(distDash, 'index.html')) ? false : 'dist/dashboard not built — run npm run build:dashboard' }, () => {
  const assets = initialAssets();
  assert.ok(assets.length > 0, 'expected index.html to reference at least one script');
  const total = assets.reduce((sum, f) => sum + gzipKB(f), 0);
  const detail = assets
    .map(f => `${path.basename(f)} ${gzipKB(f).toFixed(1)}KB`)
    .join(', ');
  assert.ok(total <= BUDGET_KB,
    `initial payload ${total.toFixed(2)}KB gzip exceeds the ${BUDGET_KB}KB budget (${detail}). `
    + 'Budgets are never raised to make a build pass — find the eager import that grew it.');

  const brotli = assets.reduce((sum, f) => sum + brotliKB(f), 0);
  assert.ok(brotli <= BROTLI_BUDGET_KB,
    `initial payload ${brotli.toFixed(2)}KB brotli exceeds the ${BROTLI_BUDGET_KB}KB budget — `
    + 'brotli is what a modern browser actually downloads.');
});

test('lazy route chunks exist — the app is still code-split', { skip: fs.existsSync(path.join(distDash, 'index.html')) ? false : 'dist/dashboard not built' }, () => {
  const initial = new Set(initialAssets().map(f => path.basename(f)));
  const chunks = fs.readdirSync(distDash)
    .filter(f => f.startsWith('chunk-') && f.endsWith('.js') && !initial.has(f));
  assert.ok(chunks.length > 10,
    `expected many lazy chunks, found ${chunks.length} — a collapse in code-splitting would `
    + 'move route code onto the critical path without changing the initial-bundle name');
});
