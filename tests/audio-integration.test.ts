import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fixture, offer, png, movie, ffmpeg } from './helpers.ts';
import { AudioEngine } from '../src/audio-engine.ts';
import { audioDefaults, type AudioEvidence } from '../src/audio-types.ts';
import { audioRange, pcmWav } from '../src/audio-media.ts';
import { registerUnderstandTool } from '../src/understand-tool.ts';
import { runProcess } from '../src/process.ts';
import { VisionError, configOf } from '../src/types.ts';

const speech = (): AudioEvidence => ({ text: 'SYNTHETIC_SPOKEN_WORDS', timing: 'segment',
  segments: [{ startSeconds: .1, endSeconds: .5, text: 'SYNTHETIC_SPOKEN_WORDS' }], warnings: [] });
const signal = () => new AbortController().signal;
function engine(adapters: Partial<AudioEngine['adapters']> = {}, settings = audioDefaults) {
  let prepared = 0;
  const local: AudioEngine['adapters']['local'] = {
    async start() {}, status: () => ({ ready: false }) as any,
    async prepare() { prepared++; }, async transcribe() { return speech(); }, async stop() {},
  };
  const app = new AudioEngine('unused-mock-directory', settings, signal(), () => { throw Error('secret-connection-marker'); }, { local, ...adapters });
  return { app, prepared: () => prepared };
}
const wav = (duration = 1) => pcmWav(Buffer.alloc(Math.round(duration * 32000)));

test('one video reference yields native image blocks and timestamped audio evidence without changing legacy prepare', async t => {
  const f = await fixture(t), audio = engine(); f.app.audio = audio.app;
  const ref = await offer(f.app, await movie(f.dir), 'video/mp4');
  const legacy = await f.app.prepare({ sessionId: 'session-a', mediaRef: ref.mediaRef, fromSeconds: 1, toSeconds: 2 });
  assert.equal(legacy.coverage.audioIncluded, false);
  let definition: any;
  assert.equal(registerUnderstandTool({ tools: { registerMultimodal(d: any) { definition = d; } } } as any, f.app), true);
  const result = await definition.run({ mediaRef: ref.mediaRef, fromSeconds: 1, toSeconds: 2, sessionId: 'forged-other-session' }, { id: 'session-a', signal: signal() });
  assert.ok(result.content.some((part: any) => part.type === 'image'));
  const text = result.content.filter((part: any) => part.type === 'text').map((part: any) => part.text).join('\n');
  assert.match(text, /SYNTHETIC_SPOKEN_WORDS/);
  assert.match(text, /"startSeconds":1.1/);
  assert.equal(result.receipt.outcome, 'completed');
  assert.equal(result.receipt.fromSeconds, 1); assert.equal(result.receipt.toSeconds, 2);
  const receipt = JSON.stringify(result.receipt);
  for (const privateValue of ['SYNTHETIC_SPOKEN_WORDS', ref.mediaRef, 'base64', 'segments']) assert.ok(!receipt.includes(privateValue));
  assert.equal(audio.prepared(), 0, 'no automatic resource preparation');
  const denied = await definition.run({ mediaRef: ref.mediaRef, sessionId: 'session-a' }, { id: 'session-b', signal: signal() });
  assert.equal(denied.receipt.code, 'media_unavailable');
  assert.equal(registerUnderstandTool({ tools: {} } as any, f.app), false);
});

test('pure audio input is decoded to exact mono PCM WAV, only selected range is processed, and raw bytes are released', async t => {
  const f = await fixture(t); let received: Buffer | undefined;
  const audio = engine({ local: { async start() {}, status: () => ({ ready: true }) as any, async prepare() {}, async stop() {},
    async transcribe(bytes) { received = bytes; return speech(); } } }); f.app.audio = audio.app;
  const ref = await offer(f.app, wav(3), 'audio/wav');
  assert.equal(ref.info.kind, 'audio'); assert.equal(ref.info.durationSeconds, 3);
  await assert.rejects(f.app.prepare({ sessionId: 'session-a', mediaRef: ref.mediaRef }), { code: 'no_visual' });
  const result = await f.app.understand({ sessionId: 'session-a', mediaRef: ref.mediaRef, fromSeconds: 1, toSeconds: 2 });
  assert.equal(result.visual, undefined); assert.equal(result.status, 'completed');
  assert.deepEqual(result.audio.coverage, { fromSeconds: 1, toSeconds: 2, nextFromSeconds: 2 });
  assert.equal(received!.readUInt32LE(4), received!.length - 8); assert.equal(received!.readUInt32LE(40), 32000);
  await f.app.release({ sessionId: 'session-a', mediaRef: ref.mediaRef });
  assert.deepEqual(await readdir(f.app.store.root), []);
  await assert.rejects(offer(f.app, wav(), 'audio/mpeg'), { code: 'mime_mismatch' });
});

