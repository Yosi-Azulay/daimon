// Search query syntax (M179, v1.16 "Recall") — the ONE source of truth for
// daimon's query language.
//
// PURE BY CONTRACT: this module imports nothing (no history, no server, no
// node builtins) so the grammar unit-tests in isolation and can be consumed by
// the daemon, the CLI, the TUI and the docs generator alike. It PARSES; it
// never queries. Compilation into SQL lives in history.ts, which turns the
// parsed filters into WHERE clauses on the real columns — NOT into FTS tricks.
// That is what makes the syntax work identically on the LIKE fallback path.
//
// The grammar is deliberately small and CLOSED (no OR, no parentheses, no
// negation — see PLAN-v1.16 "out of scope"): every token is either a
// `field:value` filter, a "quoted phrase", or a bare term, and everything is
// ANDed. Growth is a future release with its own scale check.

export type SearchKind = 'logs' | 'errors' | 'events' | 'tests' | 'error-groups';
export type SearchLevel = 'error' | 'warning' | 'lint';

/** One field of the grammar. Docs (`npm run build:docs`), the CLI help text and
 *  the unknown-field error message all render from this table — there is no
 *  second, hand-written copy of the grammar anywhere. */
export interface SearchFieldDef {
  name: string;
  arg: string;
  summary: string;
  example: string;
}

export const SEARCH_FIELDS: readonly SearchFieldDef[] = [
  {
    name: 'app',
    arg: '<name>',
    summary: 'Restrict to one app (exact name). ANDed with a --app flag or ?app= param, which it overrides.',
    example: 'app:web',
  },
  {
    name: 'kind',
    arg: 'logs|errors|events|tests|error-groups',
    summary: "Restrict to one result kind. `tests` and `error-groups` are v1.16 kinds and imply the unified scope.",
    example: 'kind:logs',
  },
  {
    name: 'level',
    arg: 'error|warning|lint',
    summary: 'Restrict to one severity. Spans both stores: event type families (error-*/warning-*/lint-*) and the log-line level column (v1.2). Log lines daimon could not classify carry no level and are excluded.',
    example: 'level:error',
  },
  {
    name: 'before',
    arg: '<time>',
    summary: 'Only rows at or before this time.',
    example: 'before:2026-07-01',
  },
  {
    name: 'after',
    arg: '<time>',
    summary: 'Only rows at or after this time (the general form of --since).',
    example: 'after:24h',
  },
] as const;

export const SEARCH_FIELD_NAMES: readonly string[] = SEARCH_FIELDS.map(f => f.name);

/** Accepted `before:` / `after:` forms, rendered into the docs and into the
 *  error message when a time value does not parse. */
export const SEARCH_TIME_FORMS: readonly string[] = [
  '2026-07-01 (UTC midnight)',
  '2026-07-01T14:30 / …T14:30:00Z',
  '24h · 30m · 7d · 90s · 2w (relative to now)',
  '1751328000000 (epoch ms)',
];

export const SEARCH_KINDS: readonly SearchKind[] = ['logs', 'errors', 'events', 'tests', 'error-groups'];
export const SEARCH_LEVELS: readonly SearchLevel[] = ['error', 'warning', 'lint'];

/** Kinds that only exist under the unified scope (M180). A `kind:` naming one
 *  of these implies `scope=all` — asking for test hits is asking for them. */
export const UNIFIED_ONLY_KINDS: readonly SearchKind[] = ['tests', 'error-groups'];

/**
 * `level:` → `events.type` families. Kept HERE (not in history.ts) so the
 * mapping is part of the grammar's single source of truth; history.ts owns the
 * wider ERROR_EVENT_TYPES list used by `kind:errors`, and a test asserts every
 * type named here is a member of it, so the two can never drift.
 *
 * `crash` is deliberately absent: it is issue-shaped (so `kind:errors` covers
 * it) but it carries no severity classification, and inventing one would be a
 * guess. Documented, not accidental.
 */
