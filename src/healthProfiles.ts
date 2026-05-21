import type { ServerProfile } from './types.js';

// Default health-probe path per server framework. When an app's serverProfile
// is known and the user hasn't pinned a healthProbePath override, daimon
// probes the profile's recommended path — typically a cheap framework page
// that exists out of the box (Django's /admin/login/, FastAPI's /docs).
//
// For profiles with no obvious sentinel, fall back to "/" and rely on the
// smart-status interpretation (200/302/401 = alive).
export const HEALTH_PROBE_DEFAULTS: Partial<Record<ServerProfile, string>> = {
  django: '/admin/login/',
  rails: '/up',
  fastapi: '/docs',
  'go-air': '/',
  'rust-trunk': '/',
  // Angular/Nx/Vite/Storybook: serve the SPA at /, which the existing probe
  // already targets — leaving these unset preserves the M46 behavior.
};

export function profileProbePath(profile: ServerProfile | undefined): string | null {
  if (!profile) return null;
  return HEALTH_PROBE_DEFAULTS[profile] ?? null;
}

// Classify an HTTP status into the polyglot v2 buckets: 200 OK, 301/302
// (redirect implies the server is alive), 401 (auth-gated). The dev-server
// frameworks daimon supports all settle into one of these once they finish
// booting.
export function isHealthyHttpStatus(code: number): boolean {
  if (code === 200 || code === 301 || code === 302 || code === 304 || code === 307 || code === 308) return true;
  if (code === 401) return true;
  return false;
}

// Connection-level signals that mean the server is not yet alive (or has
// crashed). Anything that smells like "process is gone" is unhealthy; transient
// timeouts and the like still get retried by the caller.
export function isFatalProbeError(errCode: string | undefined): boolean {
  if (!errCode) return false;
  return errCode === 'ECONNREFUSED' || errCode === 'ECONNRESET' || errCode === 'EHOSTUNREACH';
}
