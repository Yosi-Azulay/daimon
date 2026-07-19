# daimon v1.9.0 — "Everywhere"

daimon was built on Windows, and it showed in the corners nobody audited: a port
scanner that spoke `netstat` fluently but returned **nothing** on Linux, a remedy
that told a Mac user to run `taskkill`, and a dozen `process.platform` branches
with exactly one tested side. Worse, the test suite was quietly complicit —
platform-conditional tests passed vacuously off-platform, so a green run on this
Windows machine proved nothing about the other half of the installs. v1.9 is
**certification**: every platform branch inventoried and grep-gated, the POSIX
side exercised against recorded real tool output, every off-platform skip made
loud and counted, and a support matrix that says exactly what is verified, what
is fixture-verified, and what is merely hoped.

**A no-migration release.** No schema, config, or dependency changes. A v1.8
`history.db` and `state.json` open clean both directions. Every new surface ships
tier `experimental`; no frozen shape changed.

```sh
sh scripts/platform-smoke.sh        # ~2-min PASS/FAIL probe for a real Mac/Linux box
sh scripts/platform-smoke.sh --dry-run   # plumbing only, safe on any host
npm run build:docs                  # renders the platform-branch audit table
```

## What's new

- **The Linux port-scan bug, fixed (M140)** — `scanListeningPorts`' `ss -ltnp`
  parser matched the **Recv-Q** column (`0`) on every standard line and returned
  an empty map, so `daimon ports` never found a holder on its primary POSIX
  platform. It is now field-addressed (the local endpoint is the first field
  ending in `:<numeric-port>`), robust to the leading `Netid` column BusyBox /
  container `ss` prints, and fixture-gated. This is the flagship "one tested side"
  defect the audit was designed to surface.

- **Platform-branch inventory + completeness gate (M140, experimental)** — every
  `process.platform` / `os.platform()` fork is a row in `src/platformInventory.ts`
  (file:symbol → Windows behavior → POSIX behavior → how each side is tested →
  named gap → verdict). It renders as the docs "Platform support" table straight
  from the data, and `test/platform-inventory.test.mjs` greps compiled `dist/` for
  every platform token and **fails if one is missing from the table** — the
  inventory can never rot. No row may have a blank gap; every `bug` row documents
  its fix.

- **POSIX fixtures + injectable seam (M141, experimental)** — `portDiag.ts`'s
  scan/holder functions take an injectable command-runner (default: real
  `spawnSync`), so tests feed **recorded** `ss` / `lsof` / `netstat` / `ps` /
  PowerShell output through the exact production parse path — no test-only fork.
  `test/fixtures/platform/<tool>/` carries the samples (with no-permission, IPv6,
  and container variants) + provenance notes, and `test/port-forensics.test.mjs`
  runs every assertion in parity as `win32` and `linux`/`darwin`. Non-port seams
  (`frameworks.resolveCommand`, `serviceInstaller.buildServiceArtifact`,
  `doctor.isSystemDir`, `pathScope.normalizeForCompare`) gained an injectable
  `platform` parameter and both-branch tests.

- **Loud skips, no more vacuous green (M142, experimental)** — a
  `platformSkip(t, plat, note)` helper replaces every silent `if (isWin)`; a
  skipped test announces `requires <platform>: <what it would verify>`.
  `test/platform-skips.test.mjs` inventories every skip, asserts the set against a
  committed expectation, prints `# platform-skips: N` at the suite tail, and
  **fails if any test smuggles in a silent platform gate** — symmetric, so a
  future Mac/Linux run is equally honest.

- **Platform-aware remedies (M143, experimental)** — remedy phrasing matches the
  reader's OS through one helper (`src/platformRemedy.ts`): `taskkill /PID … /F`
  vs `kill …`, `netstat -ano | findstr` vs `lsof -iTCP:… -sTCP:LISTEN`. The
  EADDRINUSE port-conflict message names the right command on both branches; the
  M90 remedy audit stays green.

- **`scripts/platform-smoke.sh` (M143)** — a ~2-minute, zero-dependency PASS/FAIL
  probe for a real Mac/Linux box: daemon boot + `/api/signature`, real `ss`/`lsof`
  port scan, spawn + tree-kill of a process group (no orphans), notifier no-crash,
  env redaction spot-check, `daimon doctor`, TUI launch. Throwaway `DAIMON_HOME` +
  workspace (never touches the real `~/.daimon`); paste-able summary; `--dry-run`
  runs the plumbing on any host.

- **Honest support matrix (M144)** — the README gains a Windows/macOS/Linux ×
  feature table with `verified` / `fixture-verified` / `best-effort` statuses and
  footnotes; BSD and other incidental Node-20 platforms are labeled best-effort in
  those words.

## Migration

**None.** No schema, config, or dependency changes; nothing to migrate in either
direction.

## Before you publish

The fixtures verify the *parse logic*; only real hardware confirms the actual OS
tools behave as recorded. **Run `scripts/platform-smoke.sh` on a real macOS box
and a real Linux box and confirm PASS** before `npm publish`. Paste the summary
block into your notes — that is what upgrades a *fixture-verified* matrix cell to
*verified* for your platform.

## Gates at tag time

- tsc clean (root project); full suite **971 tests, 0 failing** (was 940 in v1.8).
- `# platform-skips: 2` (both `path-scope` Windows path-resolve tests), zero
  **silent** platform skips (accounting green).
- Contract + redaction + error-remedy suites green; no frozen shape moved.
- No dependency added; bundle within budget.

_The wall-clock suite runs ~70s on this machine (in line with v1.7/v1.8); the
"<40s quiet-machine" target remains an aspiration, not a regression._
