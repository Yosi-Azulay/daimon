// Per-process agent identity + soft-lock book-keeping. The CLI ships an
// `X-Daimon-Agent` header on every request; this module records who is calling
// the daemon, when they were last seen, and which app each agent currently
// owns. Two Claude sessions on the same machine can therefore see who started
// what without stepping on each other.

import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { daimonDir } from './daemon.js';

const AGENT_INACTIVE_MS = 5 * 60_000;
const DEFAULT_LOCK_TTL_MS = 30_000;

export interface AgentRecord {
  id: string;
  firstSeen: number;
  lastSeen: number;
  cwd: string | null;
  callCount: number;
}

export interface AppLock {
  app: string;
  agent: string;
  lockedAt: number;
  expiresAt: number;
}

// M124 (v1.6): the interaction ring tags each lock event's outcome so contention
// can be surfaced after the fact. 'denied' = an acquire refused because another
// agent held a live lock; 'steal-live' = a forced take over a live foreign lock;
// 'steal-expired' = a forced take when the prior lock had already expired (or
// none was held); 'acquired'/'handoff' are non-contended.
export type InteractionOutcome = 'acquired' | 'denied' | 'steal-live' | 'steal-expired' | 'handoff';

export interface AppInteraction {
  agent: string;
  at: number;
  action: string;
  outcome?: InteractionOutcome;
}

export interface AppContention {
  waits: number;             // acquires denied (another agent held the lock)
  stealsLive: number;        // forced takes over a live foreign lock
  stealsAfterExpiry: number; // forced takes after the prior lock expired
  longestHoldMs: number;     // longest observed single hold (first acquire → last refresh)
}

export interface AgentContention {
  waits: number;   // times THIS agent was denied
  steals: number;  // times THIS agent force-took a lock (live or after expiry)
}

export interface LockAnalytics {
  perApp: Map<string, AppContention>;
  perAgent: Map<string, AgentContention>;
}

// Stable, per-session agent id: <short-hostname>-<n>-<4hex>. Kept in env so a
// child process forks pick the same value rather than minting their own.
//
// The SESSION is the TERMINAL, not the process (v1.14 first-run fix). Minting
// a fresh random id per CLI invocation made two consecutive commands from one
// shell look like two competing agents: `daimon start web` took a 30s soft
// lock, and the `daimon stop web` typed a second later was DENIED by it — the
// first thing a stranger tries, refused by daimon's own coordination.
//
// Two properties this has to get right, and an earlier v1.14 attempt got both
// wrong, so they are spelled out:
//
//  1. The session key must actually be stable per terminal. `process.ppid`
//     ISN'T, in Git Bash / MSYS: that shell forks a real Windows process per
//     command, so the parent pid changes every invocation and a ppid-derived
//     id silently reverts to per-process. Terminal emulators publish a proper
//     per-session id (WT_SESSION, TERM_SESSION_ID, …) which IS stable there,
//     so those come first; ppid is the fallback for a bare cmd/PowerShell.
//  2. The suffix must be REAL entropy. Hashing the session key gave a value
//     fully determined by inputs already in the id, so on OS pid reuse two
//     genuinely different shells produced a BYTE-IDENTICAL id — and
//     `LockManager.acquire` then treats the second shell as the lock's owner
//     and silently REFRESHES it instead of denying: no denial, no steal, no
//     audit row. That turns the M124 multi-agent protection invisible rather
//     than merely permissive. So the suffix is random, minted once per session
//     and remembered (see rememberSessionId) — two sessions can still collide
//     with 1-in-65536 odds, exactly as they always could, but never
//     deterministically.
//
// Identity remains ADVISORY throughout: an unauthenticated header, never an
// authorization decision, and an explicit DAIMON_AGENT_ID always wins.
export function generateAgentId(): string {
  const cached = process.env.DAIMON_AGENT_ID;
  if (cached && cached.trim()) return cached.trim();
  const host = (os.hostname() || 'unknown').split('.')[0].toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 24) || 'host';
  const session = terminalSessionKey();
  const rand = () => crypto.randomBytes(2).toString('hex');

  let id: string;
  if (session) {
    const remembered = recallSessionId(session.key);
    if (remembered) {
      process.env.DAIMON_AGENT_ID = remembered;
      return remembered;
    }
    id = `${host}-${session.label}-${rand()}`;
    rememberSessionId(session.key, id);
  } else {
    // No terminal to key off (a daemon, a service, an unknown host shell):
    // per-process identity, exactly as before v1.14.
    id = `${host}-${process.pid}-${rand()}`;
  }
  process.env.DAIMON_AGENT_ID = id;
  return id;
}

