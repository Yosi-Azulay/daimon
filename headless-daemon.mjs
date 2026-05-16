import { loadConfig } from './dist/config.js';
import { discoverApps } from './dist/discovery.js';
import { Registry } from './dist/registry.js';
import { PortAllocator } from './dist/ports.js';
import { startServer } from './dist/server.js';
import { HealthMonitor } from './dist/health.js';
import { UsageMonitor } from './dist/usage.js';
import { loadPersistedState, savePersistedState } from './dist/stateFile.js';

const r = loadConfig();
if (r.kind !== 'loaded') { console.error('expected loaded config'); process.exit(1); }
const persisted = loadPersistedState();
const portAlloc = new PortAllocator(r.config.portRange, {
  initial: persisted.ports,
  onChange: snap => savePersistedState({ ports: snap }),
});
const reg = new Registry(r.config, discoverApps(r.config), portAlloc);
const health = new HealthMonitor(reg, r.config.healthProbe);
const usage = new UsageMonitor(reg);
const srv = startServer(reg, r.config.apiPort);
for (const n of r.config.autoStart || []) void reg.start(n);
console.error(`[headless] api on ${r.config.apiPort}`);

let stopping = false;
const stop = async () => {
  if (stopping) return; stopping = true;
  health.stop();
  usage.stop();
  await reg.stopAll(3000);
  srv.close();
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
