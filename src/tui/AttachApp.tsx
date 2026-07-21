import React, { useEffect, useState } from 'react';
import fs from 'node:fs';
import path from 'node:path';
import { Box, render, Text, useApp, useInput, useStdout } from 'ink';
import TextInput from 'ink-text-input';
import type { AppSummary } from '../types.js';
import { generateAgentId } from '../agents.js';
import { daimonDir } from '../daemon.js';
import { makeTheme, statusRole, healthRole } from './theme.js';
import { footerChords } from './chords.js';

// STATUS_COLORS / HEALTH_COLORS used to be duplicated verbatim here and in
// App.tsx. Both now come from the one theme module (M165), so a palette change
// lands in a single place and the attach TUI degrades down the same
// truecolor → 16-color → NO_COLOR ladder as the main one.
const theme = makeTheme();

function fmtUptime(ms: number | null): string {
  if (ms == null) return '';
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

function tokenFilePath(port: number): string {
  // daimonDir() honors DAIMON_HOME (M91) — the attach token must live in the
  // same relocated state dir as everything else, or isolated test harnesses
  // leak tokens into the real ~/.daimon.
  return path.join(daimonDir(), `attach-token.${port}`);
}

function readCachedToken(port: number): string | null {
  try { return fs.readFileSync(tokenFilePath(port), 'utf8').trim() || null; } catch { return null; }
}

function writeCachedToken(port: number, token: string): void {
  try {
    fs.mkdirSync(path.dirname(tokenFilePath(port)), { recursive: true });
    fs.writeFileSync(tokenFilePath(port), token, 'utf8');
  } catch {}
}

interface AttachProps {
  port: number;
  onExit: () => void;
}

function AttachApp({ port, onExit }: AttachProps) {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const [apps, setApps] = useState<AppSummary[]>([]);
  const [selected, setSelected] = useState(0);
  const [expanded, setExpanded] = useState(false);
  const [logs, setLogs] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [token, setToken] = useState<string | null>(() => readCachedToken(port));
  const [promptingToken, setPromptingToken] = useState(false);
  const [tokenInput, setTokenInput] = useState('');

  const base = `http://127.0.0.1:${port}`;

  async function fetchJson(p: string, init: RequestInit = {}): Promise<{ status: number; body: any }> {
    try {
      const headers: Record<string, string> = { ...(init.headers as any || {}) };
      if (token) headers['authorization'] = `Bearer ${token}`;
      headers['x-daimon-agent'] = generateAgentId();
      headers['x-daimon-cwd'] = process.cwd();
      const res = await fetch(base + p, { ...init, headers });
      const text = await res.text();
      let body: any = text;
      try { body = JSON.parse(text); } catch {}
      return { status: res.status, body };
    } catch (err: any) {
      return { status: 0, body: { error: err?.message || String(err) } };
    }
  }

  useEffect(() => {
    let stopped = false;
    const tick = async () => {
      const r = await fetchJson('/api/apps?format=full');
      if (stopped) return;
      if (r.status === 0) { setError(r.body?.error || 'daemon unreachable'); return; }
      if (r.status === 401) { setPromptingToken(true); return; }
      setError(null);
      setApps(Array.isArray(r.body) ? r.body : []);
    };
    void tick();
    const id = setInterval(tick, 1000);
    return () => { stopped = true; clearInterval(id); };
  }, [token]);

  useEffect(() => {
    if (!expanded) { setLogs([]); return; }
    let stopped = false;
    const current = apps[selected];
    if (!current) return;
    const tick = async () => {
      const r = await fetchJson(`/api/apps/${encodeURIComponent(current.name)}/logs?tail=12`);
      if (stopped) return;
      if (Array.isArray(r.body?.lines)) setLogs(r.body.lines);
    };
    void tick();
    const id = setInterval(tick, 1000);
    return () => { stopped = true; clearInterval(id); };
  }, [expanded, selected, apps.length, token]);

  useInput((input, key) => {
    if (promptingToken) {
      if (key.escape) { setPromptingToken(false); return; }
      return;
    }
    if (input === 'q' || (key.ctrl && input === 'c')) {
      onExit();
      exit();
      return;
    }
    if (key.upArrow) setSelected(s => Math.max(0, s - 1));
    else if (key.downArrow) setSelected(s => Math.min(Math.max(0, apps.length - 1), s + 1));
    else if (key.return || input === ' ') setExpanded(e => !e);
    else if (input === 's' || input === 'x' || input === 'r') {
      const current = apps[selected];
      if (!current) return;
      const kind = input === 's' ? 'start' : input === 'x' ? 'stop' : 'restart';
      void fetchJson(`/api/apps/${encodeURIComponent(current.name)}/${kind}`, { method: 'POST' });
    }
  });

  if (promptingToken) {
    return (
      <Box flexDirection="column" paddingX={1}>
        <Text {...theme.style('warning')}>daemon requires a bearer token. Enter token (Esc to cancel):</Text>
        <TextInput
          value={tokenInput}
          onChange={setTokenInput}
          mask="*"
          onSubmit={() => {
            const t = tokenInput.trim();
            if (t) {
              setToken(t);
              writeCachedToken(port, t);
            }
            setTokenInput('');
            setPromptingToken(false);
          }}
        />
      </Box>
    );
  }

  const cols = stdout.columns || 100;
  const current = apps[selected];

  return (
    <Box flexDirection="column" width={cols}>
      <Box borderStyle="round" borderColor={theme.color('primary')} paddingX={1}>
        <Text bold color={theme.color('primary')}>daimon attach</Text>
        <Text {...theme.style('muted')}>  •  http://127.0.0.1:{port}  •  HTTP-client TUI (q detaches, daemon keeps running)</Text>
      </Box>

      {error ? <Text {...theme.style('danger')}>{error}</Text> : null}

      <Box flexDirection="column" borderStyle="single" borderColor={theme.color('blurBorder')} paddingX={1}>
        <Text bold>Apps ({apps.length})</Text>
        {apps.length === 0 ? <Text {...theme.style('muted')}>(no apps)</Text> : apps.map((a, i) => {
          const sel = i === selected;
          return (
            <Box key={a.name}>
              <Text {...(sel ? theme.style('selection') : {})}>{sel ? '▸ ' : '  '}</Text>
              <Text {...(sel ? theme.style('selection') : {})}>{a.name.padEnd(20).slice(0, 20)}</Text>
              <Text {...theme.style(statusRole(a.status))}> {a.status.padEnd(9)}</Text>
              <Text {...theme.style(healthRole(a.health))}>{a.status === 'serving' ? '●' : ' '}</Text>
              <Text {...theme.style('muted')}>{a.port ? ` :${a.port}` : ''}</Text>
              <Text {...theme.style('muted')}>  errs={a.errorCount}  up={fmtUptime(a.uptimeMs)}</Text>
            </Box>
          );
        })}
      </Box>

      {current ? (
        <Box flexDirection="column" borderStyle="single" borderColor={theme.color('blurBorder')} paddingX={1}>
          <Text>Selected: <Text bold>{current.name}</Text></Text>
          <Text>URL: {current.url ?? '-'}</Text>
          {current.lastHealthError ? <Text {...theme.style('danger')}>HealthErr: {current.lastHealthError}</Text> : null}
          <Text {...theme.style('muted')}>──── recent log (Enter/Space toggles) ────</Text>
          {expanded ? (
            logs.length === 0 ? <Text {...theme.style('muted')}>(loading…)</Text> : logs.map((l, i) => <Text key={i} wrap="truncate-end">{l}</Text>)
          ) : <Text {...theme.style('muted')}>(press Enter to fetch logs)</Text>}
        </Box>
      ) : null}

      {/* Rendered from the chord map (M163) — the attach footer used to be a
          hand-written string here and a second one in keys.ts's KEY_HELP. */}
      <Text {...theme.style('muted')}>
        {footerChords('attach').map(c => `[${c.key}] ${c.label}`).join('  ')}
      </Text>
    </Box>
  );
}

export async function attachToDaemon(port: number): Promise<void> {
  let resolveExit: () => void;
  const exited = new Promise<void>(r => { resolveExit = r; });
  const inst = render(React.createElement(AttachApp, { port, onExit: () => resolveExit() }));
  await inst.waitUntilExit();
  await exited;
}