test('supported audio containers are detected and an audio MIME cannot hide a video track', async t => {
  const f = await fixture(t); await movie(f.dir);
  const variants = [['mp3', 'audio/mpeg', 'libmp3lame'], ['flac', 'audio/flac', 'flac'], ['ogg', 'audio/ogg', 'libvorbis'],
    ['m4a', 'audio/mp4', 'aac'], ['webm', 'audio/webm', 'libopus']] as const;
  for (const [ext, mime, codec] of variants) {
    const path = join(f.dir, 'audio.' + ext);
    await runProcess(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-i', join(f.dir, 'synthetic.mp4'), '-vn', '-c:a', codec, '-threads', '1', path], signal(), 65536);
    assert.equal((await offer(f.app, await readFile(path), mime)).info.kind, 'audio');
  }
  const cover = join(f.dir, 'cover.png'), covered = join(f.dir, 'covered.mp3'); await writeFile(cover, await png());
  await runProcess(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-i', join(f.dir, 'audio.mp3'), '-i', cover,
    '-map', '0:a', '-map', '1:v', '-c', 'copy', '-id3v2_version', '3', '-disposition:v', 'attached_pic', covered], signal(), 65536);
  assert.equal((await offer(f.app, await readFile(covered), 'audio/mpeg')).info.kind, 'audio', 'embedded album art remains audio');
  await assert.rejects(offer(f.app, await readFile(join(f.dir, 'synthetic.mp4')), 'audio/mp4'), { code: 'mime_mismatch' });
});

test('audio track delay and short track coverage remain on the source video timeline', async t => {
  const f = await fixture(t); let captured: Buffer | undefined;
  f.app.audio = engine({ local: { async start() {}, status: () => ({ ready: true }) as any, async prepare() {}, async stop() {},
    async transcribe(bytes) { captured = bytes; return { text: '', timing: 'clip', warnings: [] }; } } }).app;
  const path = join(f.dir, 'delayed.mp4');
  await runProcess(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y',
    '-f', 'lavfi', '-i', 'color=c=red:s=160x90:r=10:d=4', '-itsoffset', '1', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=16000:duration=1',
    '-map', '0:v', '-map', '1:a', '-c:v', 'libx264', '-threads', '1', '-c:a', 'aac', '-movflags', '+faststart', path], signal(), 65536);
  const ref = await offer(f.app, await readFile(path), 'video/mp4');
  const result = await f.app.understand({ sessionId: 'session-a', mediaRef: ref.mediaRef, visual: false, fromSeconds: .5, toSeconds: 3 });
  assert.equal(result.audio.status, 'completed');
  assert.equal(result.audio.coverage!.fromSeconds, .5);
  assert.ok(result.audio.coverage!.toSeconds > 1.9 && result.audio.coverage!.toSeconds < 2.2, JSON.stringify(result.audio.coverage));
  const pcm = captured!.subarray(44);
  assert.ok(pcm.subarray(0, 8000).every(byte => byte === 0), 'leading timeline gap is silence, not shifted speech');
  assert.ok(pcm.subarray(20000).some(byte => byte !== 0));
});

test('audio errors remain partial with usable visual output and never choose a different backend', async t => {
  const f = await fixture(t); let localCalls = 0;
  f.app.audio = engine({ local: { async start() {}, status: () => ({ ready: false }) as any, async prepare() {}, async stop() {},
    async transcribe() { localCalls++; throw Error('must not run'); } } }, { ...audioDefaults, speechBackend: 'cloud' }).app;
  const ref = await offer(f.app, await movie(f.dir), 'video/mp4');
  const result = await f.app.understand({ sessionId: 'session-a', mediaRef: ref.mediaRef });
  assert.equal(result.status, 'partial'); assert.ok(result.visual!.images.length);
  assert.equal(result.audio.status, 'failed'); assert.equal(result.audio.tasks[0].code, 'audio_model_required');
  assert.equal(localCalls, 0); assert.ok(!JSON.stringify(result).includes('secret-connection-marker'));
  const still = await offer(f.app, await png());
  assert.equal((await f.app.understand({ sessionId: 'session-a', mediaRef: still.mediaRef })).audio.status, 'not_requested');
  assert.equal((await f.app.understand({ sessionId: 'session-a', mediaRef: still.mediaRef, audio: ['speech'] })).audio.status, 'no_audio');
});

