import path from 'node:path';

// Normalize a filesystem path for cross-platform "is X under Y" comparisons.
// - Resolves to an absolute path (no trailing separator)
// - Lowercases on Windows (NTFS is case-insensitive by default)
// - Uses the platform's native separator after resolve()
// `platform` is injectable (M140) so the case-fold decision is unit-testable on
// either host; path.resolve itself stays host-bound (documented in the
// inventory), but the fold branch is what this proves.
export function normalizeForCompare(p: string, platform: NodeJS.Platform = process.platform): string {
  const abs = path.resolve(p);
  return platform === 'win32' ? abs.toLowerCase() : abs;
}

// True if `child` is the same path as `parent` or a descendant of it.
// Both arguments are resolved to absolute paths before comparison.
export function isPathUnder(child: string, parent: string, platform: NodeJS.Platform = process.platform): boolean {
  const c = normalizeForCompare(child, platform);
  const p = normalizeForCompare(parent, platform);
  if (c === p) return true;
  const withSep = p.endsWith(path.sep) ? p : p + path.sep;
  return c.startsWith(withSep);
}
