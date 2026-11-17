import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import sharp from 'sharp';
import { fixture, png, gif, movie, offer, ffmpeg } from './helpers.ts';
import { BundledDecoder } from '../src/decoder.ts';
import { join } from 'node:path';
import { runProcess } from '../src/process.ts';
import { visualDefaults } from '../src/types.ts';
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

async function localMotionGif(width = 320, height = 180) {
  const pages: Buffer[] = [], count = 7;
  const left = Math.floor(width / 4), top = Math.floor(height / 4);
  const patchWidth = Math.floor(width / 4), patchHeight = Math.floor(height / 3);
  for (let frame = 0; frame < count; frame++) {
    const pixels = Buffer.alloc(width * height * 3);
    for (let i = 2; i < pixels.length; i += 3) pixels[i] = 255;
    for (let y = top; y < top + patchHeight; y++) for (let x = left; x < left + patchWidth; x++)
      pixels.fill(frame % 2 ? 230 : 70, (y * width + x) * 3, (y * width + x + 1) * 3);
    pages.push(pixels);
  }
  return sharp(Buffer.concat(pages), { raw: { width, height: height * count, channels: 3, pageHeight: height } })
    .gif({ delay: Array(count).fill(500), loop: 0 }).toBuffer();
}

test('automatic focus retains static content and never reuses a previous media reference', async t => {
  const f = await fixture(t), a = await offer(f.app, await png());
  const blue = await sharp({ create: { width: 160, height: 60, channels: 3, background: '#0000ff' } }).png().toBuffer();
  const b = await offer(f.app, blue);
  const first = await f.app.prepare({ sessionId: 'session-a', mediaRef: a.mediaRef, focus: 'auto' });
  const second = await f.app.prepare({ sessionId: 'session-a', mediaRef: b.mediaRef, focus: 'auto' });
  assert.equal(first.images.length, 1); assert.equal(second.images.length, 1);
  assert.equal(second.focus?.applied, false); assert.match(second.focus?.reason ?? '', /静态/);
  assert.notEqual(first.images[0].base64, second.images[0].base64);
  assert.ok((await sharp(Buffer.from(second.images[0].base64, 'base64')).stats()).channels[2].mean > 240);
});

test('automatic focus adds an original-pixel detail while retaining both endpoint overviews within the frame budget', async t => {
  const f = await fixture(t), ref = await offer(f.app, await localMotionGif(), 'image/gif');
  const result = await f.app.prepare({ sessionId: 'session-a', mediaRef: ref.mediaRef, focus: 'auto', maxFrames: 3 });
  assert.equal(result.focus?.applied, true);
  assert.equal(result.images.length, 3);
  const frames = result.images.flatMap(image => image.frames), contexts = frames.filter(frame => frame.role === 'overview');
  assert.deepEqual(contexts.map(frame => frame.atSeconds), [0, 3]);
  const detailImage = result.images.find(image => image.frames[0].role === 'focus')!;
  assert.ok(detailImage);
  const region = detailImage.frames[0].crop!;
  assert.ok(region.x <= .25 && region.x + region.width >= .5);
  assert.ok(region.y <= .25 && region.y + region.height >= .25 + 1 / 3);
  assert.ok(detailImage.width < 320 && detailImage.height < 180);
  assert.ok(Math.abs(detailImage.width / detailImage.height - (320 * region.width) / (180 * region.height)) < .06);
  assert.equal(result.images[0].width, 320); assert.equal(result.images[0].height, 180);
  assert.equal(result.crop, null, 'automatic detail must not replace the full-image crop contract');
});

test('two-frame focus budget prioritizes the full timeline and sheet mode retains separately readable detail', async t => {
  const f = await fixture(t), ref = await offer(f.app, await localMotionGif(), 'image/gif');
  const small = await f.app.prepare({ sessionId: 'session-a', mediaRef: ref.mediaRef, focus: 'auto', maxFrames: 2 });
  assert.equal(small.focus?.applied, false); assert.match(small.focus?.reason ?? '', /预算/);
  assert.deepEqual(small.coverage.selectedTimes, [0, 3]); assert.equal(small.images.length, 2);
  const sheet = await f.app.prepare({ sessionId: 'session-a', mediaRef: ref.mediaRef, focus: 'auto', maxFrames: 4, layout: 'sheet' });
  assert.equal(sheet.images.length, 2);
  assert.ok(sheet.images[0].frames.every(frame => frame.role === 'overview'));
  assert.equal(sheet.images[1].frames[0].role, 'focus');
  assert.ok(sheet.images.reduce((count, image) => count + image.frames.length, 0) <= 4);
});

test('portrait automatic detail maps out of letterboxing and preserves crop aspect ratio', async t => {
  const f = await fixture(t), ref = await offer(f.app, await localMotionGif(180, 320), 'image/gif');
  const result = await f.app.prepare({ sessionId: 'session-a', mediaRef: ref.mediaRef, focus: 'auto', maxFrames: 4 });
  assert.equal(result.focus?.applied, true);
  const image = result.images.find(item => item.frames[0].role === 'focus')!, crop = image.frames[0].crop!;
  assert.ok(crop.x <= .25 && crop.x + crop.width >= .5);
  assert.ok(crop.width < .5, 'padding must not be mapped as source-image width');
  assert.ok(Math.abs(image.width / image.height - (180 * crop.width) / (320 * crop.height)) < .05);
  assert.equal(result.images[0].width, 180); assert.equal(result.images[0].height, 320);
});

