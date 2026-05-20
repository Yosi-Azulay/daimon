import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseTaskSummary } from '../dist/taskRunner.js';

test('jest summary parses passed/failed/total/suites + failed-test rows', () => {
  const out = `
PASS  src/foo.test.ts
FAIL  src/bar.test.ts
  ✕  bar > does the thing (12 ms)
Test Suites: 1 failed, 1 passed, 2 total
Tests:       1 failed, 9 passed, 10 total
`;
  const s = parseTaskSummary(out);
  assert.equal(s?.framework, 'jest');
  assert.equal(s?.passed, 9);
  assert.equal(s?.failed, 1);
  assert.equal(s?.total, 10);
  assert.equal(s?.suites, 2);
  assert.equal(s?.failedTests?.[0]?.name, 'bar > does the thing');
  assert.equal(s?.failedTests?.[0]?.file, 'src/bar.test.ts');
});

test('vitest summary parses passed/failed/total/suites', () => {
  const out = `
 Test Files  1 failed | 6 passed (7)
      Tests  3 failed | 240 passed (243)
   Start at  10:00:00
   Duration  4.21s
`;
  const s = parseTaskSummary(out);
  assert.equal(s?.framework, 'vitest');
  assert.equal(s?.passed, 240);
  assert.equal(s?.failed, 3);
  assert.equal(s?.total, 243);
  assert.equal(s?.suites, 7);
});

test('pytest summary parses passed/failed/duration', () => {
  const out = `tests/test_a.py FAILED
FAILED tests/test_a.py::test_thing
1 failed, 5 passed in 0.12s
`;
  const s = parseTaskSummary(out);
  assert.equal(s?.framework, 'pytest');
  assert.equal(s?.passed, 5);
  assert.equal(s?.failed, 1);
  assert.equal(s?.durationMs, 120);
  assert.equal(s?.failedTests?.[0]?.file, 'tests/test_a.py');
});

test('rspec summary parses examples/failures', () => {
  const out = `10 examples, 1 failure`;
  const s = parseTaskSummary(out);
  assert.equal(s?.framework, 'rspec');
  assert.equal(s?.passed, 9);
  assert.equal(s?.failed, 1);
  assert.equal(s?.total, 10);
});

test('cargo test parses passed/failed', () => {
  const out = `running 12 tests
test result: ok. 12 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out`;
  const s = parseTaskSummary(out);
  assert.equal(s?.framework, 'cargo');
  assert.equal(s?.passed, 12);
  assert.equal(s?.failed, 0);
});

test('go test sums pkg ok/FAIL lines and accumulates duration', () => {
  const out = `ok      github.com/x/a  0.123s
FAIL    github.com/x/b  0.045s
ok      github.com/x/c  0.011s`;
  const s = parseTaskSummary(out);
  assert.equal(s?.framework, 'go');
  assert.equal(s?.passed, 2);
  assert.equal(s?.failed, 1);
  assert.equal(s?.total, 3);
  // 0.123 + 0.045 + 0.011 = 0.179s = 179ms
  assert.ok(s?.durationMs === 179 || s?.durationMs === 180);
});

test('playwright summary parses passed/failed when "playwright" in output', () => {
  const out = `Running playwright tests
12 passed, 1 failed
`;
  const s = parseTaskSummary(out);
  assert.equal(s?.framework, 'playwright');
  assert.equal(s?.passed, 12);
  assert.equal(s?.failed, 1);
});

test('returns null for unrecognized output', () => {
  assert.equal(parseTaskSummary('nothing here'), null);
});