test('audio ranges and conflicting options are rejected before running any backend', async t => {
  const f = await fixture(t); let calls = 0;
  f.app.audio = engine({ music: async () => { calls++; return {}; } }).app;
  const ref = await offer(f.app, wav(2), 'audio/wav');
  for (const options of [{ audio: ['unknown'] }, { audio: [] }, { fromSeconds: NaN }, { fromSeconds: 2, toSeconds: 1 }, { atSeconds: 0, audio: ['speech'] }, { visual: 'yes' }])
    await assert.rejects(f.app.understand({ sessionId: 'session-a', mediaRef: ref.mediaRef, ...options } as any), { code: 'invalid_input' });
  assert.equal(calls, 0);
  assert.throws(() => audioRange({ ...ref.info, durationSeconds: 120 }, { toSeconds: 61 }), { code: 'invalid_input' });
  assert.deepEqual(audioRange({ ...ref.info, durationSeconds: 120 }, {}), { fromSeconds: 0, toSeconds: 30, nextFromSeconds: 30 });
});

test('local speech and music share one queue; a cancelled queued request is never started', async t => {
  let finish!: () => void, entered!: () => void, active = 0, peak = 0, speechCalls = 0, musicCalls = 0;
  const started = new Promise<void>(r => entered = r), gate = new Promise<void>(r => finish = r);
  const { app } = engine({ local: { async start() {}, status: () => ({ ready: true }) as any, async prepare() {}, async stop() {},
    async transcribe() { speechCalls++; active++; peak = Math.max(active, peak); entered(); await gate; active--; return speech(); } },
    async music() { musicCalls++; active++; peak = Math.max(active, peak); active--; return { rhythm: { text: 'estimated', timing: 'clip', warnings: [] } }; } });
  t.after(() => app.stop());
  const first = app.analyze(wav(), ['speech'], 0, 1, signal()); await started;
  const controller = new AbortController();
  const cancelled = app.analyze(wav(), ['speech'], 0, 1, controller.signal);
  const rejected = assert.rejects(cancelled); controller.abort(); await rejected;
  const next = app.analyze(wav(), ['rhythm'], 0, 1, signal());
  assert.equal(musicCalls, 0); finish(); await Promise.all([first, next]);
  assert.equal(speechCalls, 1); assert.equal(musicCalls, 1); assert.equal(peak, 1);
});

test('release and expiry discard late audio results and clean the media after use', async t => {
  for (const mode of ['release', 'expire']) {
    let now = Date.now(), entered!: () => void, finish!: () => void;
    const started = new Promise<void>(r => entered = r), gate = new Promise<void>(r => finish = r);
    const f = await fixture(t, { ttlSeconds: 30 }, () => now);
    f.app.audio = engine({ local: { async start() {}, status: () => ({ ready: true }) as any, async prepare() {}, async stop() {},
      async transcribe() { entered(); await gate; return speech(); } } }).app;
    const ref = await offer(f.app, wav(), 'audio/wav');
    const request = f.app.understand({ sessionId: 'session-a', mediaRef: ref.mediaRef });
    const rejected = assert.rejects(request, { code: 'media_unavailable' }); await started;
    if (mode === 'release') await f.app.release({ sessionId: 'session-a', mediaRef: ref.mediaRef });
    else { now += 31_000; await f.app.store.sweep(); }
    finish(); await rejected;
    assert.deepEqual(await readdir(f.app.store.root), []);
  }
});

test('caller cancellation aborts a running audio job and no transcript is returned', async t => {
  const f = await fixture(t); let entered!: () => void, aborted = false;
  const started = new Promise<void>(r => entered = r);
  f.app.audio = engine({ local: { async start() {}, status: () => ({ ready: true }) as any, async prepare() {}, async stop() {},
    async transcribe(_wav, s) { entered(); await new Promise<void>((_r, reject) => s.addEventListener('abort', () => { aborted = true; reject(new Error('private backend diagnostics')); }, { once: true })); return speech(); } } }).app;
  const ref = await offer(f.app, wav(), 'audio/wav'), controller = new AbortController();
  const pending = f.app.understand({ sessionId: 'session-a', mediaRef: ref.mediaRef }, { signal: controller.signal });
  const rejected = assert.rejects(pending, { code: 'cancelled' }); await started; controller.abort(); await rejected;
  assert.equal(aborted, true);
});