test('explicit crop takes precedence and configured visual settings remain overridable', async t => {
  const f = await fixture(t, { visual: { ...visualDefaults, layout: 'sheet', focus: 'auto', maxFrames: 3, sampleFps: 1 } });
  const ref = await offer(f.app, await localMotionGif(), 'image/gif');
  const crop = { x: 0, y: 0, width: .5, height: 1 };
  const explicit = await f.app.prepare({ sessionId: 'session-a', mediaRef: ref.mediaRef, crop, layout: 'frames' });
  assert.deepEqual(explicit.crop, crop); assert.equal(explicit.focus?.applied, false);
  assert.ok(explicit.images.every(image => image.width === 160 && image.height === 180));
  assert.equal(explicit.coverage.sampleIntervalSeconds, 1);
  const single = await f.app.prepare({ sessionId: 'session-a', mediaRef: ref.mediaRef, atSeconds: 1 });
  assert.equal(single.detail, 'detail', 'configured auto must preserve the old detailed revisit default');
  assert.equal(single.images.length, 1); assert.equal(single.focus?.applied, false);
  const override = await f.app.prepare({ sessionId: 'session-a', mediaRef: ref.mediaRef, sampleFps: 4, maxFrames: 2, focus: 'whole', layout: 'frames', detail: 'overview' });
  assert.equal(override.coverage.sampleIntervalSeconds, .25); assert.equal(override.images.length, 2);
  assert.equal(override.focus, undefined); assert.equal(override.detail, 'overview');
});

test('detail configuration changes actual pixels and request quality overrides it', async t => {
  const f = await fixture(t, { visual: { ...visualDefaults, detail: 'detail' } });
  const bytes = await sharp({ create: { width: 1000, height: 400, channels: 3, background: '#2244aa' } }).png().toBuffer();
  const ref = await offer(f.app, bytes);
  const configured = await f.app.prepare({ sessionId: 'session-a', mediaRef: ref.mediaRef });
  assert.equal(configured.images[0].width, 1000); assert.equal(configured.images[0].height, 400);
  const override = await f.app.prepare({ sessionId: 'session-a', mediaRef: ref.mediaRef, detail: 'overview' });
  assert.equal(override.images[0].width, 640); assert.equal(override.images[0].height, 256);
});

test('configurable video sampling covers the tail and reports its actual interval', async t => {
  const f = await fixture(t), ref = await offer(f.app, await movie(f.dir), 'video/mp4');
  const result = await f.app.prepare({ sessionId: 'session-a', mediaRef: ref.mediaRef, fromSeconds: 0, toSeconds: 4, sampleFps: 6, maxFrames: 2 });
  assert.equal(result.coverage.sampleIntervalSeconds, 1 / 6);
  assert.equal(result.coverage.selectedTimes[0], 0);
  assert.ok(result.coverage.selectedTimes.at(-1)! >= 3.5);
  assert.equal(result.images.length, 2); assert.equal(result.coverage.toSeconds, 4);
});

test('video focus crops source pixels before resizing a large frame', async t => {
  const f = await fixture(t), source = join(f.dir, 'local-motion.gif'), target = join(f.dir, 'large-local-motion.mp4');
  await writeFile(source, await localMotionGif());
  await runProcess(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-i', source, '-t', '3.5',
    '-filter_threads', '1', '-vf', 'scale=4608:2592:flags=neighbor', '-an', '-c:v', 'libx264', '-preset', 'ultrafast',
    '-threads', '1', '-pix_fmt', 'yuv420p', target], new AbortController().signal, 65536);
  const ref = await offer(f.app, await readFile(target), 'video/mp4');
  const result = await f.app.prepare({ sessionId: 'session-a', mediaRef: ref.mediaRef, focus: 'auto', maxFrames: 3 });
  assert.equal(result.focus?.applied, true); assert.equal(result.images.length, 3);
  const image = result.images.find(item => item.frames[0].role === 'focus')!, crop = image.frames[0].crop!;
  assert.ok(4608 * crop.width < 1600 && 2592 * crop.height < 1600, 'fixture detail fits without downscaling');
  assert.ok(Math.abs(image.width - Math.round(4608 * crop.width)) <= 1);
  assert.ok(Math.abs(image.height - Math.round(2592 * crop.height)) <= 1);
});

test('invalid visual options are rejected and cancellation leaves later focus requests usable', async t => {
  const f = await fixture(t), ref = await offer(f.app, await localMotionGif(), 'image/gif');
  for (const options of [{ focus: 'unknown' }, { maxFrames: 1 }, { maxFrames: 9 }, { maxFrames: 2.5 }, { sampleFps: 3 }, { sampleFps: Number.NaN }])
    await assert.rejects(f.app.prepare({ sessionId: 'session-a', mediaRef: ref.mediaRef, ...options } as any), { code: 'invalid_input' });
  const cancel = new AbortController();
  const pending = f.app.prepare({ sessionId: 'session-a', mediaRef: ref.mediaRef, focus: 'auto', sampleFps: 6 }, { signal: cancel.signal });
  cancel.abort(); await assert.rejects(pending, { code: 'cancelled' });
  const next = await f.app.prepare({ sessionId: 'session-a', mediaRef: ref.mediaRef, focus: 'auto' });
  assert.equal(next.focus?.applied, true); assert.equal(f.app.status().activeOperations, 0);
});
