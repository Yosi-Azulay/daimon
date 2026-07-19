# Platform fixtures (M141, v1.9 "Everywhere")

Recorded-format samples of the OS tools daimon shells out to for port forensics
and process identity, one directory per tool:

| dir | tool | platform | used by |
|-----|------|----------|---------|
| `ss/` | `ss -ltnp` | Linux | `scanListeningPorts` (primary) |
| `lsof/` | `lsof … -sTCP:LISTEN` | macOS / POSIX fallback | `scanListeningPorts` fallback + `findPortHolder` |
| `netstat/` | `netstat -ano -p TCP` | Windows | `scanListeningPorts` |
| `ps/` | `ps -o lstart= -p <pid>` | POSIX | `findPortHolder` start time |
| `powershell/` | Get-NetTCPConnection + Win32_Process JSON | Windows | `findPortHolder` |

**Honesty.** The Windows samples reflect the dev box's own platform and are also
exercised live in `ports.test.mjs`. The Linux/macOS samples are representative of
the documented tool formats (validated against man pages + public output) but were
authored on the Windows dev box — they were **not** captured on real Mac/Linux
hardware. That is exactly why `scripts/platform-smoke.sh` exists: it captures real
`ss`/`lsof`/`ps` output on a live box and is what earns a *verified* (vs
*fixture-verified*) status in the README support matrix.

The parity suite (`test/port-forensics.test.mjs`) feeds every sample through the
**production** parse path via the injectable command-runner seam in `portDiag.ts` —
no test-only fork of the parsing logic — so a real parser regression is caught here.
