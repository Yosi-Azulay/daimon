import fs from 'node:fs';
import path from 'node:path';

export function parseEnvFile(file: string): Record<string, string> {
  const out: Record<string, string> = {};
  let raw: string;
  try { raw = fs.readFileSync(file, 'utf8'); } catch { return out; }
  for (const line of raw.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const eq = t.indexOf('=');
    if (eq < 0) continue;
    const k = t.slice(0, eq).trim();
    let v = t.slice(eq + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    if (k) out[k] = v;
  }
  return out;
}

export function resolveEnvFilePath(workspaceRoot: string, file: string): string {
  if (path.isAbsolute(file)) return file;
  return path.join(workspaceRoot, file);
}

export function existingEnvFiles(workspaceRoot: string, candidates: string[]): string[] {
  return candidates.filter(c => fs.existsSync(resolveEnvFilePath(workspaceRoot, c)));
}
