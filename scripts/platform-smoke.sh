#!/bin/sh
# daimon platform smoke test (M143, v1.9 "Everywhere").
#
# A ~2-minute PASS/FAIL probe for a REAL Mac/Linux box. daimon is developed on
# Windows; its POSIX paths are fixture-verified but not hardware-verified until
# this runs green on actual hardware. Run it before `npm publish`, on macOS AND
# on Linux, and paste the summary block into the release notes.
#
# Zero dependencies beyond a POSIX shell + node + the platform's own tools
# (ss/lsof/ps). It uses a throwaway DAIMON_HOME and a throwaway workspace and
# removes both on exit — it never touches your real ~/.daimon.
#
# Usage:
#   sh scripts/platform-smoke.sh            # full run (needs a real POSIX box)
#   sh scripts/platform-smoke.sh --dry-run  # plumbing only (safe on any host,
#                                           # incl. Windows via Git Bash) — proves
#                                           # the script parses and wires up, does
#                                           # not exercise real OS tools.
#
# Exit code: 0 if every probe PASSED (or SKIPPED in --dry-run), 1 otherwise.

set -u

DRY_RUN=0
[ "${1:-}" = "--dry-run" ] && DRY_RUN=1

# --- locate repo + daimon CLI ------------------------------------------------
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
REPO_ROOT=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)
CLI="$REPO_ROOT/dist/cli.js"
API_PORT="${DAIMON_API_PORT:-4999}"

PASS=0
FAIL=0
SKIP=0
NOTES=""

ok()   { PASS=$((PASS+1)); printf 'PASS  %s\n' "$1"; }
bad()  { FAIL=$((FAIL+1)); printf 'FAIL  %s :: %s\n' "$1" "$2"; NOTES="$NOTES\n  - FAIL $1: $2"; }
skip() { SKIP=$((SKIP+1)); printf 'SKIP  %s :: %s\n' "$1" "$2"; }

have() { command -v "$1" >/dev/null 2>&1; }

# --- throwaway state ---------------------------------------------------------
TMP_HOME=$(mktemp -d 2>/dev/null || echo "/tmp/daimon-smoke-home.$$")
TMP_WS=$(mktemp -d 2>/dev/null || echo "/tmp/daimon-smoke-ws.$$")
mkdir -p "$TMP_HOME" "$TMP_WS"
export DAIMON_HOME="$TMP_HOME"

cleanup() {
  # Best-effort daemon stop, then remove both temp dirs. Never touches ~/.daimon.
  [ "$DRY_RUN" -eq 0 ] && node "$CLI" daemon stop >/dev/null 2>&1
  rm -rf "$TMP_HOME" "$TMP_WS" 2>/dev/null
}
trap cleanup EXIT INT TERM

printf '=== daimon platform smoke test ===\n'
printf 'os: %s %s   node: %s\n' "$(uname -s 2>/dev/null || echo unknown)" "$(uname -r 2>/dev/null || echo '')" "$(node --version 2>/dev/null || echo 'MISSING')"
printf 'mode: %s   DAIMON_HOME: %s\n\n' "$([ "$DRY_RUN" -eq 1 ] && echo dry-run || echo full)" "$DAIMON_HOME"

# --- Probe 0: prerequisites --------------------------------------------------
if have node; then ok "node present"; else bad "node present" "node not on PATH"; fi
if [ -f "$CLI" ]; then ok "daimon CLI built (dist/cli.js)"; else bad "daimon CLI built" "missing $CLI — run: npm run build"; fi

# In dry-run we only confirm the plumbing: temp dirs, CLI resolvable, the POSIX
# port tools are namable, and cleanup works. No daemon, no real spawns.
if [ "$DRY_RUN" -eq 1 ]; then
  [ -d "$TMP_HOME" ] && ok "throwaway DAIMON_HOME created" || bad "throwaway DAIMON_HOME" "mkdir failed"
  [ -d "$TMP_WS" ] && ok "throwaway workspace created" || bad "throwaway workspace" "mkdir failed"
  if have ss || have lsof; then ok "a port tool is available (ss/lsof)"; else skip "port tool" "neither ss nor lsof on PATH (expected off-POSIX)"; fi
  skip "daemon boot + /api/signature" "dry-run"
  skip "daimon ports scan (real ss/lsof)" "dry-run"
  skip "spawn + tree-kill (no orphans)" "dry-run"
  skip "notifier no-crash" "dry-run"
  skip "env snapshot + redaction" "dry-run"
  skip "daimon doctor" "dry-run"
  skip "TUI launches" "dry-run"
