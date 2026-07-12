# Security

daimon is a **local-only** development tool. Its security posture is built on
never leaving your machine — this document states that posture precisely, and
what to do if you find a hole in it.

## Loopback only, by construction

The daemon binds `127.0.0.1` exclusively — the host is hard-coded, not
configurable. There is no remote mode, no multi-user mode, no cloud sync, and
no way to expose the API on another interface through configuration.
State-changing HTTP requests are additionally gated by a same-origin loopback
check (Host/Origin validation), so a web page you visit cannot drive
start/stop/config on the local daemon (CSRF / DNS-rebinding defense). An
optional `apiToken` config adds bearer-token auth on top for mutating calls.

## No telemetry, ever

daimon sends nothing anywhere: no analytics, no crash reporting, no update
checks, no phoning home of any kind. The only outbound network calls the
**daemon** ever makes are the **webhooks you configure yourself** (`webhooks`
in `daimon.config.json`) — to URLs you chose, with payloads you can inspect
in the docs. This is a permanent commitment, not a current state.

One precise caveat about the **dashboard page in your browser**: it loads the
Material Symbols icon font from Google Fonts (a single static-asset request
carrying nothing but the standard HTTP headers your browser always sends).
Since v0.14 that is the only third-party request — text fonts use your
system's font stack — and offline the app stays fully usable with icons
degrading to their names. Self-hosting a subset of the icon font is on the
v0.14.x list to bring this to zero.

## Env-file redaction: values die in the same tick

daimon reads convention env files (`.env` and friends) to power `daimon env`
awareness — and raw values are parsed, salted-hashed (per-install salt at
`~/.daimon/salt`, truncated), and **discarded inside the same function frame**.
Only key *names* and truncated hashes exist beyond that moment. No API
response, event, webhook, notification, log line, or CLI flag can ever emit a
value — there is deliberately no `--show-values`. A grep-style regression
suite (`test/env-awareness.test.mjs`) enforces this at every layer. daimon
never *edits* env files either; awareness is read-only.

## State confinement

daimon writes only to:

- `~/.daimon/*` (relocatable via `DAIMON_HOME`) — state, history DB, logs,
  snapshots, sessions;
- a local `daimon.config.json`, only through explicit, audited actions
  (`daimon init`, config PATCH, `pin-health --accept`) — each rewrite is
  atomic, keeps a `.bak`, and lands in the audit log.

It never edits your source code, never runs package installs, and
`daimon doctor --auto-fix` repairs only daimon's own state. Processes daimon
kills are only ones it can positively identify as its own (the verify-then-kill
rule: an unknown port holder is named and reported, never terminated).

## Plugin trust model

Doctor plug-ins are **opt-in and unsandboxed**: they run in-process with full
Node privileges. daimon only loads files you placed in `~/.daimon/plugins`
yourself, and each plug-in stays inert until its name is added to
`doctor.autoFix.permitted`. Treat a plug-in file like any other code you
choose to run — daimon does not confine it.

## Agent isolation is cooperative, not a boundary

Per-app soft-locks and agent identity headers (`X-Daimon-Agent`) exist so two
AI agents don't trample each other — they are a coordination mechanism, not a
security boundary. Anything on your machine that can reach 127.0.0.1 can talk
to the daemon (subject to the loopback/origin gate and `apiToken` if set).

## Reporting a vulnerability

Please report security issues via
[GitHub issues](https://github.com/Yosi-Azulay/daimon/issues) — or, for
anything sensitive, through the contact form at
[flycotech.com](https://flycotech.com). Reports that come with a reproduction
against a `DAIMON_HOME`-isolated daemon are the fastest to act on.
