# Daimon Plugins (Plugin API v1)

Daimon plugins are small Node modules that **observe** what the daemon sees —
events, app start/stop transitions — and can **contribute advise-only rules**
to `daimon doctor`. That's the whole surface, deliberately: a plugin cannot
start or stop an app, change config, edit history, or otherwise act on
daimon's behalf. If you want that, script against the CLI, the HTTP API, or
MCP instead — a plugin is for reacting to what's already happening, not for
driving it.

Plugin API v1 ships in daimon v1.5.0 at stability tier `experimental` (see
[STABILITY.md](STABILITY.md)): the shape may still change in a minor release,
and `apiVersion` is the lever daimon uses to tell you when it has.

## Trust model — read this first

**Plugins are opt-in. They are NOT sandboxed.** A plugin's hooks run
in-process with full Node privileges — the same privileges as daimon itself.
Daimon only loads files *you* placed in `~/.daimon/plugins` yourself; nothing
is fetched, installed, or enabled on your behalf. There is no marketplace, no
remote plugin registry, no auto-install, ever.

Treat every plugin as trusted code you chose to run — because that's exactly
what it is. The safety property here is entirely about *placement*, not
containment: daimon validates a plugin's export *shape* (does it have a
`name`, a valid `apiVersion`, functions where functions are expected), never
its *behavior*. A plugin can `require('child_process')`, read your
filesystem, open a socket, or do anything else Node can do, and no loader
check in the world changes that.

