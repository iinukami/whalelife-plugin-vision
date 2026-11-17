import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { setImmediate } from 'node:timers/promises';
import { Vision } from '../src/runtime.ts';
import { defaults } from '../src/types.ts';
import { BundledDecoder } from '../src/decoder.ts';
import { LocalVision } from '../src/local-vision.ts';
import { AudioEngine } from '../src/audio-engine.ts';
import { temporaryDirectory } from './temporary-directory.ts';
import { png } from './helpers.ts';

function gate() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}

test('a failed media deletion can retry stop without reopening the runtime or completing before cleanup', { timeout: 10_000 }, async t => {
  const f = await temporaryDirectory(t);
  // The deliberately absent decoder keeps this image-only test independent of installed binaries.
  const app = new Vision(join(f.dir, 'media'), defaults, new AbortController().signal, undefined,
    new BundledDecoder(join(f.dir, 'absent-decoder')));
  f.cleanup.push(() => app.stop());
  app.localVision = new LocalVision(undefined, app.signal, () => { throw Error('No model connection is needed'); });
  app.audio = new AudioEngine(join(f.dir, 'audio'), undefined, app.signal, () => { throw Error('No model connection is needed'); });
  await app.start();
  const bytes = await png();
  const input = { sessionId: 'synthetic-stop-session', base64: bytes.toString('base64'), mime: 'image/png' };
  const offered = await app.offerMedia(input);
  const reference = { sessionId: input.sessionId, mediaRef: offered.mediaRef };
  const filename = offered.mediaRef + '.media';
  assert.deepEqual(await readdir(app.store.root), [filename]);

  // Exercise the real store sweep and real idle child resources, injecting only a temporary file-lock failure.
  const counts = { screen: 0, local: 0, audio: 0 };
  const screenStop = app.screen.stop.bind(app.screen), localStop = app.localVision.stop.bind(app.localVision), audioStop = app.audio.stop.bind(app.audio);
  app.screen.stop = async () => { counts.screen++; await screenStop(); };
  app.localVision.stop = async () => { counts.local++; await localStop(); };
  app.audio.stop = async () => { counts.audio++; await audioStop(); };
  const firstEntered = gate(), firstFailure = gate(), retryEntered = gate(), allowDelete = gate();
  const remove = app.store.removeFile.bind(app.store);
  let attempts = 0;
  f.cleanup.push(() => {
    app.store.removeFile = remove;
    firstFailure.release(); allowDelete.release();
  });
  app.store.removeFile = async path => {
    attempts++;
    if (attempts === 1) {
      firstEntered.release(); await firstFailure.promise;
      throw Object.assign(new Error('Synthetic transient media lock'), { code: 'EPERM' });
    }
    retryEntered.release(); await allowDelete.promise;
    await remove(path);
  };

  const first = app.stop();
  assert.equal(app.stop(), first, 'concurrent stop callers must share the same attempt');
  await firstEntered.promise;
  assert.equal(app.closed, true); assert.equal(app.signal.aborted, true);
  assert.equal(app.store.stopped, true); assert.equal(app.localVision.status().stopped, true); assert.equal(app.audio.signal.aborted, true);
  firstFailure.release(); await assert.rejects(first, { code: 'EPERM' });
  assert.equal(app.cleanupFailed, true);
  assert.deepEqual(await readdir(app.store.root), [filename], 'failed deletion remains available for cleanup retry');
  assert.equal(app.store.entries.size, 1);
  await assert.rejects(app.offerMedia(input), { code: 'stopped' });
  await assert.rejects(app.prepare(reference), { code: 'stopped' });
  await assert.rejects(app.describe(reference), { code: 'stopped' });
  await assert.rejects(app.start(), { name: 'AbortError' });

  const retry = app.stop(); let finished = false;
  assert.notEqual(retry, first, 'a failed stop must not poison all future cleanup attempts');
  assert.equal(app.stop(), retry, 'concurrent retry callers must also share the attempt');
  const completed = retry.then(() => { finished = true; });
  await retryEntered.promise; await setImmediate();
  assert.equal(finished, false, 'the replacement runtime must wait until cleanup really completes');
  assert.deepEqual(await readdir(app.store.root), [filename]);
  assert.deepEqual(counts, { screen: 2, local: 2, audio: 2 });
  allowDelete.release(); await completed;
  assert.deepEqual(await readdir(app.store.root), []); assert.equal(app.store.entries.size, 0);
  assert.equal(app.closed, true); assert.equal(app.signal.aborted, true);
  await assert.rejects(app.offerMedia(input), { code: 'stopped' });
  await assert.rejects(app.captureScreen({ mode: 'snapshot' }), { code: 'stopped' });
  assert.equal(app.stop(), retry, 'successful completion stays cached and idempotent');
  await app.stop(); assert.equal(attempts, 2); assert.deepEqual(counts, { screen: 2, local: 2, audio: 2 });
});