// Env vars terminal emulators set once per session/tab, in preference order.
// Each is stable across invocations within one terminal and different between
// terminals — which is precisely the property ppid lacks under MSYS.
const SESSION_ENV_KEYS = [
  'WT_SESSION',        // Windows Terminal (per tab) — works in Git Bash too
  'TERM_SESSION_ID',   // macOS Terminal.app
  'ITERM_SESSION_ID',  // iTerm2
  'TMUX_PANE',         // tmux
  'SSH_TTY',           // an ssh login session
] as const;

// The session this CLI invocation belongs to: `key` identifies it uniquely,
// `label` is the short numeric-ish field that goes in the id.
function terminalSessionKey(): { key: string; label: string } | null {
  for (const name of SESSION_ENV_KEYS) {
    const v = process.env[name];
    if (v && v.trim()) {
      const key = `${name}:${v.trim()}`;
      // The middle field stays NUMERIC: it has been `<host>-<pid>-<4hex>` since
      // v1.6 and a test pins that shape, so a session id is folded down to a
      // number rather than widening the format. It is a display detail —
      // uniqueness lives in `key` plus the random suffix.
      const label = String(parseInt(crypto.createHash('sha256').update(key).digest('hex').slice(0, 6), 16));
      return { key, label };
    }
  }
  const ppid = typeof process.ppid === 'number' && process.ppid > 0 ? process.ppid : null;
  if (ppid !== null) return { key: `ppid:${ppid}`, label: String(ppid) };
  return null;
}

// Session → minted id, in daimon's own state dir. Entries expire so a recycled
// pid can never inherit an old shell's identity: past the TTL the key mints a
// fresh random id instead.
const SESSION_TTL_MS = 12 * 60 * 60_000;
const SESSION_FILE = 'cli-sessions.json';

// daemon.js is imported statically: it pulls in only node builtins plus
// version.js, does not import this module back, and the CLI already loads it
// on every invocation — so this costs nothing against the M148 startup diet.
function sessionStorePath(): string | null {
  try {
    return path.join(daimonDir(), SESSION_FILE);
  } catch {
    return null;
  }
}

function recallSessionId(key: string): string | null {
  const p = sessionStorePath();
  if (!p) return null;
  try {
    const store = JSON.parse(fs.readFileSync(p, 'utf8'));
    const hit = store?.[key];
    if (hit && typeof hit.id === 'string' && typeof hit.ts === 'number' && Date.now() - hit.ts < SESSION_TTL_MS) {
      return hit.id;
    }
  } catch { /* absent or unreadable — mint a fresh one */ }
  return null;
}

