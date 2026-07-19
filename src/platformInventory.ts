// Platform-branch inventory (M140, v1.9 "Everywhere").
//
// daimon was built on Windows; this table is the honest audit of every place
// its behavior forks by operating system. It lives HERE, as data, next to the
// code it describes, so the docs render (scripts/build-docs.mjs) can never drift
// from the audit, and so test/platform-inventory.test.mjs can prove — by
// grepping dist/ for platform conditionals — that no branch escapes the table.
//
// `platformTokens` is the number of `process.platform` / `os.platform()`
// occurrences in the compiled code a row accounts for. The completeness gate
// sums these per file and fails if the total doesn't equal the tokens actually
// present in dist/. Behavior rows that fork via a library (tree-kill), a spawn
// shell, or a signal — not via a platform token — carry `platformTokens: 0`;
// they are documented for honesty but not counted by the grep gate.
//
// `verdict` is earned, not asserted (STABILITY of the support matrix depends on
// it):
//   verified            — a real test exercises this platform's own side here.
//   fixture             — a recorded-output / generated-artifact test (M141).
//   untestable-locally  — needs the smoke script on real hardware (M143); the
//                         decision is unit-tested, the OS effect is not.
//   bug                 — was wrong on POSIX; fixed in this release with a test.
//
// `gap` is mandatory and never empty: "none" is a named value, not a blank.

export type PlatformVerdict = 'verified' | 'fixture' | 'untestable-locally' | 'bug';

export interface PlatformBranch {
  /** Stable id (kebab) — deep links and test references. */
  id: string;
  /** Source file the branch lives in, repo-relative. */
  file: string;
  /** Function / symbol the branch is inside. */
  symbol: string;
  /** One-line description of what forks. */
  concern: string;
  /** Windows behavior. */
  windows: string;
  /** macOS/Linux behavior. */
  posix: string;
  /** How each side is exercised today (or the smoke probe that will). */
  tested: string;
  verdict: PlatformVerdict;
  /** Named remaining gap; "none" when there is genuinely nothing left. */
  gap: string;
  /** process.platform / os.platform() tokens in dist this row accounts for. */
  platformTokens: number;
}

