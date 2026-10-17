import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AddressModel } from '../src/personality/AddressModel.js';
import { ChannelGateway } from '../src/channels/ChannelGateway.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'xoft-addr-'));

describe('AddressModel — XOFT is male; the speaker is addressed as sir or ma\'am', () => {
  test('unknown speaker: no guessing, no honorific', () => {
    const a = new AddressModel({ dataDir: tmp() });
    a.bindSession('s', 'u');
    const p = a.describeForPrompt('s');
    assert.match(p, /male assistant/);
    assert.match(p, /Do not guess/);
  });

  test('explicit self-declaration is learned and persists', () => {
    const dir = tmp();
    const a = new AddressModel({ dataDir: dir });
    assert.equal(a.observe('u1', "I'm a woman, help me"), "ma'am");
    assert.equal(a.observe('u2', 'please call me sir'), 'sir');
    assert.equal(new AddressModel({ dataDir: dir }).getHonorific('u1'), "ma'am");
  });

  test('different speakers get different honorifics in the same app', () => {
    const a = new AddressModel({ dataDir: tmp() });
    a.setHonorific('him', 'sir');
    a.setHonorific('her', "ma'am");
    a.bindSession('s1', 'him');
    a.bindSession('s2', 'her');
    assert.match(a.describeForPrompt('s1'), /"sir"/);
    assert.match(a.describeForPrompt('s2'), /"ma'am"/);
  });

  test('normalizes variants and rejects invalid values', () => {
    const a = new AddressModel({ dataDir: tmp() });
    assert.equal(a.setHonorific('u', 'Madam'), "ma'am");
    assert.equal(a.setHonorific('u', 'ma’am'), "ma'am");
    assert.throws(() => a.setHonorific('u', 'dude'), /honorific must be/);
    assert.throws(() => a.setHonorific('', 'sir'), /userId is required/);
  });

  test('ignores messages without a declaration', () => {
    const a = new AddressModel({ dataDir: tmp() });
    assert.equal(a.observe('u', 'what is the weather'), null);
    assert.equal(a.getHonorific('u'), null);
  });

  test('ChannelGateway learns and binds before the brain runs', async () => {
    const address = new AddressModel({ dataDir: tmp() });
    let seen;
    const executiveBrain = { async handle(sessionId) { seen = address.describeForPrompt(sessionId); return { reply: 'ok' }; } };
    const gw = new ChannelGateway({ executiveBrain, address });
    await gw.handle({ channel: 'web', userId: 'u9', sessionId: 'w1', message: "I'm a man, hello" });
    assert.match(seen, /"sir"/);
  });
});
