# appman

Local Angular/Nx app manager with TUI, loopback HTTP API, and a thin JSON CLI.

## Quick start

```powershell
cd D:\Synology\SourceCode\appman
npm install
npm start
```

First run with no config creates `%USERPROFILE%\.appman\config.json` and exits.
Edit `searchRoots` to point at your Nx (or Angular CLI) workspace and run again.

## Config

Lookup order:

1. `./appman.config.json` (cwd)
2. `%USERPROFILE%\.appman\config.json`

```json
{
  "searchRoots": ["D:\\Synology\\SourceCode\\my-workspace"],
  "portRange": [4200, 4299],
  "apiPort": 4999,
  "overrides": {
    "web-admin": { "port": 4250, "command": "npx nx serve web-admin --configuration=dev" }
  }
}
```

## TUI keys

```
↑/↓     select app
s       start
x       stop
r       restart
l       toggle log focus (PgUp/PgDn to scroll)
q       quit (graceful shutdown of all children)
```

## CLI

While the TUI is running, in another terminal:

```powershell
npm run cli -- list
npm run cli -- status <name>
npm run cli -- errors <name>
npm run cli -- logs <name> --tail 50
npm run cli -- start <name>
npm run cli -- stop <name>
npm run cli -- restart <name>
```

All CLI commands print compact JSON on stdout. On daemon-not-running:
`appman is not running — start it with: npm start` on stderr, exit 1.

## HTTP API

Bound to `127.0.0.1:<apiPort>`. See `/` for the dashboard.

- `GET  /api/apps`
- `GET  /api/apps/:name`
- `GET  /api/apps/:name/errors`
- `GET  /api/apps/:name/logs?tail=N&since=30s`
- `POST /api/apps/:name/(start|stop|restart)`
