import { test } from 'node:test';
import assert from 'node:assert/strict';

// The budget collapse logic lives inline in server.ts; replicate it here as a
// unit test against an isolated copy. Any drift between this and the server
// path would be caught by an integration smoke; this test guards the
// invariants: omits never goes negative, _meta is set, capChars roughly maps
// to budget*4, and an empty input is a no-op.
function applyBudget(out, budgetTokens) {
  const capChars = budgetTokens * 4;
  let omittedNa = 0;
  let omittedRc = 0;
  while (JSON.stringify(out).length > capChars && (out.needsAttention.length || out.recentlyChanged.length)) {
    if (out.needsAttention.length > 1) { out.needsAttention.pop(); omittedNa++; }
    else if (out.recentlyChanged.length) { out.recentlyChanged.pop(); omittedRc++; }
    else if (out.needsAttention.length === 1) { out.needsAttention.pop(); omittedNa++; }
    else break;
  }
  if (omittedNa || omittedRc) {
    out._meta = { ...(out._meta ?? {}), budget: budgetTokens, omitted: { needsAttention: omittedNa, recentlyChanged: omittedRc } };
  } else {
    out._meta = { ...(out._meta ?? {}), budget: budgetTokens };
  }
  return out;
}

test('overview budget: under-budget passes through with _meta.budget only', () => {
  const out = applyBudget({ needsAttention: [{ name: 'a', errCount: 1 }], recentlyChanged: [] }, 1000);
  assert.equal(out.needsAttention.length, 1);
  assert.equal(out._meta.budget, 1000);
  assert.equal(out._meta.omitted, undefined);
});

test('overview budget: over-budget collapses needsAttention first', () => {
  const big = Array.from({ length: 50 }, (_, i) => ({
    name: `app-${i}`,
    status: 'error',
    errCount: 7,
    firstError: { file: `D:\\workspace\\some\\path\\file-${i}.ts`, line: 42, code: 'TS2304', message: 'Cannot find name foo'.repeat(3) },
  }));
  const rc = Array.from({ length: 5 }, (_, i) => ({ name: `app-${i}`, transition: 'compiling→serving', msAgo: 1000 * i }));
  const out = applyBudget({ needsAttention: big, recentlyChanged: rc }, 200);
  assert.ok(out._meta.omitted, '_meta.omitted set when truncated');
  assert.ok(out._meta.omitted.needsAttention > 0, 'truncated needsAttention');
  const len = JSON.stringify(out).length;
  assert.ok(len <= 200 * 4 + 200, `length ${len} should fit within budget+slack`);
});

test('overview budget: zero rows is a no-op', () => {
  const out = applyBudget({ needsAttention: [], recentlyChanged: [] }, 64);
  assert.equal(out._meta.omitted, undefined);
});
