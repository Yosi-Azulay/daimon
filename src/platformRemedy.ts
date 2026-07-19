// Platform-aware remedy phrasing (M143, v1.9 "Everywhere").
//
// User-facing remedies that name an OS command must match the reader's OS: a Mac
// user told to run `taskkill /PID … /F` is worse than no advice. Composition goes
// through this one small module so no caller sprinkles `process.platform ===`
// around. `platform` is injectable so both branches are unit-testable on any host.

// Terminate a process by pid.
export function killCmd(pid: number, platform: NodeJS.Platform = process.platform): string {
  return platform === 'win32' ? `taskkill /PID ${pid} /F` : `kill ${pid}`;
}

// Inspect who is listening on a port (or all listeners when port is omitted).
export function inspectPortCmd(port: number | null | undefined, platform: NodeJS.Platform = process.platform): string {
  if (platform === 'win32') {
    return port ? `netstat -ano | findstr :${port}` : 'netstat -ano';
  }
  return port ? `lsof -iTCP:${port} -sTCP:LISTEN` : 'lsof -iTCP -sTCP:LISTEN';
}

// "kill pid N (Windows: taskkill …)"-style one-liner when a remedy wants to name
// the pid inline but stay honest across platforms.
export function killHint(pid: number, platform: NodeJS.Platform = process.platform): string {
  return platform === 'win32' ? `\`taskkill /PID ${pid} /F\`` : `\`kill ${pid}\``;
}
