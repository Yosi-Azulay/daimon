// Pattern detection helpers used by the Registry to surface
// `regression-detected` events. Three flavours:
//   - kind:'compile' → current compile > factor × rolling-median(prior 20)
//   - kind:'bundle'  → initialKB > 1.10 × prior baseline
//   - kind:'error-flap' → error-recur count over last 1h > 3× the previous 24h
// Each carries a suspect-commit hint pulled from `git log -1 --format=%h %s`
// when the app's workspaceRoot is inside a git checkout.

import { execFileSync } from 'node:child_process';

export interface RegressionPayload {
  kind: 'compile' | 'bundle' | 'error-flap';
  factor: number;
  baseline: number;
  current: number;
  fingerprint?: string;
  suspectCommit?: string | null;
}

export function detectCompileRegression(prior: number[], current: number, factor = 2.0): RegressionPayload | null {
  if (prior.length < 10) return null;
  const sorted = [...prior].sort((a, b) => a - b);
  const median = sorted[Math.floor((sorted.length - 1) * 0.5)];
  if (median <= 0) return null;
  const observedFactor = current / median;
  if (observedFactor < factor) return null;
  return {
    kind: 'compile',
    factor: Math.round(observedFactor * 100) / 100,
    baseline: median,
    current,
  };
}

export function detectBundleRegression(priorInitialKB: number | undefined, currentInitialKB: number, ratio = 1.1): RegressionPayload | null {
  if (priorInitialKB == null || priorInitialKB <= 0) return null;
  const observed = currentInitialKB / priorInitialKB;
  if (observed < ratio) return null;
  return {
    kind: 'bundle',
    factor: Math.round(observed * 100) / 100,
    baseline: priorInitialKB,
    current: currentInitialKB,
  };
}

// hourEvents = error/recur count in the last 1h
// dayEvents  = error/recur count in the prior 24h (excluding the last hour)
export function detectErrorFlapRegression(hourEvents: number, dayEvents: number, fingerprint: string, factor = 3.0): RegressionPayload | null {
  if (hourEvents < 5) return null; // need a meaningful spike
  // Convert 24h-1h count to per-hour baseline.
  const baseline = dayEvents / 23;
  if (baseline <= 0) return null;
  const observedFactor = hourEvents / baseline;
  if (observedFactor < factor) return null;
  return {
    kind: 'error-flap',
    factor: Math.round(observedFactor * 100) / 100,
    baseline: Math.round(baseline * 10) / 10,
    current: hourEvents,
    fingerprint,
  };
}

// Best-effort: returns "<sha>:<subject>" or null. Caps stdout to a tight
// budget so a misbehaving git config can't stall the daemon.
export function suspectCommitForDir(cwd: string | null | undefined): string | null {
  if (!cwd) return null;
  try {
    const out = execFileSync('git', ['log', '-1', '--format=%h:%s'], {
      cwd,
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 1500,
      maxBuffer: 4096,
    }).toString('utf8').trim();
    if (!out) return null;
    return out.slice(0, 160);
  } catch {
    return null;
  }
}
