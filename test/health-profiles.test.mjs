import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HEALTH_PROBE_DEFAULTS, profileProbePath, isHealthyHttpStatus, isFatalProbeError } from '../dist/healthProfiles.js';

test('profileProbePath: django defaults to /admin/login/', () => {
  assert.equal(profileProbePath('django'), '/admin/login/');
});

test('profileProbePath: rails defaults to /up', () => {
  assert.equal(profileProbePath('rails'), '/up');
});

test('profileProbePath: fastapi defaults to /docs', () => {
  assert.equal(profileProbePath('fastapi'), '/docs');
});

test('profileProbePath: unknown profile returns null', () => {
  assert.equal(profileProbePath(undefined), null);
});

test('isHealthyHttpStatus: 200 / 302 / 401 all healthy', () => {
  assert.equal(isHealthyHttpStatus(200), true);
  assert.equal(isHealthyHttpStatus(302), true);
  assert.equal(isHealthyHttpStatus(401), true);
});

test('isHealthyHttpStatus: 5xx is NOT healthy', () => {
  assert.equal(isHealthyHttpStatus(500), false);
  assert.equal(isHealthyHttpStatus(503), false);
});

test('isFatalProbeError: ECONNREFUSED + ECONNRESET classify as fatal', () => {
  assert.equal(isFatalProbeError('ECONNREFUSED'), true);
  assert.equal(isFatalProbeError('ECONNRESET'), true);
  assert.equal(isFatalProbeError('ETIMEDOUT'), false);
  assert.equal(isFatalProbeError(undefined), false);
});

test('HEALTH_PROBE_DEFAULTS includes the 5 polyglot profiles', () => {
  for (const p of ['django', 'rails', 'fastapi', 'go-air', 'rust-trunk']) {
    assert.ok(HEALTH_PROBE_DEFAULTS[p], `missing default for ${p}`);
  }
});
