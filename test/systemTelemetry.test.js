import test from 'node:test';
import assert from 'node:assert/strict';
import { SystemTelemetry } from '../src/system/SystemTelemetry.js';

function fakeOs(seq) {
  let i = 0;
  return {
    cpus: () => { const t = seq[Math.min(i, seq.length - 1)]; i += 1; return [{ times: t }]; },
    totalmem: () => 8000, freemem: () => 2000, loadavg: () => [0.5, 0, 0], uptime: () => 1000, platform: () => 'linux', arch: () => 'x64',
  };
}

test('cpu percent is a real delta between samples (first sample has none)', () => {
  const osImpl = fakeOs([{ user: 100, idle: 900 }, { user: 100, idle: 900 }, { user: 400, idle: 1000 }]);
  const t = new SystemTelemetry({ osImpl });
  // constructor does not sample; first call primes, second call computes
  assert.equal(t.cpuPercent(), null);
  assert.equal(t.cpuPercent(), null, 'zero delta keeps the previous (null) value');
  assert.equal(t.cpuPercent(), 75, '300 busy of 400 total');
});

test('snapshot reports memory, uptime, platform and no secrets', () => {
  const t = new SystemTelemetry({ osImpl: fakeOs([{ user: 1, idle: 1 }]), fsImpl: { statfsSync: () => ({ blocks: 1000, bsize: 1024, bavail: 250 }) } });
  const s = t.snapshot();
  assert.equal(s.memory.usedPercent, 75);
  assert.deepEqual(s.storage, { totalBytes: 1024000, usedBytes: 768000, usedPercent: 75 });
  assert.equal(s.platform, 'linux x64');
  assert.equal(s.uptime.hostSeconds, 1000);
  assert.deepEqual(Object.keys(s).sort(), ['cpu', 'memory', 'node', 'platform', 'storage', 'ts', 'uptime']);
});

test('storage is null (not faked) when the platform cannot report it', () => {
  const t = new SystemTelemetry({ osImpl: fakeOs([{ user: 1, idle: 1 }]), fsImpl: { statfsSync: () => { throw new Error('ENOSYS'); } } });
  assert.equal(t.snapshot().storage, null);
});
