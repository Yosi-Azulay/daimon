import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

function readPkg(): { version?: string } {
  const candidates = [
    path.resolve(here, '..', 'package.json'),
    path.resolve(here, '..', '..', 'package.json'),
  ];
  for (const p of candidates) {
    try {
      return JSON.parse(fs.readFileSync(p, 'utf8'));
    } catch {}
  }
  return {};
}

export const BOSUN_VERSION = readPkg().version || '0.0.0';
