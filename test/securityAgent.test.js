import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SecurityAgent } from '../src/security/SecurityAgent.js';

test('secret scanner includes root .env files and redacts detected values', () => {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'xoft-secret-scan-'));
  fs.mkdirSync(path.join(projectRoot, 'src'), { recursive: true });
  fs.writeFileSync(path.join(projectRoot, '.env'), 'api_key="0123456789abcdefGHIJ"\n');
  fs.writeFileSync(path.join(projectRoot, 'src', 'safe.js'), 'export const safe = true;\n');

  const result = new SecurityAgent({ projectRoot }).scanForExposedSecrets();
  const finding = result.findings.find((item) => item.file === '.env');

  assert.ok(finding, 'a credential-like value in .env must be detected');
  assert.equal(finding.line, 1);
  assert.ok(finding.redacted.includes('(redacted)'));
  assert.ok(!JSON.stringify(result).includes('0123456789abcdefGHIJ'), 'raw credential must never appear in the report');
});

test('security hardening audit verifies actual Express middleware registrations', () => {
  const securityAgent = new SecurityAgent({ projectRoot: process.cwd() });
  const helmetMiddleware = () => {};
  const apiRateLimitMiddleware = () => {};
  const expensiveLimit = () => {};
  const app = { _router: { stack: [
    { handle: helmetMiddleware },
    { handle: apiRateLimitMiddleware, regexp: { test: (value) => value === '/api' } },
    ...['/api/media/image', '/api/media/video', '/api/security/audit'].map((routePath) => ({
      route: { path: routePath, stack: [{ handle: expensiveLimit }] },
    })),
  ] } };
  const result = securityAgent.checkConfigHardening({
    toolRegistry: { list: () => [] },
    emergencyStop: {},
    permissionSystem: {},
    app,
    helmetMiddleware,
    apiRateLimitMiddleware,
    expensiveLimit,
  });
  assert.equal(result.checks.find((check) => check.name === 'HTTP security headers (helmet)').pass, true);
  assert.equal(result.checks.find((check) => check.name === 'API rate limiting').pass, true);
  assert.equal(result.checks.find((check) => check.name === 'Stricter rate limiting on expensive endpoints').pass, true);
});

test('security hardening audit fails closed when required middleware is missing', () => {
  const securityAgent = new SecurityAgent({ projectRoot: process.cwd() });
  const result = securityAgent.checkConfigHardening({
    toolRegistry: { list: () => [] },
    emergencyStop: {},
    permissionSystem: {},
    app: { _router: { stack: [] } },
    helmetMiddleware: () => {},
    apiRateLimitMiddleware: () => {},
    expensiveLimit: () => {},
  });
  assert.equal(result.checks.find((check) => check.name === 'HTTP security headers (helmet)').pass, false);
  assert.equal(result.checks.find((check) => check.name === 'API rate limiting').pass, false);
  assert.equal(result.checks.find((check) => check.name === 'Stricter rate limiting on expensive endpoints').pass, false);
});
