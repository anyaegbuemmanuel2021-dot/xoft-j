import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SocialHandleManager } from '../src/social/SocialHandleManager.js';

function fixture(router = { async complete(_task, params) { return { text: params.messages[1].content.includes('Create a') ? 'Original draft' : 'Style analysis', provider: 'mock' }; } }) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xoft-social-test-'));
  const manager = new SocialHandleManager({ dataDir, router });
  return { manager, dataDir, router, cleanup: () => fs.rmSync(dataDir, { recursive: true, force: true }) };
}

test('new handles start stopped and duplicate platform handles are rejected case-insensitively', () => {
  const f = fixture();
  try {
    const first = f.manager.add({ platform: 'instagram', handle: '@Softly1810', niche: 'digital services' });
    assert.equal(first.workflowEnabled, false);
    assert.equal(first.killSwitch, true);
    assert.throws(() => f.manager.add({ platform: 'instagram', handle: 'softly1810' }), /already registered/);
    assert.equal(f.manager.list().length, 1);
  } finally { f.cleanup(); }
});

test('kill switch disables only the selected handle and state persists across manager instances', () => {
  const f = fixture();
  try {
    const a = f.manager.add({ platform: 'instagram', handle: 'softly1810' });
    const b = f.manager.add({ platform: 'tiktok', handle: 'softly1810' });
    f.manager.arm(a.id);
    f.manager.arm(b.id);
    const stopped = f.manager.kill(a.id, 'manual emergency stop');
    assert.equal(stopped.killSwitch, true);
    assert.equal(stopped.workflowEnabled, false);
    assert.match(stopped.killReason, /emergency stop/);
    assert.equal(f.manager.list().find((x) => x.id === b.id).workflowEnabled, true);
    const reopened = new SocialHandleManager({ dataDir: f.dataDir, router: f.router });
    assert.equal(reopened.list().find((x) => x.id === a.id).killSwitch, true);
    assert.equal(reopened.list().find((x) => x.id === b.id).workflowEnabled, true);
  } finally { f.cleanup(); }
});

test('profile URLs must use HTTPS and match the selected platform', () => {
  const f = fixture();
  try {
    assert.throws(() => f.manager.add({ platform: 'instagram', handle: 'creator', profileUrl: 'http://instagram.com/creator' }), /HTTPS/);
    assert.throws(() => f.manager.add({ platform: 'instagram', handle: 'creator', profileUrl: 'https://example.com/creator' }), /does not match/);
    assert.throws(() => f.manager.add({ platform: 'instagram', handle: 'creator', profileUrl: 'https://user:pass@instagram.com/creator' }), /credentials/);
  } finally { f.cleanup(); }
});

test('analysis and drafts use supplied samples, persist results, and never claim publication', async () => {
  const f = fixture();
  try {
    const handle = f.manager.add({ platform: 'linkedin', handle: 'creator', niche: 'technology', samplePosts: ['Three lessons from building software'] });
    const analyzed = await f.manager.analyze(handle.id);
    assert.equal(analyzed.analysis.text, 'Style analysis');
    const result = await f.manager.generateDraft(handle.id, { goal: 'Explain a useful software lesson', format: 'caption' });
    assert.equal(result.draft.text, 'Original draft');
    assert.equal(result.published, false);
    assert.equal(f.manager.list()[0].drafts.length, 1);
  } finally { f.cleanup(); }
});

test('invalid input bounds are enforced and unknown handles fail closed', () => {
  const f = fixture();
  try {
    assert.throws(() => f.manager.add({ platform: 'instagram', handle: 'bad handle' }), /only letters/);
    assert.throws(() => f.manager.add({ platform: 'instagram', handle: 'creator', samplePosts: Array(21).fill('x') }), /at most 20/);
    assert.throws(() => f.manager.kill('missing'), /not found/);
  } finally { f.cleanup(); }
});
