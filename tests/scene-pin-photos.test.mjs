import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { photoPath, decodeJpegDataUrl, withSignedPhotos, MAX_PHOTO_BYTES } =
  require('../scene-photo-storage.js');
const sceneId = '11111111-2222-3333-4444-555555555555';
const objectId = '66666666-7777-8888-9999-000000000000';

test('label photo key is deterministically scoped to scene and object', () => {
  assert.equal(photoPath(sceneId, objectId), sceneId + '/' + objectId + '/photo.jpg');
  assert.throws(() => photoPath('../other', objectId), /Invalid scene/);
  assert.throws(() => photoPath(sceneId, '../other'), /Invalid scene/);
});

test('photo uploads accept JPEG data only, with a strict byte limit', () => {
  const sample = Buffer.from([255,216,255,224,1,2,3,255,217]);
  assert.deepEqual(decodeJpegDataUrl('data:image/jpeg;base64,' + sample.toString('base64')), sample);
  assert.throws(() => decodeJpegDataUrl('invalid'), /JPEG/);
  assert.throws(() => decodeJpegDataUrl('data:image/png;base64,abcd'), /JPEG/);
  assert.throws(() => decodeJpegDataUrl('data:image/jpeg;base64,Zm9v'), /JPEG/);
  const oversized = Buffer.alloc(MAX_PHOTO_BYTES + 1, 1);
  assert.throws(() => decodeJpegDataUrl('data:image/jpeg;base64,' + oversized.toString('base64')),
    /oversized/);
});

test('labels without photos do not require a storage connection', async () => {
  const original = { id: objectId, sceneId, kind: 'label', props: { text: 'Door 1', description: 'Check nozzle' } };
  const out = await withSignedPhotos([original]);
  assert.equal(out[0].props.text, 'Door 1');
  assert.equal(out[0].props.photoUrl, null);
  assert.equal(original.props.photoUrl, undefined);
});
