// Error grouping by stack fingerprint (M72). Groups deduplicated error
// entries across apps: same source location (file:line[:code]) — or, when
// unparsed, the same number-normalized message — folds into one group with
// count, first/last-seen and the affected apps.

import crypto from 'node:crypto';
import type { ErrorEntry, IssueLevel, ParsedError } from './types.js';
import type { ParsedQuery } from './searchQuery.js';
import type { SearchHit } from './history.js';

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

/**
 * Error-group hits for the unified search scope (M180, v1.16).
 *
 * PURE, and deliberately a matcher over ALREADY-FOLDED groups: error groups are
 * derived live from the registry (the `GET /api/errors?group=fingerprint`
 * shape), so there is nothing to index and nothing new to store. Callers fold
 * first with `groupErrors()`, then filter here — the same composition-over-new-
 * state discipline the report and export bundles use.
 *
 * Semantics, matching the other stores: every text token must appear somewhere
 * in the group's searchable text (message + source file), matching is
 * case-insensitive substring (a "quoted phrase" is one contiguous substring),
 * `app:` matches any app the group was seen in, `level:` matches the group's
 * own severity, and the time bounds test the group's span — a group is "in the
 * window" when it was last seen at/after `after:` and first seen at/before
 * `before:`.
 */
export function searchErrorGroups(groups: ErrorGroup[], q: ParsedQuery, limit: number): SearchHit[] {
  const tokens = [...q.phrases, ...q.terms]
    // A trailing `*` is the FTS prefix marker; here every match is already a
    // substring, so the marker is simply dropped rather than matched literally.
    .map(t => (t.length > 1 && t.endsWith('*') ? t.slice(0, -1) : t))
    .filter(Boolean)
    .map(t => t.toLowerCase());
  const out: SearchHit[] = [];
  for (const g of groups) {
    if (q.app && !g.apps.includes(q.app)) continue;
    if (q.level && g.level !== q.level) continue;
    if (q.after != null && g.lastSeen < q.after) continue;
    if (q.before != null && g.firstSeen > q.before) continue;
    const hay = `${g.message} ${g.parsed?.file ?? ''}`.toLowerCase();
    if (tokens.length && !tokens.every(t => hay.includes(t))) continue;
    out.push({
      kind: 'error-groups',
      app: g.apps[0] ?? '',
      ts: g.lastSeen,
      snippet: `×${g.count} ${g.message.slice(0, 160)}`,
      ref: `errgroup:${g.fingerprint}`,
    });
    if (out.length >= limit) break;
  }
  return out;
}
