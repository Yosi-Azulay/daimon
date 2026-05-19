import crypto from 'node:crypto';
import type { AppState, ErrorEntry, ParsedError, ParserTool } from './types.js';

const SERVING_PATTERNS = [
  /Local:\s+http/i,
  /Application bundle generation complete/i,
  /compiled successfully/i,
  /webpack compiled\s+(?:successfully|in\b)/i,
  /Angular Live Development Server is listening/i,
  /Storybook\s+[\d.]+\s+(?:for\s+\S+\s+)?started/i,
  /VITE\s+v[\d.]+\s+ready/i,
];

const COMPILING_PATTERNS = [
  /Building\.\.\./i,
  /Compilation started/i,
  /Initial chunk files/i,
  /Compiling/i,
];

const ERROR_PATTERNS = [
  /^\s*ERROR\b/,
  /\berror TS\d+/,
  /✘/,
  /\[ERROR\]/,
  /Cannot find module/i,
  /^FAIL\s+\S+/,
  /^\s*●\s+/,
  /^\s*>\s+NX\s+.*failed/i,
  /\bModule not found:/,
  /\[vite\]\s+(?:Internal server error|Pre-transform error)/i,
  /\[plugin:[^\]]+\]/i,
  /^\s*ERR!\s+/,
  /^\s*(?:Uncaught\s+)?(?:Error|TypeError|SyntaxError|ReferenceError|RangeError):\s+/,
];

const TS_CODE_RX = /\berror TS(\d+)/;
const ESBUILD_TS_RX = /✘\s*\[ERROR\]\s*TS(\d+)/;
const LOCATION_RX = /([A-Z]:[\\/][^\s:()]+|[^\s:()]+\.(?:tsx?|jsx?|mjs|cjs|vue|svelte)):(\d+):(\d+)/;
// Stack-trace style: "at handler (D:\\app\\src\\index.ts:42:10)" or "at file:///D:/...:42:10".
const PAREN_LOCATION_RX = /\(([A-Z]:[\\/][^\s:()]+|[^\s:()]+\.(?:tsx?|jsx?|mjs|cjs|vue|svelte)):(\d+):(\d+)\)/;
// TSC report format: "src/foo.ts(10,3): error TS2322: ...".
const TSC_LOCATION_RX = /([A-Z]:[\\/][^\s:()]+|[^\s:()]+\.(?:tsx?|jsx?|mjs|cjs|vue|svelte))\((\d+),(\d+)\)\s*:/;
// Jest "FAIL src/foo.test.ts" — captures file only.
const JEST_FAIL_FILE_RX = /^FAIL\s+(\S+\.(?:tsx?|jsx?|mjs|cjs))(?:\s|$)/;
// Webpack "ERROR in ./src/foo.ts[:L:C]" or "ERROR in ./src/foo.ts L:C" — captures file (and L:C when present).
const WEBPACK_ERROR_RX = /^ERROR in\s+(\S+\.(?:tsx?|jsx?|mjs|cjs|vue|svelte))(?:[:\s](\d+):(\d+))?/;
// Esbuild prints the file path on its own indented line just below the error line:
//   ✘ [ERROR] TS2724: ...
//       apps/editor/src/app/app.ts:3:9:
// Match a whole-line "<path>:<line>:<col>:" with optional indentation and trailing colon.
const BARE_LOCATION_LINE_RX = /^\s+([A-Z]:[\\/][^\s:()]+|[^\s:()]+\.(?:tsx?|jsx?|mjs|cjs|vue|svelte)):(\d+):(\d+):?\s*$/;

const TOOL_RULES: { tool: ParserTool; rx: RegExp }[] = [
  { tool: 'vite', rx: /\[vite\]|\[plugin:vite:|transformWithEsbuild/i },
  { tool: 'storybook', rx: /\bstorybook\b|^\s*ERR!\s|builder-vite/i },
  { tool: 'jest', rx: /^FAIL\s|^\s*●\s+|\bjest\b/i },
  { tool: 'nx', rx: />\s+NX\s+|Failed tasks:|Nx errored/i },
  { tool: 'webpack', rx: /\bModule not found:|webpack compiled|webpack-dev-server/i },
  { tool: 'esbuild', rx: /✘\s*\[ERROR\]|esbuild/i },
  { tool: 'typescript', rx: /\berror TS\d+/ },
  { tool: 'node', rx: /^\s*(?:Uncaught\s+)?(?:Error|TypeError|SyntaxError|ReferenceError|RangeError):/ },
];

function detectTool(line: string): ParserTool | undefined {
  for (const { tool, rx } of TOOL_RULES) {
    if (rx.test(line)) return tool;
  }
  return undefined;
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
    }
  }
  const tool = detectTool(line);
  if (tool) out.tool = tool;
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

export function parseLine(state: AppState, line: string): ParseResult | null {
  // Back-fill: an indented "path:line:col:" line right after an error patches its parsed location.
  const bareLoc = line.match(BARE_LOCATION_LINE_RX);
  const parenLoc = !bareLoc ? line.match(PAREN_LOCATION_RX) : null;
  const backfill = bareLoc ?? parenLoc;
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
  }

  const trimmed = line.trim();
  if (!trimmed) return null;

  const prev = state.status;
  let statusChanged = false;
  let announcedUrl: string | undefined;

  const ann = detectAnnouncedUrl(trimmed);
  if (ann && !state.announcedUrl) {
    state.announcedUrl = ann;
    announcedUrl = ann;
  }

  const bundleUpdated = parseBundleLine(state, trimmed);
  let compileMs: number | undefined;

  if (SERVING_PATTERNS.some(rx => rx.test(trimmed))) {
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
  if (ERROR_PATTERNS.some(rx => rx.test(trimmed))) {
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
        parsed: parseStructured(trimmed),
      };
      state.errors.set(hash, entry);
      isNew = true;
    }
    state.lastErrorHash = hash;
    errorResult = { entry, isNew };
    state.status = 'error';
  }

  statusChanged = state.status !== prev;
  return { statusChanged, error: errorResult, announcedUrl, bundleUpdated, compileMs };
}
