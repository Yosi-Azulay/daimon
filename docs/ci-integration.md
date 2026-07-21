# Using daimon in CI

`daimon ci start <profile>` turns "bring up the stack and wait for it" into a single CI step with a structured report and meaningful exit codes. It is designed for GitHub Actions / Jenkins / any runner that can run Node 20+.

## Install in CI

```bash
npm install -g daimon
```

Provide a config in the repo root (`daimon.config.json`) or generate one non-interactively:

```bash
daimon init --yes    # scans this folder with the framework registry and writes daimon.config.json
```

The daemon auto-spawns on the first `daimon` call that needs it — no separate "start the daemon" step is required. It binds `127.0.0.1` only, so nothing is exposed on the runner's network.

Since v1.14 `daimon init` writes the config and **starts nothing**, including when a daemon is already running from an earlier step. If your job writes a config *after* the daemon is already up, add `daimon daemon restart` so the new config is actually loaded — otherwise the daemon keeps serving the one it booted with.

## The CI verb

```bash
daimon ci start fullstack --until ready --timeout 5m --json
```

- `--until` — target state per app: `serving` | `healthy` | `ready` (alias for `healthy`). Default: `healthy`.
- `--timeout` — total budget (default `5m`, max `20m`).
- `--json` — structured report on stdout (the default for `ci`).

The JSON report:

```json
{
  "profile": "fullstack",
  "until": "healthy",
  "allReached": true,
  "perApp": [
    { "name": "web-admin", "state": "healthy", "reachedTargetMs": 18250, "timedOut": false },
    { "name": "api",       "state": "healthy", "reachedTargetMs": 6120,  "timedOut": false }
  ],
  "totalMs": 18400
}
```

### Exit codes

| Code | Meaning |
| ---- | ------- |
| `0`  | Every app in the profile reached the target state. |
| `1`  | Error — e.g. unknown profile, bad arguments, daemon failure. |
| `2`  | Timeout — at least one app never reached the target within `--timeout`. |

Exit code `2` is the same timeout convention used by `daimon wait`, `daimon focus`, and `daimon ensure*`, so existing scripts can treat them uniformly.

## GitHub Actions example

A complete workflow that brings up a profile, runs e2e tests against it, and always surfaces daimon's diagnostics on failure:

```yaml
name: e2e
on: [push, pull_request]

jobs:
  e2e:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-node@v4
        with:
          node-version: 20

      - name: Install dependencies
        run: npm ci

      - name: Install daimon
        run: npm install -g daimon

      - name: Bring up the stack
        run: daimon ci start fullstack --until ready --timeout 5m --json | tee daimon-ci-report.json

      - name: Run e2e tests
        run: npm run e2e

      - name: Collect daimon diagnostics
        if: failure()
        run: |
          daimon overview --budget 2000 || true
          daimon errors web-admin --since 10m || true
          daimon timeline --since 10m --kinds status,error || true

      - name: Upload CI report
        if: always()
        uses: actions/upload-artifact@v4
        with:
          name: daimon-ci-report
          path: daimon-ci-report.json

      - name: Tear down
        if: always()
        run: daimon down fullstack || true
```

Notes:

- `daimon ci start` failing with exit `2` fails the job at the bring-up step — your e2e step never runs against a half-up stack.
- The report is plain JSON on stdout, so `tee`-ing it into an artifact gives you per-app timings (`reachedTargetMs`) for free.

## Webhook-to-Slack example

Add a `webhooks` entry to `daimon.config.json` and daimon pushes events to Slack as they happen — useful for long CI runs or a shared staging box:

```jsonc
{
  "webhooks": [
    {
      "url": "https://hooks.slack.com/services/T000/B000/XXXXXXXX",
      "events": ["error", "regression-detected", "status"],
      "filter": { "to": ["error", "unhealthy"] }
    }
  ]
}
```

- Slack (and Discord) URLs get native attachment shaping automatically; other endpoints receive a generic envelope `{ event, app, ts, payload }`.
- `events` accepts aliases: `error` matches both `error-new` and `error-recur` (same for `warning` / `lint`).
- The `filter.to` above means: only notify on transitions *into* `error` or `unhealthy` — quiet on the happy path.
- Deliveries are rate-limited to 1 req/sec with bounded retries, so an event storm in CI can't flood your channel.

In CI, keep the secret out of the repo by templating the config before the daimon step:

```yaml
      - name: Inject Slack webhook
        run: |
          node -e "
            const fs = require('fs');
            const cfg = JSON.parse(fs.readFileSync('daimon.config.json', 'utf8'));
            cfg.webhooks = [{ url: process.env.SLACK_WEBHOOK_URL, events: ['error', 'regression-detected'] }];
            fs.writeFileSync('daimon.config.json', JSON.stringify(cfg, null, 2));
          "
        env:
          SLACK_WEBHOOK_URL: ${{ secrets.SLACK_WEBHOOK_URL }}
```

## See also

- [Docs site](index.html) — full CLI / MCP / config reference.
- `daimon orchestrate <profile> --goal stable` — the agent-oriented sibling of `ci start` (adds one try-fix round on stragglers).
- `daimon.config.example.json` in the repo root — every config key with safe defaults.