export const LEVEL_EVENT_TYPES: Readonly<Record<SearchLevel, readonly string[]>> = {
  error: ['error-new', 'error-recur'],
  warning: ['warning-new', 'warning-recur'],
  lint: ['lint-new', 'lint-recur'],
};

export interface ParsedQuery {
  /** Bare terms, in input order. A trailing `*` survives here — the FTS
   *  compiler turns it into a prefix search, the LIKE compiler strips it. */
  terms: string[];
  /** "Quoted phrases": one FTS phrase token, one contiguous LIKE substring. */
  phrases: string[];
  app?: string;
  kind?: SearchKind;
  level?: SearchLevel;
  /** Absolute epoch-ms bounds, already resolved from relative forms. */
  before?: number;
  after?: number;
  /** The input, verbatim — carried so callers can echo what was run. */
  raw: string;
}

export interface SearchQueryError {
  error: string;
  hint: string;
}

export type ParseResult =
  | { ok: true; query: ParsedQuery }
  | ({ ok: false } & SearchQueryError);

/** True when the parsed query carries no text to match — only filters. Such a
 *  query is answered by column predicates alone (no FTS MATCH, no LIKE). */
export function isFilterOnly(q: ParsedQuery): boolean {
  return q.terms.length === 0 && q.phrases.length === 0;
}

/** True when the query asks for a kind that only exists under `scope=all`. */
export function impliesUnifiedScope(q: ParsedQuery): boolean {
  return !!q.kind && UNIFIED_ONLY_KINDS.includes(q.kind);
}

const FIELD_LIST = SEARCH_FIELD_NAMES.join(', ');

function fieldError(name: string): SearchQueryError {
  return {
    error: `unknown field '${name}:' — valid fields: ${FIELD_LIST}`,
    hint: `use one of ${FIELD_LIST}, or quote the token to search for it literally: "${name}:…"`,
  };
}

interface RawToken {
  text: string;
  /** The token opened with a quote — it is a phrase, never a field. */
  quotedStart: boolean;
}

/**
 * Split on whitespace, honouring "double quotes" and backslash escapes.
 *
 * `\` escapes the next character anywhere (so `a\ b` is one term and `\"` is a
 * literal quote); a quote toggles quoting, and whitespace inside quotes is
 * kept. An unterminated quote is NOT an error — the rest of the input is one
 * phrase, which is what a user typing a phrase and hitting enter meant.
 */
function tokenize(input: string): RawToken[] {
  const out: RawToken[] = [];
  let buf = '';
  let started = false;      // buf holds a token (possibly empty, e.g. `""`)
  let quotedStart = false;
  let inQuote = false;
  const push = () => {
    if (started) out.push({ text: buf, quotedStart });
    buf = '';
    started = false;
    quotedStart = false;
  };
  for (let i = 0; i < input.length; i++) {
    const c = input[i];
    if (c === '\\' && i + 1 < input.length) {
      buf += input[i + 1];
      started = true;
      i++;
      continue;
    }
    if (c === '"') {
      if (!started) quotedStart = true;
      started = true;
      inQuote = !inQuote;
      continue;
    }
    if (!inQuote && /\s/.test(c)) { push(); continue; }
    buf += c;
    started = true;
  }
  push();
  return out.filter(t => t.text.length > 0 || t.quotedStart);
}

const DURATION_RE = /^(\d+)(ms|s|m|h|d|w)$/;
const DURATION_MS: Record<string, number> = {
  ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000, w: 7 * 86_400_000,
};

/**
 * Resolve a `before:`/`after:` value to absolute epoch ms.
 * Relative durations are resolved against `now` (injected, never read from the
 * clock here — the parser stays pure and deterministic under test).
 */
