import fs from 'node:fs';
import path from 'node:path';
import { daimonDir } from './daemon.js';

export function secretsPath(): string {
  return path.join(daimonDir(), 'secrets.json');
}

export function readSecrets(): Record<string, string> {
  try {
    let raw = fs.readFileSync(secretsPath(), 'utf8');
    if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1);
    const obj = JSON.parse(raw);
    if (!obj || typeof obj !== 'object') return {};
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(obj)) {
      if (typeof v === 'string') out[k] = v;
    }
    return out;
  } catch {
    return {};
  }
}

export function substituteSecrets(env: Record<string, string>, secrets: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    out[k] = v.replace(/\$\{([A-Z_][A-Z0-9_]*)\}/gi, (_, name) => secrets[name] ?? `\${${name}}`);
  }
  return out;
}
