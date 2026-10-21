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
