import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import sharp from 'sharp';
import { fixture, png, gif, movie, offer, ffmpeg } from './helpers.ts';
import { BundledDecoder } from '../src/decoder.ts';
import { join } from 'node:path';
import { runProcess } from '../src/process.ts';
test('image is real decodable pixels; crop preserves selected region; original bytes stay intact', async t => {
  const f = await fixture(t), bytes = await png(), ref = await offer(f.app, bytes);
  const prepared = await f.app.prepare({ sessionId: 'session-a', mediaRef: ref.mediaRef, detail: 'detail', crop: { x: .5, y: 0, width: .5, height: 1 } });
  const image = Buffer.from(prepared.images[0].base64, 'base64');
  const stats = await sharp(image).stats(), meta = await sharp(image).metadata();
  assert.equal(meta.width, 80); assert.equal(meta.height, 60);
  assert.ok(stats.channels[2].mean > 240); assert.ok(stats.channels[0].mean < 10);
  assert.equal(meta.exif, undefined); assert.equal(prepared.coverage.sampled, false);
  assert.deepEqual(await readFile(f.app.store.lookup('session-a', ref.mediaRef).path), bytes);
  assert.equal(f.app.status().mainModelViewing, false);
});
test('GIF uses frame durations and keeps original animation, with honest sampling metadata', async t => {
  const f = await fixture(t), bytes = await gif(), ref = await offer(f.app, bytes, 'image/gif');
  assert.equal(ref.info.kind, 'animation'); assert.equal(ref.info.durationSeconds, 1);
  const prepared = await f.app.prepare({ sessionId: 'session-a', mediaRef: ref.mediaRef, atSeconds: .6 });
  const stats = await sharp(Buffer.from(prepared.images[0].base64, 'base64')).stats();
  assert.ok(stats.channels[2].mean > 240); assert.equal(prepared.coverage.audioIncluded, false);
  assert.equal(prepared.coverage.timelineComplete, false);
  assert.deepEqual(await readFile(f.app.store.lookup('session-a', ref.mediaRef).path), bytes);
});
test('GIF overview sheet has numbered cells and temporal map', async t => {
  const f = await fixture(t), ref = await offer(f.app, await gif(), 'image/gif');
  const p = await f.app.prepare({ sessionId: 'session-a', mediaRef: ref.mediaRef, layout: 'sheet' });
  assert.equal(p.images.length, 1); assert.equal(p.images[0].frames.length, 2);
  assert.deepEqual(p.images[0].frames.map(f => f.atSeconds), [0, .5]);
  assert.equal((await sharp(Buffer.from(p.images[0].base64, 'base64')).metadata()).width, 960);
});
test('finite MP4 sampling, pagination, timestamps, audio boundary and detailed revisit', async t => {
  const f = await fixture(t), ref = await offer(f.app, await movie(f.dir), 'video/mp4');
  assert.equal(ref.info.kind, 'video'); assert.equal(ref.info.hasAudio, true);
  const p = await f.app.prepare({ sessionId: 'session-a', mediaRef: ref.mediaRef, fromSeconds: 0, toSeconds: 2 });
  assert.equal(p.coverage.nextFromSeconds, 2); assert.equal(p.coverage.audioIncluded, false);
  assert.ok(p.coverage.selectedTimes.some(n => n >= 1)); assert.ok(p.images.length <= 8);
  const detail = await f.app.prepare({ sessionId: 'session-a', mediaRef: ref.mediaRef, atSeconds: 2.5, detail: 'detail' });
  const stats = await sharp(Buffer.from(detail.images[0].base64, 'base64')).stats();
  assert.ok(stats.channels[2].mean > 230); assert.ok(stats.channels[0].mean < 15);
  const last = await f.app.prepare({ sessionId: 'session-a', mediaRef: ref.mediaRef, fromSeconds: 2 });
  assert.equal(last.coverage.nextFromSeconds, null);
  const short = await f.app.prepare({ sessionId: 'session-a', mediaRef: ref.mediaRef, fromSeconds: 3.8, toSeconds: 3.99 });
  assert.ok(short.images.length >= 1, 'sub-half-second interval still yields a real frame');
});
test('wrong mime, corrupt images, unsupported content and malformed base64 are rejected without remnants', async t => {
  const f = await fixture(t), bytes = await png();
  await assert.rejects(offer(f.app, bytes, 'image/jpeg'), { code: 'mime_mismatch' });
  await assert.rejects(offer(f.app, bytes.subarray(0, 30)), { code: 'decode_failed' });
  await assert.rejects(offer(f.app, Buffer.from('private-marker-do-not-log')), { code: 'unsupported_media' });
  await assert.rejects(f.app.offerMedia({ sessionId: 'session-a', mime: 'image/png', base64: 'data:image/png;base64,AAAA' }), { code: 'invalid_encoding' });
  assert.equal(f.app.store.entries.size, 0); assert.deepEqual(await readdir(f.app.store.root), []);
});
test('invalid crop and time parameters fail instead of silently changing what is viewed', async t => {
  const f = await fixture(t), ref = await offer(f.app, await png());
  for (const args of [{ atSeconds: 0 }, { crop: { x: .8, y: 0, width: .5, height: 1 } }, { detail: 'unknown' }, { layout: 'unknown' }])
    await assert.rejects(f.app.prepare({ sessionId: 'session-a', mediaRef: ref.mediaRef, ...args } as any), { code: 'invalid_input' });
  const animation = await offer(f.app, await gif(), 'image/gif');
  for (const args of [{ fromSeconds: .8, toSeconds: .2 }, { atSeconds: 1 }, { atSeconds: .5, fromSeconds: 0 }, { fromSeconds: NaN }])
    await assert.rejects(f.app.prepare({ sessionId: 'session-a', mediaRef: animation.mediaRef, ...args }), { code: 'invalid_input' });
});
test('missing video decoder is explicit and does not disable still images', async t => {
  const f = await fixture(t, {}, undefined, new BundledDecoder(join(import.meta.dirname, 'missing-runtime')));
  assert.equal((f.app.status().decoder as any).ready, false);
  await assert.rejects(offer(f.app, await movie(f.dir), 'video/mp4'), { code: 'decoder_unavailable' });
  const ref = await offer(f.app, await png());
  assert.equal((await f.app.prepare({ sessionId: 'session-a', mediaRef: ref.mediaRef })).images.length, 1);
});
test('JPEG orientation is applied before crop and private EXIF does not enter prepared pixels', async t => {
  const f = await fixture(t);
  const bytes = await sharp(await png()).jpeg().withMetadata({ orientation: 6 }).withExif({ IFD0: { ImageDescription: 'SYNTHETIC_PRIVATE_METADATA' } }).toBuffer();
  const ref = await offer(f.app, bytes, 'image/jpeg');
  assert.equal(ref.info.width, 60); assert.equal(ref.info.height, 160);
  const p = await f.app.prepare({ sessionId: 'session-a', mediaRef: ref.mediaRef, detail: 'detail' });
  const meta = await sharp(Buffer.from(p.images[0].base64, 'base64')).metadata();
  assert.equal(meta.width, 60); assert.equal(meta.height, 160); assert.equal(meta.exif, undefined);
  assert.ok(!JSON.stringify(p).includes('SYNTHETIC_PRIVATE_METADATA'));
});
test('static and animated WebP preserve the declared format and temporal view', async t => {
  const f = await fixture(t);
  const staticRef = await offer(f.app, await sharp(await png()).webp().toBuffer(), 'image/webp');
  assert.equal(staticRef.info.kind, 'image');
  const animated = await sharp(await gif(), { animated: true }).webp({ lossless: true }).toBuffer();
  const ref = await offer(f.app, animated, 'image/webp');
  assert.equal(ref.info.kind, 'animation');
  const p = await f.app.prepare({ sessionId: 'session-a', mediaRef: ref.mediaRef, atSeconds: .6 });
  assert.ok((await sharp(Buffer.from(p.images[0].base64, 'base64')).stats()).channels[2].mean > 240);
});
test('WebM is decoded through the restricted file demuxer and produces visual samples', async t => {
  const f = await fixture(t); await movie(f.dir);
  const target = join(f.dir, 'synthetic.webm');
  await runProcess(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-i', join(f.dir, 'synthetic.mp4'), '-an', '-c:v', 'libvpx-vp9', '-threads', '1', '-deadline', 'realtime', target], new AbortController().signal, 65536);
  const ref = await offer(f.app, await readFile(target), 'video/webm');
  assert.equal(ref.info.kind, 'video');
  const p = await f.app.prepare({ sessionId: 'session-a', mediaRef: ref.mediaRef, atSeconds: 2 });
  assert.ok((await sharp(Buffer.from(p.images[0].base64, 'base64')).stats()).channels[2].mean > 230);
});
