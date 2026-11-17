import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdir } from 'node:fs/promises';
import type { Context } from 'whalelife';
import type { BundledDecoder } from '../src/decoder.ts';
import type { LocalVision } from '../src/local-vision.ts';
import type { CallOptions, PreparedImage } from '../src/types.ts';
import { registerViewTool } from '../src/view-tool.ts';
import { registerUnderstandTool } from '../src/understand-tool.ts';
import { fixture, offer, png } from './helpers.ts';

const SESSION = 'trusted-local-vision-session';
const DESCRIPTION = 'SYNTHETIC_LATE_LOCAL_DESCRIPTION_MUST_NOT_BE_DELIVERED';
const settings = { backend: 'ollama' as const, modelId: 'synthetic-local-model', maxTokens: 512 };
// PNG preparation needs no external decoder. Keep this regression independent
// of installed FFmpeg resources, Ollama, network, desktop and real models.
function decoder() {
  return { ready: false, async start() {}, status: () => ({ ready: false }) } as unknown as BundledDecoder;
}
function heldLocalModel() {
  let enter!: () => void, release!: () => void, calls = 0;
  const entered = new Promise<void>(resolve => { enter = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const model = {
    async describe(images: PreparedImage[], _question: string | undefined, signal: AbortSignal) {
      calls++; assert.equal(images.length, 1); assert.equal(images[0].mime, 'image/jpeg');
      enter(); await gate; signal.throwIfAborted();
      return { backend: 'ollama', text: DESCRIPTION, images: images.length, truncated: false };
    },
    async stop() { release(); },
  } as unknown as LocalVision;
  return { model, entered, release, calls: () => calls };
}

for (const [name, register] of [['vision_view', registerViewTool], ['media_understand', registerUnderstandTool]] as const) {
  for (const invalidation of ['release', 'expiry'] as const) {
    test(`${name}: ${invalidation} during local inference discards the late description and uses the trusted media scope`, { timeout: 10_000 }, async t => {
      let now = 1_800_000_000_000;
      const f = await fixture(t, { ttlSeconds: 30, visualUnderstanding: settings }, () => now, decoder());
      const local = heldLocalModel();
      // temporaryDirectory already registered teardown; release the gate before
      // fixture's app.stop() even if an assertion fails while inference is held.
      f.cleanup.push(() => local.release()); f.app.localVision = local.model;
      const ref = await offer(f.app, await png(), 'image/png', SESSION);
      const scopes: ({ sessionId: string; mediaRef: string } | undefined)[] = [];
      const describe = f.app.describeVisual.bind(f.app);
      f.app.describeVisual = (images, question, options, media) => {
        scopes.push(media); return describe(images, question, options, media);
      };
      let tool: any;
      const ctx = { tools: { registerTransient: (definition: unknown) => { tool = definition; } } } as unknown as Context;
      assert.equal(register(ctx, f.app), true);
      const pending = tool.run({ mediaRef: ref.mediaRef, sessionId: 'untrusted-model-override', question: 'Synthetic question' },
        { id: SESSION, signal: new AbortController().signal });
      await Promise.race([local.entered, pending.then(() => { throw Error('Tool finished before the held local inference'); })]);
      assert.deepEqual(scopes, [{ sessionId: SESSION, mediaRef: ref.mediaRef }]);
      assert.equal(local.calls(), 1); assert.equal(f.app.store.entries.get(ref.mediaRef)?.pins, 1);
      if (invalidation === 'release') await f.app.release({ sessionId: SESSION, mediaRef: ref.mediaRef });
      else { now += 31_000; await f.app.store.sweep(); }
      assert.equal((await readdir(f.app.store.root)).length, 1, 'the pinned original is retained until local work settles');
      local.release();
      const result = await pending;
      assert.equal(result.receipt.outcome, 'failed');
      assert.equal(typeof result.content.text, 'string'); assert.match(result.content.text, /media_unavailable/);
      assert.doesNotMatch(JSON.stringify(result), new RegExp(DESCRIPTION));
      assert.doesNotMatch(JSON.stringify(result), /data:image\/|"base64"|"type":"image"/);
      assert.equal(f.app.pending.size, 0); assert.deepEqual(await readdir(f.app.store.root), []);
    });
  }
}

test('a cross-session or already released scope fails before local inference starts', async t => {
  const f = await fixture(t, { visualUnderstanding: settings }, undefined, decoder());
  const local = heldLocalModel(); f.cleanup.push(() => local.release()); f.app.localVision = local.model;
  const ref = await offer(f.app, await png(), 'image/png', SESSION);
  const prepared = await f.app.prepare({ sessionId: SESSION, mediaRef: ref.mediaRef });
  const options: CallOptions = { signal: new AbortController().signal };
  await assert.rejects(f.app.describeVisual(prepared.images, undefined, options,
    { sessionId: 'different-session', mediaRef: ref.mediaRef }), { code: 'media_unavailable' });
  await f.app.release({ sessionId: SESSION, mediaRef: ref.mediaRef });
  await assert.rejects(f.app.describeVisual(prepared.images, undefined, options,
    { sessionId: SESSION, mediaRef: ref.mediaRef }), { code: 'media_unavailable' });
  assert.equal(local.calls(), 0); assert.deepEqual(await readdir(f.app.store.root), []);
});