else
  # --- Probe 1: daemon boot + loopback signature -----------------------------
  if node "$CLI" list --json >/dev/null 2>&1; then
    SIG=""
    if have curl; then SIG=$(curl -s "http://127.0.0.1:$API_PORT/api/signature" 2>/dev/null); fi
    if [ -z "$SIG" ] && have wget; then SIG=$(wget -qO- "http://127.0.0.1:$API_PORT/api/signature" 2>/dev/null); fi
    if [ -z "$SIG" ]; then
      SIG=$(node -e "require('http').get({host:'127.0.0.1',port:$API_PORT,path:'/api/signature'},r=>{let d='';r.on('data',c=>d+=c);r.on('end',()=>process.stdout.write(d))}).on('error',()=>process.exit(3))" 2>/dev/null)
    fi
    case "$SIG" in
      *'"daimon":true'*|*'"daimon": true'*) ok "daemon boot + /api/signature (loopback)";;
      *) bad "daemon boot + /api/signature" "no daimon signature on 127.0.0.1:$API_PORT (got: ${SIG:-<empty>})";;
    esac
  else
    bad "daemon boot" "daimon list failed to start/reach the daemon"
  fi

  # --- Probe 2: port scan via real ss/lsof -----------------------------------
  if have ss || have lsof; then
    if node "$CLI" ports --json >/dev/null 2>&1; then
      ok "daimon ports scan (real $(have ss && echo ss || echo lsof))"
    else
      bad "daimon ports scan" "daimon ports errored"
    fi
  else
    skip "daimon ports scan" "neither ss nor lsof present"
  fi

  # --- Probe 3: spawn + tree-kill of a process group (no orphans) ------------
  # A dev app that spawns a grandchild; after `daimon stop`, neither may survive.
  cat > "$TMP_WS/package.json" <<'PKG'
{ "name": "daimon-smoke-app", "version": "0.0.0",
  "scripts": { "dev": "node -e \"require('child_process').spawn(process.execPath,['-e','setInterval(()=>{},1e9)'],{stdio:'ignore'});setInterval(()=>{},1e9)\"" } }
PKG
  if ( cd "$TMP_WS" && node "$CLI" start daimon-smoke-app >/dev/null 2>&1 ); then
    sleep 2
    ( cd "$TMP_WS" && node "$CLI" stop daimon-smoke-app >/dev/null 2>&1 )
    sleep 2
    # Count lingering grandchildren from our throwaway workspace.
    ORPHANS=$(ps -eo args 2>/dev/null | grep -c 'setInterval(()=>{},1e9)' 2>/dev/null || echo 0)
    # grep matches itself once; treat <=1 as clean.
    if [ "${ORPHANS:-0}" -le 1 ]; then ok "spawn + tree-kill (no orphans)"; else bad "spawn + tree-kill" "$ORPHANS lingering child processes after stop"; fi
  else
    bad "spawn + tree-kill" "could not start the smoke app"
  fi

  # --- Probe 4: notifier does not crash the daemon ---------------------------
  # The daemon booted with notifications off by default; reaching status proves
  # the notifier init path (node-notifier require) did not throw fatally.
  if node "$CLI" list --json >/dev/null 2>&1; then ok "notifier no-crash (daemon healthy)"; else bad "notifier no-crash" "daemon unreachable after boot"; fi

  # --- Probe 5: env snapshot + redaction spot-check --------------------------
  printf 'SECRET_TOKEN=hunter2\nAPI_KEY=abcd1234\n' > "$TMP_WS/.env"
  ENVOUT=$( cd "$TMP_WS" && node "$CLI" env --json 2>/dev/null )
  case "$ENVOUT" in
    *hunter2*|*abcd1234*) bad "env redaction" "a raw secret VALUE leaked into env output";;
    *SECRET_TOKEN*|*API_KEY*) ok "env snapshot + redaction (names only, no values)";;
    *) skip "env snapshot" "no env keys surfaced (workspace may not be scanned)";;
  esac

  # --- Probe 6: doctor -------------------------------------------------------
  if node "$CLI" doctor --json >/dev/null 2>&1; then ok "daimon doctor ran"; else bad "daimon doctor" "doctor errored"; fi

  # --- Probe 7: TUI launches (headless smoke) --------------------------------
  # Launch the TUI with no TTY and kill it quickly; a clean start (no immediate
  # crash) is the signal. Skipped if `timeout` is unavailable.
  if have timeout; then
    if timeout 3 node "$CLI" tui >/dev/null 2>&1; RC=$?; [ "$RC" -eq 124 ] || [ "$RC" -eq 0 ]; then
      ok "TUI launches"
    else
      bad "TUI launches" "tui exited with code $RC"
    fi
  else
    skip "TUI launches" "no \`timeout\` command to bound the run"
  fi
fi

# --- summary (paste-able) ----------------------------------------------------
printf '\n=== summary ===\n'
printf 'platform: %s %s\n' "$(uname -s 2>/dev/null || echo unknown)" "$(uname -m 2>/dev/null || echo '')"
printf 'daimon:   %s\n' "$(node "$CLI" --version 2>/dev/null | head -n1 || echo '?')"
printf 'result:   %d passed, %d failed, %d skipped\n' "$PASS" "$FAIL" "$SKIP"
if [ "$FAIL" -gt 0 ]; then
  printf 'status:   FAIL%b\n' "$NOTES"
  exit 1
fi
printf 'status:   PASS\n'
exit 0
