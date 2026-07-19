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
