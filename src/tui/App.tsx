import React, { useEffect, useState } from 'react';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Box, Text, useApp, useInput, useStdout } from 'ink';
import TextInput from 'ink-text-input';
import { spawn, spawnSync } from 'node:child_process';
import type { Registry } from '../registry.js';
import type { AppHealth, AppSummary, AppStatus } from '../types.js';
import LogPane from './LogPane.js';

function openUrl(url: string): void {
  try {
    if (process.platform === 'win32') {
      spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
    } else if (process.platform === 'darwin') {
      spawn('open', [url], { detached: true, stdio: 'ignore' }).unref();
    } else {
      spawn('xdg-open', [url], { detached: true, stdio: 'ignore' }).unref();
    }
  } catch {}
}

interface Props {
  registry: Registry;
  apiPort: number;
  onQuit: () => void;
}

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

export default function App({ registry, apiPort, onQuit }: Props) {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const [apps, setApps] = useState<AppSummary[]>(registry.list());
  const [selected, setSelected] = useState(0);
  const [logFocus, setLogFocus] = useState(false);
  const [logScroll, setLogScroll] = useState(0);
  const [fullLog, setFullLog] = useState(false);
  const [tagFilter, setTagFilter] = useState<string[]>([]);
  const [tagPicking, setTagPicking] = useState(false);
  const [tagInput, setTagInput] = useState('');
  const [editing, setEditing] = useState<{ name: string; field: 'command' | 'port' | 'env'; cmd: string; port: string; env: string } | null>(null);
  const [, setTick] = useState(0);

  useEffect(() => {
    const onChange = () => setApps(registry.list());
    registry.on('change', onChange);
    const interval = setInterval(() => {
      setApps(registry.list());
      setTick(t => t + 1);
    }, 1000);
    return () => {
      registry.off('change', onChange);
      clearInterval(interval);
    };
  }, [registry]);

  useInput((input, key) => {
    if (fullLog) return;
    if (editing) {
      if (key.escape) { setEditing(null); return; }
      if (key.tab) {
        const nextField = editing.field === 'command' ? 'port' : editing.field === 'port' ? 'env' : 'command';
        setEditing({ ...editing, field: nextField });
        return;
      }
      return;
    }
    if (tagPicking) {
      if (key.escape) { setTagPicking(false); setTagInput(''); return; }
      if (key.return) {
        const t = tagInput.trim();
        setTagFilter(t ? t.split(/[\s,]+/).filter(Boolean) : []);
        setTagPicking(false);
        setTagInput('');
        return;
      }
      if (key.backspace || key.delete) { setTagInput(s => s.slice(0, -1)); return; }
      if (input && !key.ctrl) setTagInput(s => s + input);
      return;
    }
    if (input === 'q' || (key.ctrl && input === 'c')) {
      onQuit();
      exit();
      return;
    }
    if (apps.length === 0) return;

    if (key.upArrow) {
      setSelected(s => Math.max(0, s - 1));
      setLogScroll(0);
      return;
    }
    if (key.downArrow) {
      setSelected(s => Math.min(apps.length - 1, s + 1));
      setLogScroll(0);
      return;
    }

    const current = apps[selected];
    if (!current) return;

    if (input === 's') void registry.start(current.name);
    else if (input === 'x') void registry.stop(current.name);
    else if (input === 'r') void registry.restart(current.name);
    else if (input === 'L') setFullLog(true);
    else if (input === 't') { setTagPicking(true); setTagInput(tagFilter.join(' ')); }
    else if (input === 'e') {
      const cfg = registry.getConfig();
      const app = registry.getApp(current.name);
      const so = registry.getState(current.name)?.sessionOverrides ?? null;
      const envSrc = so?.env ?? cfg.overrides?.[current.name]?.env ?? {};
      const envText = Object.entries(envSrc).map(([k, v]) => `${k}=${v}`).join('\n');
      setEditing({
        name: current.name,
        field: 'command',
        cmd: so?.command ?? app?.command ?? '',
        port: String(so?.port ?? cfg.overrides?.[current.name]?.port ?? current.port ?? ''),
        env: envText,
      });
    }
    else if (input === 'E') {
      const cfg = registry.getConfig();
      const cands = cfg.envFiles?.[current.name] ?? [];
      if (!cands.length) return;
      const cur = registry.getState(current.name)?.activeEnvFile ?? null;
      const idx = cur ? cands.indexOf(cur) : -1;
      const next = cands[(idx + 1) % cands.length];
      registry.setActiveEnvFile(current.name, next);
    }
    else if (input === 'V') {
      const editor = process.env.EDITOR || (process.platform === 'win32' ? 'notepad' : 'vi');
      const tmp = path.join(os.tmpdir(), `daimon-${current.name}-${Date.now()}.json`);
      const cfg = registry.getConfig();
      const app = registry.getApp(current.name);
      const so = registry.getState(current.name)?.sessionOverrides ?? null;
      const payload = {
        command: so?.command ?? app?.command,
        port: so?.port ?? cfg.overrides?.[current.name]?.port ?? null,
        env: so?.env ?? cfg.overrides?.[current.name]?.env ?? {},
      };
      try {
        fs.writeFileSync(tmp, JSON.stringify(payload, null, 2));
        spawnSync(editor, [tmp], { stdio: 'inherit', shell: true });
        const raw = fs.readFileSync(tmp, 'utf8');
        const parsed = JSON.parse(raw);
        registry.setSessionOverride(current.name, {
          command: typeof parsed.command === 'string' ? parsed.command : undefined,
          port: typeof parsed.port === 'number' ? parsed.port : undefined,
          env: parsed.env && typeof parsed.env === 'object' ? parsed.env : undefined,
        });
        fs.unlinkSync(tmp);
      } catch {}
    }
    else if (input === 'l') setLogFocus(f => !f);
    else if (input === 'o') { if (current.url) openUrl(current.url); }
    else if (key.pageUp) setLogScroll(s => s + 5);
    else if (key.pageDown) setLogScroll(s => Math.max(0, s - 5));
  });

  const visibleApps = tagFilter.length === 0
    ? apps
    : apps.filter(a => tagFilter.every(t => a.tags.includes(t)));
  const current = visibleApps[Math.min(selected, Math.max(0, visibleApps.length - 1))];
  const state = current ? registry.getState(current.name) : null;
  const recentLogs = state
    ? state.logBuffer
        .slice(Math.max(0, state.logBuffer.length - 12 - logScroll), state.logBuffer.length - logScroll)
        .map(e => e.line)
    : [];

  const cols = stdout.columns || 100;
  const leftWidth = Math.min(36, Math.floor(cols * 0.4));

  if (fullLog && current) {
    return <LogPane registry={registry} appName={current.name} onExit={() => setFullLog(false)} />;
  }

  return (
    <Box flexDirection="column" width={cols}>
      <Box borderStyle="round" borderColor="cyan" paddingX={1}>
        <Text bold color="cyan">daimon</Text>
        <Text dimColor>  •  api http://127.0.0.1:{apiPort}</Text>
      </Box>

      <Box flexDirection="row">
        <Box flexDirection="column" width={leftWidth} borderStyle="single" borderColor="gray" paddingX={1}>
          <Text bold>Apps {tagFilter.length ? <Text dimColor>(tags: {tagFilter.join(', ')})</Text> : null}</Text>
          {visibleApps.length === 0 ? (
            <Text dimColor>{apps.length === 0 ? '(no apps discovered)' : '(no apps match tag filter)'}</Text>
          ) : visibleApps.map((a, i) => {
            const sel = i === selected;
            return (
              <Box key={a.name}>
                <Text color={sel ? 'cyan' : undefined}>{sel ? '▸ ' : '  '}</Text>
                <Text color={sel ? 'cyan' : undefined}>{((registry.getState(a.name)?.sessionOverrides ? '*' : '') + a.name).padEnd(20).slice(0, 20)}</Text>
                <Text color={STATUS_COLORS[a.status]}> {a.status.padEnd(9)}</Text>
                <Text color={HEALTH_COLORS[a.health]}>{a.status === 'serving' ? '●' : ' '}</Text>
                <Text dimColor>{a.port ? ` :${a.port}` : ''}</Text>
                {cols >= 100 && a.cpu != null ? <Text dimColor>  {String(a.cpu).padStart(5)}% {String(a.memMB ?? 0).padStart(5)}MB</Text> : null}
              </Box>
            );
          })}
        </Box>

        <Box flexDirection="column" flexGrow={1} borderStyle="single" borderColor="gray" paddingX={1}>
          {current && state ? (
            <>
              <Text>Selected: <Text bold>{current.name}</Text></Text>
              <Text>Status:   <Text color={STATUS_COLORS[current.status]}>{current.status}</Text> <Text color={HEALTH_COLORS[current.health]}>●</Text> <Text dimColor>{current.health}</Text></Text>
              <Text>Port:     {current.port ?? '-'}</Text>
              <Text>URL:      {current.url ?? '-'}</Text>
              {current.announcedUrl && current.announcedUrl !== current.url ? (
                <Text dimColor>Announced: {current.announcedUrl}</Text>
              ) : null}
              {current.lastHealthError ? (
                <Text color="red">HealthErr: {current.lastHealthError}</Text>
              ) : null}
              {current.stale ? (
                <Text color="yellow">⚠ stale (best guess)</Text>
              ) : null}
              <Text>Errors:   <Text color={current.errorCount ? 'red' : undefined}>{current.errorCount}</Text></Text>
              <Text>Uptime:   {fmtUptime(current.uptimeMs)}</Text>
              {current.cpu != null || current.memMB != null ? (
                <Text>Usage:    {current.cpu ?? '-'}%  {current.memMB ?? '-'} MB</Text>
              ) : null}
              {current.compileHistoryMs.length > 0 ? (
                <Text>Recent compile: {current.compileHistoryMs.slice(-5).map(ms => (ms / 1000).toFixed(1) + 's').join(' · ')}</Text>
              ) : null}
              {current.bundle ? (
                <Text>Bundle: {current.bundle.initialKB}KB initial · {current.bundle.lazyKB}KB lazy{current.bundleRegressionPct != null && current.bundleRegressionPct > 10 ? <Text color="red"> (+{current.bundleRegressionPct}% ⚠)</Text> : null}</Text>
              ) : null}
              {state.lastStatusMessage ? <Text dimColor>Note:     {state.lastStatusMessage}</Text> : null}
              <Text>──── recent log {logFocus ? '(focused)' : ''} ────</Text>
              {recentLogs.length === 0 ? <Text dimColor>(no output yet)</Text> : recentLogs.map((line, i) => (
                <Text key={i} wrap="truncate-end">{line}</Text>
              ))}
            </>
          ) : (
            <Text dimColor>No app selected.</Text>
          )}
        </Box>
      </Box>

      <Box flexDirection="column">
        {tagPicking ? (
          <Text>tag filter (space-separated, Enter to apply, Esc to cancel): <Text color="cyan">{tagInput}</Text></Text>
        ) : null}
        {editing ? (
          <Box flexDirection="column" borderStyle="round" borderColor="yellow" paddingX={1}>
            <Text bold color="yellow">edit {editing.name} (session-only)  Tab=next field  Enter=save  Esc=cancel</Text>
            <Box>
              <Text>{editing.field === 'command' ? '> ' : '  '}command: </Text>
              {editing.field === 'command' ? (
                <TextInput value={editing.cmd} onChange={v => setEditing({ ...editing, cmd: v })} onSubmit={() => setEditing({ ...editing, field: 'port' })} />
              ) : <Text dimColor>{editing.cmd}</Text>}
            </Box>
            <Box>
              <Text>{editing.field === 'port' ? '> ' : '  '}port:    </Text>
              {editing.field === 'port' ? (
                <TextInput value={editing.port} onChange={v => setEditing({ ...editing, port: v })} onSubmit={() => setEditing({ ...editing, field: 'env' })} />
              ) : <Text dimColor>{editing.port}</Text>}
            </Box>
            <Box>
              <Text>{editing.field === 'env' ? '> ' : '  '}env (k=v;): </Text>
              {editing.field === 'env' ? (
                <TextInput value={editing.env.replace(/\n/g, ';')} onChange={v => setEditing({ ...editing, env: v.replace(/;/g, '\n') })} onSubmit={() => {
                  const portNum = Number(editing.port);
                  const env: Record<string, string> = {};
                  for (const line of editing.env.split(/\n/)) {
                    const m = line.match(/^\s*([^=]+)=(.*)$/);
                    if (m) env[m[1].trim()] = m[2];
                  }
                  registry.setSessionOverride(editing.name, {
                    command: editing.cmd || undefined,
                    port: Number.isFinite(portNum) && portNum > 0 ? portNum : undefined,
                    env: Object.keys(env).length ? env : undefined,
                  });
                  setEditing(null);
                }} />
              ) : <Text dimColor>{editing.env}</Text>}
            </Box>
          </Box>
        ) : null}
        <Text dimColor>[s] start  [x] stop  [r] restart  [o] open URL  [t] tag filter  [e] edit  [E] cycle env  [V] $EDITOR  [l] log focus  [Shift+L] full log  [PgUp/PgDn] scroll  [q] quit</Text>
      </Box>
    </Box>
  );
}
