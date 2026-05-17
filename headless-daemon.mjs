import { loadConfig } from './dist/config.js';
import { discoverApps } from './dist/discovery.js';
import { Registry } from './dist/registry.js';
import { PortAllocator } from './dist/ports.js';
import { startServer } from './dist/server.js';
import { HealthMonitor } from './dist/health.js';
import { UsageMonitor } from './dist/usage.js';
import { Restarter } from './dist/restarter.js';
import { loadPersistedState, savePersistedState } from './dist/stateFile.js';
import { History } from './dist/history.js';
import { findCycle } from './dist/depends.js';

const r = loadConfig();
if (r.kind !== 'loaded') { console.error('expected loaded config'); process.exit(1); }
if (r.config.depends && Object.keys(r.config.depends).length) {
  const c = findCycle(r.config.depends);
  if (c) { console.error(`[headless] depends cycle: ${c.join(' -> ')}`); process.exit(1); }
}
const persisted = loadPersistedState();
const portAlloc = new PortAllocator(r.config.portRange, {
  initial: persisted.ports,
  onChange: snap => savePersistedState({ ports: snap }),
});
const reg = new Registry(r.config, discoverApps(r.config), portAlloc);
const history = new History(r.config.history);
reg.setHistory(history);
const health = new HealthMonitor(reg, r.config.healthProbe, r.config);
const usage = new UsageMonitor(reg);
const restarter = new Restarter(reg, r.config.autoRestart);
reg.on('childExit', ({ name, code, signal, stopping }) => restarter.onExit(name, code, signal, stopping));
reg.on('userStop', ({ name }) => restarter.onUserStop(name));
const srv = startServer(reg, r.config.apiPort);
for (const n of r.config.autoStart || []) {
  if (r.config.depends && r.config.depends[n] && r.config.depends[n].length) void reg.startWithDeps(n);
  else void reg.start(n);
}
console.error(`[headless] api on ${r.config.apiPort}`);

let stopping = false;
const stop = async () => {
  if (stopping) return; stopping = true;
  health.stop();
  usage.stop();
  restarter.stop();
  await reg.stopAll(3000);
  history.close();
  srv.close();
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
