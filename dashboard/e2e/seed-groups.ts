// Shared "seed a couple of named app groups over the REAL registry" helper
// (M97 groups dashboard drive). Groups are config-driven (daimon.config.json
// 'groups' map, M93) rather than a history-db table, so unlike the rest of
// e2e/seed.ts's direct-DB-insert seeding this goes through the daemon's own
// PATCH /api/config over HTTP — and it needs REAL registry app names (GET
// /api/groups renders membership against the live registry; seed.ts's
// synthetic history-only names like 'web-admin' would just render as
// 0-member groups since they're not apps the daemon actually discovered).
// Used by both e2e/seed.ts (the standalone pre-drive seed script) and any
// Playwright spec that needs groups seeded independent of whether that
// script ran first — mirrors dashboard.spec.ts's seedCrashFor / mute-badge
// tests, which re-seed their own state against real apps rather than
// trusting seed.ts's fixed fake names.

export interface SeededGroups {
  web: string[];
  day: string[];
}

// Returns null ONLY for the legitimate skip cases — no live daemon, no
// registry apps, or a pre-v1.1 daemon (GET /api/groups 404s). Once the
// daemon has answered /api/groups with 200 it demonstrably supports groups,
// so any later seeding failure THROWS: a broken etag or a rejected PATCH on
// a current daemon is a regression the drive must fail on, not silently
// test.skip() past (the skip condition can't otherwise tell "old daemon"
// from "current daemon broke").
export async function seedRealGroups(baseURL: string): Promise<SeededGroups | null> {
  let groupsSupported = false;
  try {
    const probe = await fetch(`${baseURL}/api/groups`);
    if (probe.status === 404) return null; // pre-v1.1 daemon — legit skip
    groupsSupported = probe.ok;
    if (!groupsSupported) return null;

    const appsRes = await fetch(`${baseURL}/api/apps`);
    if (!appsRes.ok) return null;
    const apps: { name: string }[] = await appsRes.json();
    if (!Array.isArray(apps) || !apps.length) return null; // empty workspace — legit skip

    const cfgRes = await fetch(`${baseURL}/api/config`);
    if (!cfgRes.ok) throw new Error(`GET /api/config failed (${cfgRes.status}) on a groups-capable daemon`);
    const etag = cfgRes.headers.get('etag');
    if (!etag) throw new Error('GET /api/config returned no etag on a groups-capable daemon');

    const names = apps.map(a => a.name);
    // 'web' covers all-but-the-last app (leaves >=1 app ungrouped whenever
    // there's more than one app to work with); 'day' is just the first app,
    // deliberately overlapping with 'web' -- that overlap is what exercises
    // the multi-group-membership path (an app under two section headings /
    // two detail-page chips).
    const web = names.length > 1 ? names.slice(0, -1) : names.slice();
    const day = names.slice(0, 1);

    const patchRes = await fetch(`${baseURL}/api/config`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', 'if-match': etag },
      body: JSON.stringify({ groups: { web: { apps: web, autoStart: false }, day: { apps: day, autoStart: false } } }),
    });
    if (!patchRes.ok) throw new Error(`PATCH /api/config groups seed failed (${patchRes.status}) on a groups-capable daemon`);
    return { web, day };
  } catch (err) {
    // Network-level failure with no groups probe answered = no live daemon —
    // the legit skip. Anything after a successful probe re-throws.
    if (groupsSupported) throw err;
    return null;
  }
}