function rememberSessionId(key: string, id: string): void {
  const p = sessionStorePath();
  if (!p) return;
  try {
    let store: Record<string, { id: string; ts: number }> = {};
    try { store = JSON.parse(fs.readFileSync(p, 'utf8')) || {}; } catch {}
    const now = Date.now();
    for (const [k, v] of Object.entries(store)) {
      if (!v || typeof v.ts !== 'number' || now - v.ts >= SESSION_TTL_MS) delete store[k];
    }
    store[key] = { id, ts: now };
    fs.mkdirSync(path.dirname(p), { recursive: true });
    // tmp+rename: two shells can mint at the same moment, and a torn file here
    // would cost every session its identity (M88 atomic-write rule).
    const tmp = `${p}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(store, null, 2) + '\n', 'utf8');
    fs.renameSync(tmp, p);
  } catch { /* identity is advisory — never fail a command over it */ }
}

export class AgentRegistry {
  private readonly agents = new Map<string, AgentRecord>();

  touch(id: string, cwd: string | null, now = Date.now()): AgentRecord {
    let rec = this.agents.get(id);
    if (!rec) {
      rec = { id, firstSeen: now, lastSeen: now, cwd, callCount: 0 };
      this.agents.set(id, rec);
    }
    rec.lastSeen = now;
    if (cwd) rec.cwd = cwd;
    rec.callCount++;
    return rec;
  }

  list(now = Date.now()): AgentRecord[] {
    const out: AgentRecord[] = [];
    for (const rec of this.agents.values()) {
      if (now - rec.lastSeen <= AGENT_INACTIVE_MS) out.push({ ...rec });
    }
    return out.sort((a, b) => b.lastSeen - a.lastSeen);
  }

  prune(now = Date.now()): number {
    let removed = 0;
    for (const [id, rec] of this.agents) {
      if (now - rec.lastSeen > AGENT_INACTIVE_MS * 2) {
        this.agents.delete(id);
        removed++;
      }
    }
    return removed;
  }
}

// Widened from 16 (M124): analytics read the whole ring, so a slightly deeper
// per-app window gives better contention signal. Still memory-only, still
// bounded — no persistence, no new state.
const INTERACTION_RING = 64;

export class LockManager {
  private readonly locks = new Map<string, AppLock>();
  private readonly history = new Map<string, AppInteraction[]>();
  // Longest single observed hold per app (first acquire → last same-agent
  // refresh). Tracked as the lock refreshes since expired locks are never
  // explicitly released.
  private readonly longestHold = new Map<string, number>();

  constructor(private readonly ttlMs = DEFAULT_LOCK_TTL_MS) {}

  // Returns null when the lock was acquired (or refreshed by the same agent),
  // or the live AppLock when another agent currently holds it (a denial).
  acquire(app: string, agent: string, action: string, now = Date.now()): AppLock | null {
    const existing = this.locks.get(app);
    if (existing && existing.expiresAt > now && existing.agent !== agent) {
      this.recordInteraction(app, agent, action, now, 'denied');
      return { ...existing };
    }
    // Same-agent refresh keeps the original lockedAt so a hold's duration spans
    // first acquire → last refresh; a fresh/expired lock starts a new hold.
    const refresh = existing && existing.agent === agent && existing.expiresAt > now;
    const lockedAt = refresh ? existing!.lockedAt : now;
    const next: AppLock = { app, agent, lockedAt, expiresAt: now + this.ttlMs };
    this.locks.set(app, next);
    this.noteHold(app, now - lockedAt);
    this.recordInteraction(app, agent, action, now, 'acquired');
    return null;
  }

  // Force-take a lock regardless of holder. Used by --steal and by handoff.
  steal(app: string, agent: string, action: string, now = Date.now()): AppLock {
    const existing = this.locks.get(app);
    const outcome: InteractionOutcome =
      existing && existing.agent !== agent && existing.expiresAt > now ? 'steal-live' : 'steal-expired';
    this.recordInteraction(app, agent, action, now, outcome);
    const next: AppLock = { app, agent, lockedAt: now, expiresAt: now + this.ttlMs };
    this.locks.set(app, next);
    return next;
  }

  handoff(app: string, toAgent: string, fromAgent: string | null, now = Date.now()): AppLock {
    this.recordInteraction(app, toAgent, `handoff${fromAgent ? `<-${fromAgent}` : ''}`, now, 'handoff');
    const next: AppLock = { app, agent: toAgent, lockedAt: now, expiresAt: now + this.ttlMs };
    this.locks.set(app, next);
    return next;
  }

  current(app: string, now = Date.now()): AppLock | null {
    const l = this.locks.get(app);
    if (!l) return null;
    if (l.expiresAt <= now) { this.locks.delete(app); return null; }
    return { ...l };
  }

  list(now = Date.now()): AppLock[] {
    const out: AppLock[] = [];
    for (const l of this.locks.values()) {
      if (l.expiresAt > now) out.push({ ...l });
    }
    return out;
  }

  recentInteractions(app: string, limit = 3): AppInteraction[] {
    const arr = this.history.get(app) ?? [];
    return arr.slice(-limit).reverse();
  }

  // Contention analytics (M124), derived from the in-memory ring — session-
  // scoped (denials are never persisted; durable live-steal counts come from
  // `steal:<app>` audit rows). Longest hold folds in any currently-live hold.
  analytics(now = Date.now()): LockAnalytics {
    const perApp = new Map<string, AppContention>();
    const perAgent = new Map<string, AgentContention>();
    for (const [app, ring] of this.history) {
      const a: AppContention = { waits: 0, stealsLive: 0, stealsAfterExpiry: 0, longestHoldMs: this.longestHold.get(app) ?? 0 };
      for (const it of ring) {
        if (it.outcome === 'denied') a.waits++;
        else if (it.outcome === 'steal-live') a.stealsLive++;
        else if (it.outcome === 'steal-expired') a.stealsAfterExpiry++;
        if (it.outcome === 'denied' || it.outcome === 'steal-live' || it.outcome === 'steal-expired') {
          const ag = perAgent.get(it.agent) ?? { waits: 0, steals: 0 };
          if (it.outcome === 'denied') ag.waits++; else ag.steals++;
          perAgent.set(it.agent, ag);
        }
      }
      const live = this.locks.get(app);
      if (live && live.expiresAt > now) a.longestHoldMs = Math.max(a.longestHoldMs, now - live.lockedAt);
      perApp.set(app, a);
    }
    return { perApp, perAgent };
  }

  private noteHold(app: string, ms: number): void {
    if (ms > (this.longestHold.get(app) ?? 0)) this.longestHold.set(app, ms);
  }

  private recordInteraction(app: string, agent: string, action: string, now: number, outcome?: InteractionOutcome): void {
    const arr = this.history.get(app) ?? [];
    arr.push({ agent, at: now, action, outcome });
    while (arr.length > INTERACTION_RING) arr.shift();
    this.history.set(app, arr);
  }
}
