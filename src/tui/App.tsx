import React, { useEffect, useMemo, useState } from 'react';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Box, Text, useApp, useInput, useStdout } from 'ink';
import TextInput from 'ink-text-input';
import { spawn, spawnSync } from 'node:child_process';
import type { Registry } from '../registry.js';
import type { AppEvent, AppSummary } from '../types.js';
import LogPane from './LogPane.js';
import HelpOverlay from './HelpOverlay.js';
import { computeRibbon, renderRibbon } from './ribbon.js';
import { allProfiles, profileBadge } from '../frameworks.js';
import { canStartTestRun, formatTestSummary } from './testChord.js';
import { cycleGroupFilter, filterByGroup, computeGroupHealth, formatGroupHeader } from './groupChord.js';
import { cycleWorkspaceFilter, filterByWorkspace, workspaceCycle } from './workspaceChord.js';
import { renderAwayLine, type AwaySummary } from '../away.js';
import TimelinePane from './TimelinePane.js';
import {
  resolveChord, footerChords, MAIN_CHORD_IDS, firstRunHintText,
  type Pane, type MainChordId, type KeyState,
} from './chords.js';
import { makeTheme, statusRole, healthRole, type Theme } from './theme.js';
import {
  computeLayout, windowSlice, positionLabel, statusSegments, type Tone, type Segment,
} from './layout.js';
import { IDLE_TICK_MS } from './renderBudget.js';
import {
  nextLevelFilter, nextGrepMode, visibleLogLines, matchingIndices, nextMatchIndex,
  isFollowing, type LevelFilter, type GrepMode,
} from './logFilterChord.js';

// Framework badge tags for TUI rows (M72): [next], [flask], ...
const BADGE_BY_ID = new Map(allProfiles(undefined).map(p => [p.id, profileBadge(p)]));
function badgeFor(id: string | null | undefined): string {
  if (!id) return '';
  return BADGE_BY_ID.get(id) ?? id.slice(0, 5);
}

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
  // "While you were away" (M135): computed once at startup by main.ts; shown
  // dismissibly in the header. onAckAway persists the dismissal to state.json.
  initialAway?: AwaySummary | null;
  onAckAway?: () => void;
  // First-attach hint (M170, v1.14): true only when this machine has never
  // attached the TUI. Acknowledged immediately on mount so it shows exactly
  // once, ever; Esc clears it from view.
  firstRunHint?: boolean;
  onAckFirstRunHint?: () => void;
}

