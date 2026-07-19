# ss fixtures — provenance

- **Tool:** `ss -ltnp` (iproute2 / util-linux `ss`; the container case is BusyBox `ss`).
- **Platform:** Linux.
- **Format source:** column layout and the `users:(("name",pid=N,fd=M))` process field
  validated against `ss(8)` and public sample output. The BusyBox variant carries a
  leading `Netid` column and omits process info (typical inside containers / without
  privileges).
- **Honesty note:** these are representative recorded-format samples, authored on the
  Windows dev box against the documented format — **not** captured live on a Linux host.
  The `scripts/platform-smoke.sh` probe captures real `ss` output on actual hardware and
  is what upgrades port forensics from *fixture-verified* to *verified* on Linux.