export const PLATFORM_BRANCHES: PlatformBranch[] = [
  // --- Port forensics (the release's flagship POSIX surface) ---------------
  {
    id: 'portdiag-find-holder',
    file: 'src/portDiag.ts',
    symbol: 'findPortHolder',
    concern: 'Identify the process holding one TCP port (EADDRINUSE forensics).',
    windows: 'PowerShell Get-NetTCPConnection + Win32_Process → pid, name, cmd, start time.',
    posix: 'lsof -nP -iTCP:<port> -sTCP:LISTEN → pid + command; ps -o lstart= for start time.',
    tested: 'win32: live-listener test (ports.test.mjs). posix: recorded lsof/ps fixtures through the parser (port-forensics.test.mjs).',
    verdict: 'fixture',
    gap: 'Real lsof/ps availability + column layout confirmed only on hardware via scripts/platform-smoke.sh.',
    platformTokens: 1,
  },
  {
    id: 'portdiag-scan-listeners',
    file: 'src/portDiag.ts',
    symbol: 'scanListeningPorts',
    concern: 'One-shot scan of a whole port pool → which ports listen, by which pid.',
    windows: 'netstat -ano -p TCP, parsed by column (parseNetstatListen).',
    posix: 'ss -ltnp (parseSsListen, column-addressed) with an lsof fallback for macOS (parseLsofListen).',
    tested: 'win32: live-listener test. posix: recorded ss + lsof fixtures (incl. no-permission / IPv6 / container variants) through the real parsers.',
    verdict: 'bug',
    gap: 'FIXED this release: the ss parser matched the Recv-Q column and returned nothing on Linux; now field-indexed + fixture-gated. Remaining: real ss/lsof output confirmed on hardware via the smoke script.',
    platformTokens: 1,
  },
  {
    id: 'portdiag-remedy-phrasing',
    file: 'src/portDiag.ts',
    symbol: 'renderApiPortConflict',
    concern: 'The EADDRINUSE remedy names the platform-correct kill / inspect command.',
    windows: 'Suggests `taskkill /PID <pid> /F` and `netstat -ano | findstr :<port>`.',
    posix: 'Suggests `kill <pid>` and `lsof -iTCP:<port> -sTCP:LISTEN`.',
    tested: 'Both branches asserted in platform-remedies.test.mjs; the host branch also in ports.test.mjs.',
    verdict: 'verified',
    gap: 'none',
    platformTokens: 1,
  },
  {
    id: 'platform-remedy-helper',
    file: 'src/platformRemedy.ts',
    symbol: 'killCmd / inspectPortCmd / killHint',
    concern: 'Central platform-aware phrasing for kill and port-inspect commands.',
    windows: 'taskkill /PID … /F, netstat -ano | findstr.',
    posix: 'kill …, lsof -iTCP -sTCP:LISTEN.',
    tested: 'Every function asserted on both branches in platform-remedies.test.mjs.',
    verdict: 'verified',
    gap: 'none',
    platformTokens: 3,
  },
  // --- OS notifications ----------------------------------------------------
  {
    id: 'notifier-backend',
    file: 'src/notifier.ts',
    symbol: 'Notifier (constructor)',
    concern: 'Choose the OS notification backend.',
    windows: 'node-notifier + a WindowsToaster fallback (withFallback: true).',
    posix: 'node-notifier default (notify-send on Linux, terminal-notifier/osascript on macOS).',
    tested: 'Routing, batching, quiet-hours, and fail-soft are unit-tested via an injectable sink on both sides; real toast delivery is not simulated.',
    verdict: 'untestable-locally',
    gap: 'Actual notification delivery on a desktop session is smoke-script / manual only — never silent (warnOnce on failure).',
    platformTokens: 1,
  },
  // --- Suspicious-root guard ----------------------------------------------
  {
    id: 'doctor-system-dirs',
    file: 'src/doctor.ts',
    symbol: 'isSystemDir / suspiciousRootReason',
    concern: 'Flag a searchRoot pointed at a system directory.',
    windows: 'C:\\Windows, C:\\Program Files, C:\\Program Files (x86), C:\\ProgramData.',
    posix: '/usr, /etc, /bin, /sbin, /var, /system, /library, /opt/homebrew.',
    tested: 'Both lists are unit-tested via the injectable platform parameter (doctor.test.mjs).',
    verdict: 'verified',
    gap: 'none',
    platformTokens: 1,
  },
  // --- Path case-folding ---------------------------------------------------
  {
    id: 'pathscope-casefold',
    file: 'src/pathScope.ts',
    symbol: 'normalizeForCompare / isPathUnder',
    concern: 'Case-fold decision for "is path X under Y" comparisons.',
    windows: 'Lowercases (NTFS is case-insensitive by default).',
    posix: 'Preserves case (paths are case-sensitive).',
    tested: 'The case-fold branch is unit-tested via the injectable platform parameter, both in normalizeForCompare and isPathUnder (pathscope.test.mjs).',
    verdict: 'verified',
    gap: 'node\'s path.resolve semantics (drive letters, symlinks) are host-bound; the fold decision is proven, real POSIX resolution is exercised on hardware.',
    platformTokens: 2,
  },
  // --- Framework launch command variants -----------------------------------
  {
    id: 'frameworks-command-variant',
    file: 'src/frameworks.ts',
    symbol: 'resolveCommand',
    concern: 'Pick the OS-specific launch command for a framework.',
    windows: 'commandCandidates[].win32 (mvnw.cmd, gradlew.cmd) and win32Command (ruby bin/rails).',
    posix: 'The base command (./mvnw, ./gradlew, bin/rails).',
    tested: 'Both platforms run through the parameterized frameworks suite via the injectable platform argument (frameworks.test.mjs).',
    verdict: 'verified',
    gap: 'none',
    platformTokens: 1,
  },
  // --- Test command resolution --------------------------------------------
  {
    id: 'testrunners-resolve',
    file: 'src/testRunners.ts',
    symbol: 'resolveTestCommand',
    concern: 'Resolve the test command for an app.',
    windows: 'Same command as POSIX (python -m pytest, go test ./..., npx …).',
    posix: 'Same command as Windows.',
    tested: 'Parameterized by the injectable platform argument; commands are platform-identical so both branches assert equality (testrunners.test.mjs).',
    verdict: 'verified',
    gap: 'none — the platform parameter is reserved; test invocation is OS-identical (the shell handles .cmd resolution).',
    platformTokens: 1,
  },
  // --- Service manifest ----------------------------------------------------
  {
    id: 'service-artifact',
    file: 'src/serviceInstaller.ts',
    symbol: 'buildServiceArtifact',
    concern: 'Generate the OS service manifest + install command.',
    windows: 'WinSW-style XML + nssm install command.',
    posix: 'launchd plist (macOS) or systemd --user unit (Linux), with the matching launchctl/systemctl command.',
    tested: 'All three manifest bodies + paths are generated and asserted via the injectable platform parameter (service-installer.test.mjs).',
    verdict: 'fixture',
    gap: 'Manifest CONTENT is verified for all three; actually loading it (launchctl/systemctl/nssm) is smoke-script / manual on hardware.',
    platformTokens: 1,
  },
  // --- Crash dump platform record -----------------------------------------
  {
    id: 'crashdump-platform-line',
    file: 'src/crashDump.ts',
    symbol: 'writeCrashDump',
    concern: 'Record the host platform in a crash dump (no branch — a recorded field).',
    windows: 'Writes "platform: win32 <release>".',
    posix: 'Writes "platform: linux|darwin <release>".',
    tested: 'The dump shape (including the platform line) is asserted in crash-forensics.test.mjs on the host platform.',
    verdict: 'verified',
    gap: 'none',
    platformTokens: 1,
  },
  // --- Dashboard opener (CLI) ---------------------------------------------
  {
    id: 'cli-dashboard-opener',
    file: 'src/cli.ts',
    symbol: 'run (dashboard verb)',
    concern: 'Open the dashboard URL in the default browser.',
    windows: 'spawn("cmd", ["/c", "start", "", url]).',
    posix: 'spawn("open", …) on macOS, spawn("xdg-open", …) on Linux.',
    tested: 'Fire-and-forget, best-effort (always prints the URL as fallback); the spawn itself is not asserted.',
    verdict: 'untestable-locally',
    gap: 'Browser launch is smoke-script / manual; failure is non-fatal by design (the URL is always printed).',
    platformTokens: 3,
  },
  {
    id: 'cli-info-platform-field',
    file: 'src/cli.ts',
    symbol: 'run (version/info)',
    concern: 'Report the host platform in `daimon --version` info (no branch).',
    windows: 'Emits "platform": "win32".',
    posix: 'Emits "platform": "linux" | "darwin".',
    tested: 'Info payload shape is covered by the CLI surface tests on the host platform.',
    verdict: 'verified',
    gap: 'none',
    platformTokens: 1,
  },
  // --- TUI opener + editor -------------------------------------------------
  {
    id: 'tui-opener',
    file: 'src/tui/App.tsx',
    symbol: 'openUrl',
    concern: 'Open a URL from the TUI (o chord).',
    windows: 'cmd /c start.',
    posix: 'open (macOS) / xdg-open (Linux).',
    tested: 'Fire-and-forget, best-effort; not asserted (the TUI is Ink and not unit-mounted for spawns).',
    verdict: 'untestable-locally',
    gap: 'Browser launch is smoke-script / manual; failure is swallowed by design.',
    platformTokens: 2,
  },
  {
    id: 'tui-editor-default',
    file: 'src/tui/App.tsx',
    symbol: 'input handler (V chord)',
    concern: 'Default $EDITOR for the inline config editor.',
    windows: 'notepad.',
    posix: 'vi.',
    tested: 'The default choice is trivial; the editor spawn (spawnSync, shell: true) is interactive and not unit-tested.',
    verdict: 'untestable-locally',
    gap: 'Editor launch is manual; $EDITOR override is honored first on every platform.',
    platformTokens: 1,
  },

  // === Behavior rows: platform-conditional via a library/shell/signal, ======
  // === not via a process.platform token (platformTokens: 0) =================
  {
    id: 'tree-kill-teardown',
    file: 'src/appProcess.ts',
    symbol: 'stop / killHolder / taskRunner / testRunners / registry',
    concern: 'Terminate a process tree (SIGTERM then SIGKILL escalation).',
    windows: 'tree-kill shells out to taskkill /pid <pid> /T /F.',
    posix: 'tree-kill walks the ps tree and sends kill(2) to each pid.',
    tested: 'win32: real process-group kills in the lifecycle + task tests. posix: tree-kill\'s own behavior + the smoke script (no orphans left).',
    verdict: 'untestable-locally',
    gap: 'POSIX process-group teardown (no orphaned children) is confirmed on hardware via the smoke script.',
    platformTokens: 0,
  },
  {
    id: 'spawn-shell-quoting',
    file: 'src/appProcess.ts',
    symbol: 'start / taskRunner / testRunners (shell: true)',
    concern: 'Run dev-server / task / test commands through a shell.',
    windows: 'shell: true ⇒ cmd.exe (%VAR%, different quoting, .cmd resolution).',
    posix: 'shell: true ⇒ /bin/sh (POSIX quoting).',
    tested: 'shellSafe.ts allow-lists (not escaping) reject shell metacharacters on both shells; unit-tested in shell-safe.test.mjs.',
    verdict: 'verified',
    gap: 'none — the allow-list is intentionally platform-agnostic; unsafe tokens are refused, never quoted, so cmd.exe vs /bin/sh differences cannot be exploited.',
    platformTokens: 0,
  },
  {
    id: 'signal-handling',
    file: 'src/main.ts',
    symbol: 'process.on(SIGINT|SIGTERM)',
    concern: 'Graceful daemon shutdown on interrupt/terminate.',
    windows: 'Node maps Ctrl-C to SIGINT; SIGTERM is synthesized on console-close — shutdown() flushes history + writes state.',
    posix: 'Real SIGINT/SIGTERM delivery triggers the same shutdown() path.',
    tested: 'win32: lifecycle-torture spawns a real daemon and stops it. posix: the same path plus the smoke script.',
    verdict: 'untestable-locally',
    gap: 'POSIX signal delivery + clean flush confirmed on hardware via the smoke script.',
    platformTokens: 0,
  },
];

// Sum of platform tokens the inventory claims for a given dist file basename.
// The completeness test compares this against the tokens actually in dist/.
export function tokensByFile(): Map<string, number> {
  const m = new Map<string, number>();
  for (const b of PLATFORM_BRANCHES) {
    if (!b.platformTokens) continue;
    // Normalize src/foo/bar.ts → foo/bar.js so it lines up with dist/.
    const distRel = b.file.replace(/^src\//, '').replace(/\.tsx?$/, '.js');
    m.set(distRel, (m.get(distRel) ?? 0) + b.platformTokens);
  }
  return m;
}
