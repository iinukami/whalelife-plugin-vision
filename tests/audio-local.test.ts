/*! Copyright (c) 2026 iinukami and contributors.
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7: see LICENSE-ADDITIONAL.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { LocalSpeech, parseSenseVoiceSrt, runSenseVoiceProcess, senseVoiceExecutable, type LocalSpeechDependencies } from '../src/audio-local.ts';
import { temporaryDirectory } from './temporary-directory.ts';

const EXE = 'llama-funasr-sensevoice.exe';
const digest = (b: Buffer) => createHash('sha256').update(b).digest('hex');
function crc(b: Buffer) { let x = 0xffffffff; for (const v of b) { x ^= v; for (let n = 0; n < 8; n++) x = (x >>> 1) ^ ((x & 1) ? 0xedb88320 : 0); } return (x ^ 0xffffffff) >>> 0; }
function zip(entries = [{ name: `pkg/${EXE}`, bytes: Buffer.from('MZ fake executable') }]) {
  const locals: Buffer[] = [], central: Buffer[] = []; let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name), local = Buffer.alloc(30), record = Buffer.alloc(46);
    local.writeUInt32LE(0x04034b50); local.writeUInt16LE(20, 4); local.writeUInt32LE(crc(entry.bytes), 14);
    local.writeUInt32LE(entry.bytes.length, 18); local.writeUInt32LE(entry.bytes.length, 22); local.writeUInt16LE(name.length, 26);
    record.writeUInt32LE(0x02014b50); record.writeUInt16LE(20, 4); record.writeUInt16LE(20, 6);
    record.writeUInt32LE(crc(entry.bytes), 16); record.writeUInt32LE(entry.bytes.length, 20); record.writeUInt32LE(entry.bytes.length, 24);
    record.writeUInt16LE(name.length, 28); record.writeUInt32LE(offset, 42);
    locals.push(local, name, entry.bytes); central.push(record, name); offset += local.length + name.length + entry.bytes.length;
  }
  const c = Buffer.concat(central), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(c.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, c, end]);
}
function wav(seconds = 2) {
  const b = Buffer.alloc(44 + seconds * 32000); b.write('RIFF'); b.writeUInt32LE(b.length - 8, 4); b.write('WAVEfmt ', 8);
  b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(16000, 24);
  b.writeUInt32LE(32000, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(b.length - 44, 40);
  return b;
}
const speech = Buffer.from('1\n00:00:00,100 --> 00:00:01,500\n<|zh|><|NEUTRAL|><|Speech|><|withitn|>你好。\n\n');
test('production resource manifest constructs and checks without downloads', async t => {
  const tmp = await temporaryDirectory(t); let requests = 0;
  const local = new LocalSpeech(join(tmp.dir, 'missing'), new AbortController().signal, {
    platform: 'win32-x64', fetch: async () => { requests++; throw Error('must not download'); },
  });
  tmp.cleanup.push(() => local.stop()); await local.start();
  assert.equal(local.status().phase, 'missing'); assert.equal(local.status().totalBytes, 260887284);
  assert.equal(requests, 0); assert.deepEqual(await readdir(tmp.dir), []);
});

function fixture() {
  const bodies = new Map<string, Buffer>([['runtime.zip', zip()], ['sensevoice-small-q8.gguf', Buffer.from('fake q8 weights')], ['fsmn-vad.gguf', Buffer.from('fake vad')]]);
  const manifest = { id: 'sensevoice-test', model: 'synthetic model', assets: [...bodies].map(([name, body]) => ({
    name, url: `https://huggingface.co/test/resolve/fixed/${name}`, bytes: body.length, sha256: digest(body),
  })) };
  const calls: string[] = [];
  const fetcher: typeof fetch = async (input, options) => {
    assert.equal(options?.redirect, 'manual'); const url = String(input); calls.push(url);
    const body = bodies.get(url.split('/').at(-1)!)!;
    return new Response(new Uint8Array(body), { headers: { 'content-length': String(body.length) } });
  };
  return { bodies, manifest, calls, dependencies: { manifest, fetch: fetcher, platform: 'win32-x64', run: async () => speech } satisfies LocalSpeechDependencies };
}

test('local start only checks resources; preparation deduplicates and survives reload with verified assets', async t => {
  const tmp = await temporaryDirectory(t), root = join(tmp.dir, 'local'), f = fixture();
  const local = new LocalSpeech(root, new AbortController().signal, f.dependencies); tmp.cleanup.push(() => local.stop());
  await local.start(); assert.equal(local.status().phase, 'missing'); assert.equal(f.calls.length, 0);
  await assert.rejects(lstat(root), { code: 'ENOENT' });
  const first = local.prepare(), second = local.prepare(); assert.equal(first, second); await first;
  assert.equal(f.calls.length, 3); assert.equal(local.status().ready, true);
  assert.equal(local.status().downloadBytes, local.status().totalBytes);
  assert(!JSON.stringify(local.status()).includes(root));
  assert.deepEqual(await readdir(root), ['sensevoice-test']);
  const reload = new LocalSpeech(root, new AbortController().signal, f.dependencies); tmp.cleanup.push(() => reload.stop());
  await reload.start(); assert.equal(reload.status().ready, true); await reload.prepare(); assert.equal(f.calls.length, 3);
});

test('integrated local speech uses fixed CPU args, VAD times, and removes raw clip', async t => {
  const tmp = await temporaryDirectory(t), f = fixture(); let called = false;
  const local = new LocalSpeech(tmp.dir, new AbortController().signal, { ...f.dependencies,
    run: async (exe, args, signal) => {
      called = true; assert.equal(signal.aborted, false); assert(exe.endsWith(EXE));
      assert.equal(args[args.indexOf('--backend') + 1], 'cpu'); assert(args.includes('--srt')); assert(args.includes('--keep-tags'));
      assert.equal(args[args.indexOf('--vad-maxseg') + 1], '30000'); assert(!args.includes('--threads'));
      assert.deepEqual(await readFile(args[args.indexOf('-a') + 1]), wav()); return speech;
    } });
  tmp.cleanup.push(() => local.stop()); await local.prepare();
  const result = await local.transcribe(wav(), new AbortController().signal, 4);
  assert(called); assert.equal(result.text, '你好。'); assert.equal(result.timing, 'segment');
  assert.deepEqual(result.segments, [{ startSeconds: 0.1, endSeconds: 1.5, text: '你好。' }]);
  assert(result.warnings.some(s => s.includes('8 个 CPU'))); assert.deepEqual(await readdir(tmp.dir), ['sensevoice-test']);
});

test('start and prepare remove only exact owned orphan clips without downloads at startup', async t => {
  const tmp = await temporaryDirectory(t), f = fixture();
  const owned = join(tmp.dir, '.clip-12345678-abcd-4321-8abc-123456789abc');
  const unknown = join(tmp.dir, '.clip-not-owned'); await mkdir(unknown); await writeFile(join(unknown, 'keep.txt'), 'keep');
  await mkdir(owned); await writeFile(join(owned, 'input.wav'), wav());
  const local = new LocalSpeech(tmp.dir, new AbortController().signal, f.dependencies); tmp.cleanup.push(() => local.stop());
  await local.start(); assert.equal(local.status().phase, 'missing'); assert.equal(f.calls.length, 0);
  assert.deepEqual(await readdir(tmp.dir), ['.clip-not-owned']);
  await mkdir(owned); await writeFile(join(owned, 'input.wav'), wav()); await local.prepare();
  assert.deepEqual(await readdir(tmp.dir), ['.clip-not-owned', 'sensevoice-test']);
  assert.equal(await readFile(join(unknown, 'keep.txt'), 'utf8'), 'keep');
});

test('orphan cleanup refuses linked directories, linked input, or unknown contents', async t => {
  const tmp = await temporaryDirectory(t), outside = await temporaryDirectory(t), f = fixture();
  await writeFile(join(outside.dir, 'keep.txt'), 'keep');
  for (const mode of ['directory-link', 'input-link', 'unknown']) {
    const root = join(tmp.dir, mode); await mkdir(root);
    const clip = join(root, '.clip-12345678-abcd-4321-8abc-123456789abc');
    if (mode === 'directory-link') await symlink(outside.dir, clip, 'junction');
    else {
      await mkdir(clip);
      if (mode === 'input-link') await symlink(outside.dir, join(clip, 'input.wav'), 'junction');
      else await writeFile(join(clip, 'keep.txt'), 'keep');
    }
    const local = new LocalSpeech(root, new AbortController().signal, f.dependencies); tmp.cleanup.push(() => local.stop());
    await local.start(); assert.equal(local.status().phase, 'error');
    await assert.rejects(local.prepare(), { code: 'unsafe_storage' });
    assert.equal((await readdir(root)).length, 1); assert.equal(f.calls.length, 0);
  }
  assert.equal(await readFile(join(outside.dir, 'keep.txt'), 'utf8'), 'keep');
});

test('download checksum/size failures are redacted, atomically discarded, and retryable', async t => {
  const tmp = await temporaryDirectory(t), f = fixture();
  f.bodies.set('sensevoice-small-q8.gguf', Buffer.from('fake XX weights'));
  const local = new LocalSpeech(tmp.dir, new AbortController().signal, f.dependencies); tmp.cleanup.push(() => local.stop());
  await assert.rejects(local.prepare(), { code: 'local_resource_invalid' }); assert.equal(local.status().ready, false);
  assert.deepEqual(await readdir(tmp.dir), []); assert(!JSON.stringify(local.status()).includes('weights'));
  f.bodies.set('sensevoice-small-q8.gguf', Buffer.from('fake q8 weights'));
  await local.prepare(); assert.equal(local.status().ready, true);
});

test('tampered executable/model are detected without executing; explicit preparation repairs owned resources', async t => {
  const tmp = await temporaryDirectory(t), f = fixture(); let calls = 0;
  const local = new LocalSpeech(tmp.dir, new AbortController().signal, { ...f.dependencies, run: async () => { calls++; return speech; } });
  tmp.cleanup.push(() => local.stop()); await local.prepare();
  await writeFile(join(tmp.dir, 'sensevoice-test', EXE), Buffer.from('MZ altered binary!'));
  await assert.rejects(local.transcribe(wav(), new AbortController().signal), { code: 'local_resource_invalid' }); assert.equal(calls, 0);
  assert.equal(local.status().ready, false);
  await local.prepare(); assert.equal(local.status().ready, true); assert.deepEqual(await readdir(tmp.dir), ['sensevoice-test']);
  await writeFile(join(tmp.dir, 'sensevoice-test', 'fsmn-vad.gguf'), Buffer.from('changed!'));
  const reload = new LocalSpeech(tmp.dir, new AbortController().signal, f.dependencies); tmp.cleanup.push(() => reload.stop());
  await reload.start(); assert.equal(reload.status().ready, false); assert.equal(reload.status().phase, 'error');
});

test('download redirects only reach fixed public HTTPS hosts; network failures do not leak URLs or credentials', async t => {
  const tmp = await temporaryDirectory(t), f = fixture();
  const local = new LocalSpeech(tmp.dir, new AbortController().signal, { ...f.dependencies,
    fetch: async () => new Response(null, { status: 302, headers: { location: 'http://127.0.0.1/private?secret=hidden' } }) });
  tmp.cleanup.push(() => local.stop()); await assert.rejects(local.prepare(), { code: 'local_download_failed' });
  assert(!JSON.stringify(local.status()).includes('secret')); assert.deepEqual(await readdir(tmp.dir), []);
  const broken = new LocalSpeech(tmp.dir, new AbortController().signal, { ...f.dependencies,
    fetch: async () => { throw Error('secret API_KEY private C:/media.wav'); } });
  tmp.cleanup.push(() => broken.stop()); await assert.rejects(broken.prepare(), e => !String(e).includes('API_KEY'));
  assert(!JSON.stringify(broken.status()).includes('private'));
});

test('stop cancels preparation and cleans owned stage without touching existing unrelated files', async t => {
  const tmp = await temporaryDirectory(t), f = fixture(); await writeFile(join(tmp.dir, 'keep.txt'), 'keep');
  let entered!: () => void; const started = new Promise<void>(resolve => { entered = resolve; });
  const local = new LocalSpeech(tmp.dir, new AbortController().signal, { ...f.dependencies,
    fetch: async (_input, options) => { entered(); return await new Promise<Response>((_resolve, reject) => {
      options!.signal!.addEventListener('abort', () => reject(Error('private cancellation')), { once: true });
    }); } }); tmp.cleanup.push(() => local.stop());
  const work = local.prepare(); const rejection = assert.rejects(work, { code: 'cancelled' }); await started;
  await local.stop(); await rejection; assert.equal(local.status().phase, 'stopped'); assert.equal(local.status().ready, false);
  assert.deepEqual(await readdir(tmp.dir), ['keep.txt']); assert.equal(await readFile(join(tmp.dir, 'keep.txt'), 'utf8'), 'keep');
});

test('failed HTTP and exclusive file creation close streaming download responses', async t => {
  const tmp = await temporaryDirectory(t);
  for (const mode of ['http', 'disk']) {
    const root = join(tmp.dir, mode), f = fixture(); let cancelled = 0;
    const local = new LocalSpeech(root, new AbortController().signal, { ...f.dependencies,
      fetch: async () => {
        if (mode === 'disk') {
          const stage = (await readdir(root)).find(name => name.startsWith('.prepare-'))!;
          await writeFile(join(root, stage, 'runtime.zip'), 'synthetic exclusive-write failure');
        }
        return new Response(new ReadableStream<Uint8Array>({ cancel() { cancelled++; } }), { status: mode === 'http' ? 503 : 200 });
      } });
    tmp.cleanup.push(() => local.stop());
    await assert.rejects(local.prepare(), { code: 'local_download_failed' });
    assert.equal(cancelled, 1); assert.deepEqual(await readdir(root), []);
  }
});

test('cancellation drops late inference, busy rejects concurrent calls, and clip is removed', async t => {
  const tmp = await temporaryDirectory(t), f = fixture();
  let entered!: () => void, finish!: () => void; const started = new Promise<void>(r => { entered = r; });
  const local = new LocalSpeech(tmp.dir, new AbortController().signal, { ...f.dependencies,
    run: async () => { entered(); await new Promise<void>(r => { finish = r; }); return speech; } });
  tmp.cleanup.push(() => local.stop()); await local.prepare();
  const control = new AbortController(), work = local.transcribe(wav(), control.signal);
  const rejected = assert.rejects(work, { code: 'cancelled' }); await started;
  await assert.rejects(local.transcribe(wav(), new AbortController().signal), { code: 'busy' });
  await assert.rejects(local.prepare(), { code: 'busy' }); control.abort('sensitive'); finish(); await rejected;
  assert.deepEqual(await readdir(tmp.dir), ['sensevoice-test']);
});

test('unsupported OS and malformed, long, or stereo WAV never start inference or downloads', async t => {
  const tmp = await temporaryDirectory(t), f = fixture();
  const unsupported = new LocalSpeech(join(tmp.dir, 'linux'), new AbortController().signal, { ...f.dependencies, platform: 'linux-x64' });
  tmp.cleanup.push(() => unsupported.stop()); await unsupported.start(); assert.equal(unsupported.status().supported, false);
  await assert.rejects(unsupported.prepare(), { code: 'local_platform_unsupported' }); assert.equal(f.calls.length, 0);
  let called = false; const local = new LocalSpeech(join(tmp.dir, 'valid'), new AbortController().signal, { ...f.dependencies,
    run: async () => { called = true; return speech; } }); tmp.cleanup.push(() => local.stop());
  await assert.rejects(local.transcribe(wav(), new AbortController().signal), { code: 'local_not_ready' }); await local.prepare();
  const stereo = wav(); stereo.writeUInt16LE(2, 22);
  for (const b of [Buffer.from('not wav'), wav(61), stereo, wav().subarray(0, 50)])
    await assert.rejects(local.transcribe(b, new AbortController().signal), { code: 'invalid_audio' });
  assert.equal(called, false);
});

test('archive parser rejects traversal, links, duplicated executables, CRC corruption and ZIP bombs', () => {
  assert.equal(senseVoiceExecutable(zip()).toString(), 'MZ fake executable');
  for (const name of ['../outside.exe', '/outside.exe', 'C:/outside.exe', 'pkg/../outside.exe', 'pkg/NUL.exe'])
    assert.throws(() => senseVoiceExecutable(zip([{ name, bytes: Buffer.from('MZ') }])), { code: 'local_resource_invalid' });
  assert.throws(() => senseVoiceExecutable(zip([{ name: EXE, bytes: Buffer.from('MZ') }, { name: `pkg/${EXE}`, bytes: Buffer.from('MZ') }])), { code: 'local_resource_invalid' });
  const corrupt = zip(); corrupt[30 + Buffer.byteLength(`pkg/${EXE}`)] = 0; assert.throws(() => senseVoiceExecutable(corrupt));
  const link = zip(), central = link.readUInt32LE(link.length - 6); link.writeUInt32LE((0xa000 << 16) >>> 0, central + 38); assert.throws(() => senseVoiceExecutable(link));
  const bomb = zip(), center = bomb.readUInt32LE(bomb.length - 6); bomb.writeUInt32LE(200 * 1024 * 1024, center + 24); assert.throws(() => senseVoiceExecutable(bomb));
});

test('resource directories reject symlink escapes', async t => {
  const tmp = await temporaryDirectory(t), outside = await temporaryDirectory(t), f = fixture();
  const linked = join(tmp.dir, 'local'); await symlink(outside.dir, linked, 'junction');
  const local = new LocalSpeech(linked, new AbortController().signal, f.dependencies); tmp.cleanup.push(() => local.stop());
  await assert.rejects(local.prepare(), { code: 'unsafe_storage' }); assert.equal(f.calls.length, 0); assert.deepEqual(await readdir(outside.dir), []);
  const nested = new LocalSpeech(join(linked, 'new-child'), new AbortController().signal, f.dependencies); tmp.cleanup.push(() => nested.stop());
  await assert.rejects(nested.prepare(), { code: 'unsafe_storage' }); assert.deepEqual(await readdir(outside.dir), []);
});

test('SRT parser treats event tags as predictions and rejects fabricated/out-of-range time or excessive text', () => {
  const rich = parseSenseVoiceSrt(Buffer.from('1\n00:00:00,000 --> 00:00:01,000\n<|zh|><|HAPPY|><|Applause|>测试\n\n'), 2);
  assert.deepEqual(rich.events, ['掌声']); assert.equal(rich.text, '测试'); assert(!rich.text.includes('HAPPY')); assert(rich.warnings[0].includes('不是逐字'));
  const empty = parseSenseVoiceSrt(Buffer.from(''), 2); assert.equal(empty.text, ''); assert(empty.warnings.some(s => s.includes('不据此断言')));
  for (const value of ['unexpected stdout', '1\n00:00:00,000 --> 00:00:10,000\n文本', '1\n00:00:02,000 --> 00:00:01,000\n文本'])
    assert.throws(() => parseSenseVoiceSrt(Buffer.from(value), 2), { code: 'local_output_invalid' });
  assert.throws(() => parseSenseVoiceSrt(Buffer.from(`1\n00:00:00,000 --> 00:00:01,000\n${'字'.repeat(12001)}`), 2), { code: 'output_limit' });
});

test('real child-process boundary redacts stderr, catches zero-exit computation failure and limits output', async () => {
  const signal = new AbortController().signal;
  const data = await runSenseVoiceProcess(process.execPath, ['-e', "process.stderr.write('private path ignored');process.stdout.write('hello')"], signal);
  assert.equal(data.toString(), 'hello');
  await assert.rejects(runSenseVoiceProcess(process.execPath, ['-e', "process.stderr.write('compute failed C:/private.wav');process.stdout.write('not success')"], signal),
    e => (e as { code: string }).code === 'local_inference_failed' && !String(e).includes('private.wav'));
  await assert.rejects(runSenseVoiceProcess(process.execPath, ['-e', "process.stdout.write('x'.repeat(70000))"], signal), { code: 'output_limit' });
  const controller = new AbortController(); const work = runSenseVoiceProcess(process.execPath, ['-e', 'setInterval(()=>{},1000)'], controller.signal);
  controller.abort('private reason'); await assert.rejects(work, e => (e as { code: string }).code === 'cancelled' && !String(e).includes('private reason'));
});
