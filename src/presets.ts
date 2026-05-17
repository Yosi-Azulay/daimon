import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

function presetsDir(): string {
  const candidates = [
    path.resolve(here, 'templates', 'presets'),
    path.resolve(here, '..', 'src', 'templates', 'presets'),
  ];
  for (const p of candidates) if (fs.existsSync(p)) return p;
  return candidates[0];
}

export function listPresets(): Array<{ name: string; description: string; patch: any }> {
  const dir = presetsDir();
  if (!fs.existsSync(dir)) return [];
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.json'));
  const out: any[] = [];
  for (const f of files) {
    try {
      let raw = fs.readFileSync(path.join(dir, f), 'utf8');
      if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1);
      out.push(JSON.parse(raw));
    } catch {}
  }
  return out;
}
