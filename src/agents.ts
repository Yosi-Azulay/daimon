// Per-process agent identity + soft-lock book-keeping. The CLI ships an
// `X-Daimon-Agent` header on every request; this module records who is calling
// the daemon, when they were last seen, and which app each agent currently
// owns. Two Claude sessions on the same machine can therefore see who started
// what without stepping on each other.

import os from 'node:os';
import crypto from 'node:crypto';

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

// Stable, per-session agent id: <short-hostname>-<pid>-<4hex>. Kept in env so a
// child process forks pick the same value rather than minting their own.
//
// The SESSION is the terminal, not the process (v1.14 first-run fix). Minting
// a fresh random id per CLI invocation made two consecutive commands from one
// shell look like two competing agents: `daimon start web` took a 30s soft
// lock, and the `daimon stop web` typed a second later was DENIED by it —
// the first thing a stranger tries, refused by daimon's own coordination.
// So the identity is derived from the parent process (the shell) instead:
// same terminal → same agent across invocations, while a second terminal, an
// editor, or a Claude Code session each still get their own identity and the
// multi-agent soft-lock protection that exists for them. Shape is unchanged
// (<host>-<n>-<4hex>) and identity remains ADVISORY — an unauthenticated
// header, never an authorization decision.
export function generateAgentId(): string {
  const cached = process.env.DAIMON_AGENT_ID;
  if (cached && cached.trim()) return cached.trim();
  const host = (os.hostname() || 'unknown').split('.')[0].toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 24) || 'host';
  const ppid = typeof process.ppid === 'number' && process.ppid > 0 ? process.ppid : null;
  // Deterministic 4-hex from the session key so the id is reproducible for the
  // same shell; random only when there is no parent to key off.
  const id = ppid !== null
    ? `${host}-${ppid}-${crypto.createHash('sha256').update(`${host}:${ppid}`).digest('hex').slice(0, 4)}`
    : `${host}-${process.pid}-${crypto.randomBytes(2).toString('hex')}`;
  process.env.DAIMON_AGENT_ID = id;
  return id;
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
