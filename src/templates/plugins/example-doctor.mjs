// Sample daimon plug-in (Plugin API v1, daimon v1.5+). See PLUGINS.md.
//
// Drop this file (any name ending in .mjs/.js/.cjs) into ~/.daimon/plugins/
// and restart the daemon (`daimon daemon restart`) — plugins are enumerated
// once at startup, no hot reload. `daimon plugins` then lists it.
//
// TRUST MODEL — plug-ins are NOT sandboxed. This file runs in-process with
// full Node privileges; daimon only loads files you placed in your own
// ~/.daimon/plugins directory. Treat any plug-in as trusted code you chose
// to run.
//
// The v1 hook surface is observe + doctor-rule contribution only: hooks
// receive read-only frozen snapshots, and nothing a hook returns is consumed
// except registerDoctorRules(). A hook that throws disables the plug-in for
// the session (one `plugin-error` self-event) — it never takes the daemon
// down. Fix the file, then `daimon daemon restart` to reload it.

export default {
  name: 'example-doctor',
  apiVersion: 1,
  description: 'No-op example plug-in demonstrating the v1 hook surface.',

  // Fires after each event is recorded (off the write path, fire-and-forget).
  // `evt` is a frozen copy: { ts, app, type, from?, to?, message? }.
  onEvent(evt) {
    void evt; // observe only — e.g. append to your own log file
  },

  // Fire on app lifecycle transitions. `app` is a frozen snapshot:
  // { name, framework, port, pid, status }.
  onAppStart(app) {
    void app;
  },
  onAppStop(app) {
    void app;
  },

  // Contribute advise-only doctor rules. Rules can flag, never fix — plugin
  // rules have no auto-fix capability in v1. `ctx` is read-only:
  // { config, apps: [{ name, framework, workspaceRoot }] }.
  registerDoctorRules() {
    return [
      {
        id: 'app-name-length',
        description: 'Flags apps whose names are longer than 32 characters.',
        check(ctx) {
          const long = ctx.apps.filter(a => a.name.length > 32);
          if (long.length === 0) return { ok: true };
          return long.map(a => ({
            ok: false,
            detail: `app name "${a.name}" is longer than 32 characters — consider a shorter override name`,
          }));
        },
      },
    ];
  },
};
