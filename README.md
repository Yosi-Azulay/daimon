# appman

Local Angular/Nx/Vite/Storybook app manager with TUI, loopback HTTP API, JSON CLI, and MCP server.

## Quick start

```powershell
cd D:\Synology\SourceCode\appman
npm install
npm start
```

First run with no config creates `%USERPROFILE%\.appman\config.json` and exits.
Edit `searchRoots` to point at your workspace and run again.

## Config

Lookup order:

1. `./appman.config.json` (cwd)
2. `%USERPROFILE%\.appman\config.json`

```jsonc
{
  "searchRoots": ["D:\\Synology\\SourceCode\\my-workspace"],
  "portRange": [4200, 4299],
  "apiPort": 4999,

  "autoStart": ["web-admin"],
  "profiles": { "fullstack": ["web-admin", "api-portal"] },
  "tags": { "web-admin": ["frontend"], "api-portal": ["backend"] },

  "autoRestart": { "enabled": false, "maxAttempts": 5, "windowMs": 300000 },
  "healthProbe": { "enabled": true, "intervalMs": 30000, "timeoutMs": 2000, "path": "/" },
  "logs": { "enabled": false, "dir": "~/.appman/logs", "maxFiles": 5, "maxBytesPerFile": 10000000 },

  "overrides": {
    "web-admin": {
      "port": 4250,
      "command": "npx nx serve web-admin --configuration=dev",
      "env": { "API_BASE": "https://staging.example.com" }
    }
  }
}
```

All new sections are optional; v0.1 configs still load unchanged.

## TUI keys

```
↑/↓        select app
s          start
x          stop
r          restart
o          open URL in default browser
t          tag filter (space-separated; Enter applies, Esc cancels)
l          toggle log focus (PgUp/PgDn to scroll)
Shift+L    full-screen log (/ search, n/N next/prev, g/G bottom/top, q to exit)
q          quit (graceful shutdown of all children)
```

## CLI

While the TUI is running, in another terminal:

```powershell
npm run cli -- list [--tag <name>] ...
npm run cli -- status <name>
npm run cli -- errors <name> [--since 2m] [--since-last] [--client <id>] [--structured]
npm run cli -- events [--since 2m] [--app <name>]
npm run cli -- wait <name> [--until serving|healthy|stopped|error] [--timeout 60s]
npm run cli -- logs <name> [--tail 50] [--since 30s]
npm run cli -- start <name>
npm run cli -- stop <name>
npm run cli -- restart <name>
npm run cli -- up [<profile>]
npm run cli -- down [<profile>]
```

All CLI commands print compact JSON on stdout. On daemon-not-running:
`appman is not running — start it with: npm start` on stderr, exit 1.

`appman wait` exits 0 when the condition is met, 2 on timeout, 1 on other errors.

## HTTP API

Bound to `127.0.0.1:<apiPort>` (loopback only). See `/` for the dashboard.

```
GET  /api/apps
GET  /api/apps/:name
GET  /api/apps/:name/errors[?since=2m]
GET  /api/apps/:name/errors/since-last?client=<id>
GET  /api/apps/:name/logs?tail=N&since=30s
GET  /api/apps/:name/wait?until=serving&timeout=60
GET  /api/events?since=5m&app=<name>
POST /api/apps/:name/(start|stop|restart)
```

## MCP server (for Claude Code)

Register the MCP server with Claude Code so it can manage apps without parsing logs:

```bash
claude mcp add appman -- node D:\Synology\SourceCode\appman\dist\mcp.js
```

Or by hand, in `.mcp.json`:

```json
{
  "mcpServers": {
    "appman": { "command": "node", "args": ["D:\\Synology\\SourceCode\\appman\\dist\\mcp.js"] }
  }
}
```

The MCP server is a stdio proxy to the running daemon — start `npm start` first. Tools exposed:
`list_apps`, `get_status`, `get_errors`, `get_logs`, `start_app`, `stop_app`, `restart_app`, `wait_for_app`.

## State files (in `%USERPROFILE%\.appman\`)

- `config.json` — your config (above)
- `state.json` — sticky ports (auto-written, debounced 500 ms)
- `cursors.json` — per-client error cursors used by `--since-last`
- `logs/<name>.log[.N]` — disk logs when `logs.enabled` is true
