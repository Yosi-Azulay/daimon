// Loud platform skips (M142, v1.9 "Everywhere").
//
// A platform-conditional test must announce what it did NOT prove, on every
// host — a bare `if (isWin) { test(...) }` (which silently omits the test on the
// other OS) or a `if (process.platform !== 'x') return` (which passes vacuously)
// is a defect. Route every such test through platformSkip so a Windows run and a
// future Mac/Linux run are equally honest.
//
// Usage:
//   test('does X on Windows', (t) => {
//     if (platformSkip(t, 'win32', 'real NTFS case-insensitive path matching')) return;
//     ...assertions that only make sense on the host platform...
//   });
//
// The trailing `return` after a true result is correct: the loud t.skip() is the
// signal; returning just avoids running host-specific assertions off-platform.
//
// `required` is a platform string or an array of them. The note states what the
// test WOULD verify, so a skipped line reads: "requires win32: <note>".
export function platformSkip(t, required, note) {
  const needed = Array.isArray(required) ? required : [required];
  if (!needed.includes(process.platform)) {
    t.skip(`requires ${needed.join('|')}: ${note}`);
    return true;
  }
  return false;
}
