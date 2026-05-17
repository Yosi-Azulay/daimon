import React from 'react';
import { render } from 'ink';
import { pathToFileURL } from 'node:url';
import { loadConfig, configLookupPaths } from './config.js';
import { discoverApps } from './discovery.js';
import { Registry } from './registry.js';
import { PortAllocator } from './ports.js';
import { startServer } from './server.js';
import { HealthMonitor } from './health.js';
import { UsageMonitor } from './usage.js';
import { Restarter } from './restarter.js';
import { loadPersistedState, savePersistedState } from './stateFile.js';
import { History } from './history.js';
import { findCycle } from './depends.js';
import { Notifier } from './notifier.js';
import { StaleDetector } from './staleDetector.js';
import { RequestLog } from './requestLog.js';
import { buildLockInfo, removeLock, writeLock } from './daemon.js';
import { patchConfigOnDisk, softReloadFromDisk } from './configManager.js';
import { installCrashHandlers } from './crashDump.js';
import { consumeHandoff } from './stateHandoff.js';
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
      process.exit(1);
    }
  }

  const apps = discoverApps(config);
  if (apps.length === 0) {
    process.stdout.write(`[daimon] no serveable projects discovered in: ${config.searchRoots.join(', ') || '(none)'}\n`);
  }

  const persisted = loadPersistedState();
  const portAlloc = new PortAllocator(config.portRange, {
    initial: persisted.ports,
    onChange: snap => savePersistedState({ ports: snap }),
  });
  const registry = new Registry(config, apps, portAlloc);
  crashRegistry = registry;
  crashConfig = config;
  const history = new History(config.history);
  registry.setHistory(history);
  const health = new HealthMonitor(registry, config.healthProbe, config);
  const usage = new UsageMonitor(registry);
  const restarter = new Restarter(registry, config.autoRestart);
  const notifier = new Notifier(registry, config.notifications);
  const staleDetector = new StaleDetector(registry, config.staleDetect);
  const requestLog = new RequestLog(registry, config.requestLog);
  registry.on('childExit', ({ name, code, signal, stopping }: any) => restarter.onExit(name, code, signal, stopping));
  registry.on('userStop', ({ name }: any) => restarter.onUserStop(name));

  const handoff = consumeHandoff();
  if (handoff && handoff.apps.length) {
    process.stdout.write(`[daimon] state-handoff: restoring ${handoff.apps.map(a => a.name).join(', ')}\n`);
    for (const h of handoff.apps) {
      portAlloc.pin(h.name, h.port);
    }
    for (const h of handoff.apps) {
      if (registry.names().includes(h.name)) {
        void registry.start(h.name);
      }
    }
  }

  if (config.autoStart && config.autoStart.length) {
    const known = new Set(registry.names());
    for (const name of config.autoStart) {
      if (!known.has(name)) {
        process.stderr.write(`[daimon] warning: autoStart references unknown app "${name}"\n`);
        continue;
      }
      if (config.depends && config.depends[name] && config.depends[name].length) {
        void registry.startWithDeps(name);
      } else {
        void registry.start(name);
      }
    }
  }

  const apiPort = process.env.DAIMON_PORT ? Number(process.env.DAIMON_PORT) : config.apiPort;
  const headless = !!opts.headless || !!config.headless || process.argv.includes('--headless');

  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    try { health.stop(); } catch {}
    try { usage.stop(); } catch {}
    try { restarter.stop(); } catch {}
    try { notifier.stop(); } catch {}
    try { staleDetector.stop(); } catch {}
    try { requestLog.stop(); } catch {}
    try { history.close(); } catch {}
    try {
      await registry.stopAll(3000);
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
  });
  process.stdout.write(`[daimon] api: http://127.0.0.1:${apiPort}\n`);
  try { writeLock(buildLockInfo(apiPort, headless)); } catch (err: any) { process.stderr.write(`[daimon] warning: could not write daemon.lock: ${err?.message || err}\n`); }

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
