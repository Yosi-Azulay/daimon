// Log-level classification (M99). Every ingested log line gets an optional
// level — declared per framework as registry DATA (FrameworkProfile
// `logLevelPatterns`, fixture-gated like every registry field since M65),
// with a conservative shared heuristic as the generic fallback.
//
// Contract:
//   - Registry patterns are ordered; FIRST match wins.
//   - A profile's patterns are tried first; when none match, the same generic
//     heuristic that pattern-less profiles get applies (declaring patterns
//     never classifies WORSE than not declaring them).
//   - Classification is FAIL-SOFT AT INGEST: any miss, parser error, or
//     pathological input yields level null — a classifier bug may never drop
//     or delay a log line (the caller stores the line regardless).
//   - Patterns are validated data compiled once per profile row, never loaded
//     code. Invalid rows are skipped at compile time (config validation warns).

import stripAnsi from 'strip-ansi';
import { MAX_PATTERN_CHARS, LOG_LEVELS, isLogLevel, type FrameworkProfile, type LogLevel, type LogLevelPattern } from './frameworks.js';

// The LogLevel type and LogLevelPattern row shape live in frameworks.ts next
// to the FrameworkProfile field they describe; re-exported here so classifier
// consumers need only this module.
export { LOG_LEVELS, isLogLevel };
export type { LogLevel, LogLevelPattern };

interface CompiledRow {
  rx: RegExp;
  level: LogLevel;
}

// Generic fallback heuristic: a case-insensitive error/warn(ing)/info word
// near the line start (after ANSI stripping). Deliberately conservative —
// no debug detection, and "0 errors" / "no warnings" style summary counts
// are excluded so a green build line never classifies as an error.
const GENERIC_TOKEN_RX = /\b(errors?|warn(?:ing)?s?|info)\b/i;
const GENERIC_ZERO_COUNT_RX = /\b(?:0|no)\s+(?:errors?|warnings?)\b/i;
const GENERIC_MAX_TOKEN_INDEX = 40;

const ANSI_ESC = String.fromCharCode(27); // the ANSI escape byte

function genericLevel(line: string): LogLevel | null {
  const m = GENERIC_TOKEN_RX.exec(line);
  if (!m || m.index > GENERIC_MAX_TOKEN_INDEX) return null;
  if (GENERIC_ZERO_COUNT_RX.test(line)) return null;
  const token = m[1].toLowerCase();
  if (token.startsWith('error')) return 'error';
  if (token === 'info') return 'info';
  return 'warn';
}

// Compile a profile's declared rows into matchers. Invalid entries (bad regex,
// over-long pattern, unknown level) are dropped — validated data, never loaded
// code; `warn` (when given) surfaces each dropped row for config validation.
export function compileLogLevelPatterns(
  rows: LogLevelPattern[] | undefined,
  warn?: (msg: string) => void,
): CompiledRow[] {
  if (!rows || !Array.isArray(rows)) return [];
  const out: CompiledRow[] = [];
  for (const row of rows) {
    if (!row || typeof row !== 'object' || typeof row.pattern !== 'string' || !isLogLevel(row.level)) {
      warn?.(`logLevelPatterns entry must be { pattern, level: error|warn|info|debug } — row ignored`);
      continue;
    }
    if (row.pattern.length === 0 || row.pattern.length > MAX_PATTERN_CHARS) {
      warn?.(`logLevelPatterns pattern must be 1-${MAX_PATTERN_CHARS} chars — row ignored`);
      continue;
    }
    try {
      out.push({ rx: new RegExp(row.pattern, 'i'), level: row.level });
    } catch (err: any) {
      warn?.(`logLevelPatterns pattern ${JSON.stringify(row.pattern)} is not a valid regex (${err?.message ?? err}) — row ignored`);
    }
  }
  return out;
}

// Compiled matchers are cached per profile row object — regexes compile once
// at profile load, not once per app start.
const compiledCache = new WeakMap<object, CompiledRow[]>();

export function compiledPatternsFor(profile: Pick<FrameworkProfile, 'logLevelPatterns'> | undefined): CompiledRow[] {
  if (!profile?.logLevelPatterns?.length) return [];
  let hit = compiledCache.get(profile);
  if (!hit) {
    hit = compileLogLevelPatterns(profile.logLevelPatterns);
    compiledCache.set(profile, hit);
  }
  return hit;
}

// Classify one line. Fail-soft by construction: any throw (a pathological
// regex interaction, malformed input) returns null and the line is stored
// unclassified — never dropped, never delayed.
export function classifyLogLine(line: string, compiled?: CompiledRow[]): LogLevel | null {
  try {
    if (!line) return null;
    // Ingest already ANSI-strips, but classify defensively for callers that
    // hand over raw lines (fixtures, report backfill).
    // ESC kept out of the source literal (grep-clean tree, M91).
    const clean = line.includes(ANSI_ESC) ? stripAnsi(line) : line;
    if (compiled) {
      for (const row of compiled) {
        if (row.rx.test(clean)) return row.level;
      }
    }
    return genericLevel(clean);
  } catch {
    return null;
  }
}

// Convenience: a per-app classifier closure the registry hands to AppProcess.
export function makeClassifier(profile: Pick<FrameworkProfile, 'logLevelPatterns'> | undefined): (line: string) => LogLevel | null {
  const compiled = compiledPatternsFor(profile);
  return line => classifyLogLine(line, compiled);
}
