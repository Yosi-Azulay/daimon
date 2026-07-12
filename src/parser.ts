import crypto from 'node:crypto';
import type { AppState, ErrorEntry, ParsedError, ParserTool } from './types.js';
import type { FrameworkProfile } from './frameworks.js';

const SERVING_PATTERNS = [
  /Local:\s+http/i,
  /Application bundle generation complete/i,
  /compiled successfully/i,
  /webpack compiled\s+(?:successfully|in\b)/i,
  /Angular Live Development Server is listening/i,
  /Storybook\s+[\d.]+\s+(?:for\s+\S+\s+)?started/i,
  /VITE\s+v[\d.]+\s+ready/i,
  /Quit the server with CONTROL-C/i,
  /Uvicorn running on http/i,
  /Application startup complete/i,
  /Puma starting in single mode/i,
  /Use Ctrl-C to stop/i,
  /Listening on tcp:\/\//i,
  /running on http/i,
  /serving HTTP on/i,
  /trunk serve.*at/i,
];

const COMPILING_PATTERNS = [
  /Building\.\.\./i,
  /Compilation started/i,
  /Initial chunk files/i,
  /Compiling/i,
  /Watching for file changes with StatReloader/i,
  /Performing system checks/i,
  /watching files for changes/i,
  /building\.{3}/i,
  /Compiling \(/i,
];

// Lint patterns. Tested FIRST — these are tighter than the generic
// "file:line:col:" pattern in ERROR_PATTERNS, so checking them first lets us
// keep lint findings out of the error column. Each pattern must be specific
// enough that it can't false-positive on a real compile error.
// Daimon NEVER spawns linters; this is parse-only.
const LINT_PATTERNS = [
  // Eslint stylish/compact (no filename on the finding line; just the inner
  // "<line>:<col>  <severity>  ...  <rule-name>" body). Two-or-more spaces
  // before the severity distinguishes it from "file:line:col error TS..." prose.
  /^\s+\d+:\d+\s{2,}(?:warning|error)\s{2,}\S/i,
  // Biome rule path "lint/<category>/<ruleName>" — only Biome formats it that way.
  /\blint\/[a-z][a-z0-9-]+\/[a-z][a-zA-Z0-9-]+\b/,
  // Ruff: "src/foo.py:3:1: F401 [*] `os` imported but unused".
  /^\s*\S+\.py:\d+:\d+:\s+[A-Z]\d{3,}\b/,
  // Clippy banner (`warning: ... clippy::`) and the "= note:" hint that
  // identifies the lint rule.
  /^warning:\s.*clippy::/i,
  /^\s*=\s+note:\s+`#\[warn\(clippy::/,
];

// Warning patterns. Tested AFTER ERROR_PATTERNS so a line matching both stays an error.
// Captured warnings do NOT flip app status to 'error' — they're informational signals.
const WARNING_PATTERNS = [
  // Angular compiler: "▲ [WARNING] NG8107: ..." or "[WARNING] ..."
  /^\s*(?:▲\s*)?\[WARNING\]/,
  // TypeScript: "warning TS6133:"
  /\bwarning TS\d+/i,
  // Generic "[warning]" / "[warn]" tags from various tools.
  /^\s*\[(?:warning|warn)\]\s+/i,
  // Eslint-style "warning  '...' is defined but never used"
  /^\s*warning\s+\S+\s+is\s+/i,
  // Python DeprecationWarning / UserWarning / FutureWarning lines.
  /^\s*\S+:\d+:\s*(?:Deprecation|User|Future|Pending|Resource|Runtime|Syntax)Warning:/,
  // Webpack: "WARNING in ./src/..."
  /^WARNING in\s+/,
  // Vite warning prefix.
  /^\s*\[vite\]\s+warning/i,
];

const ERROR_PATTERNS = [
  /^\s*ERROR\b/,
  /\berror TS\d+/,
  /✘/,
  /\[ERROR\]/,
  /Cannot find module/i,
  /^FAIL\s+\S+/,
  /^\s*●\s+/,
  /^\s*(?:>\s+)?NX\s+.*failed/i,
  /^\s*Failed tasks:/,
  /^\s*Task\s+"[^"]+"\s+is continuous but exited with code\s+\d+/,
  /\bModule not found:/,
  /\[vite\]\s+(?:Internal server error|Pre-transform error)/i,
  /\[plugin:[^\]]+\]/i,
  /^\s*ERR!\s+/,
  /^\s*(?:Uncaught\s+)?(?:Error|TypeError|SyntaxError|ReferenceError|RangeError):\s+/,
  /^Traceback \(most recent call last\):/,
  /^\s*[A-Z][a-zA-Z]*Error:\s+/,
  /^\s*\[error\]\s+/i,
  /^panic:\s+/,
  /^thread\s+'[^']+'\s+panicked at/,
  /^error\[E\d+\]:/,
  /^\S+\.(?:go|rb|py|rs|dart):\d+:\d+:/,
  /^\s*[A-Z][a-zA-Z]*\.[A-Z][a-zA-Z]*:\s+/,
  /^[A-Z][a-zA-Z]+(?:::[A-Z][a-zA-Z]+)+\s*[(:]/,
  /^[A-Z][a-zA-Z]*Error\s*\(/,
];

const TS_CODE_RX = /\berror TS(\d+)/;
const ESBUILD_TS_RX = /✘\s*\[ERROR\]\s*TS(\d+)/;
const LOCATION_RX = /([A-Z]:[\\/][^\s:()]+|[^\s:()]+\.(?:tsx?|jsx?|mjs|cjs|vue|svelte|astro|py|rb|go|rs|dart)):(\d+):(\d+)/;
// Stack-trace style: "at handler (D:\\app\\src\\index.ts:42:10)" or "at file:///D:/...:42:10".
const PAREN_LOCATION_RX = /\(([A-Z]:[\\/][^\s:()]+|[^\s:()]+\.(?:tsx?|jsx?|mjs|cjs|vue|svelte|astro|py|rb|go|rs)):(\d+):(\d+)\)/;
// TSC report format: "src/foo.ts(10,3): error TS2322: ...".
const TSC_LOCATION_RX = /([A-Z]:[\\/][^\s:()]+|[^\s:()]+\.(?:tsx?|jsx?|mjs|cjs|vue|svelte))\((\d+),(\d+)\)\s*:/;
// Python traceback line:   File "/path/to/file.py", line 42
const PY_TRACEBACK_RX = /File\s+"([^"]+\.py)",\s+line\s+(\d+)/;
// Rust compiler:   --> src/main.rs:42:9
const RUST_LOCATION_RX = /^\s*-->\s+([^\s:]+\.rs):(\d+):(\d+)/;
// Rails-style: app/controllers/widgets_controller.rb:14:in `show'
const RB_LOCATION_RX = /^([^\s:()]+\.rb):(\d+):in\b/;
// Jest "FAIL src/foo.test.ts" — captures file only.
const JEST_FAIL_FILE_RX = /^FAIL\s+(\S+\.(?:tsx?|jsx?|mjs|cjs))(?:\s|$)/;
// Webpack "ERROR in ./src/foo.ts[:L:C]" or "ERROR in ./src/foo.ts L:C" — captures file (and L:C when present).
const WEBPACK_ERROR_RX = /^ERROR in\s+(\S+\.(?:tsx?|jsx?|mjs|cjs|vue|svelte))(?:[:\s](\d+):(\d+))?/;
// Esbuild prints the file path on its own indented line just below the error line:
//   ✘ [ERROR] TS2724: ...
//       apps/editor/src/app/app.ts:3:9:
// Match a whole-line "<path>:<line>:<col>:" with optional indentation and trailing colon.
const BARE_LOCATION_LINE_RX = /^\s+([A-Z]:[\\/][^\s:()]+|[^\s:()]+\.(?:tsx?|jsx?|mjs|cjs|vue|svelte|astro)):(\d+):(\d+):?\s*$/;

const TOOL_RULES: { tool: ParserTool; rx: RegExp }[] = [
  { tool: 'vite', rx: /\[vite\]|\[plugin:vite:|transformWithEsbuild/i },
  { tool: 'storybook', rx: /\bstorybook\b|^\s*ERR!\s|builder-vite/i },
  { tool: 'jest', rx: /^FAIL\s|^\s*●\s+|\bjest\b/i },
  { tool: 'nx', rx: /(?:>\s+)?NX\s+(?:\w|.*failed)|Failed tasks:|Nx errored|exited with code\s+\d+/i },
  { tool: 'webpack', rx: /\bModule not found:|webpack compiled|webpack-dev-server/i },
  { tool: 'esbuild', rx: /✘\s*\[ERROR\]|esbuild/i },
  { tool: 'typescript', rx: /\berror TS\d+/ },
  { tool: 'django', rx: /\bdjango\b|StatReloader|manage\.py runserver/i },
  { tool: 'rails', rx: /\brails\b|Puma starting|Booting (?:Puma|Rails)|ActionController|NameError\s*\(|\.rb:\d+:in/i },
  { tool: 'fastapi', rx: /\buvicorn\b|fastapi|ASGI/i },
  { tool: 'go-air', rx: /\bair v\d|building\.{3}|\.go:\d+:\d+/i },
  { tool: 'rust-trunk', rx: /\btrunk\b|^error\[E\d+\]|^\s*-->\s+\S+\.rs:/i },
  { tool: 'python', rx: /^Traceback \(most recent call last\):|^\s*File "[^"]+\.py"|[A-Z][a-zA-Z]*Error:\s/ },
  { tool: 'node', rx: /^\s*(?:Uncaught\s+)?(?:Error|TypeError|SyntaxError|ReferenceError|RangeError):/ },
];

function detectTool(line: string): ParserTool | undefined {
  for (const { tool, rx } of TOOL_RULES) {
    if (rx.test(line)) return tool;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Per-profile parsing (M67). A framework profile row can reference one of
// these parser ids; the rules ADD detection/extraction on top of the generic
// pipeline. Fail-soft by construction: rules only ever contribute extra
// signal — unmatched lines flow through the generic path unchanged, and no
// line is ever dropped or reordered.
// ---------------------------------------------------------------------------

interface LocationRule {
  rx: RegExp;
  file: number;
  line: number;
  col?: number;
}

interface ProfileErrorRules {
  tool: ParserTool;
  // Lines that OPEN an error entry (in addition to the generic ERROR_PATTERNS).
  errorRx?: RegExp[];
  // Inline file:line extraction tried before the generic location rules.
  locations?: LocationRule[];
  // Continuation lines that backfill the previous entry's missing location.
  backfills?: LocationRule[];
}

const PROFILE_ERROR_RULES: Record<string, ProfileErrorRules> = {
  // Python: "Traceback (most recent call last):" then indented File frames.
  // The generic pipeline already opens the entry; the deepest File frame
  // backfills {file,line} (last frame = the raising site).
  'python-traceback': {
    tool: 'python-traceback',
    errorRx: [/^Traceback \(most recent call last\):/],
    backfills: [{ rx: /File\s+"([^"]+\.py)",\s+line\s+(\d+)/, file: 1, line: 2 }],
  },
  // Go compiler / air rebuilds: "main.go:12:5: undefined: foo".
  'go-build': {
    tool: 'go-build',
    errorRx: [/^\S+\.go:\d+:\d+:\s+/],
    locations: [{ rx: /^(\S+\.go):(\d+):(\d+):\s+/, file: 1, line: 2, col: 3 }],
  },
  // Cargo: "error[E0308]: mismatched types" (or bare "error: ...") with the
  // location on the following "  --> src/main.rs:4:5" line.
  'rust-cargo': {
    tool: 'rust-cargo',
    errorRx: [/^error(?:\[E\d+\])?:\s+/],
    backfills: [{ rx: /^\s*-->\s+([^\s:]+\.rs):(\d+):(\d+)/, file: 1, line: 2, col: 3 }],
  },
  // MSBuild/Roslyn: "Program.cs(12,5): error CS1002: ; expected".
  'dotnet': {
    tool: 'dotnet',
    errorRx: [/:\s+error\s+[A-Z]{2,4}\d{3,5}\s*:/],
    locations: [{ rx: /^\s*(.+?\.(?:cs|razor|cshtml|vb|fs))\((\d+),(\d+)\)\s*:\s*error/i, file: 1, line: 2, col: 3 }],
  },
  // PHP/Laravel: "PHP Fatal error: ... in /app/routes/web.php:5" (or the
  // classic "... in /app/x.php on line 5") and laravel.log-style ERROR lines.
  'php': {
    tool: 'php',
    errorRx: [/^PHP (?:Fatal error|Parse error|Warning):/, /(?:local|production)\.ERROR:/],
    locations: [{ rx: /\bin\s+(\S+\.php)(?::|\s+on\s+line\s+)(\d+)/i, file: 1, line: 2 }],
  },
  // javac: "Foo.java:5: error: ';' expected"; Spring stacktraces backfill from
  // the first "at pkg.Class.method(Foo.java:42)" frame.
  'jvm-gradle': {
    tool: 'jvm-gradle',
    errorRx: [/\.(?:java|kt|kts|groovy):\d+:\s*error/i, /^Exception in thread\s+/, /^Caused by:\s+\S+/],
    locations: [{ rx: /^\s*(\S+?\.(?:java|kt|kts|groovy)):(\d+):\s*error/i, file: 1, line: 2 }],
    backfills: [{ rx: /^\s+at\s+[\w.$<>]+\(([\w$.-]+\.(?:java|kt|kts)):(\d+)\)/, file: 1, line: 2 }],
  },
};

export const PROFILE_ERROR_PARSER_IDS: ReadonlySet<string> = new Set(Object.keys(PROFILE_ERROR_RULES));

// Compiled per-profile parse context: readiness/url regexes from the registry
// row plus the referenced error-parser rules. Cached by row identity so the
// hot log path compiles each pattern once.
export interface ProfileParseContext {
  readinessRx?: RegExp;
  urlRx?: RegExp;
  rules?: ProfileErrorRules;
}

const parseCtxCache = new Map<string, ProfileParseContext | undefined>();

function safeCompile(pattern: string): RegExp | undefined {
  try {
    return new RegExp(pattern, 'i');
  } catch {
    return undefined; // custom patterns are validated at config load; fail-soft here
  }
}

export function compileParseContext(profile: FrameworkProfile | undefined): ProfileParseContext | undefined {
  if (!profile) return undefined;
  const key = `${profile.id}\u0000${profile.readiness?.pattern ?? ''}\u0000${profile.url?.pattern ?? ''}\u0000${profile.errorParser ?? ''}`;
  if (parseCtxCache.has(key)) return parseCtxCache.get(key);
  const ctx: ProfileParseContext = {};
  if (profile.readiness?.pattern) ctx.readinessRx = safeCompile(profile.readiness.pattern);
  if (profile.url?.pattern) ctx.urlRx = safeCompile(profile.url.pattern);
  if (profile.errorParser && PROFILE_ERROR_RULES[profile.errorParser]) {
    ctx.rules = PROFILE_ERROR_RULES[profile.errorParser];
  }
  const out = (ctx.readinessRx || ctx.urlRx || ctx.rules) ? ctx : undefined;
  parseCtxCache.set(key, out);
  return out;
}

const ANNOUNCED_LOCAL_RX = /Local:\s+(https?:\/\/\S+)/i;
const ANNOUNCED_SERVER_RX = /Server running at\s+(https?:\/\/\S+)/i;
const ANNOUNCED_LISTENING_RX = /listening on\s+(https?:\/\/\S+)/i;
const ANNOUNCED_LISTEN_PLAIN_RX = /(?:listening|listen)\s+(https?:\/\/\S+)/i;
const BUNDLE_INITIAL_HEADER_RX = /Initial chunk files/i;
const BUNDLE_LAZY_HEADER_RX = /Lazy chunk files/i;
const BUNDLE_TOTAL_RX = /(Initial total|Lazy total)\s*\|?\s*([\d.]+)\s*(kB|MB|B)\b/i;
const BUNDLE_ROW_RX = /^\s*\|?\s*([^\s|][^|]*?)\s*\|\s*([^|]+?)\s*\|\s*([\d.]+)\s*(kB|MB|B)\b/i;

function hashLine(line: string): string {
  return crypto.createHash('sha1').update(line).digest('hex').slice(0, 16);
}

function parseStructured(line: string): ParsedError {
  const out: ParsedError = { message: line };
  const codeMatch = line.match(ESBUILD_TS_RX) || line.match(TS_CODE_RX);
  if (codeMatch) out.code = `TS${codeMatch[1]}`;
  const locMatch =
    line.match(TSC_LOCATION_RX) ||
    line.match(PAREN_LOCATION_RX) ||
    line.match(LOCATION_RX);
  if (locMatch) {
    out.file = locMatch[1];
    out.line = Number(locMatch[2]);
    out.col = Number(locMatch[3]);
  } else {
    const webpackErr = line.match(WEBPACK_ERROR_RX);
    if (webpackErr) {
      out.file = webpackErr[1];
      if (webpackErr[2]) out.line = Number(webpackErr[2]);
      if (webpackErr[3]) out.col = Number(webpackErr[3]);
    } else {
      const jestFail = line.match(JEST_FAIL_FILE_RX);
      if (jestFail) out.file = jestFail[1];
      else {
        const rust = line.match(RUST_LOCATION_RX);
        if (rust) {
          out.file = rust[1];
          out.line = Number(rust[2]);
          out.col = Number(rust[3]);
        } else {
          const py = line.match(PY_TRACEBACK_RX);
          if (py) {
            out.file = py[1];
            out.line = Number(py[2]);
          }
        }
      }
    }
  }
  const tool = detectTool(line);
  if (tool) out.tool = tool;
  return out;
}

// Profile location rules win over the generic extraction (e.g. the dotnet
// "Program.cs(12,5):" shape that the generic TSC rule only knows for ts/js).
function parseStructuredWithProfile(line: string, ctx?: ProfileParseContext): ParsedError {
  const rules = ctx?.rules;
  if (rules?.locations) {
    for (const rule of rules.locations) {
      const m = line.match(rule.rx);
      if (!m) continue;
      const out: ParsedError = { message: line, file: m[rule.file], line: Number(m[rule.line]), tool: rules.tool };
      if (rule.col !== undefined && m[rule.col]) out.col = Number(m[rule.col]);
      const code = line.match(/\berror\s+([A-Z]{2,4}\d{3,5})\b/);
      if (code) out.code = code[1];
      return out;
    }
  }
  const out = parseStructured(line);
  if (!out.tool && rules && rules.errorRx?.some(rx => rx.test(line))) out.tool = rules.tool;
  return out;
}

export interface ParseResult {
  statusChanged: boolean;
  error?: { entry: ErrorEntry; isNew: boolean };
  announcedUrl?: string;
  bundleUpdated?: boolean;
  compileMs?: number;
}

function rewriteHost(rawUrl: string, fallback: string): string {
  try {
    const u = new URL(rawUrl);
    if (u.hostname === '0.0.0.0' || u.hostname === '[::]') {
      u.hostname = fallback.includes(':') ? `[${fallback}]` : fallback;
      return u.toString().replace(/\/$/, '');
    }
    return rawUrl.replace(/\/$/, '');
  } catch {
    return rawUrl;
  }
}

export function detectAnnouncedUrl(line: string, fallbackHost = '127.0.0.1'): string | null {
  const m = line.match(ANNOUNCED_LOCAL_RX)
    || line.match(ANNOUNCED_SERVER_RX)
    || line.match(ANNOUNCED_LISTENING_RX)
    || line.match(ANNOUNCED_LISTEN_PLAIN_RX);
  if (!m) return null;
  const raw = m[1].replace(/[),.;]+$/, '');
  return rewriteHost(raw, fallbackHost);
}

function parseBundleLine(state: AppState, trimmed: string): boolean {
  if (BUNDLE_INITIAL_HEADER_RX.test(trimmed)) {
    if (!state.bundle) state.bundle = { initialKB: 0, lazyKB: 0, files: [] };
    (state as any)._bundleSection = 'initial';
    return false;
  }
  if (BUNDLE_LAZY_HEADER_RX.test(trimmed)) {
    if (!state.bundle) state.bundle = { initialKB: 0, lazyKB: 0, files: [] };
    (state as any)._bundleSection = 'lazy';
    return false;
  }
  const totalMatch = trimmed.match(BUNDLE_TOTAL_RX);
  if (totalMatch && state.bundle) {
    const num = parseFloat(totalMatch[2]);
    const unit = totalMatch[3].toUpperCase();
    const kb = Math.round(unit === 'MB' ? num * 1024 : unit === 'B' ? num / 1024 : num);
    if (/Initial/i.test(totalMatch[1])) state.bundle.initialKB = kb;
    else state.bundle.lazyKB = kb;
    return true;
  }
  const rowMatch = trimmed.match(BUNDLE_ROW_RX);
  if (rowMatch && state.bundle) {
    const file = rowMatch[1].trim();
    if (/^(Initial|Lazy)\s+(total|chunk)/i.test(file)) return false;
    const unit = rowMatch[4].toUpperCase();
    const raw = parseFloat(rowMatch[3]);
    const kb = unit === 'MB' ? raw * 1024 : unit === 'B' ? raw / 1024 : raw;
    state.bundle.files.push({ name: file, sizeKB: Math.round(kb * 10) / 10 });
    return false;
  }
  return false;
}

// Hard cap on the slice the regexes see: dev-server lines that matter (status
// banners, error heads, URLs) live in the first few hundred chars, and several
// matchers backtrack quadratically on long unbroken tokens (base64 blobs or
// minified-bundle dumps in stdout) — 2KB keeps the worst case under ~20ms.
const MAX_PARSE_LINE_CHARS = 2048;

export function parseLine(state: AppState, line: string, ctx?: ProfileParseContext): ParseResult | null {
  if (line.length > MAX_PARSE_LINE_CHARS) line = line.slice(0, MAX_PARSE_LINE_CHARS);
  const bareLoc = line.match(BARE_LOCATION_LINE_RX);
  const parenLoc = !bareLoc ? line.match(PAREN_LOCATION_RX) : null;
  const rustLoc = !bareLoc && !parenLoc ? line.match(RUST_LOCATION_RX) : null;
  const backfill = bareLoc ?? parenLoc ?? rustLoc;
  if (backfill && state.lastErrorHash) {
    const prevEntry = state.errors.get(state.lastErrorHash);
    if (prevEntry && (!prevEntry.parsed?.file)) {
      prevEntry.parsed = {
        ...(prevEntry.parsed ?? { message: prevEntry.message }),
        file: backfill[1],
        line: Number(backfill[2]),
        col: Number(backfill[3]),
      };
    }
  } else if (state.lastErrorHash) {
    const py = line.match(PY_TRACEBACK_RX);
    const rb = !py ? line.match(RB_LOCATION_RX) : null;
    if (py || rb) {
      const prevEntry = state.errors.get(state.lastErrorHash);
      if (prevEntry && (!prevEntry.parsed?.file)) {
        const m = (py ?? rb)!;
        prevEntry.parsed = {
          ...(prevEntry.parsed ?? { message: prevEntry.message }),
          file: m[1],
          line: Number(m[2]),
        };
      }
    } else if (ctx?.rules?.backfills) {
      // Per-profile continuation lines (traceback frames, "-->" locations,
      // stack frames). Later frames may refine an earlier fill: a Python
      // traceback's deepest File frame is the raising site, so profile
      // backfills overwrite a previous PROFILE fill but never a generic one.
      for (const rule of ctx.rules.backfills) {
        const m = line.match(rule.rx);
        if (!m) continue;
        const prevEntry = state.errors.get(state.lastErrorHash);
        if (prevEntry && (!prevEntry.parsed?.file || (prevEntry.parsed as any)._profileFill)) {
          prevEntry.parsed = {
            ...(prevEntry.parsed ?? { message: prevEntry.message }),
            file: m[rule.file],
            line: Number(m[rule.line]),
            ...(rule.col !== undefined && m[rule.col] ? { col: Number(m[rule.col]) } : {}),
            tool: ctx.rules.tool,
          };
          Object.defineProperty(prevEntry.parsed, '_profileFill', { value: true, enumerable: false });
        }
        break;
      }
    }
  }

  const trimmed = line.trim();
  if (!trimmed) return null;

  const prev = state.status;
  let statusChanged = false;
  let announcedUrl: string | undefined;

  let ann = detectAnnouncedUrl(trimmed);
  if (!ann && ctx?.urlRx) {
    // Profile URL extraction (M67): first capture group is the URL. Catches
    // announcements the generic patterns miss (Flask's "* Running on",
    // Astro's colon-less "Local http://...").
    const m = trimmed.match(ctx.urlRx);
    if (m?.[1]) {
      const raw = m[1].replace(/[),.;]+$/, '');
      if (/^https?:\/\//i.test(raw)) ann = rewriteHost(raw, '127.0.0.1');
    }
  }
  if (ann && !state.announcedUrl) {
    state.announcedUrl = ann;
    announcedUrl = ann;
  }

  const bundleUpdated = parseBundleLine(state, trimmed);
  let compileMs: number | undefined;

  if (SERVING_PATTERNS.some(rx => rx.test(trimmed)) || (ctx?.readinessRx?.test(trimmed) ?? false)) {
    const wasError = state.status === 'error' || !!state.recoveringFromError;
    if (state.status === 'compiling' || state.status === 'starting' || state.status === 'error') {
      const now = Date.now();
      if (state.compileStartedAt != null) {
        compileMs = now - state.compileStartedAt;
        state.lastCompileMs = compileMs;
        state.lastCompileAt = now;
        state.compileStartedAt = null;
        state.compileHistory.push(compileMs);
        if (state.compileHistory.length > 20) {
          state.compileHistory.splice(0, state.compileHistory.length - 20);
        }
      } else {
        state.lastCompileAt = now;
      }
    }
    state.status = 'serving';
    if (wasError) {
      state.errors.clear();
      state.recoveringFromError = false;
    }
  } else if (COMPILING_PATTERNS.some(rx => rx.test(trimmed))) {
    if (state.status === 'starting' || state.status === 'serving' || state.status === 'error') {
      if (state.status === 'error') state.recoveringFromError = true;
      state.compileStartedAt = Date.now();
      state.status = 'compiling';
    }
  }

  let errorResult: ParseResult['error'];
  // Lint patterns are specific enough to win over generic ERROR_PATTERNS (e.g.,
  // ruff "src/x.py:1:1: F401 …" would otherwise tip the generic
  // "<file>:<line>:<col>:" error rule). Check lint first; fall back to error;
  // then warning. Test against the raw line for lint so eslint's indentation
  // (which carries semantic weight) is preserved.
  const isLint = LINT_PATTERNS.some(rx => rx.test(line));
  const isError = !isLint && (
    ERROR_PATTERNS.some(rx => rx.test(trimmed))
    || (ctx?.rules?.errorRx?.some(rx => rx.test(trimmed)) ?? false)
  );
  const isWarning = !isLint && !isError && WARNING_PATTERNS.some(rx => rx.test(trimmed));
  if (isError || isWarning || isLint) {
    const hash = hashLine(trimmed);
    const now = Date.now();
    const existing = state.errors.get(hash);
    let isNew = false;
    let entry: ErrorEntry;
    if (existing) {
      existing.count += 1;
      existing.lastSeen = now;
      entry = existing;
    } else {
      entry = {
        message: trimmed,
        count: 1,
        firstSeen: now,
        lastSeen: now,
        parsed: parseStructuredWithProfile(trimmed, ctx),
        level: isLint ? 'lint' : isWarning ? 'warning' : 'error',
      };
      state.errors.set(hash, entry);
      isNew = true;
    }
    // Only errors get status-flip + the lastErrorHash backfill slot.
    // Warnings can still backfill (they record a hash) but never change status.
    state.lastErrorHash = hash;
    errorResult = { entry, isNew };
    if (isError) state.status = 'error';
  }

  statusChanged = state.status !== prev;
  return { statusChanged, error: errorResult, announcedUrl, bundleUpdated, compileMs };
}
