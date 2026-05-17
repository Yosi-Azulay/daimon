import React, { useEffect, useState } from 'react';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Box, render, Text, useApp, useInput, useStdout } from 'ink';
import TextInput from 'ink-text-input';
import type { AppHealth, AppStatus, AppSummary } from '../types.js';

const STATUS_COLORS: Record<AppStatus, string> = {
  stopped: 'gray',
  starting: 'yellow',
  compiling: 'yellow',
  serving: 'green',
  error: 'red',
};

const HEALTH_COLORS: Record<AppHealth, string> = {
  healthy: 'green',
  unhealthy: 'red',
  unknown: 'gray',
};

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
  return path.join(os.homedir(), '.appman', `attach-token.${port}`);
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
      const r = await fetchJson('/api/apps');
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
        <Text color="yellow">daemon requires a bearer token. Enter token (Esc to cancel):</Text>
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
      <Box borderStyle="round" borderColor="cyan" paddingX={1}>
        <Text bold color="cyan">appman attach</Text>
        <Text dimColor>  •  http://127.0.0.1:{port}  •  HTTP-client TUI (q detaches, daemon keeps running)</Text>
      </Box>

      {error ? <Text color="red">{error}</Text> : null}

      <Box flexDirection="column" borderStyle="single" borderColor="gray" paddingX={1}>
        <Text bold>Apps ({apps.length})</Text>
        {apps.length === 0 ? <Text dimColor>(no apps)</Text> : apps.map((a, i) => {
          const sel = i === selected;
          return (
            <Box key={a.name}>
              <Text color={sel ? 'cyan' : undefined}>{sel ? '▸ ' : '  '}</Text>
              <Text color={sel ? 'cyan' : undefined}>{a.name.padEnd(20).slice(0, 20)}</Text>
              <Text color={STATUS_COLORS[a.status]}> {a.status.padEnd(9)}</Text>
              <Text color={HEALTH_COLORS[a.health]}>{a.status === 'serving' ? '●' : ' '}</Text>
              <Text dimColor>{a.port ? ` :${a.port}` : ''}</Text>
              <Text dimColor>  errs={a.errorCount}  up={fmtUptime(a.uptimeMs)}</Text>
            </Box>
          );
        })}
      </Box>

      {current ? (
        <Box flexDirection="column" borderStyle="single" borderColor="gray" paddingX={1}>
          <Text>Selected: <Text bold>{current.name}</Text></Text>
          <Text>URL: {current.url ?? '-'}</Text>
          {current.lastHealthError ? <Text color="red">HealthErr: {current.lastHealthError}</Text> : null}
          <Text dimColor>──── recent log (Enter/Space toggles) ────</Text>
          {expanded ? (
            logs.length === 0 ? <Text dimColor>(loading…)</Text> : logs.map((l, i) => <Text key={i} wrap="truncate-end">{l}</Text>)
          ) : <Text dimColor>(press Enter to fetch logs)</Text>}
        </Box>
      ) : null}

      <Text dimColor>[s] start  [x] stop  [r] restart  [Enter] toggle log  [q] detach (daemon keeps running)</Text>
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
