# lsof fixtures — provenance

- **Tool:** `lsof -nP -iTCP -sTCP:LISTEN` (bulk scan) and `lsof -nP -iTCP:<port> -sTCP:LISTEN` (single holder).
- **Platform:** macOS (also the POSIX fallback when `ss` is absent).
- **Format source:** `COMMAND PID USER FD TYPE DEVICE SIZE/OFF NODE NAME` columns and the
  trailing `<addr>:<port> (LISTEN)` NAME field validated against `lsof(8)` and public sample
  output. Includes IPv4, IPv6 (`[::1]:port`), a wildcard `*:port`, and an IPv4+IPv6 duplicate
  of the same listener.
- **Honesty note:** representative recorded-format samples authored against the documented
  format on the Windows dev box — **not** captured live on macOS. `scripts/platform-smoke.sh`
  captures real `lsof` output on hardware and upgrades this surface to *verified* on macOS.
