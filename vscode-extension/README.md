# daimon — VS Code extension

Status-bar app health, errors panel, and one-click start/stop for [daimon](https://github.com/Yosi-Azulay/daimon)-discovered apps, scoped to the workspace folder you have open.

## Features

- **Status bar item** — shows `✓ N apps healthy`, `⚠ unhealthy`, or `daemon down` for the current workspace's daimon apps. Click to open the dashboard.
- **Errors view** — sidebar tree listing parsed errors from daimon (file/line/col/code/message). Click a row to open the file at the error location.
- **Commands** — `Daimon: Start app`, `Daimon: Stop app`, `Daimon: Open dashboard`, `Daimon: Show logs for current cwd`.
- **Soft-lock aware** — if another agent owns the app, the Start command prompts you to steal.

## Requirements

- `daimon` daemon running locally (`daimon daemon start --detach`).
- VS Code 1.85+.

## Configuration

| Setting | Default | Description |
| ------- | ------- | ----------- |
| `daimon.apiPort` | `4999` | HTTP port of the daemon. |
| `daimon.apiToken` | `""` | Bearer token if `daimon.config.json` sets `apiToken`. |

## Build

```
cd vscode-extension
npm install
npm run compile
npm run package    # → daimon-vscode.vsix
```

Publishing to the marketplace is a human step:

```
vsce publish
```