export function parseTimeBound(value: string, now: number): number | null {
  const v = value.trim();
  if (!v) return null;
  const dur = DURATION_RE.exec(v);
  if (dur) return now - Number(dur[1]) * DURATION_MS[dur[2]];
  if (/^\d+$/.test(v)) {
    // Epoch ms. Seconds would be ambiguous with a duration-less number, so
    // only ms is accepted — documented in SEARCH_TIME_FORMS.
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) {
    const n = Date.parse(v + 'T00:00:00Z');
    return Number.isNaN(n) ? null : n;
  }
  if (/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2})?(\.\d+)?(Z|[+-]\d{2}:?\d{2})?$/.test(v)) {
    const iso = v.replace(' ', 'T');
    // A datetime with no zone designator is read as UTC, matching the
    // date-only form above — daimon stores epoch ms and prints UTC.
    const withZone = /(Z|[+-]\d{2}:?\d{2})$/.test(iso) ? iso : iso + 'Z';
    const n = Date.parse(withZone);
    return Number.isNaN(n) ? null : n;
  }
  return null;
}

/**
 * Parse a query string into filters + text.
 *
 * Never throws. Unknown fields, empty field values and unparseable times each
 * return `{ ok: false, error, hint }` — the error names the valid fields (the
 * M90 "every error carries a remedy" rule), and the SAME message is rendered by
 * HTTP 400, CLI stderr and the TUI's inline error line.
 */
export function parseSearchQuery(input: string, now: number = Date.now()): ParseResult {
  const raw = input ?? '';
  const q: ParsedQuery = { terms: [], phrases: [], raw };
  for (const tok of tokenize(raw)) {
    if (tok.quotedStart) {
      if (tok.text) q.phrases.push(tok.text);
      continue;
    }
    const m = /^([A-Za-z][A-Za-z0-9_-]*):([\s\S]*)$/.exec(tok.text);
    if (!m) {
      q.terms.push(tok.text);
      continue;
    }
    const field = m[1].toLowerCase();
    const value = m[2];
    if (!SEARCH_FIELD_NAMES.includes(field)) return { ok: false, ...fieldError(m[1]) };
    if (!value.trim()) {
      return {
        ok: false,
        error: `field '${field}:' needs a value`,
        hint: `for example ${SEARCH_FIELDS.find(f => f.name === field)!.example}`,
      };
    }
    switch (field) {
      case 'app':
        q.app = value;
        break;
      case 'kind': {
        const k = value.toLowerCase() as SearchKind;
        if (!SEARCH_KINDS.includes(k)) {
          return {
            ok: false,
            error: `kind must be ${SEARCH_KINDS.join('|')} (got '${value}')`,
            hint: `example: kind:logs — 'tests' and 'error-groups' search test runs and folded error groups`,
          };
        }
        q.kind = k;
        break;
      }
      case 'level': {
        const l = value.toLowerCase() as SearchLevel;
        if (!SEARCH_LEVELS.includes(l)) {
          return {
            ok: false,
            error: `level must be ${SEARCH_LEVELS.join('|')} (got '${value}')`,
            hint: 'example: level:error — log lines daimon could not classify carry no level and are excluded',
          };
        }
        q.level = l;
        break;
      }
      case 'before':
      case 'after': {
        const ts = parseTimeBound(value, now);
        if (ts == null) {
          return {
            ok: false,
            error: `${field}:${value} is not a time`,
            hint: `accepted forms: ${SEARCH_TIME_FORMS.join(' · ')}`,
          };
        }
        if (field === 'before') q.before = ts; else q.after = ts;
        break;
      }
    }
  }
  return { ok: true, query: q };
}

/** Human-readable echo of the compiled filters — used by the TUI header and the
 *  CLI's non-JSON output so a user can see what their query actually meant. */
export function describeQuery(q: ParsedQuery): string {
  const bits: string[] = [];
  if (q.app) bits.push(`app=${q.app}`);
  if (q.kind) bits.push(`kind=${q.kind}`);
  if (q.level) bits.push(`level=${q.level}`);
  if (q.after != null) bits.push(`after=${new Date(q.after).toISOString()}`);
  if (q.before != null) bits.push(`before=${new Date(q.before).toISOString()}`);
  const text = [...q.phrases.map(p => `"${p}"`), ...q.terms];
  if (text.length) bits.push(`text=${text.join(' ')}`);
  return bits.join(' · ') || '(no filters)';
}
