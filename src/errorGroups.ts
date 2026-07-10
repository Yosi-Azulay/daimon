// Error grouping by stack fingerprint (M72). Groups deduplicated error
// entries across apps: same source location (file:line[:code]) — or, when
// unparsed, the same number-normalized message — folds into one group with
// count, first/last-seen and the affected apps.

import crypto from 'node:crypto';
import type { ErrorEntry, IssueLevel, ParsedError } from './types.js';

export interface ErrorGroup {
  fingerprint: string;
  message: string;
  parsed?: ParsedError;
  level: IssueLevel;
  count: number;
  firstSeen: number;
  lastSeen: number;
  apps: string[];
  // Individual entries folded into the group, newest first.
  instances: { app: string; message: string; count: number; firstSeen: number; lastSeen: number; parsed?: ParsedError }[];
}

export function fingerprintOf(e: ErrorEntry): string {
  const p = e.parsed;
  if (p?.file && p.line != null) {
    return `${p.file}:${p.line}${p.code ? `:${p.code}` : ''}`;
  }
  // Volatile bits (counters, addresses, durations) must not split groups.
  const norm = e.message
    .replace(/0x[0-9a-fA-F]+/g, '#')
    .replace(/\d+/g, '#')
    .trim()
    .toLowerCase();
  return 'msg:' + crypto.createHash('sha1').update(norm).digest('hex').slice(0, 12);
}

export function groupErrors(perApp: { app: string; errors: ErrorEntry[] }[]): ErrorGroup[] {
  const groups = new Map<string, ErrorGroup>();
  for (const { app, errors } of perApp) {
    for (const e of errors) {
      const fp = fingerprintOf(e);
      let g = groups.get(fp);
      if (!g) {
        g = {
          fingerprint: fp,
          message: e.message,
          parsed: e.parsed,
          level: e.level ?? 'error',
          count: 0,
          firstSeen: e.firstSeen,
          lastSeen: e.lastSeen,
          apps: [],
          instances: [],
        };
        groups.set(fp, g);
      }
      g.count += e.count;
      g.firstSeen = Math.min(g.firstSeen, e.firstSeen);
      g.lastSeen = Math.max(g.lastSeen, e.lastSeen);
      if (!g.apps.includes(app)) g.apps.push(app);
      g.instances.push({ app, message: e.message, count: e.count, firstSeen: e.firstSeen, lastSeen: e.lastSeen, parsed: e.parsed });
    }
  }
  const out = [...groups.values()];
  for (const g of out) g.instances.sort((a, b) => b.lastSeen - a.lastSeen);
  out.sort((a, b) => b.lastSeen - a.lastSeen);
  return out;
}
