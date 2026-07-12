// Shared route list (M89): a plain data module (no `test()` calls), so
// importing it from a11y.spec.ts / keyboard.spec.ts never drags dashboard
// .spec.ts's own tests into an unrelated Playwright run — importing a file
// that calls the `test()` global registers its tests for whichever project
// is currently executing, even if that file was never named on the command
// line. dashboard.spec.ts re-exports ROUTE_PATHS from here for back-compat.
export const ROUTE_PATHS: string[] = [
  '/',
  '/errors',
  '/logs',
  '/config',
  '/doctor',
  '/events',
  '/history',
  '/trends',
  '/timeline',
  '/tests',
  '/sessions',
  '/agents',
  '/regressions',
  '/report',
];
