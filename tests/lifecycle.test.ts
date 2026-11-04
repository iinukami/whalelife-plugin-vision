import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdir, writeFile, mkdir, symlink, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fixture, png, offer } from './helpers.ts';
import { temporaryDirectory } from './temporary-directory.ts';
import { Vision } from '../src/runtime.ts';
import { defaults } from '../src/types.ts';
import { runProcess } from '../src/process.ts';
test('session-bound refs cannot cross conversations or accept paths; release invalidates immediately', async t => {
  const f = await fixture(t), ref = await offer(f.app, await png());
  await assert.rejects(f.app.prepare({ sessionId: 'session-b', mediaRef: ref.mediaRef }), { code: 'media_unavailable' });
  await assert.rejects(f.app.describe({ sessionId: 'session-b', mediaRef: ref.mediaRef }), { code: 'media_unavailable' });
  await assert.rejects(f.app.describe({ sessionId: 'session-a', mediaRef: '../secret' }), { code: 'media_unavailable' });
  await f.app.release({ sessionId: 'session-a', mediaRef: ref.mediaRef });
  await assert.rejects(f.app.prepare({ sessionId: 'session-a', mediaRef: ref.mediaRef }), { code: 'media_unavailable' });
  assert.deepEqual(await readdir(f.app.store.root), []);
});
test('expiry rejects reads and sweep deletes bytes; restart never revives refs', async t => {
  let now = 1_800_000_000_000;
  const f = await fixture(t, { ttlSeconds: 30 }, () => now), ref = await offer(f.app, await png());
  now += 31_000;
  await assert.rejects(f.app.describe({ sessionId: 'session-a', mediaRef: ref.mediaRef }), { code: 'media_unavailable' });
  await f.app.store.sweep(); assert.deepEqual(await readdir(f.app.store.root), []);
  const next = await offer(f.app, await png());
  await f.app.stop(); await f.app.stop();
  assert.deepEqual(await readdir(f.app.store.root), []);
  const app = new Vision(f.app.store.root, defaults, new AbortController().signal);
  f.cleanup.push(() => app.stop()); await app.start();
  await assert.rejects(app.describe({ sessionId: 'session-a', mediaRef: next.mediaRef }), { code: 'media_unavailable' });
});
test('stale blobs are removed on start but unrelated files are preserved', async t => {
  const f = await temporaryDirectory(t), root = join(f.dir, 'media'); await mkdir(root);
  await writeFile(join(root, 'vis_' + 'a'.repeat(48) + '.media'), 'stale');
  await writeFile(join(root, 'keep.txt'), 'unrelated');
  const app = new Vision(root, defaults, new AbortController().signal); f.cleanup.push(() => app.stop()); await app.start();
  assert.deepEqual(await readdir(root), ['keep.txt']);
});
test('storage junction is refused without deleting target contents', async t => {
  const f = await temporaryDirectory(t), target = join(f.dir, 'target'), link = join(f.dir, 'link'); await mkdir(target);
  await writeFile(join(target, 'keep.txt'), 'preserve'); await symlink(target, link, process.platform === 'win32' ? 'junction' : 'dir');
  const app = new Vision(link, defaults, new AbortController().signal);
  await assert.rejects(app.start(), { code: 'unsafe_storage' });
  assert.equal(await readFile(join(target, 'keep.txt'), 'utf8'), 'preserve');
});
test('quota and cancellation do not evict another session or retain failed input', async t => {
  const f = await fixture(t), bytes = await png();
  for (let i = 0; i < 16; i++) await offer(f.app, bytes);
  await assert.rejects(offer(f.app, bytes), { code: 'quota' });
  const b = await offer(f.app, bytes, 'image/png', 'session-b');
  const controller = new AbortController(); controller.abort();
  await assert.rejects(f.app.prepare({ sessionId: 'session-b', mediaRef: b.mediaRef }, { signal: controller.signal }));
  assert.equal((await f.app.describe({ sessionId: 'session-b', mediaRef: b.mediaRef })).mediaRef, b.mediaRef);
  await f.app.stop(); assert.deepEqual(await readdir(f.app.store.root), []);
  await assert.rejects(offer(f.app, bytes), { code: 'stopped' });
});
test('decoder cancellation, deadline and output limits await child exit', async () => {
  const c = new AbortController();
  const task = runProcess(process.execPath, ['-e', 'setInterval(()=>{},1000)'], c.signal, 1000);
  const timer = setTimeout(() => c.abort(), 100);
  try { await assert.rejects(task, { code: 'cancelled' }); } finally { clearTimeout(timer); }
  await assert.rejects(runProcess(process.execPath, ['-e', 'setInterval(()=>{},1000)'], new AbortController().signal, 1000, 100), { code: 'decoder_timeout' });
  await assert.rejects(runProcess(process.execPath, ['-e', 'process.stdout.write("x".repeat(20000))'], new AbortController().signal, 1000), { code: 'output_limit' });
});
test('release while a read is pinned prevents late return, then removes original bytes', async t => {
  const f = await fixture(t), ref = await offer(f.app, await png());
  let started!: () => void, unblock!: () => void;
  const begin = new Promise<void>(r => { started = r; }), gate = new Promise<void>(r => { unblock = r; });
  const task = f.app.store.use('session-a', ref.mediaRef, new AbortController().signal, async () => { started(); await gate; return 'private-marker'; });
  await begin;
  await f.app.release({ sessionId: 'session-a', mediaRef: ref.mediaRef });
  unblock(); await assert.rejects(task, { code: 'media_unavailable' });
  assert.deepEqual(await readdir(f.app.store.root), []);
});
test('concurrent pending offers reserve per-session quota before asynchronous decoding', async t => {
  const f = await fixture(t), bytes = await png();
  for (let i = 0; i < 15; i++) await offer(f.app, bytes);
  let unblock!: () => void;
  const gate = new Promise<void>(r => { unblock = r; });
  const info = f.app.store.entries.values().next().value!.info;
  const pending = f.app.store.offer('session-a', bytes, async () => { await gate; return info; }, new AbortController().signal);
  try { await assert.rejects(f.app.store.offer('session-a', bytes, async () => info, new AbortController().signal), { code: 'quota' }); }
  finally { unblock(); await pending; }
  assert.equal(f.app.store.entries.size, 16);
});
test('arbitrary cancellation reasons and noncanonical base64 are not reflected', async t => {
  const f = await fixture(t), ref = await offer(f.app, await png());
  const c = new AbortController(); c.abort('private-cancellation-marker');
  await assert.rejects(f.app.prepare({ sessionId: 'session-a', mediaRef: ref.mediaRef }, { signal: c.signal }), e => {
    assert.ok(!String(e).includes('private-cancellation-marker')); return true;
  });
  await assert.rejects(f.app.offerMedia({ sessionId: 'session-a', mime: 'image/png', base64: 'AB==' }), { code: 'invalid_encoding' });
});
