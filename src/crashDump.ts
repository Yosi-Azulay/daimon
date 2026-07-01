import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DAIMON_VERSION } from './version.js';
import { daimonDir } from './daemon.js';
import type { Registry } from './registry.js';
import type { AppmanConfig } from './types.js';

const REDACT_KEY = /key|secret|token|password|pass/i;

function redactedConfig(cfg: AppmanConfig | null): any {
  if (!cfg) return null;
  const clone: any = JSON.parse(JSON.stringify(cfg));
  if (clone.apiToken) clone.apiToken = '***';
  if (clone.overrides) {
    for (const n of Object.keys(clone.overrides)) {
      const env = clone.overrides[n]?.env;
      if (env) for (const k of Object.keys(env)) if (REDACT_KEY.test(k)) env[k] = '***';
    }
  }
  return clone;
}

// Dev servers routinely echo connection strings, tokens, and env values to
// stdout. Those lines land verbatim in the crash dump on disk, so mask the
// common secret shapes before writing: credentials embedded in URLs, and
// `secret-ish-key = value` assignments. Best-effort — it can't catch every
// format, but it removes the obvious leaks.
const URL_CREDS_RX = /(\b[a-z][a-z0-9+.-]*:\/\/)[^\s:@/]+:[^\s@/]+@/gi;
const SECRET_ASSIGN_RX = /\b([A-Za-z0-9_.-]*(?:key|secret|token|password|passwd|pwd|auth)[A-Za-z0-9_.-]*)(\s*[=:]\s*)(["']?)([^\s"']+)\3/gi;

export function redactLogLine(line: string): string {
  return line
    .replace(URL_CREDS_RX, '$1***:***@')
    .replace(SECRET_ASSIGN_RX, (_m, k, sep, q) => `${k}${sep}${q}***${q}`);
}

function recentDaemonLogLines(registry: Registry | null, max = 200): string[] {
  if (!registry) return [];
  const lines: { ts: number; line: string }[] = [];
  for (const name of registry.names()) {
    const s = registry.getState(name);
    if (!s) continue;
    for (const entry of s.logBuffer) lines.push({ ts: entry.ts, line: `[${name}] ${redactLogLine(entry.line)}` });
  }
  lines.sort((a, b) => a.ts - b.ts);
  return lines.slice(-max).map(e => e.line);
}

function crashesDir(): string {
  const d = path.join(daimonDir(), 'crashes');
  fs.mkdirSync(d, { recursive: true });
  return d;
}

export function writeCrashDump(err: unknown, registry: Registry | null, config: AppmanConfig | null): string {
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const file = path.join(crashesDir(), `${ts}.txt`);
  const e: any = err;
  const parts = [
    `daimon crash dump @ ${new Date().toISOString()}`,
    `version: ${DAIMON_VERSION}`,
    `node: ${process.version}`,
    `platform: ${process.platform} ${os.release()}`,
    `cwd: ${process.cwd()}`,
    `pid: ${process.pid}`,
    '',
    'ERROR:',
    e?.stack || String(e),
    '',
    'CONFIG (redacted):',
    JSON.stringify(redactedConfig(config), null, 2),
    '',
    'RECENT LOG (last 200 lines across apps):',
    ...recentDaemonLogLines(registry, 200),
  ];
  try { fs.writeFileSync(file, parts.join('\n')); } catch {}
  return file;
}

export function installCrashHandlers(opts: { getRegistry: () => Registry | null; getConfig: () => AppmanConfig | null }): void {
  const onFatal = (err: unknown) => {
    let file: string | null = null;
    try { file = writeCrashDump(err, opts.getRegistry(), opts.getConfig()); } catch {}
    try { process.stderr.write(`[daimon] fatal: ${(err as any)?.stack || err}\n`); } catch {}
    if (file) try { process.stderr.write(`[daimon] crash dump: ${file}\n`); } catch {}
    process.exit(1);
  };
  process.on('uncaughtException', onFatal);
  process.on('unhandledRejection', onFatal as any);
}
