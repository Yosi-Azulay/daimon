import React from 'react';
import path from 'node:path';
import { render } from 'ink';
import { pathToFileURL } from 'node:url';
import { loadConfig, configLookupPaths } from './config.js';
import { discoverApps } from './discovery.js';
import { Registry } from './registry.js';
import { PortAllocator, parsePortPool } from './ports.js';
import { inspectApiPort, renderApiPortConflict } from './portDiag.js';
import { writeCrashDump } from './crashDump.js';
import { startServer } from './server.js';
import { HealthMonitor } from './health.js';
import { UsageMonitor } from './usage.js';
import { Restarter } from './restarter.js';
import { loadPersistedState, savePersistedState, flushPersistedState, stateLoadDiagnostics } from './stateFile.js';
import { scanListeningPorts } from './portDiag.js';
import { isPidAlive } from './daemon.js';
import { History } from './history.js';
import { findCycle } from './depends.js';
import { Notifier } from './notifier.js';
import { StaleDetector } from './staleDetector.js';
import { RequestLog } from './requestLog.js';
import { buildLockInfo, readLock, removeLock, writeLock } from './daemon.js';
import { patchConfigOnDisk, softReloadFromDisk } from './configManager.js';
import { installCrashHandlers } from './crashDump.js';
import { consumeHandoff } from './stateHandoff.js';
import { loadSessionState, saveSessionState } from './sessionState.js';
import { SelfMetricsCollector } from './selfMetrics.js';
import { loadPlugins, pluginsDir, PluginHost } from './plugins.js';
import { DigestScheduler, WebhookDispatcher, effectiveWebhooks, redactWebhookUrl } from './webhooks.js';
import { buildReport, renderReportMd } from './report.js';
import App from './tui/App.js';

export interface StartOpts {
  headless?: boolean;
}

