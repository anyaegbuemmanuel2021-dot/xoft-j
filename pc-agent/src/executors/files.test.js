const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { listFiles, receiveTransfer, MAX_TRANSFER_BYTES } = require('./files');

async function fixture(fn) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'xoft-files-test-'));
  const allowed = path.join(root, 'allowed');
  const outside = path.join(root, 'outside');
  await fs.mkdir(allowed);
  await fs.mkdir(outside);
  try { await fn({ root, allowed, outside }); }
  finally { await fs.rm(root, { recursive: true, force: true }); }
}

test('legacy file listing refuses a symlink that resolves outside allowedRoots', async (t) => {
  await fixture(async ({ allowed, outside }) => {
    await fs.writeFile(path.join(outside, 'secret.txt'), 'private');
    try {
      await fs.symlink(outside, path.join(allowed, 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
    } catch (err) {
      if (process.platform === 'win32' && ['EPERM', 'EACCES', 'UNKNOWN'].includes(err.code)) {
        t.skip('Windows symlink/junction creation requires privileges on this machine');
        return;
      }
      throw err;
    }
    const result = await listFiles(path.join(allowed, 'escape'), [allowed]);
    assert.equal(result.success, false);
    assert.match(result.error, /outside every configured allowedRoots/);
  });
});

test('inbound transfer rejects directory traversal in remote filenames', async () => {
  await fixture(async ({ allowed, outside }) => {
    const result = await receiveTransfer(path.join(allowed, 'ignored.txt'), {
      fileName: '../outside/pwned.txt',
      contentBase64: Buffer.from('no').toString('base64'),
    }, [allowed]);
    assert.equal(result.success, false);
    assert.match(result.error, /Invalid inbound file name/);
    await assert.rejects(fs.access(path.join(outside, 'pwned.txt')));
  });
});

test('inbound transfer refuses oversized base64 before writing to disk', async () => {
  await fixture(async ({ allowed }) => {
    const tooLarge = 'A'.repeat(Math.ceil(MAX_TRANSFER_BYTES / 3) * 4 + 4);
    const result = await receiveTransfer(path.join(allowed, 'ignored.bin'), {
      fileName: 'too-large.bin',
      contentBase64: tooLarge,
    }, [allowed]);
    assert.equal(result.success, false);
    assert.match(result.error, /exceeds the 26214400-byte transfer limit/);
    await assert.rejects(fs.access(path.join(allowed, 'too-large.bin')));
  });
});

test('inbound transfer does not overwrite an existing file and verifies the written file size', async () => {
  await fixture(async ({ allowed }) => {
    const destination = path.join(allowed, 'already-there.txt');
    await fs.writeFile(destination, 'keep me');
    const result = await receiveTransfer(destination, {
      fileName: 'already-there.txt',
      contentBase64: Buffer.from('replace me').toString('base64'),
    }, [allowed]);
    assert.equal(result.success, false);
    assert.match(result.error, /EEXIST|already exists/i);
    assert.equal(await fs.readFile(destination, 'utf8'), 'keep me');
    const ok = await receiveTransfer(path.join(allowed, 'ignored.txt'), {
      fileName: 'new.txt',
      contentBase64: Buffer.from('verified').toString('base64'),
    }, [allowed]);
    assert.equal(ok.success, true);
    assert.equal(ok.verification.verified, true);
    assert.equal(ok.data.sizeBytes, 8);
    assert.equal(await fs.readFile(ok.data.savedTo, 'utf8'), 'verified');
  });
});
