// Sample doctor plug-in for daimon v0.8+.
//
// Drop this file (or a copy renamed `doctor-<your-name>.mjs`) into
// ~/.daimon/plugins/ and restart the daemon. `daimon plugin list` will then show
// it. The plug-in is **inert** until its `name` ("example-doctor" below) is
// added to `doctor.autoFix.permitted` in daimon.config.json — this is the same
// opt-in gate built-in rules use, applied uniformly to the bundled sample and
// to user-authored plug-ins. Auditable in one sentence: if a plug-in's name
// isn't in `permitted`, its `fix` never runs.
//
// The DoctorContext exposes only the M36 mutation primitives — plug-ins cannot
// shell out to `npm`/`pip`/`bundle`/`cargo`/`go mod`. Edits to user source code
// are not allowed; state is confined to ~/.daimon/* and daimon.config.json.

export default {
  name: 'example-doctor',
  description: 'No-op example plug-in that demonstrates the v0.8 doctor surface.',
  requires: ['apps'],

  async scan(ctx) {
    // `ctx.apps` is the read-only list of discovered apps; `ctx.config` is the
    // active AppmanConfig; `ctx.history` exposes self-metrics queries.
    const findings = [];
    for (const app of ctx.apps) {
      if (app.name.length > 32) {
        findings.push({
          pluginName: 'example-doctor',
          id: `app-name-long:${app.name}`,
          severity: 'info',
          message: `app name "${app.name}" is longer than 32 characters`,
        });
      }
    }
    return findings;
  },

  // `fix` is optional. When absent, the plug-in is read-only. When present, it
  // will be invoked only if `doctor.autoFix.permitted` contains "example-doctor".
  async fix(_finding, _ctx) {
    return {
      ok: true,
      description: 'example-doctor has no real fix; this is a teaching sample.',
    };
  },
};
