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

export interface AppInteraction {
  agent: string;
  at: number;
  action: string;
}

// Stable, per-session agent id: <short-hostname>-<pid>-<4hex>. Kept in env so a
// child process forks pick the same value rather than minting their own.
export function generateAgentId(): string {
  const cached = process.env.DAIMON_AGENT_ID;
  if (cached && cached.trim()) return cached.trim();
  const host = (os.hostname() || 'unknown').split('.')[0].toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 24) || 'host';
  const pid = process.pid;
  const rand = crypto.randomBytes(2).toString('hex');
  const id = `${host}-${pid}-${rand}`;
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

export class LockManager {
  private readonly locks = new Map<string, AppLock>();
  private readonly history = new Map<string, AppInteraction[]>();

  constructor(private readonly ttlMs = DEFAULT_LOCK_TTL_MS) {}

  // Returns null when the lock was acquired (or refreshed by the same agent),
  // or the live AppLock when another agent currently holds it.
  acquire(app: string, agent: string, action: string, now = Date.now()): AppLock | null {
    this.recordInteraction(app, agent, action, now);
    const existing = this.locks.get(app);
    if (existing && existing.expiresAt > now && existing.agent !== agent) {
      return { ...existing };
    }
    const next: AppLock = { app, agent, lockedAt: now, expiresAt: now + this.ttlMs };
    this.locks.set(app, next);
    return null;
  }

  // Force-take a lock regardless of holder. Used by --steal and by handoff.
  steal(app: string, agent: string, action: string, now = Date.now()): AppLock {
    this.recordInteraction(app, agent, action, now);
    const next: AppLock = { app, agent, lockedAt: now, expiresAt: now + this.ttlMs };
    this.locks.set(app, next);
    return next;
  }

  handoff(app: string, toAgent: string, fromAgent: string | null, now = Date.now()): AppLock {
    this.recordInteraction(app, toAgent, `handoff${fromAgent ? `<-${fromAgent}` : ''}`, now);
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

  private recordInteraction(app: string, agent: string, action: string, now: number): void {
    const arr = this.history.get(app) ?? [];
    arr.push({ agent, at: now, action });
    while (arr.length > 16) arr.shift();
    this.history.set(app, arr);
  }
}