function fmtUptime(ms: number | null): string {
  if (ms == null) return '';
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

// Status-bar tones → theme roles. The bar itself is computed in layout.ts,
// which knows nothing about the palette (M165: color lives in ONE module).
const TONE_ROLE = {
  normal: 'primary', muted: 'muted', accent: 'accent',
  warn: 'warning', danger: 'danger', good: 'serving',
} as const;

// A chord handler receives the raw keypress so one chord can cover a pair of
// keys (j/k, ↑/↓, PgUp/PgDn) without splitting into two map rows.
type ChordHandler = (input: string, key: KeyState) => void;

export default function App({ registry, apiPort, onQuit, initialAway, onAckAway, firstRunHint, onAckFirstRunHint }: Props) {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const theme = useMemo<Theme>(() => makeTheme(), []);

  const [apps, setApps] = useState<AppSummary[]>(registry.list());
  const [selected, setSelected] = useState(0);
  const [tagFilter, setTagFilter] = useState<string[]>([]);
  const [groupFilter, setGroupFilter] = useState<string | null>(null);
  // Workspace filter (M173, v1.15) — CLIENT-SIDE by design: this TUI process's
  // own state, never written to the daemon or state.json, so two attached TUIs
  // can watch two different workspaces at once.
  const [wsFilter, setWsFilter] = useState<string | null>(null);
  const [tagPicking, setTagPicking] = useState(false);
  const [tagInput, setTagInput] = useState('');
  const [editing, setEditing] = useState<{ name: string; field: 'command' | 'port' | 'env'; cmd: string; port: string; env: string } | null>(null);
  const [, setTick] = useState(0);
  const [chord, setChord] = useState<'g' | null>(null);
  const [filterText, setFilterText] = useState('');
  const [filterPicking, setFilterPicking] = useState(false);
  const [restartConfirm, setRestartConfirm] = useState<string | null>(null);
  const [orchestrateProfile, setOrchestrateProfile] = useState('');
  const [orchestrateAsking, setOrchestrateAsking] = useState(false);
  const [statusMsg, setStatusMsg] = useState<string | null>(null);
  const [events, setEvents] = useState<AppEvent[]>(registry.events({ sinceMs: 60 * 60 * 1000 }));
  const [testRuns, setTestRuns] = useState<Record<string, { running: boolean; summary: string | null }>>({});
  const [away, setAway] = useState<AwaySummary | null>(initialAway ?? null);
  const [showFirstRunHint, setShowFirstRunHint] = useState(!!firstRunHint);
  const [timelineOpen, setTimelineOpen] = useState(false);

  // ── v1.13 pane / focus model (M162) ─────────────────────────────────────────
  const [focusedPane, setFocusedPane] = useState<Pane>('list');
  const [maximized, setMaximized] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [helpScroll, setHelpScroll] = useState(0);

  // ── log pane state, lifted (M164) ───────────────────────────────────────────
  // Owned here so the inline pane and the maximized pane are the same pane:
  // maximizing preserves grep, level, and scroll position.
  const [levelFilter, setLevelFilter] = useState<LevelFilter>('all');
  const [grepQuery, setGrepQuery] = useState('');
  const [grepOpen, setGrepOpen] = useState(false);
  const [grepMode, setGrepMode] = useState<GrepMode>('filter');
  const [logScroll, setLogScroll] = useState(0);
  const [followLog, setFollowLog] = useState(true);
  const [matchCursor, setMatchCursor] = useState<number | null>(null);

  // Terminal size as STATE so a resize re-layouts on the resize signal itself,
  // not on the next tick (M162).
  const [size, setSize] = useState(() => ({ cols: stdout.columns || 100, rows: stdout.rows || 30 }));
  // Acknowledge the first-attach hint the moment it is shown: "once, ever" is
  // a promise about the state file, not about how long the pane stays up, so
  // it must survive a crash between attach and quit.
  useEffect(() => {
    if (firstRunHint) onAckFirstRunHint?.();
  }, [firstRunHint, onAckFirstRunHint]);

  useEffect(() => {
    const onResize = () => setSize({ cols: stdout.columns || 100, rows: stdout.rows || 30 });
    stdout.on('resize', onResize);
    return () => { stdout.off('resize', onResize); };
  }, [stdout]);

  // Change-driven updates + ONE slow clock tick (M166). The registry already
  // announces everything that matters; the tick exists only to refresh derived
  // clock values (uptime) that no event announces. See renderBudget.ts.
  useEffect(() => {
    const onChange = () => setApps(registry.list());
    const onEvent = () => {
      setApps(registry.list());
      setEvents(registry.events({ sinceMs: 60 * 60 * 1000 }));
    };
    registry.on('change', onChange);
    registry.on('event', onEvent);
    const interval = setInterval(() => setTick(t => t + 1), IDLE_TICK_MS);
    return () => {
      registry.off('change', onChange);
      registry.off('event', onEvent);
      clearInterval(interval);
    };
  }, [registry]);

  const flashStatus = (msg: string) => {
    setStatusMsg(msg);
    setTimeout(() => setStatusMsg(m => (m === msg ? null : m)), 4000);
  };

  // ── derived view state ──────────────────────────────────────────────────────

  const filterLc = filterText.trim().toLowerCase();
  // `groupMembers` null = no group filter active; [] = the active group is
  // empty or vanished from config (filters the list down to nothing).
  const groupMembers = groupFilter ? (registry.getConfig().groups?.[groupFilter]?.apps ?? []) : null;
  const visibleApps = filterByWorkspace(
    filterByGroup(
      tagFilter.length === 0 ? apps : apps.filter(a => tagFilter.every(t => a.tags.includes(t))),
      groupMembers,
    ),
    wsFilter,
  ).filter(a => !filterLc || a.name.toLowerCase().includes(filterLc));
  const selIdx = Math.min(selected, Math.max(0, visibleApps.length - 1));
  const current = visibleApps[selIdx];
  const state = current ? registry.getState(current.name) : null;

  // The pane resolving chords right now: maximizing the log makes it the active
  // scope, which is exactly how the v1.12 full-screen log pane behaved.
  const activePane: Pane = maximized ? 'log' : focusedPane;

  const layout = computeLayout(size.cols, size.rows, focusedPane as 'list' | 'detail' | 'log', maximized);

  const allLogEntries = state?.logBuffer ?? [];
  const logEntries = useMemo(
    () => visibleLogLines(allLogEntries, levelFilter, grepQuery, grepMode),
    [allLogEntries, levelFilter, grepQuery, grepMode],
  );
  const grepMatches = useMemo(
    () => matchingIndices(logEntries, grepQuery),
    [logEntries, grepQuery],
  );
  const storming = current ? registry.logStormState(current.name).active : false;
  const following = isFollowing(logScroll, followLog);

  const logRowsVisible = Math.max(1, layout.logRows - 1);
  const maxLogScroll = Math.max(0, logEntries.length - logRowsVisible);

  // Scrolling up pauses follow; landing back at the bottom resumes it.
  const scrollLog = (delta: number) => {
    setLogScroll(s => {
      const next = Math.max(0, Math.min(maxLogScroll, s + delta));
      if (next > 0) setFollowLog(false);
      else setFollowLog(true);
      return next;
    });
  };

  // Put a matched line in view: scroll so the match sits inside the window.
  const jumpToMatch = (dir: 1 | -1) => {
    if (!grepQuery) { flashStatus('no grep pattern — press [/] first'); return; }
    if (!grepMatches.length) { flashStatus(`no lines match "${grepQuery}"`); return; }
    const cursorAbs = matchCursor ?? (logEntries.length - 1 - logScroll);
    const next = nextMatchIndex(grepMatches, cursorAbs, dir);
    if (next == null) return;
    setMatchCursor(next);
    // Keep the match roughly centered in the window.
    const fromBottom = logEntries.length - 1 - next;
    const target = Math.max(0, Math.min(maxLogScroll, fromBottom - Math.floor(logRowsVisible / 2)));
    setLogScroll(target);
    setFollowLog(target === 0);
  };

  const cyclePane = () => {
    // Only cycle to panes the current layout actually renders — in `minimal`
    // mode every pane is reachable because each is shown alone.
    const order: Pane[] = ['list', 'detail', 'log'];
    setFocusedPane(p => order[(order.indexOf(p) + 1) % order.length]);
  };

  // ── long-running actions ────────────────────────────────────────────────────

  const runTryFix = async (name: string) => {
    flashStatus(`try-fix ${name}…`);
    try {
      const { runAutoFix, ALL_AUTO_FIX } = await import('../autoFix.js');
      const cfg = registry.getConfig();
      const permitted = (cfg.doctor?.autoFix?.permitted as any) ?? ALL_AUTO_FIX;
      const r = await runAutoFix({ permitted, dryRun: false });
      await registry.restart(name);
      const w = await registry.waitFor(name, 'healthy', 60000);
      flashStatus(`try-fix ${name}: ${w.timedOut ? 'timeout' : 'reached'} · fixed ${r.ran.length}`);
    } catch (err: any) {
      flashStatus(`try-fix ${name} failed: ${err?.message ?? err}`);
    }
  };

  const runTestsFor = async (name: string) => {
    setTestRuns(r => ({ ...r, [name]: { running: true, summary: r[name]?.summary ?? null } }));
    flashStatus(`running tests for ${name}…`);
    try {
      const result = await registry.runTests(name);
      const summary = formatTestSummary(result);
      setTestRuns(r => ({ ...r, [name]: { running: false, summary } }));
      flashStatus(`${name}: ${summary}`);
    } catch (err: any) {
      const summary = formatTestSummary({ error: err?.message ?? String(err) });
      setTestRuns(r => ({ ...r, [name]: { running: false, summary } }));
      flashStatus(`${name}: ${summary}`);
    }
  };

  const runFocus = async (name: string) => {
    flashStatus(`focus ${name} until stable…`);
    try {
      const start = Date.now();
      let lastEvAt = Date.now();
      const onEv = (ev: AppEvent) => { if (ev.app === name) lastEvAt = Date.now(); };
      registry.on('event', onEv);
      try {
        while (Date.now() - start < 180_000) {
          const s = registry.summary(name);
          if (s && s.status === 'serving' && s.health === 'healthy' && Date.now() - lastEvAt >= 5000) {
            flashStatus(`focus ${name}: stable after ${Math.round((Date.now() - start) / 1000)}s`);
            return;
          }
          await new Promise(r => setTimeout(r, 500));
        }
      } finally { registry.off('event', onEv); }
      flashStatus(`focus ${name}: timed out`);
    } catch (err: any) {
      flashStatus(`focus ${name} failed: ${err?.message ?? err}`);
    }
  };

  const runOrchestrate = async (profile: string) => {
    flashStatus(`orchestrate ${profile}…`);
    try {
      const { orchestrateProfile: doOrchestrate } = await import('../orchestrate.js');
      const r = await doOrchestrate(registry, registry.getConfig(), { profile, goal: 'healthy', timeoutMs: 300_000 });
      if ((r as any).error) { flashStatus(`orchestrate ${profile}: ${(r as any).error}`); return; }
      const ok = (r as any).allReached;
      flashStatus(`orchestrate ${profile}: ${ok ? 'all reached' : 'some failing'} · ${Math.round((r as any).totalMs / 1000)}s`);
    } catch (err: any) {
      flashStatus(`orchestrate ${profile} failed: ${err?.message ?? err}`);
    }
  };

  const openEditPrompt = (name: string) => {
    const cfg = registry.getConfig();
    const app = registry.getApp(name);
    const so = registry.getState(name)?.sessionOverrides ?? null;
    const envSrc = so?.env ?? cfg.overrides?.[name]?.env ?? {};
    const envText = Object.entries(envSrc).map(([k, v]) => `${k}=${v}`).join('\n');
    setEditing({
      name,
      field: 'command',
      cmd: so?.command ?? app?.command ?? '',
      port: String(so?.port ?? cfg.overrides?.[name]?.port ?? current?.port ?? ''),
      env: envText,
    });
  };

  const openInEditor = (name: string) => {
    const editor = process.env.EDITOR || (process.platform === 'win32' ? 'notepad' : 'vi');
    const tmp = path.join(os.tmpdir(), `daimon-${name}-${Date.now()}.json`);
    const cfg = registry.getConfig();
    const app = registry.getApp(name);
    const so = registry.getState(name)?.sessionOverrides ?? null;
    const payload = {
      command: so?.command ?? app?.command,
      port: so?.port ?? cfg.overrides?.[name]?.port ?? null,
      env: so?.env ?? cfg.overrides?.[name]?.env ?? {},
    };
    try {
      fs.writeFileSync(tmp, JSON.stringify(payload, null, 2));
      spawnSync(editor, [tmp], { stdio: 'inherit', shell: true });
      const raw = fs.readFileSync(tmp, 'utf8');
      const parsed = JSON.parse(raw);
      registry.setSessionOverride(name, {
        command: typeof parsed.command === 'string' ? parsed.command : undefined,
        port: typeof parsed.port === 'number' ? parsed.port : undefined,
        env: parsed.env && typeof parsed.env === 'object' ? parsed.env : undefined,
      });
      fs.unlinkSync(tmp);
    } catch {}
  };

  const cycleEnvFile = (name: string) => {
    const cfg = registry.getConfig();
    const cands = cfg.envFiles?.[name] ?? [];
    if (!cands.length) return;
    const cur = registry.getState(name)?.activeEnvFile ?? null;
    const idx = cur ? cands.indexOf(cur) : -1;
    const next = cands[(idx + 1) % cands.length];
    registry.setActiveEnvFile(name, next);
  };

  // ── chord dispatch (M163) ───────────────────────────────────────────────────
  // One handler per chord the main app owns. `Record<MainChordId, …>` is
  // exhaustiveness-checked by tsc: a chord added to the map with no handler
  // here (or a handler for a chord that is not in the map) fails the BUILD.
  // That is the compile-time half of the anti-drift guarantee; the runtime half
  // is test/tui-chords.test.mjs.
  const withApp = (fn: (name: string) => void): ChordHandler => () => {
    if (!current) return;
    fn(current.name);
  };

  const handlers: Record<MainChordId, ChordHandler> = {
    // global
    help: () => { setHelpOpen(true); setHelpScroll(0); },
    nextPane: () => cyclePane(),
    maximizeLog: () => {
      setMaximized(m => {
        if (!m) setFocusedPane('log');
        return !m;
      });
    },
    timeline: () => setTimelineOpen(true),
    quit: () => { onQuit(); exit(); },

    // navigation
    move: (input, key) => {
      const up = input === 'k' || !!key.upArrow;
      setSelected(s => {
        const n = up ? Math.max(0, s - 1) : Math.min(Math.max(0, visibleApps.length - 1), s + 1);
        return n;
      });
      // A new selection means a new log stream: back to the tail.
      setLogScroll(0);
      setFollowLog(true);
      setMatchCursor(null);
    },

    // lifecycle
    start: withApp(n => { void registry.start(n); }),
    stop: withApp(n => { void registry.stop(n); }),
    restart: withApp(n => setRestartConfirm(n)),
    focus: withApp(n => { void runFocus(n); }),
    tryFix: withApp(n => { void runTryFix(n); }),
    test: withApp(n => {
      if (canStartTestRun(testRuns[n]?.running ?? false)) void runTestsFor(n);
      else flashStatus(`tests already running for ${n}`);
    }),
    orchestrate: () => setOrchestrateAsking(true),

    // inspect
    openUrl: () => { if (current?.url) openUrl(current.url); },
    edit: withApp(n => openEditPrompt(n)),
    envFile: withApp(n => cycleEnvFile(n)),
    editor: withApp(n => openInEditor(n)),
    logFocus: () => setFocusedPane('log'),

    // filter
    filter: () => setFilterPicking(true),
    tagFilter: () => { setTagPicking(true); setTagInput(tagFilter.join(' ')); },
    groupFilter: () => {
      const names = Object.keys(registry.getConfig().groups ?? {});
      setGroupFilter(f => cycleGroupFilter(names, f));
    },
    wsFilter: () => {
      const labels = workspaceCycle(registry.getConfig());
      const next = cycleWorkspaceFilter(labels, wsFilter);
      setWsFilter(next);
      flashStatus(next ? `workspace: ${next}` : labels.length ? 'workspace filter off' : 'no searchRoots configured');
    },
    viewHint: () => {
      setChord('g');
      setTimeout(() => setChord(c => (c === 'g' ? null : c)), 1200);
    },

    // log pane
    levelCycle: () => { setLevelFilter(f => nextLevelFilter(f)); setLogScroll(0); setFollowLog(true); },
    grep: () => setGrepOpen(true),
    grepNext: () => jumpToMatch(1),
    grepPrev: () => jumpToMatch(-1),
    logTop: () => { setLogScroll(maxLogScroll); setFollowLog(false); },
    logBottom: () => { setLogScroll(0); setFollowLog(true); setMatchCursor(null); },
    logScroll: (_input, key) => scrollLog(key.upArrow ? 1 : -1),
    logPage: (_input, key) => scrollLog(key.pageUp ? logRowsVisible : -logRowsVisible),
  };

  useInput((input, key) => {
    // 1. Help overlay owns every key while it is open.
    if (helpOpen) {
      if (input === '?' || input === 'q' || key.escape) { setHelpOpen(false); return; }
      if (key.upArrow) { setHelpScroll(s => Math.max(0, s - 1)); return; }
      if (key.downArrow) { setHelpScroll(s => s + 1); return; }
      if (key.pageUp) { setHelpScroll(s => Math.max(0, s - 10)); return; }
      if (key.pageDown) { setHelpScroll(s => s + 10); return; }
      return;
    }

    // 2. Grep input — a MODAL chord scope, resolved through the same map as
    //    every other chord (Esc clears the pattern and closes, which is the
    //    v1.2 contract; Tab toggles filter/highlight; Enter keeps and closes).
    //    Anything else falls through to the TextInput.
    if (grepOpen) {
      const g = resolveChord('grep', input, key);
      if (g?.id === 'grepClear') { setGrepOpen(false); setGrepQuery(''); setMatchCursor(null); return; }
      if (g?.id === 'grepMode') { setGrepMode(m => nextGrepMode(m)); return; }
      if (g?.id === 'grepKeep') { setGrepOpen(false); return; }
      return;
    }

    // 3. Modal prompts, unchanged from v1.12.
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
    if (filterPicking) {
      if (key.escape) { setFilterPicking(false); return; }
      if (key.return) { setFilterPicking(false); return; }
      if (key.backspace || key.delete) { setFilterText(s => s.slice(0, -1)); return; }
      if (input && !key.ctrl) setFilterText(s => s + input);
      return;
    }
    if (orchestrateAsking) {
      if (key.escape) { setOrchestrateAsking(false); setOrchestrateProfile(''); return; }
      if (key.return) {
        const profile = orchestrateProfile.trim();
        setOrchestrateAsking(false);
        setOrchestrateProfile('');
        if (profile) void runOrchestrate(profile);
        return;
      }
      if (key.backspace || key.delete) { setOrchestrateProfile(s => s.slice(0, -1)); return; }
      if (input && !key.ctrl) setOrchestrateProfile(s => s + input);
      return;
    }
    if (restartConfirm) {
      if (input === 'y' || input === 'Y') {
        const name = restartConfirm;
        setRestartConfirm(null);
        void registry.restart(name);
        flashStatus(`restarted ${name}`);
      } else if (input === 'n' || input === 'N' || key.escape) {
        setRestartConfirm(null);
      }
      return;
    }

    // 4. A maximized log pane exits on q/Esc — exactly what the v1.12
    //    full-screen log pane did. Checked before the `quit` chord so the key
    //    keeps its old meaning here.
    if (maximized && (input === 'q' || key.escape)) { setMaximized(false); return; }

    // 5. "While you were away" (M135): Esc dismisses and acks so it never
    //    re-nags. Before app navigation so it works with zero apps.
    if (away && key.escape) { setAway(null); onAckAway?.(); return; }

    // 5b. The first-attach hint (M170) clears on Esc too — it is already
    //     acknowledged on mount, so this only takes it off the screen.
    if (showFirstRunHint && key.escape) { setShowFirstRunHint(false); return; }

    // 6. Esc from a focused log pane returns to the list.
    if (!maximized && focusedPane === 'log' && key.escape) { setFocusedPane('list'); return; }

    // 7. The `g` two-key view chord (M?): g then a/e/v/s/n.
    if (chord === 'g') {
      setChord(null);
      const c = input.toLowerCase();
      if (c === 'a') flashStatus('view: apps (only TUI view)');
      else if (c === 'e') flashStatus('view: errors — selected app errors shown in detail pane');
      else if (c === 'v') flashStatus('view: events — recent registry events shown in log pane');
      else if (c === 's') flashStatus('view: settings — edit `daimon.config.json`');
      else if (c === 'n') flashStatus('view: sessions — `daimon record` to toggle recording');
      return;
    }

    // 8. Everything else resolves through the chord map, scoped to the pane
    //    that currently has focus. This is the ONLY place keys are dispatched.
    const hit = resolveChord(activePane, input, key);
    if (!hit) return;
    const handler = handlers[hit.id as MainChordId];
    if (handler) handler(input, key);
  });

  // ── full-screen surfaces ────────────────────────────────────────────────────

  // Timeline chord (M136): walk the event stream by hour/day bucket. Windowed
  // query on open; empty history renders a note, not a crash.
  if (timelineOpen) {
    return <TimelinePane registry={registry} appName={current?.name ?? null} onExit={() => setTimelineOpen(false)} />;
  }

  if (helpOpen) {
    return <HelpOverlay pane={activePane} theme={theme} cols={size.cols} rows={size.rows} scroll={helpScroll} />;
  }

  // ── shared pieces ───────────────────────────────────────────────────────────

  const logPane = (
    <LogPane
      appName={current?.name ?? null}
      entries={logEntries}
      totalCount={allLogEntries.length}
      matchCount={grepMatches.length}
      level={levelFilter}
      grepQuery={grepQuery}
      grepMode={grepMode}
      grepOpen={grepOpen}
      onGrepChange={setGrepQuery}
      onGrepSubmit={() => setGrepOpen(false)}
      following={following}
      storming={storming}
      scroll={logScroll}
      focused={activePane === 'log'}
      maximized={maximized}
      rows={maximized ? layout.logRows : layout.logRows}
      cols={maximized ? size.cols : Math.max(20, size.cols - layout.leftWidth)}
      theme={theme}
      cursorIdx={matchCursor}
    />
  );

  const mutedCount = apps.filter(a => registry.isMuted(a.name)).length;
  const stormCount = registry.activeLogStorms().length;
  const segments: Segment[] = statusSegments({
    apiPort,
    degraded: apps.some(a => a.status === 'error'),
    workspace: current?.workspaceLabel ?? null,
    nameFilter: filterText,
    tagFilter,
    groupFilter,
    wsFilter,
    mutedCount,
    stormCount,
    appCount: apps.length,
    visibleCount: visibleApps.length,
    flash: statusMsg,
  });

  const statusBar = (
    <Box width={size.cols}>
      {segments.map((s, i) => (
        <Text key={i} {...theme.style(TONE_ROLE[s.tone as Tone])}>
          {i > 0 ? ' · ' : ''}{s.text}
        </Text>
      ))}
    </Box>
  );

  // The footer renders the focused pane's chords FROM THE MAP — the three
  // hand-written ribbons v1.12 shipped (App's, LogPane's, keys.ts's KEY_HELP)
  // are gone, which is what makes the drift test possible.
  const footer = (
    <Text {...theme.style('muted')}>
      {footerChords(activePane).map(c => `[${c.key}] ${c.label}`).join('  ')}
    </Text>
  );

  if (maximized) {
    return (
      <Box flexDirection="column" width={size.cols}>
        {statusBar}
        {logPane}
        {footer}
      </Box>
    );
  }

  // ── app list pane ───────────────────────────────────────────────────────────

  // Windowed (M166): a 100-app registry renders one viewport, never 100 rows.
  const rowsPerApp = layout.columns.ribbon ? 2 : 1;
  const listViewport = Math.max(1, Math.floor(layout.listRows / rowsPerApp));
  const win = windowSlice(visibleApps.length, selIdx, listViewport);
  const windowApps = visibleApps.slice(win.start, win.end);

  const listPane = (
    <Box
      flexDirection="column"
      width={layout.mode === 'minimal' ? size.cols : layout.leftWidth}
      borderStyle="single"
      borderColor={activePane === 'list' ? theme.color('focusBorder') : theme.color('blurBorder')}
      paddingX={1}
    >
      <Box>
        <Text bold color={activePane === 'list' ? theme.color('primary') : undefined}>
          {activePane === 'list' ? '▸ ' : '  '}Apps
        </Text>
        <Text {...theme.style('muted')}>{' '}{positionLabel(selIdx, visibleApps.length)}</Text>
        {win.start > 0 ? <Text {...theme.style('muted')}> ↑</Text> : null}
        {win.end < visibleApps.length ? <Text {...theme.style('muted')}> ↓</Text> : null}
      </Box>
      {groupFilter ? (
        <Text {...theme.style('muted')}>
          {formatGroupHeader(groupFilter, computeGroupHealth(apps, groupMembers ?? []).healthy, (groupMembers ?? []).length)}
        </Text>
      ) : null}
      {visibleApps.length === 0 ? (
        <Text {...theme.style('muted')}>{apps.length === 0 ? '(no apps discovered)' : '(no apps match filter)'}</Text>
      ) : windowApps.map((a, i) => {
        const absIdx = win.start + i;
        const sel = absIdx === selIdx;
        const ticks = computeRibbon(events, a.name);
        const ribbon = renderRibbon(ticks);
        const selStyle = sel ? theme.style('selection') : {};
        return (
          <Box key={a.name} flexDirection="column">
            <Box>
              <Text {...selStyle}>{sel ? '▸ ' : '  '}</Text>
              <Text {...selStyle}>
                {((registry.getState(a.name)?.sessionOverrides ? '*' : '') + a.name)
                  .padEnd(layout.nameWidth).slice(0, layout.nameWidth)}
              </Text>
              <Text {...theme.style(statusRole(a.status))}> {a.status.padEnd(9)}</Text>
              <Text {...theme.style(healthRole(a.health))}>{a.status === 'serving' ? '●' : ' '}</Text>
              {layout.columns.port ? <Text {...theme.style('muted')}>{a.port ? ` :${a.port}` : ''}</Text> : null}
              {layout.columns.badge && a.serverProfile ? (
                <Text {...theme.style('muted')}> [{badgeFor(a.serverProfile)}]</Text>
              ) : null}
              {layout.columns.cpu && a.cpu != null ? (
                <Text {...theme.style('muted')}>  {String(a.cpu).padStart(5)}% {String(a.memMB ?? 0).padStart(5)}MB</Text>
              ) : null}
            </Box>
            {layout.columns.ribbon ? (
              <Box>
                <Text {...theme.style('muted')}>    </Text>
                <Text {...theme.style('muted')}>{ribbon}</Text>
              </Box>
            ) : null}
          </Box>
        );
      })}
    </Box>
  );

  // ── detail pane ─────────────────────────────────────────────────────────────

  const detailPane = (
    <Box
      flexDirection="column"
      flexGrow={1}
      borderStyle="single"
      borderColor={activePane === 'detail' ? theme.color('focusBorder') : theme.color('blurBorder')}
      paddingX={1}
    >
      {current && state ? (
        <>
          <Box>
            <Text bold color={activePane === 'detail' ? theme.color('primary') : undefined}>
              {activePane === 'detail' ? '▸ ' : '  '}{current.name}
            </Text>
            {registry.isMuted(current.name) ? <Text {...theme.style('muted')}>  [muted]</Text> : null}
            {storming ? <Text {...theme.style('storm')}>  ⚡ log storm</Text> : null}
          </Box>
          <Text>
            Status:   <Text {...theme.style(statusRole(current.status))}>{current.status}</Text>
            {' '}<Text {...theme.style(healthRole(current.health))}>●</Text>
            {' '}<Text {...theme.style('muted')}>{current.health}</Text>
          </Text>
          <Text>Port:     {current.port ?? '-'}</Text>
          <Text>URL:      {current.url ?? '-'}</Text>
          {current.announcedUrl && current.announcedUrl !== current.url ? (
            <Text {...theme.style('muted')}>Announced: {current.announcedUrl}</Text>
          ) : null}
          {current.lastHealthError ? (
            <Text {...theme.style('danger')}>HealthErr: {current.lastHealthError}</Text>
          ) : null}
          {current.stale ? <Text {...theme.style('warning')}>⚠ stale (best guess)</Text> : null}
          <Text>
            Errors:   <Text {...(current.errorCount ? theme.style('danger') : {})}>{current.errorCount}</Text>
          </Text>
          <Text>Uptime:   {fmtUptime(current.uptimeMs)}</Text>
          {current.cpu != null || current.memMB != null ? (
            <Text>Usage:    {current.cpu ?? '-'}%  {current.memMB ?? '-'} MB</Text>
          ) : null}
          {current.compileHistoryMs.length > 0 ? (
            <Text>Recent compile: {current.compileHistoryMs.slice(-5).map(ms => (ms / 1000).toFixed(1) + 's').join(' · ')}</Text>
          ) : null}
          {current.bundle ? (
            <Text>
              Bundle: {current.bundle.initialKB}KB initial · {current.bundle.lazyKB}KB lazy
              {current.bundleRegressionPct != null && current.bundleRegressionPct > 10 ? (
                <Text {...theme.style('danger')}> (+{current.bundleRegressionPct}% ⚠)</Text>
              ) : null}
            </Text>
          ) : null}
          {current.activeEnvFile ? <Text {...theme.style('muted')}>Env file: {current.activeEnvFile}</Text> : null}
          {state.lastStatusMessage ? <Text {...theme.style('muted')}>Note:     {state.lastStatusMessage}</Text> : null}
          {testRuns[current.name] ? (
            <Text
              {...(testRuns[current.name].running
                ? theme.style('warning')
                : testRuns[current.name].summary?.startsWith('✗')
                  ? theme.style('danger')
                  : testRuns[current.name].summary?.startsWith('✓')
                    ? theme.style('serving')
                    : {})}
            >
              Tests:    {testRuns[current.name].running ? 'running tests…' : testRuns[current.name].summary}
            </Text>
          ) : null}
        </>
      ) : (
        <Text {...theme.style('muted')}>No app selected.</Text>
      )}
    </Box>
  );

  return (
    <Box flexDirection="column" width={size.cols}>
      <Box borderStyle="round" borderColor={theme.color('primary')} paddingX={1}>
        <Text bold color={theme.color('primary')}>daimon</Text>
        <Text {...theme.style('muted')}>  •  api http://127.0.0.1:{apiPort}</Text>
      </Box>

      {away ? (
        <Box paddingX={1}>
          <Text {...theme.style('warning')}>↩ {renderAwayLine(away)}</Text>
          <Text {...theme.style('muted')}>  [esc to dismiss]</Text>
        </Box>
      ) : null}

      {showFirstRunHint ? (
        <Box paddingX={1}>
          <Text {...theme.style('accent')}>{firstRunHintText()}</Text>
          <Text {...theme.style('muted')}>  [esc to dismiss]</Text>
        </Box>
      ) : null}

      {layout.mode === 'minimal' ? (
        // Below 60 columns two bordered boxes leave ~26 usable columns each,
        // which is where rows start wrapping into garbage. One pane at a time
        // instead — Tab still reaches all three.
        <Box flexDirection="column">
          {layout.showList ? listPane : null}
          {layout.showDetail ? detailPane : null}
          {layout.showLog ? logPane : null}
        </Box>
      ) : (
        <Box flexDirection="row">
          {listPane}
          <Box flexDirection="column" flexGrow={1}>
            {detailPane}
            {logPane}
          </Box>
        </Box>
      )}

      <Box flexDirection="column">
        {tagPicking ? (
          <Text>tag filter (space-separated, Enter to apply, Esc to cancel): <Text color={theme.color('accent')}>{tagInput}</Text></Text>
        ) : null}
        {editing ? (
          <Box flexDirection="column" borderStyle="round" borderColor={theme.color('warning')} paddingX={1}>
            <Text bold {...theme.style('warning')}>edit {editing.name} (session-only)  Tab=next field  Enter=save  Esc=cancel</Text>
            <Box>
              <Text>{editing.field === 'command' ? '> ' : '  '}command: </Text>
              {editing.field === 'command' ? (
                <TextInput value={editing.cmd} onChange={v => setEditing({ ...editing, cmd: v })} onSubmit={() => setEditing({ ...editing, field: 'port' })} />
              ) : <Text {...theme.style('muted')}>{editing.cmd}</Text>}
            </Box>
            <Box>
              <Text>{editing.field === 'port' ? '> ' : '  '}port:    </Text>
              {editing.field === 'port' ? (
                <TextInput value={editing.port} onChange={v => setEditing({ ...editing, port: v })} onSubmit={() => setEditing({ ...editing, field: 'env' })} />
              ) : <Text {...theme.style('muted')}>{editing.port}</Text>}
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
              ) : <Text {...theme.style('muted')}>{editing.env}</Text>}
            </Box>
          </Box>
        ) : null}
        {restartConfirm ? (
          <Box borderStyle="round" borderColor={theme.color('warning')} paddingX={1}>
            <Text bold {...theme.style('warning')}>Restart {restartConfirm}? </Text>
            <Text {...theme.style('muted')}>[y]es  [n]o / Esc</Text>
          </Box>
        ) : null}
        {filterPicking ? (
          <Text>filter (Enter to apply, Esc to clear): <Text color={theme.color('accent')}>{filterText}</Text></Text>
        ) : null}
        {orchestrateAsking ? (
          <Box borderStyle="round" borderColor={theme.color('accent')} paddingX={1}>
            <Text bold color={theme.color('accent')}>orchestrate profile (Enter to run, Esc to cancel): </Text>
            <Text color={theme.color('accent')}>{orchestrateProfile}</Text>
          </Box>
        ) : null}
        {statusBar}
        {footer}
      </Box>
    </Box>
  );
}

// Re-exported so main.ts and tests can assert the TUI dispatches exactly the
// chords the map declares (see test/tui-chords.test.mjs).
export { MAIN_CHORD_IDS };