export async function startInProcess(opts: StartOpts = {}): Promise<void> {
  let crashRegistry: any = null;
  let crashConfig: any = null;
  installCrashHandlers({ getRegistry: () => crashRegistry, getConfig: () => crashConfig });
  let cfgResult;
  try {
    cfgResult = loadConfig();
  } catch (err: any) {
    process.stderr.write(`[daimon] config error: ${err.message}\n`);
    process.stderr.write(`[daimon] fix the JSON and re-run — 'daimon config validate' pinpoints the problem\n`);
    process.exit(1);
  }

  if (cfgResult.kind === 'stub-created') {
    const paths = configLookupPaths();
    process.stdout.write(`[daimon] no config found. Created stub at:\n  ${cfgResult.path}\n`);
    process.stdout.write(`[daimon] Edit it to add "searchRoots" pointing at your Nx/Angular workspace, then run again.\n`);
    process.stdout.write(`[daimon] (Local override path: ${paths.local})\n`);
    process.exit(0);
  }

  const { config, path: cfgPath } = cfgResult;
  process.stdout.write(`[daimon] config: ${cfgPath}\n`);

  if (config.depends && Object.keys(config.depends).length) {
    const cycle = findCycle(config.depends);
    if (cycle) {
      process.stderr.write(`[daimon] config error: depends graph has a cycle: ${cycle.join(' -> ')}\n`);
      process.stderr.write(`[daimon] break the cycle in daimon.config.json "depends" — remove one edge of the loop above\n`);
      process.exit(1);
    }
  }

  const apps = discoverApps(config);
  if (apps.length === 0) {
    process.stdout.write(`[daimon] no serveable projects discovered in: ${config.searchRoots.join(', ') || '(none)'}\n`);
  }

  // ── Crash-recovery order (M88) ─────────────────────────────────────────
  // After an unclean exit the startup sequence is, in this order:
  //   1. recover persisted state  (state.json → .bak → archive-corrupt+fresh)
  //   2. verify the daemon lock   (readLock() clears a stale lock whose pid
  //      is dead; per-app soft-locks are in-memory and die with the daemon)
  //   3. re-adopt or mark orphans (consumeHandoff below, before autoStart)
  //   4. then serve               (startServer at the end of this function;
  //      the lock is written only after a successful bind)
  // Recovery is never silent: steps 1 and 3 record self-warn / status events.
  const persisted = loadPersistedState();
  const stateDiag = stateLoadDiagnostics();
  readLock(); // step 2: side effect — deletes a leftover lock from a dead pid
  // ports.pool (M81) narrows the allocator to the pool range; absent = the
  // legacy portRange behavior, byte for byte.
  const portAlloc = new PortAllocator(parsePortPool(config.ports?.pool) ?? config.portRange, {
    initial: persisted.ports,
    onChange: snap => savePersistedState({ ports: snap }),
  });
  const registry = new Registry(config, apps, portAlloc);
  crashRegistry = registry;
  crashConfig = config;
  // Notification mutes (M84) persist alongside port assignments.
  registry.restoreMutes(persisted.mutes);
  registry.onMutesChanged = snap => savePersistedState({ mutes: snap });
  const history = new History(config.history);
  registry.setHistory(history);
  const archivedDb = history.archivedCorruptDbPath();
  if (archivedDb) {
    registry.recordEvent({ app: '__daemon__', type: 'self-warn', message: `history.db was corrupt and was rebuilt; previous db archived at ${archivedDb}` });
  }
  // State recovery is never silent (M88): say what load had to do.
  if (stateDiag.recoveredFromBak) {
    registry.recordEvent({ app: '__daemon__', type: 'self-warn', message: 'state.json was corrupt; recovered from state.json.bak (port assignments and mutes intact)' });
  }
  if (stateDiag.archivedCorruptPath) {
    registry.recordEvent({ app: '__daemon__', type: 'self-warn', message: `state.json and its .bak were both unreadable; archived at ${stateDiag.archivedCorruptPath} and started fresh — port assignments and mutes were reset` });
  }
  const ftsDegraded = history.ftsDegradedReason();
  if (ftsDegraded) {
    registry.recordEvent({ app: '__daemon__', type: 'self-warn', message: `full-text search degraded to LIKE fallback: ${ftsDegraded}` });
  }
  // Per-app log-line FTS ingestion (M77). Errors/events are always indexed via
  // the events table; log lines default on with global/per-app opt-out.
  registry.on('log', ({ name, ts, line, level }: { name: string; ts: number; line: string; level?: string | null }) => {
    const cfg2 = registry.getConfig();
    if (cfg2.search?.logIndex === false) return;
    if (cfg2.overrides?.[name]?.logIndex === false) return;
    history.recordLogLine(name, line, ts, level ?? null);
  });

  // Session preservation (M55): restore error history / log tails from the
  // last snapshot (survives kill -9), then keep snapshotting every 30s.
  const restoredApps = registry.restoreSessionState(loadSessionState());
  if (restoredApps > 0) {
    process.stdout.write(`[daimon] session-state: restored errors/logs for ${restoredApps} app${restoredApps === 1 ? '' : 's'} from the previous session\n`);
  }
  const sessionTick = setInterval(() => {
    try { saveSessionState(registry.exportSessionState()); } catch {}
  }, 30_000);
  if (sessionTick.unref) sessionTick.unref();
  const health = new HealthMonitor(registry, config.healthProbe, config);
  // Resource sampling (M105): a downsampler riding the existing 2s pidusage
  // poll — no second timer. Rows go through history's batched write path;
  // a failing app self-warns once and the others keep sampling.
  const resourceSampleMs = config.resources?.sampleMs ?? 30_000;
  const usage = new UsageMonitor(registry, 2000, resourceSampleMs > 0 ? {
    sampleMs: resourceSampleMs,
    onSample: (name, ts, rssBytes, cpuPct) => {
      history.recordResourceSample(name, rssBytes, cpuPct, ts);
      registry.noteResourceSample(name, ts, rssBytes, cpuPct);
    },
    onSampleError: (name, err: any) => {
      try {
        registry.recordEvent({ app: '__daemon__', type: 'self-warn', message: `resource sampling failed for ${name}: ${err?.message || err} — sampling continues for other apps` });
      } catch {}
    },
  } : undefined);
  const restarter = new Restarter(registry, config.autoRestart);
  const notifier = new Notifier(registry, config.notifications);
  const staleDetector = new StaleDetector(registry, config.staleDetect);
  const requestLog = new RequestLog(registry, config.requestLog);
  registry.on('childExit', ({ name, code, signal, stopping }: any) => restarter.onExit(name, code, signal, stopping));
  registry.on('userStop', ({ name }: any) => restarter.onUserStop(name));

  // Handoff re-adoption (M88, step 3 of the recovery order). The outgoing
  // daemon left these children RUNNING; verify each (pid alive AND port
  // listening) before adopting. Unverifiable children surface as 'orphaned'
  // with a remedy — never silently dropped, never blindly killed.
  const handoff = consumeHandoff();
  if (handoff && handoff.apps.length) {
    process.stdout.write(`[daimon] state-handoff: verifying ${handoff.apps.map(a => a.name).join(', ')}\n`);
    const known = new Set(registry.names());
    const ports = new Set(handoff.apps.map(h => h.port).filter((p): p is number => typeof p === 'number'));
    let listeners = new Map<number, number>();
    try { listeners = scanListeningPorts(ports); } catch {}
    for (const h of handoff.apps) {
      if (!known.has(h.name)) continue;
      portAlloc.pin(h.name, h.port);
      if (h.pid === undefined) {
        // Pre-v0.14 handoff file: the old daemon killed its children on
        // shutdown, so the legacy contract applies — start them fresh.
        void registry.start(h.name);
        continue;
      }
      const pidAlive = h.pid != null && isPidAlive(h.pid);
      const listenerPid = listeners.get(h.port) ?? null;
      const portListening = listenerPid != null;
      // Adopt only on the strongest evidence: the pid the OUTGOING daemon saw
      // listening on this port is alive AND is STILL the one listening.
      if (pidAlive && listenerPid === h.pid) {
        registry.adoptChild(h.name, h.pid!, h.port, h.startedAt ?? null);
        process.stdout.write(`[daimon] state-handoff: re-adopted ${h.name} (pid ${h.pid}, port ${h.port})\n`);
      } else if (portListening && listenerPid !== h.pid) {
        registry.markOrphaned(h.name, pidAlive ? h.pid! : null, h.port,
          `port ${h.port} is now held by pid ${listenerPid}, not the handed-off child (pid ${h.pid ?? '?'}) — run 'daimon free-port ${h.port}' to identify it, then 'daimon start ${h.name}'`);
        process.stdout.write(`[daimon] state-handoff: ${h.name} orphaned (port ${h.port} held by pid ${listenerPid})\n`);
      } else if (pidAlive && !portListening) {
        registry.markOrphaned(h.name, h.pid!, h.port,
          `survived the daemon handoff (pid ${h.pid}) but nothing is listening on port ${h.port} — inspect with 'daimon why ${h.name}', then 'daimon stop ${h.name}' to end it or 'daimon restart ${h.name}' to replace it`);
        process.stdout.write(`[daimon] state-handoff: ${h.name} orphaned (pid ${h.pid} alive, port ${h.port} silent)\n`);
      } else {
        registry.recordEvent({ app: h.name, type: 'status', from: 'serving', to: 'stopped', message: `child (pid ${h.pid ?? '?'}) did not survive the daemon handoff — run 'daimon start ${h.name}'` });
        process.stdout.write(`[daimon] state-handoff: ${h.name} did not survive (pid gone, port free) — left stopped\n`);
      }
    }
  }

  // Boot autoStart (M96): the per-app `autoStart` list plus every
  // `autoStart: true` group, deduped at resolution — an app named by several
  // sources spawns exactly once, with one log line naming every source.
  // Per-app failure degrades (never blocks boot); a config without autoStart
  // groups boots exactly as before.
  {
    const { autoStartPlan } = await import('./groups.js');
    const plan = autoStartPlan(config);
    if (plan.length) {
      const known = new Set(registry.names());
      for (const entry of plan) {
        const fromListOnly = entry.sources.length === 1 && entry.sources[0] === 'autoStart';
        if (!known.has(entry.app)) {
          // Keep the historical line byte-identical for the legacy list.
          process.stderr.write(fromListOnly
            ? `[daimon] warning: autoStart references unknown app "${entry.app}"\n`
            : `[daimon] warning: autoStart references unknown app "${entry.app}" (${entry.sources.join(' + ')})\n`);
          continue;
        }
        if (entry.sources.length > 1) {
          process.stdout.write(`[daimon] autoStart: ${entry.app} requested by ${entry.sources.join(' + ')} — starting once\n`);
        }
        if (config.depends && config.depends[entry.app] && config.depends[entry.app].length) {
          registry.startWithDeps(entry.app).catch(() => {});
        } else {
          registry.start(entry.app).catch(() => {});
        }
      }
    }
  }

  const apiPort = process.env.DAIMON_PORT ? Number(process.env.DAIMON_PORT) : config.apiPort;
  const headless = !!opts.headless || !!config.headless || process.argv.includes('--headless');

  const errorTtlTick = setInterval(() => {
    try { registry.pruneOldErrors(); } catch {}
  }, 60 * 60 * 1000);

  // Plugin API v1 (M116): enumerate ~/.daimon/plugins once at startup; every
  // load failure is a skipped file + self-warn, never a daemon-down. Hook
  // dispatch rides the registry 'event' emitter, deferred off the write path.
  const pluginHost = await (async () => {
    let loaded: Awaited<ReturnType<typeof loadPlugins>> = [];
    try {
      loaded = await loadPlugins(pluginsDir(config.plugins?.dir ?? undefined));
    } catch {}
    const host = new PluginHost(loaded, {
      onPluginError: info => {
        try {
          registry.recordEvent({
            app: '__daemon__', type: 'plugin-error',
            message: `plugin "${info.plugin}" disabled for this session — ${info.hook} threw: ${info.message}${info.stack ? `\n${info.stack}` : ''}`,
          });
        } catch {}
      },
    });
    host.setSnapshotProvider(name => {
      const app = registry.getApp(name);
      const st = registry.getState(name);
      if (!app && !st) return null;
      return {
        name,
        framework: app?.serverProfile ?? app?.workspaceType ?? null,
        port: st?.port ?? null,
        pid: st?.pid ?? null,
        status: st?.status ?? 'unknown',
      };
    });
    registry.on('event', evt => host.handleRegistryEvent(evt));
    // Skip warnings land AFTER the host subscribes, so active plugins observe
    // their broken siblings' self-warn events like any other event.
    for (const p of loaded) {
      if (p.status !== 'active') {
        process.stderr.write(`[daimon] plug-in skipped: ${path.basename(p.file)} — ${p.error}\n`);
        try { registry.recordEvent({ app: '__daemon__', type: 'self-warn', message: `plug-in skipped: ${path.basename(p.file)} — ${p.error}` }); } catch {}
      }
    }
    return host;
  })();

  // Global webhooks + per-app overrides.<app>.webhooks blocks (M72).
  const allWebhooks = effectiveWebhooks(config);
  const webhookDispatcher = allWebhooks.length
    ? new WebhookDispatcher(registry, allWebhooks, {
        onLog: msg => process.stderr.write(`[daimon] ${msg}\n`),
      })
    : null;

  // Scheduled digest (M84): one 1-minute timer, catch-up once, delivery via
  // the dispatcher's normal queue/rate-limit/retry path.
  const digestWebhooks = allWebhooks.filter(w => typeof w.digest === 'string');
  const digestState: Record<string, number> = { ...(persisted.digests ?? {}) };
  const digestScheduler = webhookDispatcher && digestWebhooks.length
    ? new DigestScheduler({
        webhooks: digestWebhooks,
        dispatcher: webhookDispatcher,
        buildReport: sinceTs => {
          const report = buildReport(
            { registry, history, flakyThreshold: config.tests?.flakyThreshold ?? 3 },
            { since: sinceTs },
          );
          return { json: report, md: renderReportMd(report) };
        },
        state: {
          get: url => digestState[url] ?? 0,
          set: (url, ts) => { digestState[url] = ts; savePersistedState({ digests: { ...digestState } }); },
        },
        onDigestSent: url => {
          registry.recordEvent({ app: '__daemon__', type: 'digest-sent', message: `daily digest sent to ${redactWebhookUrl(url)}` });
        },
      })
    : null;
  digestScheduler?.start();

  const selfMetrics = new SelfMetricsCollector(history);
  selfMetrics.setSelfWarnHandler(msg => {
    try { registry.recordEvent({ app: '__daemon__', type: 'self-warn', message: msg }); } catch {}
  });
  const selfMetricsTick = setInterval(() => {
    const snap = selfMetrics.snapshot();
    history.recordSelfMetric(snap.rssMB, snap.heapUsedMB, snap.eventLoopLagMs, snap.historyDbQueryMs.p95);
  }, 60 * 1000);
  if (selfMetricsTick.unref) selfMetricsTick.unref();

  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    try { clearInterval(errorTtlTick); } catch {}
    try { clearInterval(selfMetricsTick); } catch {}
    try { clearInterval(sessionTick); saveSessionState(registry.exportSessionState()); } catch {}
    try { flushPersistedState(); } catch {}
    try { selfMetrics.stop(); } catch {}
    try { health.stop(); } catch {}
    try { usage.stop(); } catch {}
    try { restarter.stop(); } catch {}
    try { notifier.stop(); } catch {}
    try { staleDetector.stop(); } catch {}
    try { requestLog.stop(); } catch {}
    try { digestScheduler?.stop(); } catch {}
    try { webhookDispatcher?.stop(); } catch {}
    // Close active log-storm episodes (M101) BEFORE history closes so the
    // log-storm-end events land — an unmatched log-storm would keep doctor's
    // rule red for its whole lookback window.
    try { registry.endActiveLogStorms(); } catch {}
    try { history.close(); } catch {}
    try {
      // Handoff shutdown (M88): a snapshot-state call in the last 60s means a
      // new daemon is about to re-adopt the children — leave them running.
      // (Their stdio pipes die with this process; log capture resumes when the
      // app is next restarted. A plain `daimon daemon stop` still kills all.)
      if (registry.isHandoffPending()) {
        process.stdout.write(`[daimon] handoff pending — leaving managed children running for re-adoption\n`);
        await registry.stopAll(3000, { keepManagedChildren: true });
      } else {
        await registry.stopAll(3000);
      }
    } catch {}
    try {
      server.close();
    } catch {}
    try { removeLock(); } catch {}
    process.exit(0);
  };

  const server = startServer(registry, apiPort, {
    metricsEnabled: config.metrics.enabled,
    requestLog,
    onShutdown: () => { void shutdown(); },
    configPath: cfgPath,
    getConfig: () => registry.getConfig(),
    patchConfig: (patch) => {
      try {
        const r = patchConfigOnDisk({ configPath: cfgPath, patch });
        const apply = softReloadFromDisk({ configPath: cfgPath, registry });
        return { ok: true, applied: r.applied, addedApps: apply.addedApps, removedApps: apply.removedApps, restartRequired: apply.restartRequired } as any;
      } catch (err: any) {
        return { ok: false, error: err?.message || String(err) };
      }
    },
    reloadConfig: async () => {
      const r = softReloadFromDisk({ configPath: cfgPath, registry });
      return { ok: true, addedApps: r.addedApps, removedApps: r.removedApps, restartRequired: r.restartRequired };
    },
    selfMetrics,
    getPlugins: () => pluginHost.list(),
    getPluginCounts: () => pluginHost.counts(),
    runPluginScans: async () => {
      await pluginHost.runDoctorRules({
        config: registry.getConfig(),
        apps: registry.names().map(n => {
          const app = registry.getApp(n);
          return { name: n, framework: app?.serverProfile ?? app?.workspaceType ?? null, workspaceRoot: app?.workspaceRoot ?? null };
        }),
      });
    },
  });
  // A live lock observed before our bind = a running daemon we may be
  // colliding with; feeds the EADDRINUSE forensics below.
  const preexistingLock = readLock() !== null;
  server.once('error', (err: any) => {
    if (err?.code !== 'EADDRINUSE') {
      process.stderr.write(`[daimon] api server error: ${err?.stack || err}\n`);
      process.exit(1);
    }
    // Startup forensics (M81): identify the holder, say whether it answers as
    // a daimon, print the remedy and the crash-dump path — then exit non-zero.
    void (async () => {
      let lines: string[];
      try {
        const f = await inspectApiPort(apiPort, preexistingLock);
        let dump: string | null = null;
        try { dump = writeCrashDump(new Error(renderApiPortConflict(f).join('\n')), registry, config); } catch {}
        lines = renderApiPortConflict(f, dump);
      } catch (inner: any) {
        lines = [`failed to bind api port 127.0.0.1:${apiPort} (EADDRINUSE)`, `forensics failed: ${inner?.message || inner}`];
      }
      for (const l of lines) process.stderr.write(`[daimon] ${l}\n`);
      process.exit(1);
    })();
  });
  server.once('listening', () => {
    process.stdout.write(`[daimon] api: http://127.0.0.1:${apiPort}\n`);
    // Lock only after a successful bind — an EADDRINUSE loser must never
    // clobber the winning daemon's lock (the v0.12 orphan incident).
    try { writeLock(buildLockInfo(apiPort, headless, cfgPath)); } catch (err: any) { process.stderr.write(`[daimon] warning: could not write daemon.lock: ${err?.message || err}\n`); }
  });

  process.on('SIGINT', () => { void shutdown(); });
  process.on('SIGTERM', () => { void shutdown(); });
  process.on('beforeExit', () => { void shutdown(); });

  if (headless) {
    process.stdout.write(`[daimon] headless mode — TUI suppressed. Dashboard: http://127.0.0.1:${apiPort}\n`);
    let lastSnapshot = '';
    const heartbeat = setInterval(() => {
      const summary = registry.list().map(s => ({ name: s.name, status: s.status, health: s.health, port: s.port }));
      const json = JSON.stringify(summary);
      if (json !== lastSnapshot) {
        process.stderr.write(json + '\n');
        lastSnapshot = json;
      }
    }, 60_000);
    await new Promise<void>(() => {});
    clearInterval(heartbeat);
    return;
  }

  const inst = render(React.createElement(App, { registry, apiPort, onQuit: () => void shutdown() }));
  await inst.waitUntilExit();
  await shutdown();
}

const invokedDirectly = (() => {
  try { return import.meta.url === pathToFileURL(process.argv[1] || '').href; } catch { return false; }
})();

if (invokedDirectly) {
  startInProcess().catch(err => {
    process.stderr.write(`[daimon] fatal: ${err?.stack || err}\n`);
    process.exit(1);
  });
}
