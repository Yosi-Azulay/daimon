import React from 'react';
import { render } from 'ink';
import { loadConfig, configLookupPaths } from './config.js';
import { discoverApps } from './discovery.js';
import { Registry } from './registry.js';
import { PortAllocator } from './ports.js';
import { startServer } from './server.js';
import { HealthMonitor } from './health.js';
import { loadPersistedState, savePersistedState } from './stateFile.js';
import App from './tui/App.js';

async function main() {
  let cfgResult;
  try {
    cfgResult = loadConfig();
  } catch (err: any) {
    process.stderr.write(`[appman] config error: ${err.message}\n`);
    process.exit(1);
  }

  if (cfgResult.kind === 'stub-created') {
    const paths = configLookupPaths();
    process.stdout.write(`[appman] no config found. Created stub at:\n  ${cfgResult.path}\n`);
    process.stdout.write(`[appman] Edit it to add "searchRoots" pointing at your Nx/Angular workspace, then run again.\n`);
    process.stdout.write(`[appman] (Local override path: ${paths.local})\n`);
    process.exit(0);
  }

  const { config, path: cfgPath } = cfgResult;
  process.stdout.write(`[appman] config: ${cfgPath}\n`);

  const apps = discoverApps(config);
  if (apps.length === 0) {
    process.stdout.write(`[appman] no serveable projects discovered in: ${config.searchRoots.join(', ') || '(none)'}\n`);
  }

  const persisted = loadPersistedState();
  const portAlloc = new PortAllocator(config.portRange, {
    initial: persisted.ports,
    onChange: snap => savePersistedState({ ports: snap }),
  });
  const registry = new Registry(config, apps, portAlloc);
  const health = new HealthMonitor(registry, config.healthProbe);

  if (config.autoStart && config.autoStart.length) {
    const known = new Set(registry.names());
    for (const name of config.autoStart) {
      if (!known.has(name)) {
        process.stderr.write(`[appman] warning: autoStart references unknown app "${name}"\n`);
        continue;
      }
      void registry.start(name);
    }
  }

  const server = startServer(registry, config.apiPort);
  process.stdout.write(`[appman] api: http://127.0.0.1:${config.apiPort}\n`);

  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    try { health.stop(); } catch {}
    try {
      await registry.stopAll(3000);
    } catch {}
    try {
      server.close();
    } catch {}
    process.exit(0);
  };

  process.on('SIGINT', () => { void shutdown(); });
  process.on('SIGTERM', () => { void shutdown(); });
  process.on('beforeExit', () => { void shutdown(); });

  const inst = render(React.createElement(App, { registry, apiPort: config.apiPort, onQuit: () => void shutdown() }));
  await inst.waitUntilExit();
  await shutdown();
}

main().catch(err => {
  process.stderr.write(`[appman] fatal: ${err?.stack || err}\n`);
  process.exit(1);
});
