import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import { daimonDir } from './daemon.js';

const MAX_BYTES = 1_000_000;

function auditPath(): string {
  return path.join(daimonDir(), 'audit.log');
}

// Neutralise the column/row delimiters so a field value (raw header or config
// key) can't inject extra tab-separated columns or forge a new row. Also drop
// commas from within a single changedKeys entry so the ',' join stays lossless.
function auditField(v: string): string {
  return v.replace(/\t/g, ' ').replace(/[\r\n]/g, ' ').replace(/,/g, ' ');
}

function rotateIfNeeded(p: string): void {
  try {
    const st = fs.statSync(p);
    if (st.size > MAX_BYTES) {
      const rotated = p + '.1';
      try { fs.unlinkSync(rotated); } catch {}
      fs.renameSync(p, rotated);
    }
  } catch {}
}

export function appendAuditEntry(
  remoteIp: string,
  prevRaw: any,
  nextRaw: any,
  changedKeys: string[],
  cwd: string | null = null,
  agent: string | null = null,
): void {
  const p = auditPath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  rotateIfNeeded(p);
  const diff = JSON.stringify({ prev: prevRaw, next: nextRaw });
  const sha1 = crypto.createHash('sha1').update(diff).digest('hex').slice(0, 12);
  // Tab-delimited columns: ts \t remote \t sha1 \t changedKeys \t cwd \t agent.
  // Old (5-col) rows still parse — agent is just absent. The agent column is
  // the X-Daimon-Agent header the CLI sends (a per-session `<host>-<pid>-<hex>`
  // id), which is the only reliable signal when two Claudes share an IP+cwd.
  // cwd/agent come from raw HTTP headers and changedKeys from config keys, any
  // of which could contain a TAB/newline and forge extra columns — strip the
  // delimiters so a field can never break out of its own column.
  const cols = [
    new Date().toISOString(),
    remoteIp,
    sha1,
    changedKeys.map(auditField).join(','),
    auditField(cwd ?? ''),
    auditField(agent ?? ''),
  ];
  const line = cols.join('\t') + '\n';
  try { fs.appendFileSync(p, line); } catch {}
}

export interface AuditEntry {
  ts: string;
  remote: string;
  sha1: string;
  changedKeys: string[];
  cwd: string | null;
  agent: string | null;
}

// Best-effort parser for both 5- and 6-column rows. Empty trailing columns are
// reported as null. Used by tests and `daimon doctor`'s audit-rotation rule.
export function parseAuditLine(line: string): AuditEntry | null {
  if (!line || !line.trim()) return null;
  const parts = line.replace(/\r?\n$/, '').split('\t');
  if (parts.length < 4) return null;
  const [ts, remote, sha1, keys, cwd, agent] = parts;
  return {
    ts,
    remote,
    sha1,
    changedKeys: keys ? keys.split(',').filter(Boolean) : [],
    cwd: cwd && cwd.length ? cwd : null,
    agent: agent && agent.length ? agent : null,
  };
}