test('oversized evidence is explicitly truncated, source offsets apply once, and invalid segments fail', async t => {
  const local = { async start() {}, status: () => ({ ready: true }) as any, async prepare() {}, async stop() {}, async transcribe() { return speech(); } };
  const { app } = engine({ local }); t.after(() => app.stop());
  assert.equal((await app.analyze(wav(), ['speech'], 12, 1, signal()))[0].evidence!.segments![0].startSeconds, 12.1);
  local.transcribe = async () => ({ text: '中'.repeat(10000), timing: 'segment', segments: [{ startSeconds: 0, endSeconds: 1, text: '中'.repeat(10000) }], warnings: [] });
  const evidence = (await app.analyze(wav(), ['speech'], 0, 1, signal()))[0].evidence!;
  assert.ok(Buffer.byteLength(JSON.stringify(evidence)) < 6 * 1024); assert.equal(evidence.segments, undefined);
  assert.equal(evidence.timing, 'clip'); assert.match(evidence.warnings[0], /截断/); assert.ok(!evidence.text.includes('\ufffd'));
  local.transcribe = async () => ({ ...speech(), segments: [{ startSeconds: 0, endSeconds: 10, text: 'bad' }] });
  assert.equal((await app.analyze(wav(), ['speech'], 0, 1, signal()))[0].code, 'invalid_audio_result');
  local.transcribe = async () => { throw new VisionError('local_resources_required', '请准备资源'); };
  assert.equal((await app.analyze(wav(), ['speech'], 0, 1, signal()))[0].code, 'local_resources_required');
});

test('audio settings default locally, retain explicit model selections, and reject invalid values', () => {
  assert.equal(configOf({}).audio, undefined);
  assert.deepEqual(configOf({ audio: {} }).audio, audioDefaults);
  assert.deepEqual(configOf({ audio: { speechBackend: 'cloud', speechModelId: ' stt ', understandingModelId: 'omni' } }).audio,
    { ...audioDefaults, speechBackend: 'cloud', speechModelId: 'stt', understandingModelId: 'omni' });
  for (const audio of [{ speechBackend: 'auto' }, { musicBackend: 'auto' }, { speechModelId: 'bad\nvalue' }, { understandingModelId: 'x'.repeat(201) }])
    assert.throws(() => configOf({ audio }), { code: 'invalid_config' });
});

test('default-length music evidence keeps real candidates and uncertainty when details are bounded', async t => {
  const pcm = Buffer.alloc(30 * 32000);
  for (let i = 0; i < pcm.length / 2; i++) pcm.writeInt16LE(Math.round([261.626, 329.628, 391.995].reduce((sum, hz) => sum + Math.sin(i * hz * 2 * Math.PI / 16000), 0) * 4000), i * 2);
  const { app } = engine(); t.after(() => app.stop());
  const results = await app.analyze(pcmWav(pcm), ['chords'], 10, 30, signal());
  assert.equal(results[0].status, 'completed');
  const evidence = results[0].evidence!;
  assert.ok(Buffer.byteLength(JSON.stringify(evidence)) <= 6 * 1024);
  assert.match(JSON.stringify(evidence.details), /C:maj/);
  assert.match(evidence.warnings.join(' '), /截断/);
  assert.ok(evidence.warnings.length > 1, 'algorithm uncertainty is preserved alongside truncation warning');
  assert.equal(evidence.details!.timeOrigin, 'clip_start');
  for (let i = 0; i < pcm.length / 2; i++) {
    const frequency = Math.floor(i / 8000) % 2 ? 523.251 : 440;
    pcm.writeInt16LE(Math.round(Math.sin(i * frequency * 2 * Math.PI / 16000) * 12000), i * 2);
  }
  const melody = (await app.analyze(pcmWav(pcm), ['melody'], 10, 30, signal()))[0].evidence!;
  assert.ok(Buffer.byteLength(JSON.stringify(melody)) <= 6 * 1024);
  assert.ok(Array.isArray(melody.details!.notes) && melody.details!.notes.length > 0);
  assert.ok(melody.segments!.length > 0 && melody.segments!.length <= 8);
  assert.ok(melody.segments![0].startSeconds >= 10, 'retained note segments still use original-media timing');
});
