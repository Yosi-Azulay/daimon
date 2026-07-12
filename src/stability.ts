// Stability tiers (M87 / v0.14 "Runway"). Every public surface — CLI verb,
// HTTP endpoint, MCP tool, config key, event kind — declares one of these at
// its source of truth (cliSurface.ts, httpSurface.ts, mcp.ts, config.ts,
// types.ts). STABILITY.md defines the promise each tier makes:
//
//   frozen        shape never breaks; additive changes only. Every frozen
//                 surface has a golden-shape snapshot in test/fixtures/contract
//                 — a missing snapshot fails the contract suite.
//   stable        breaks only with a major version bump + migration note.
//   experimental  may change in any release.
//
// New surfaces MUST declare a tier; default new work to experimental.
export type Stability = 'frozen' | 'stable' | 'experimental';

export const STABILITY_TIERS: Stability[] = ['frozen', 'stable', 'experimental'];

export function isStability(v: unknown): v is Stability {
  return v === 'frozen' || v === 'stable' || v === 'experimental';
}
