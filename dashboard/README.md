# daimon dashboard (Angular 20 + Material 3)

Angular workspace that builds to `../dist/dashboard/`. The daimon daemon serves
that folder as the static SPA when present; otherwise it falls back to the
v0.4-era `src/dashboard.html`.

## Build

```
cd dashboard
npm install      # first time
npm run build    # → ../dist/dashboard/
```

Then any running daimon daemon on `http://127.0.0.1:4999/` serves the built
SPA. Live-reload during dashboard development:

```
npm start        # ng serve on 127.0.0.1:4998, proxy /api -> daemon yourself
```

## Layout

- `src/app/app.ts` — root component
- `src/app/apps-list.ts` — main page (overview + per-app cards)
- `src/app/app-detail.ts` — per-app detail (status + errors)
- `src/app/daimon-api.ts` — typed HTTP + signal-based store + NDJSON event stream
- `src/styles.scss` — Material 3 theme tokens (light/dark via `color-scheme`)

## Build-time guarantee

Daimon's own `tsc` and `esbuild` never touch this folder. The Angular CLI
runs `prepublishOnly` *only when `dashboard/node_modules` is present* — bare
`tsc` builds and CI test runs work without it.
