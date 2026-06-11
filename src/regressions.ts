// Pattern detection helpers used by the Registry to surface
// `regression-detected` events. Three flavours:
//   - kind:'compile' → current compile > factor × rolling-median(prior 20)
//   - kind:'bundle'  → initialKB > 1.10 × prior baseline
//   - kind:'error-flap' → error-recur count over last 1h > 3× the previous 24h
// Each carries a suspect-commit hint pulled from `git log -1 --format=%h %s`
// when the app's workspaceRoot is inside a git checkout.

import { execFile } from 'node:child_process';

export interface RegressionPayload {
  kind: 'compile' | 'bundle' | 'error-flap';
  factor: number;
  baseline: number;
  current: number;
  fingerprint?: string;
  suspectCommit?: string | null;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

export function detectCompileRegression(prior: number[], current: number, factor = 2.0): RegressionPayload | null {
  if (prior.length < 10) return null;
  const baseline = median(prior);
  if (baseline <= 0) return null;
  const observedFactor = current / baseline;
  if (observedFactor < factor) return null;
  return {
    kind: 'compile',
    factor: Math.round(observedFactor * 100) / 100,
    baseline,
    current,
  };
}

// Accepts the rolling window of prior initialKB values (newest-first or any
// order); a single number is still accepted for back-compat with v0.10.0 callers.
export function detectBundleRegression(priorInitialKB: number[] | number | undefined, currentInitialKB: number, ratio = 1.1): RegressionPayload | null {
  const prior = (Array.isArray(priorInitialKB) ? priorInitialKB : [priorInitialKB ?? 0]).filter(v => v > 0);
  if (prior.length === 0) return null;
  const baseline = median(prior);
  if (baseline <= 0) return null;
  const observed = currentInitialKB / baseline;
  if (observed < ratio) return null;
  return {
    kind: 'bundle',
    factor: Math.round(observed * 100) / 100,
    baseline,
    current: currentInitialKB,
  };
}

// hourEvents = error/recur count in the last 1h
// dayEvents  = error/recur count in the prior 24h (excluding the last hour)
export function detectErrorFlapRegression(hourEvents: number, dayEvents: number, fingerprint: string, factor = 3.0): RegressionPayload | null {
  if (hourEvents < 5) return null; // need a meaningful spike
  // Convert 24h-1h count to per-hour baseline. A zero baseline (fingerprint
  // never seen before this hour) is the sharpest spike of all — cap the
  // factor rather than suppress it.
  const baseline = dayEvents / 23;
  const observedFactor = baseline <= 0 ? 99 : hourEvents / baseline;
  if (observedFactor < factor) return null;
  return {
    kind: 'error-flap',
    factor: Math.round(observedFactor * 100) / 100,
    baseline: Math.round(baseline * 10) / 10,
    current: hourEvents,
    fingerprint,
  };
}

// Best-effort: resolves "<sha>:<subject>" or null. Async so the git spawn
// never stalls the compile hot path; stdout capped so a misbehaving git
// config can't balloon memory.
export function suspectCommitForDir(cwd: string | null | undefined): Promise<string | null> {
  if (!cwd) return Promise.resolve(null);
  return new Promise(resolve => {
    execFile('git', ['log', '-1', '--format=%h:%s'], {
      cwd,
      timeout: 1500,
      maxBuffer: 4096,
      windowsHide: true,
    }, (err, stdout) => {
      if (err) return resolve(null);
      const out = stdout.toString().trim();
      resolve(out ? out.slice(0, 160) : null);
    });
  });
}
