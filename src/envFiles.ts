import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { daimonDir } from './daemon.js';

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

// ---------------------------------------------------------------------------
// Env awareness (M82) — read-only, redacted at the STORAGE layer. Raw values
// are parsed and discarded inside snapshotEnvFiles in the same tick; only key
// names and per-key salted truncated hashes ever leave this module. There is
// deliberately no way to read a value back out — open the file.
// ---------------------------------------------------------------------------

export interface EnvFileSnapshot {
  file: string;
  exists: boolean;
  mtime: number | null;
  size: number | null;
  keyNames: string[];
  // key → 12-hex-char HMAC(salt, key + value). Change detection only.
  keyHashes: Record<string, string>;
}

export interface EnvSnapshot {
  files: EnvFileSnapshot[];
}

export function saltPath(): string {
  return path.join(daimonDir(), 'salt');
}

let cachedSalt: string | null = null;

// Per-install random salt, created once and reused (~/.daimon/salt). Keeps
// hashes non-comparable across machines and useless as an offline dictionary
// target without the file.
export function envSalt(): string {
  if (cachedSalt) return cachedSalt;
  const p = saltPath();
  try {
    const existing = fs.readFileSync(p, 'utf8').trim();
    if (existing.length >= 32) {
      cachedSalt = existing;
      return existing;
    }
  } catch {}
  const fresh = crypto.randomBytes(32).toString('hex');
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, fresh, { mode: 0o600 });
  } catch {}
  cachedSalt = fresh;
  return fresh;
}

// Test-only: forget the cached salt so DAIMON_HOME relocation is honored.
export function _resetSaltCacheForTest(): void {
  cachedSalt = null;
}

export function hashEnvValue(salt: string, key: string, value: string): string {
  return crypto.createHmac('sha256', salt).update(key + '\n' + value).digest('hex').slice(0, 12);
}

// Fingerprint every candidate file. Values live only inside this function's
// frame: parsed, hashed, discarded — never returned, never stored.
export function snapshotEnvFiles(workspaceRoot: string, candidates: string[], salt = envSalt()): EnvSnapshot {
  const files: EnvFileSnapshot[] = [];
  for (const c of candidates) {
    const abs = resolveEnvFilePath(workspaceRoot, c);
    let stat: fs.Stats | null = null;
    try { stat = fs.statSync(abs); } catch {}
    if (!stat || !stat.isFile()) {
      files.push({ file: c, exists: false, mtime: null, size: null, keyNames: [], keyHashes: {} });
      continue;
    }
    const values = parseEnvFile(abs);
    const keyNames = Object.keys(values);
    const keyHashes: Record<string, string> = {};
    for (const k of keyNames) keyHashes[k] = hashEnvValue(salt, k, values[k]);
    files.push({ file: c, exists: true, mtime: Math.round(stat.mtimeMs), size: stat.size, keyNames, keyHashes });
  }
  return { files };
}

export interface EnvDiff {
  filesAdded: string[];
  filesRemoved: string[];
  keysAdded: { file: string; key: string }[];
  keysRemoved: { file: string; key: string }[];
  keysChanged: { file: string; key: string }[];
  changed: boolean;
}

// Diff two snapshots (from → to). Only names travel; hashes are compared and
// dropped.
export function diffEnvSnapshots(from: EnvSnapshot | null, to: EnvSnapshot | null): EnvDiff {
  const out: EnvDiff = { filesAdded: [], filesRemoved: [], keysAdded: [], keysRemoved: [], keysChanged: [], changed: false };
  const fromFiles = new Map((from?.files ?? []).filter(f => f.exists).map(f => [f.file, f]));
  const toFiles = new Map((to?.files ?? []).filter(f => f.exists).map(f => [f.file, f]));
  for (const file of toFiles.keys()) if (!fromFiles.has(file)) out.filesAdded.push(file);
  for (const file of fromFiles.keys()) if (!toFiles.has(file)) out.filesRemoved.push(file);
  for (const [file, toF] of toFiles) {
    const fromF = fromFiles.get(file);
    if (!fromF) continue;
    const fromKeys = new Set(fromF.keyNames);
    const toKeys = new Set(toF.keyNames);
    for (const k of toKeys) if (!fromKeys.has(k)) out.keysAdded.push({ file, key: k });
    for (const k of fromKeys) if (!toKeys.has(k)) out.keysRemoved.push({ file, key: k });
    for (const k of toKeys) {
      if (!fromKeys.has(k)) continue;
      if (fromF.keyHashes[k] !== toF.keyHashes[k]) out.keysChanged.push({ file, key: k });
    }
  }
  out.changed = !!(out.filesAdded.length || out.filesRemoved.length || out.keysAdded.length || out.keysRemoved.length || out.keysChanged.length);
  return out;
}

// Candidate resolution order: explicit config (envFiles.<app>) wins, then the
// framework profile's documented conventions, then the generic ['.env'].
export function envFileCandidates(
  configured: string[] | undefined,
  profileEnvFiles: string[] | undefined,
  generic: string[] = ['.env'],
): string[] {
  if (configured && configured.length) return [...configured];
  if (profileEnvFiles && profileEnvFiles.length) return [...profileEnvFiles];
  return [...generic];
}
