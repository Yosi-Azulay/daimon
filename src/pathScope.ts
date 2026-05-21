import path from 'node:path';

// Normalize a filesystem path for cross-platform "is X under Y" comparisons.
// - Resolves to an absolute path (no trailing separator)
// - Lowercases on Windows (NTFS is case-insensitive by default)
// - Uses the platform's native separator after resolve()
export function normalizeForCompare(p: string): string {
  const abs = path.resolve(p);
  return process.platform === 'win32' ? abs.toLowerCase() : abs;
}

// True if `child` is the same path as `parent` or a descendant of it.
// Both arguments are resolved to absolute paths before comparison.
export function isPathUnder(child: string, parent: string): boolean {
  const c = normalizeForCompare(child);
  const p = normalizeForCompare(parent);
  if (c === p) return true;
  const withSep = p.endsWith(path.sep) ? p : p + path.sep;
  return c.startsWith(withSep);
}
