import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';

const MARKERS = ['nx.json', 'angular.json', 'vite.config.ts', 'vite.config.js', 'vite.config.mjs', '.storybook'];

function ask(rl: readline.Interface, q: string): Promise<string> {
  return new Promise(resolve => rl.question(q, ans => resolve(ans.trim())));
}

function detectMarkers(cwd: string): string[] {
  const out: string[] = [];
  for (const m of MARKERS) {
    if (fs.existsSync(path.join(cwd, m))) out.push(m);
  }
  return out;
}

export interface InitOpts {
  cwd?: string;
  force?: boolean;
}

export interface InitResult {
  path: string;
  installClaude: boolean;
  config: any;
}

export async function runInit(opts: InitOpts = {}): Promise<InitResult> {
  const cwd = opts.cwd ?? process.cwd();
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const markers = detectMarkers(cwd);
    const searchRoots: any[] = [];

    if (markers.length) {
      process.stdout.write(`[daimon init] detected in ${cwd}: ${markers.join(', ')}\n`);
      const useCwd = (await ask(rl, 'Add this folder as a searchRoot? [Y/n] ')) || 'y';
      if (useCwd.toLowerCase().startsWith('y')) {
        const label = await ask(rl, 'Optional label for this workspace (blank = none): ');
        searchRoots.push(label ? { path: cwd, label } : cwd);
      }
    }

    const more = await ask(rl, 'Additional searchRoots (comma-separated absolute paths, blank to skip): ');
    if (more) {
      for (const p of more.split(',').map(s => s.trim()).filter(Boolean)) searchRoots.push(p);
    }

    const portRangeRaw = (await ask(rl, 'Port range [4200-4299]: ')) || '4200-4299';
    const portMatch = portRangeRaw.match(/^(\d+)\s*[-,\s]\s*(\d+)$/);
    const portRange: [number, number] = portMatch ? [Number(portMatch[1]), Number(portMatch[2])] : [4200, 4299];

    const apiPortRaw = (await ask(rl, 'apiPort [4999]: ')) || '4999';
    const apiPort = Number(apiPortRaw) || 4999;

    const targetAns = (await ask(rl, 'Write to (1) ./daimon.config.json or (2) ~/.daimon/config.json? [1] ')) || '1';
    const target = targetAns.trim() === '2' ? path.join(os.homedir(), '.daimon', 'config.json') : path.join(cwd, 'daimon.config.json');

    if (fs.existsSync(target) && !opts.force) {
      throw new Error(`refusing to overwrite ${target} (pass --force to overwrite)`);
    }

    const config: any = { searchRoots, portRange, apiPort };

    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, JSON.stringify(config, null, 2) + '\n', 'utf8');
    process.stdout.write(`[daimon init] wrote ${target}\n`);

    const installClaudeAns = (await ask(rl, 'Install Claude Code integration? [Y/n] ')) || 'y';
    const installClaude = installClaudeAns.toLowerCase().startsWith('y');

    return { path: target, installClaude, config };
  } finally {
    rl.close();
  }
}