To be blunt about why: an in-process "sandbox" for code you already decided
to run would be security theater. Real isolation needs a separate process (or
container) with its own privilege boundary, which is a different, much
heavier feature daimon does not offer today. If a document, a plugin's
`description`, or anyone else calls this a sandbox, they're wrong — don't
install it on that claim alone. What daimon *does* give you is **crash
isolation**: a plugin that throws can't take the daemon down (see
[Lifecycle](#lifecycle) below) — that's a reliability guarantee, not a
security one.

## Quick start

1. Write a `.mjs` file (`.js` and `.cjs` also load; anything else in the
   directory — READMEs, `.disabled` renames, editor droppings — is ignored
   silently) that exports an object shaped like `DaimonPlugin`:

   ```js
   // ~/.daimon/plugins/hello.mjs
   export default {
     name: 'hello',
     apiVersion: 1,
     onEvent(evt) {
       console.error(`[hello] ${evt.app} ${evt.type} ${evt.from ?? ''}->${evt.to ?? ''}`);
     },
   };
   ```

2. Drop it in `~/.daimon/plugins/` (relocates with `DAIMON_HOME`; see
   [Where plugins live](#where-plugins-live) below).

3. `daimon daemon restart` — plugins are enumerated once at startup; there's
   no watcher.

4. `daimon plugins` to confirm it's active:

   ```
   plugins  1 file in ~/.daimon/plugins
     hello                      active     v1  onEvent
   ```

### Where plugins live

The default directory is `<DAIMON_HOME>/plugins` (`~/.daimon/plugins` unless
`DAIMON_HOME` is set — `DAIMON_HOME` relocates daimon's whole state
directory, plugins included). You can point elsewhere with the `plugins.dir`
config key:

```json
{ "plugins": { "dir": "/path/to/my/plugins" } }
```

`plugins.dir` defaults to `null` (use the default location) and is tier
`stable` in `daimon.config.json` — the *location mechanism* won't change out
from under you even while the plugin API itself is `experimental`.

## API reference

A plugin file's default export (or the module's own exports, if there's no
`default`) must match:

```ts
interface DaimonPlugin {
  name: string;            // kebab-case: /^[a-z][a-z0-9-]*$/
  apiVersion: 1;            // must be exactly 1
  description?: string;
  onEvent?(evt: Readonly<AppEvent>): unknown;
  onAppStart?(app: PluginAppSnapshot): unknown;
  onAppStop?(app: PluginAppSnapshot): unknown;
  registerDoctorRules?(): PluginDoctorRule[];
}
```

All four hooks are optional — implement only what you need. Each may be
**sync or async**; daimon never blocks on a hook (fire-and-forget), but a
returned promise's rejection is caught and handled like a sync throw. No
hook's return value is used for anything except `registerDoctorRules()`.
`onEvent`, `onAppStart`, and `onAppStop` are pure observers: whatever they
return is discarded.

### `onEvent(evt)`

Called once for every daimon event, **after** it has already been recorded to
the registry and history — dispatch is off the event write path (a
`setImmediate` tick, fire-and-forget), so a slow or hung `onEvent` cannot
delay app lifecycle or history writes. If no active plugin declares any
observe hook, daimon skips scheduling the dispatch entirely (one array check
on the hot path).

`evt` is a frozen copy:

```ts
{ ts: number; app: string; type: string; from?: string; to?: string; message?: string }
```

Mutating it throws in strict-mode code (any `.mjs` module) and silently does
nothing in sloppy-mode CJS — either way it's a frozen copy and never reaches
daimon state. `type` includes daimon's own event kinds — status changes,
errors, compiles, regressions, `self-warn`, `plugin-error`, and more; there's
no fixed enum here for plugins to depend on, since new kinds ship over time.

### `onAppStart(app)` / `onAppStop(app)`

Derived from status-transition events: `onAppStart` fires when an app's
status moves *to* `starting`; `onAppStop` fires when it moves *to* `stopped`.
(The synthetic `__daemon__` pseudo-app never triggers these.) `app` is a
frozen snapshot:

```ts
{ name: string; framework: string | null; port: number | null; pid: number | null; status: string }
```

Taken from the daemon's live app registry at dispatch time — if the app has
already vanished from the registry by the time your hook runs, daimon
synthesizes a minimal snapshot (`framework`/`port`/`pid` all `null`, `status`
set to the transition's target) rather than skipping the call.

### `registerDoctorRules()`

Called **once, at load time** — not per hook dispatch. Return an array of
rules:

```ts
{
  id: string;             // e.g. "no-apps-discovered"
  description: string;
  check(ctx: PluginDoctorContext): PluginDoctorFinding | PluginDoctorFinding[] | Promise<...>;
}
```

`check(ctx)` receives a frozen, read-only context:

```ts
{ config: unknown; apps: { name: string; framework: string | null; workspaceRoot: string | null }[] }
```

and returns one finding or an array of them:

```ts
{ ok: boolean; detail?: string }
```

Findings render in `daimon doctor` as `plugin:<plugin-name>/<rule-id>`, and
in the plugin's own row (`daimon plugins`, `GET /api/plugins`) as
`findings: [{ rule, ok, detail }]` after the last scan. **Plugin doctor
rules are advise-only in v1 — there is no auto-fix hook for them.** A rule
can only report; it can never repair.

`registerDoctorRules()` itself running at *load* time (rather than
dispatch time) matters: if it throws, or returns something that isn't an
array of `{ id, description, check }`, the whole plugin fails to **load**
(`load-error`) — it never reaches `active` status at all. Contrast this with
a `check()` function throwing later, at scan time, which disables an
already-active plugin for the session (see [Lifecycle](#lifecycle)).

## Lifecycle

- **Enumeration**: plugin files are read once, at daemon startup, in
  alphabetical order by filename. There is no file watcher and no
  hot-reload — edit a file, then run `daimon daemon restart` to pick it up.
- **Load validation** catches, per file, independently of its siblings:
  missing/empty `name`, a non-kebab-case `name`, a duplicate `name` (the
  first file alphabetically wins; the later one becomes `load-error`),
  missing or unsupported `apiVersion`, a declared hook that isn't a
  function, a non-string `description`, and a malformed
  `registerDoctorRules()` return (or throw). Any of these mark that one file
  `status: 'load-error'` with an `error` message and skip it — every other
  file in the directory loads normally. Each skip also fires one `self-warn`
  event (`plug-in skipped: <file> — <reason>`), so active plugins' own
  `onEvent` hooks observe their broken siblings' skip warnings like any
  other event, and `daimon doctor` surfaces the same information as a
  `plugin-load-error: <file>` finding (advise-only — **doctor never edits or
  deletes a plugin file**; you fix or remove it yourself).
- **Crash isolation** (this is the reliability guarantee, not a security
  one): if a hook throws synchronously, or an async hook's promise rejects,
  that plugin is disabled for the rest of the daemon's session — every one
  of its hooks stops being called, and any doctor rules it contributed stop
  being run. Exactly one `plugin-error` self-event is recorded, carrying the
  plugin name, the hook that threw, the error message, and the stack. There
  is no retry and no auto-re-enable; `daimon daemon restart` reloads the
  plugin fresh (and it starts active again, at least until it throws once
  more). A throwing `check()` during a doctor scan (`POST /api/plugins/scan`,
  or the doctor-run rules) disables its plugin the same way, mid-scan; the
  failed check is also recorded as a `{ ok: false }` finding, and other
  plugins' rules still run.
- **`daimon doctor` reloads plugins fresh on every run** — independent of the
  daemon's long-lived plugin host that observe hooks use. That means editing
  a plugin file and immediately running `daimon doctor` (or
  `daimon plugin validate <path>`) always checks the file as it is *right
  now*, without needing a restart — but it also means a doctor run can't
  "recover" a plugin that the live daemon has session-disabled; only
  restarting the daemon does that. Only the daemon's own long-running
  process — the one your `onEvent`/`onAppStart`/`onAppStop` hooks actually
  run inside — requires a restart to see file changes.
- **Inspection surfaces**: `daimon plugins` (table on a TTY, `--json` or
  piped output otherwise), `daimon plugin list` / `daimon plugin show <name>`
  (same data via the daemon), `daimon plugin validate <path>` (an *offline*
  shape check — no running daemon required), `GET /api/plugins`,
  `POST /api/plugins/scan` (re-runs every active plugin's doctor rules right
  now and returns the refreshed list), and MCP `daimon_plugins`. Every one of
  these reports `status` as `active`, `disabled`, or `load-error`.

## apiVersion policy

`apiVersion: 1` is the only value this daimon accepts today — declare it
literally as the number `1`. The whole surface is `experimental`
(STABILITY.md), which for a plugin author means: the hook set, the snapshot
shapes, and the doctor-rule contract may still change in a future minor
release. `apiVersion` is how daimon tells you when that happens — a file
declaring an `apiVersion` this daimon doesn't recognize is skipped with a
`load-error` and a self-warn naming the file and the version daimon does
support, never a crash and never a silent best-effort load under the wrong
contract.

## Migrating a pre-v1.5 plug-in

Before Plugin API v1, daimon's doctor plug-ins used a different, narrower
shape: `{ name, scan }`. That shape no longer loads. A file exporting `scan`
without an `apiVersion` is detected specifically and fails with a message
that names the migration, rather than a generic "missing apiVersion" error.

To migrate: wrap whatever your `scan()` used to compute into
`registerDoctorRules()`, and add `apiVersion: 1`:

```js
// before (no longer loads)
export default {
  name: 'my-rule',
  async scan(ctx) {
    return ctx.apps.length ? [] : [{ ok: false, detail: 'no apps' }];
  },
};

// after (Plugin API v1)
export default {
  name: 'my-rule',
  apiVersion: 1,
  registerDoctorRules() {
    return [{
      id: 'no-apps',
      description: 'Flags a workspace with zero discovered apps.',
      check(ctx) {
        return ctx.apps.length ? { ok: true } : { ok: false, detail: 'no apps' };
      },
    }];
  },
};
```

## Cookbook

Two working examples live in [`examples/plugins/`](examples/plugins/). Their
sources are reproduced verbatim below — copy either one into
`~/.daimon/plugins/` as a starting point.

### `events-to-jsonl.mjs` — observe hook

Appends one JSON line per daimon event to a file next to the plugin. The
comments in the source are the point: this is ordinary, unsandboxed file I/O,
by design.

```js
// events-to-jsonl — example daimon plugin (Plugin API v1). See PLUGINS.md.
//
// Appends one JSON line per daimon event to events.jsonl NEXT TO THIS FILE
// (so a copy in ~/.daimon/plugins logs to ~/.daimon/plugins/events.jsonl).
// Demonstrates the observe hook and honest file I/O: plugins are NOT
// sandboxed — this code runs in-process with full Node privileges, so it can
// write wherever you can. That is the trust model, not a bug.
//
// Install: copy into ~/.daimon/plugins/, then `daimon daemon restart`.
// Verify:  `daimon plugins` shows it active; tail events.jsonl while an app
//          starts or errors.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'events.jsonl');

export default {
  name: 'events-to-jsonl',
  apiVersion: 1,
  description: 'Appends every daimon event to events.jsonl beside this file.',

  // Called after each event is recorded, off the write path. `evt` is a
  // frozen copy: { ts, app, type, from?, to?, message? }. Throwing here would
  // disable this plugin for the session — appendFileSync on a local path is
  // safe enough for an example; wrap riskier I/O in your own try/catch.
  onEvent(evt) {
    fs.appendFileSync(OUT_FILE, JSON.stringify(evt) + '\n');
  },
};
```

Install it, restart the daemon, then start or stop an app in that workspace
and tail `~/.daimon/plugins/events.jsonl` — you'll see one JSON object per
line, including the plugin's own load skip-warnings if any sibling plugin
failed to load.

### `custom-doctor-rule.mjs` — doctor rule hook

Contributes one advise-only `daimon doctor` rule that flags a workspace where
daimon discovered zero apps.

```js
// custom-doctor-rule — example daimon plugin (Plugin API v1). See PLUGINS.md.
//
// Contributes one advise-only rule to `daimon doctor`: it flags a workspace
// where daimon discovered no apps at all. Plugin rules can FLAG, never fix —
// registerDoctorRules() is the only hook whose return value daimon consumes,
// and there is no auto-fix capability for plugin rules in v1.
//
// Install: copy into ~/.daimon/plugins/, then `daimon daemon restart`.
// Verify:  `daimon doctor` shows a `plugin:custom-doctor-rule/no-apps-discovered`
//          row (failing only when nothing was discovered).

export default {
  name: 'custom-doctor-rule',
  apiVersion: 1,
  description: 'Advise-only doctor rule: flags a workspace with zero discovered apps.',

  // Called once at load. Each rule: { id, description, check(ctx) }. check()
  // receives a read-only ctx { config, apps: [{ name, framework,
  // workspaceRoot }] } and returns one finding { ok, detail? } or an array of
  // them. Findings render in `daimon doctor` as `plugin:<plugin>/<rule>`.
  registerDoctorRules() {
    return [
      {
        id: 'no-apps-discovered',
        description: 'Flags a workspace where daimon discovered no apps.',
        check(ctx) {
          if (ctx.apps.length > 0) {
            return { ok: true, detail: `${ctx.apps.length} app(s) discovered` };
          }
          return {
            ok: false,
            detail: 'no apps discovered — check searchRoots in daimon.config.json, or run `daimon why-empty`',
          };
        },
      },
    ];
  },
};
```

Install it, restart the daemon, then run `daimon doctor` — look for a
`plugin:custom-doctor-rule/no-apps-discovered` row. It reports `ok: true` in
any workspace where daimon actually found apps, so to see it fail, point
`searchRoots` at an empty directory.

### Testing a plugin in isolation

Don't test against your real `~/.daimon` — use a throwaway `DAIMON_HOME`, the
same recipe daimon's own test suite uses:

```bash
export DAIMON_HOME=$(mktemp -d)
mkdir -p "$DAIMON_HOME/plugins"
cp my-plugin.mjs "$DAIMON_HOME/plugins/"

# Offline shape check — no daemon needed:
daimon plugin validate "$DAIMON_HOME/plugins/my-plugin.mjs"

# Load it for real: any daemon-needing command auto-spawns the daemon under
# this DAIMON_HOME (or use `daimon daemon start` / `daimon daemon restart`
# explicitly if one's already running under this home).
daimon list

# Confirm status:
daimon plugins
daimon plugin show my-plugin-name

# Exercise the observe hooks by starting/stopping an app in a workspace this
# DAIMON_HOME's config points at, then check whatever your plugin wrote out.

# Clean up:
daimon daemon stop
rm -rf "$DAIMON_HOME"
```

`daimon plugin validate <path>` and `daimon doctor` both re-read the file
fresh each time (no restart needed to see edits reflected there); the
observe hooks only exist in the daemon process launched above, so after
editing the plugin you'll need `daimon daemon restart` under that same
`DAIMON_HOME` to see the new behavior from `onEvent`/`onAppStart`/`onAppStop`.
