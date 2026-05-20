import { defineConfig } from 'vitest/config';

// Light-touch Vitest setup for daimon's dashboard.
//
// We deliberately do NOT spin up the Angular runtime here. The dashboard's
// signal-bearing components are exercised at integration level by the daimon
// daemon's regression tests; this Vitest layer covers the pure logic units
// (URI builders, summary parsers, pill-kind selectors) that ride along with
// the components. Keeps the dev-dep footprint small (vitest only, no
// jsdom / @angular/build / playwright) and matches the plan's "fixture-daemon
// harness" framing — the daemon is the fixture, this is the harness.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.spec.ts'],
    reporters: ['default'],
    passWithNoTests: false,
  },
});
