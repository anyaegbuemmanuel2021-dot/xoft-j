import test from 'node:test';
import assert from 'node:assert/strict';
import { recordedMimeType } from '../public/js/voice/listen.js';

test('recorded MIME prefers the browser recorder value, including codec parameters', () => {
  assert.equal(recordedMimeType({ mimeType: 'audio/mp4;codecs=mp4a.40.2' }, { mimeType: 'audio/webm' }), 'audio/mp4;codecs=mp4a.40.2');
});

test('recorded MIME falls back to the selected recorder option when mimeType is omitted', () => {
  assert.equal(recordedMimeType({ mimeType: '' }, { mimeType: 'audio/ogg;codecs=opus' }), 'audio/ogg;codecs=opus');
});

test('recorded MIME uses WebM only when neither recorder nor options report a type', () => {
  assert.equal(recordedMimeType({}, {}), 'audio/webm');
});
