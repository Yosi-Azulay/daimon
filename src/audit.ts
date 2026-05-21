import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import { daimonDir } from './daemon.js';

const MAX_BYTES = 1_000_000;

function auditPath(): string {
  return path.join(daimonDir(), 'audit.log');
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

export function appendAuditEntry(remoteIp: string, prevRaw: any, nextRaw: any, changedKeys: string[], cwd: string | null = null): void {
  const p = auditPath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  rotateIfNeeded(p);
  const diff = JSON.stringify({ prev: prevRaw, next: nextRaw });
  const sha1 = crypto.createHash('sha1').update(diff).digest('hex').slice(0, 12);
  // Tab-delimited columns: ts \t remote \t sha1 \t changedKeys \t cwd. The
  // trailing cwd is the X-Daimon-Cwd value the CLI sent (empty when missing),
  // which lets you tell two agents apart when they share an IP (always).
  const line = `${new Date().toISOString()}\t${remoteIp}\t${sha1}\t${changedKeys.join(',')}\t${cwd ?? ''}\n`;
  try { fs.appendFileSync(p, line); } catch {}
}
