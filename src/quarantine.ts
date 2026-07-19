// Flaky quarantine (M130, v1.7). A quarantine is a config-declared list of
// glob-style patterns (`*` wildcard) matched against a test's full name
// (`suite > test`). Quarantined tests STILL RUN and STILL RECORD — daimon never
// edits a test config, so it couldn't skip them and wouldn't. They're annotated
// so flaky detection and test-failure alerts can ignore them, and surfaced with
// their age so a parked test can never rot invisibly. Pure + fail-soft: an
// invalid pattern is dropped (the caller warns), never throws.

// The canonical name a pattern matches against. Runners disagree on separators
// (`›`, `>`, `::`); we normalize to `suite > test` so one convention covers all.
export function quarantineTestName(suite: string | null | undefined, test: string | null | undefined): string {
  const s = (suite ?? '').trim();
  const t = (test ?? '').trim();
  return s ? `${s} > ${t}` : t;
}

// Compile a `*`-glob to an anchored, case-sensitive RegExp. Every other regex
// metacharacter is escaped, so patterns are literal except for `*` → `.*`.
function globToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${escaped}$`);
}

export interface QuarantineMatcher {
  readonly patterns: string[];
  matches(fullName: string): boolean;
}

// Build a matcher from raw patterns. Non-string / empty / uncompilable entries
// are skipped (config.ts already warns on them at load); the result is always
// usable. An empty pattern list matches nothing.
export function compileQuarantine(patterns: readonly string[] | undefined): QuarantineMatcher {
  const compiled: { src: string; re: RegExp }[] = [];
  for (const p of patterns ?? []) {
    if (typeof p !== 'string') continue;
    const s = p.trim();
    if (!s) continue;
    try { compiled.push({ src: s, re: globToRegExp(s) }); } catch { /* skip uncompilable */ }
  }
  return {
    patterns: compiled.map(c => c.src),
    matches(fullName: string): boolean {
      return compiled.some(c => c.re.test(fullName));
    },
  };
}

// Reconcile a first-seen map against the currently-configured patterns: new
// patterns get `now`, removed patterns are dropped (so "oldest since" can never
// count a pattern that isn't parked anymore). Returns the next map plus whether
// it changed, so the caller only persists on a real delta.
export function reconcileFirstSeen(
  prev: Record<string, number> | undefined,
  patterns: readonly string[] | undefined,
  now: number,
): { firstSeen: Record<string, number>; changed: boolean } {
  const active = new Set((patterns ?? []).map(p => (typeof p === 'string' ? p.trim() : '')).filter(Boolean));
  const next: Record<string, number> = {};
  let changed = false;
  for (const p of active) {
    if (prev && typeof prev[p] === 'number') next[p] = prev[p];
    else { next[p] = now; changed = true; }
  }
  // Any previously-tracked pattern no longer active is a drop.
  if (prev) for (const k of Object.keys(prev)) if (!active.has(k)) changed = true;
  return { firstSeen: next, changed };
}

export interface QuarantineSummary {
  patterns: string[];
  count: number;
  // Epoch ms of the oldest still-parked pattern, or null when nothing is parked.
  oldestSince: number | null;
}

export function quarantineSummary(firstSeen: Record<string, number>): QuarantineSummary {
  const patterns = Object.keys(firstSeen);
  let oldestSince: number | null = null;
  for (const p of patterns) {
    const ts = firstSeen[p];
    if (typeof ts === 'number' && (oldestSince == null || ts < oldestSince)) oldestSince = ts;
  }
  return { patterns, count: patterns.length, oldestSince };
}
