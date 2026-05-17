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

export function appendAuditEntry(remoteIp: string, prevRaw: any, nextRaw: any, changedKeys: string[]): void {
  const p = auditPath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  rotateIfNeeded(p);
  const diff = JSON.stringify({ prev: prevRaw, next: nextRaw });
  const sha1 = crypto.createHash('sha1').update(diff).digest('hex').slice(0, 12);
  const line = `${new Date().toISOString()}\t${remoteIp}\t${sha1}\t${changedKeys.join(',')}\n`;
  try { fs.appendFileSync(p, line); } catch {}
}
