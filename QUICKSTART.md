# Quickstart

Five minutes from `npm i -g daimon` to a dev server you can start, watch, and debug — without reading any source.

Every `bash` block on this page is executed as written by `test/quickstart.test.mjs` against a clean state directory, so what you read here is what actually runs.

---

## 1. Install

<!-- quickstart:skip installs globally; daimon never runs install commands, including in its own tests -->

```bash
npm i -g daimon
```

Requires Node ≥ 20. Everything below is local: daimon binds `127.0.0.1` only, has no accounts, and sends nothing anywhere.

---

## 2. Point daimon at your code

Daimon needs one thing from you: **where your projects live**. Write a `daimon.config.json` in your workspace root:

<!-- quickstart:config -->

```json
{
  "searchRoots": ["."],
  "portRange": [4200, 4299],
  "apiPort": 4999
}
```

That is the whole minimum config. `searchRoots` is the list of folders to scan (`"."` means "this folder"); `portRange` is the pool daimon assigns dev-server ports from; `apiPort` is where the local daemon listens. Every other key is optional and documented in [`daimon.config.example.json`](daimon.config.example.json).

Hand-writing this file is a first-class path — it is a plain JSON file, and daimon never rewrites it behind your back.

---

## 3. …or let `daimon init` write it for you

If you would rather not type it, run the wizard in your workspace:

<!-- quickstart:fresh -->

```bash
daimon init --yes
```

`daimon init` runs **the same discovery scan the daemon runs**, shows you the apps it found, and writes `daimon.config.json` in the current directory. `--yes` accepts that proposal without prompting; leave it off to review and edit the ports interactively.

It writes exactly that one file. It never starts anything, never touches your source, and **never replaces an existing `daimon.config.json`** — with a config already present, `--yes` refuses and tells you to use `daimon init --force` or the interactive flow instead.

---

## 4. Start the daemon

```bash
daimon daemon start --detach
```

One daemon serves every workspace on the machine. `--detach` leaves it running in the background; without it, `daemon start` runs in the foreground and opens the terminal UI. This step is optional either way — most verbs auto-spawn the daemon on first use — it is here so the first run is explicit.

---

## 5. See what daimon found

```bash
daimon list
```

You get one compact JSON row per discovered app — name, status, port, health, error count. If the list is empty, `daimon why-empty` explains exactly what was scanned and why each candidate was rejected.

---

## 6. Start an app

```bash
daimon start hello-web
```

Daimon spawns the app's **own** dev command (the one your framework documents — daimon never invents a build), hands it a port from the pool, and starts parsing its output for errors and its readiness banner.

Check on it, then stop it:

```bash
daimon status hello-web
daimon stop hello-web
```

Useful neighbours: `daimon ensure <app>` starts it *and* blocks until it is healthy (what you want in a script), `daimon logs <app> --level error` cuts the firehose to the lines that matter, and `daimon errors <app>` shows the deduplicated error groups.

---

## 7. Open the dashboard

<!-- quickstart:skip opens a browser window -->

```bash
daimon dashboard
```

The dashboard is the same data as the CLI, on `127.0.0.1`. There is also a terminal UI — run `daimon` with no arguments and press `?` for the full chord list.

---

## 8. When it breaks

<!-- quickstart:exit 0,1 doctor exits 1 when it reports findings — that is a result, not a failure -->

```bash
daimon doctor
```

`doctor` is the first stop, always: it checks your config, search roots, ports, locks, and daimon's own state, and every finding names the remedy. `daimon doctor --auto-fix` applies the repairs it is allowed to make — only ever to daimon's own state under `~/.daimon`, never to your code and never to a process it cannot positively identify.

For a specific broken app:

```bash
daimon why hello-web
```

One-shot forensics: the last crash with its exit code and final log lines, grouped errors, restart storms, environment changes since it last worked, and any doctor findings that mention it.

Two more when you need them: `daimon config validate` checks your config offline (typo'd keys get a "did you mean"), and `daimon frameworks` prints every framework daimon can detect, with what matched here.

---

## 9. Shut down

```bash
daimon daemon stop
```

---

## Where to go next

- [README](README.md) — the full tour: framework registry, groups, agents, MCP server, stability tiers.
- [`daimon.config.example.json`](daimon.config.example.json) — every config key with safe defaults.
- [SECURITY.md](SECURITY.md) — the loopback-only, no-telemetry posture in full.
- [STABILITY.md](STABILITY.md) — what `frozen` / `stable` / `experimental` mean for the surfaces you script against.
