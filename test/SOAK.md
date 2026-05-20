# daimon soak procedure (M42 — F3 + F7)

These soaks are **not** part of `npm test` (they take hours), but are reproducible.

## F3 — Daemon crash auto-recovery soak (manual)

Goal: confirm the daemon respawns cleanly after random kills, with no orphan PIDs and no stale locks.

1. Start the daemon: `daimon daemon start --detach`.
2. In a loop (suggested: 30 iterations):
   - Read the PID via `daimon daemon status`.
   - Kill the PID with `SIGKILL` (Windows: `taskkill /PID <pid> /F`).
   - Pause 2 s.
   - Run `daimon list` — it must auto-spawn a fresh daemon and return apps.
   - Assert: a single daemon process by name; no stale `~/.daimon/daemon.lock` from the killed run.
3. Vary the kill point: during cold start, during a state-handoff window (after `POST /api/snapshot-state`),
   and during a sticky-port allocation.

Acceptance: every iteration recovers; no orphan PIDs survive (`tasklist /FI "IMAGENAME eq node.exe"`
shows ≤1 daemon process).

## F7 — 24h memory soak (manual)

Goal: confirm < 10% RSS growth over 24 h with 5 simulated apps running.

1. Configure 5 lightweight apps in `daimon.config.json` (a static-server harness is fine).
2. `daimon up <profile>` — bring them all to `serving`.
3. Capture baseline RSS: `daimon self | jq '.rssMB'` (M43 endpoint).
4. Leave running for 24 h with the apps emitting periodic log lines and intermittent errors.
5. Re-capture RSS and compare. Acceptance: `(rss_24h - rss_0) / rss_0 < 0.10`.

Tooling note: M43's `self_metrics` table persists rssMB / heapUsedMB / eventLoopLagMs every minute.
Pull the curve with `sqlite3 ~/.daimon/history.db 'SELECT * FROM self_metrics ORDER BY ts'`.
