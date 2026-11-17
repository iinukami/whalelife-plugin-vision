import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Context } from 'whalelife';
import type { Vision } from '../src/runtime.ts';
import { VisionError, type CallOptions, type PreparedMedia, type UnderstoodMedia } from '../src/types.ts';
import type { ScreenResult } from '../src/screen.ts';
import { registerViewTool } from '../src/view-tool.ts';
import { registerUnderstandTool } from '../src/understand-tool.ts';
import { registerScreenTool } from '../src/screen-tool.ts';
import { registerVisualTool } from '../src/visual-route.ts';

const IMAGE_BYTES = Buffer.from('SYNTHETIC_LOCAL_IMAGE_BYTES_NOT_FOR_MAIN_MODEL');
const IMAGE_BASE64 = IMAGE_BYTES.toString('base64');
const DESCRIPTION = 'SYNTHETIC_LOCAL_VISUAL_DESCRIPTION';
const TRANSCRIPT = 'SYNTHETIC_AUDIO_EVIDENCE';
const REF = 'vis_' + 'ab'.repeat(24);
const registrations = [
  ['vision_view', registerViewTool], ['media_understand', registerUnderstandTool], ['screen_view', registerScreenTool],
] as const;

function prepared(): PreparedMedia {
  return {
    mediaRef: REF, info: { kind: 'image', mime: 'image/png', width: 3, height: 2, durationSeconds: null, frameCount: null, hasAudio: false, timing: 'still' },
    images: [{ mime: 'image/jpeg', base64: IMAGE_BASE64, width: 3, height: 2,
      frames: [{ index: 1, atSeconds: null, reason: 'still', rect: { x: 0, y: 0, width: 3, height: 2 } }] }],
    coverage: { fromSeconds: null, toSeconds: null, nextFromSeconds: null, sampled: false, audioIncluded: false,
      sampleIntervalSeconds: null, selectedTimes: [], omittedCandidates: 0, timelineComplete: false },
    detail: 'detail', crop: null, warnings: ['Synthetic visual limitation'],
  };
}
function audiovisual(onlyAudio = false): UnderstoodMedia {
  const image = prepared();
  return { mediaRef: REF, info: { ...image.info, kind: onlyAudio ? 'audio' : 'video', mime: onlyAudio ? 'audio/wav' : 'video/mp4',
    hasAudio: true, durationSeconds: 2, timing: 'container' }, ...(onlyAudio ? {} : { visual: image }), status: 'completed',
  audio: { status: 'completed', coverage: { fromSeconds: 0, toSeconds: 2, nextFromSeconds: null },
    tasks: [{ task: 'speech', backend: 'local', status: 'completed', evidence: { text: TRANSCRIPT, timing: 'clip', warnings: [] } }] } };
}
function screen(): ScreenResult {
  return { mode: 'snapshot', target: 'window', detail: 'detail', images: prepared().images, warnings: ['Synthetic screen limitation'],
    coverage: { requestedSeconds: 0, fromSeconds: 0, toSeconds: 0, observedSeconds: 0, selectedTimes: [0], capturedFrames: 1,
      requestedSampleIntervalSeconds: null, startedAt: null, endedAt: null, timelineComplete: false, audioIncluded: false } };
}
function fixture(options: { main?: boolean; truncated?: boolean; fail?: Error; onlyAudio?: boolean } = {}) {
  const native = new Map<string, any>(), transient = new Map<string, any>(), ordinary = new Map<string, any>();
  const calls: { operation: string; input: any; options?: CallOptions; question?: string }[] = [];
  const ctx = { tools: {
    registerMultimodal: (tool: any) => native.set(tool.name, tool),
    registerTransient: (tool: any) => transient.set(tool.name, tool),
    register: (tool: any) => ordinary.set(tool.name, tool),
  } } as unknown as Context;
  const app = { config: options.main ? {} : { visualUnderstanding: { backend: 'ollama', modelId: 'fixture', maxTokens: 512 } },
    prepare: async (input: unknown, callOptions: CallOptions) => { calls.push({ operation: 'prepare', input, options: callOptions }); return prepared(); },
    understand: async (input: unknown, callOptions: CallOptions) => { calls.push({ operation: 'understand', input, options: callOptions }); return audiovisual(options.onlyAudio); },
    captureScreen: async (input: unknown, callOptions: CallOptions) => { calls.push({ operation: 'capture', input, options: callOptions }); return screen(); },
    describeVisual: async (images: unknown, question: string | undefined, callOptions: CallOptions) => {
      calls.push({ operation: 'describe', input: images, question, options: callOptions });
      if (options.fail) throw options.fail;
      callOptions.signal?.throwIfAborted();
      return { backend: 'ollama', text: DESCRIPTION, truncated: options.truncated ?? false, usage: { promptTokens: 5, outputTokens: 4 } };
    },
  } as unknown as Vision;
  return { ctx, app, native, transient, ordinary, calls };
}
function assertTextOnly(result: any) {
  assert.deepEqual(Object.keys(result.content), ['text']);
  assert.equal(typeof result.content.text, 'string');
  const wire = JSON.stringify(result);
  assert.ok(!wire.includes(IMAGE_BASE64)); assert.ok(!wire.includes(IMAGE_BYTES.toString()));
  assert.doesNotMatch(wire, /data:image\/|image_url|"base64"|"type":"image"/);
  assert.ok(!JSON.stringify(result.receipt).includes(DESCRIPTION));
  assert.ok(!JSON.stringify(result.receipt).includes(TRANSCRIPT));
}

for (const [name, register] of registrations) {
  test(`${name}: Ollama registers only a transient text route and forwards trusted session, signal and the bounded question`, async () => {
    const f = fixture(), signal = new AbortController().signal;
    assert.equal(register(f.ctx, f.app), true);
    assert.equal(f.transient.size, 1); assert.equal(f.native.size, 0); assert.equal(f.ordinary.size, 0);
    const tool = f.transient.get(name);
    const result = await tool.run({ mediaRef: REF, mode: 'snapshot', sessionId: 'model-cannot-set-this', question: '  Which synthetic color?  ' }, { id: 'trusted-session', signal });
    assertTextOnly(result); assert.match(result.content.text, new RegExp(DESCRIPTION));
    assert.match(result.content.text, /不是主模型亲眼查看原图/);
    const read = f.calls[0], local = f.calls[1];
    assert.equal(read.options?.signal, signal); assert.equal(local.options?.signal, signal);
    if (name === 'screen_view') assert.equal(read.input.sessionId, undefined);
    else assert.equal(read.input.sessionId, 'trusted-session');
    assert.equal(local.operation, 'describe'); assert.equal(local.question, 'Which synthetic color?');
    assert.equal(local.input[0].base64, IMAGE_BASE64, 'only the local adapter receives prepared image bytes');
    assert.equal(tool.schema.properties.question.maxLength, 1000);
  });

  test(`${name}: invalid question or missing trusted session never starts image preparation or local inference`, async () => {
    const f = fixture(); register(f.ctx, f.app);
    const tool = f.transient.get(name), session = { id: 'trusted-session', signal: new AbortController().signal };
    for (const question of ['x'.repeat(1001), 123, 'invalid\u0000question']) {
      const result = await tool.run({ mediaRef: REF, question }, session);
      assertTextOnly(result); assert.equal(result.receipt.outcome, 'failed'); assert.equal(result.receipt.code, 'invalid_input');
    }
    const missing = await tool.run({ mediaRef: REF, sessionId: 'model-provided' }, {});
    assertTextOnly(missing); assert.equal(missing.receipt.code, 'invalid_session');
    assert.equal(f.calls.length, 0);
    const valid = await tool.run({ mediaRef: REF, question: 'x'.repeat(1000) }, session);
    assertTextOnly(valid); assert.equal(f.calls.at(-1)!.question!.length, 1000);
  });

  test(`${name}: truncated local output is explicitly partial and never switches to image transport`, async () => {
    const f = fixture({ truncated: true }); register(f.ctx, f.app);
    const result = await f.transient.get(name).run({ mediaRef: REF }, { id: 'trusted-session', signal: new AbortController().signal });
    assertTextOnly(result); assert.equal(result.receipt.outcome, 'partial'); assert.equal(result.receipt.truncated, true);
    assert.match(result.content.text, /描述达到生成预算而截断/);
  });

  test(`${name}: unchanged main mode returns native images and never invokes a second visual model`, async () => {
    const f = fixture({ main: true }); register(f.ctx, f.app);
    assert.equal(f.native.size, 1); assert.equal(f.transient.size, 0); assert.equal(f.ordinary.size, 0);
    const result = await f.native.get(name).run({ mediaRef: REF }, { id: 'trusted-session', signal: new AbortController().signal });
    const image = result.content.find((part: any) => part.type === 'image');
    assert.ok(image); assert.deepEqual(Buffer.from(image.data), IMAGE_BYTES);
    assert.ok(!f.calls.some(call => call.operation === 'describe'));
  });
}

test('missing transient support disables all local visual tools without falling back to normal or multimodal tools', () => {
  const f = fixture(), called: string[] = [];
  const ctx = { tools: { registerMultimodal: () => called.push('multimodal'), register: () => called.push('ordinary') } } as unknown as Context;
  for (const [, register] of registrations) assert.equal(register(ctx, f.app), false);
  assert.deepEqual(called, []);
});

test('a broken local result containing a native image is rejected at the transport boundary', async () => {
  const f = fixture();
  registerVisualTool(f.ctx, f.app, { name: 'synthetic-broken-local-tool', danger: 'safe', description: 'Synthetic guard fixture', schema: {},
    async run() { return { content: [{ type: 'image', mimeType: 'image/jpeg', data: IMAGE_BYTES }], receipt: null }; } });
  await assert.rejects(f.transient.get('synthetic-broken-local-tool').run({}, {}), { code: 'local_vision_route' });
  assert.equal(f.native.size, 0); assert.equal(f.ordinary.size, 0);
});

test('Ollama failure never returns prepared images while audiovisual output preserves independently completed audio', async () => {
  for (const [name, register] of registrations) {
    const f = fixture({ fail: new VisionError('local_vision_unavailable', 'Synthetic local model unavailable') }); register(f.ctx, f.app);
    const result = await f.transient.get(name).run({ mediaRef: REF }, { id: 'trusted-session', signal: new AbortController().signal });
    assertTextOnly(result); assert.doesNotMatch(result.content.text, new RegExp(DESCRIPTION));
    if (name === 'media_understand') {
      assert.equal(result.receipt.outcome, 'partial'); assert.match(result.content.text, new RegExp(TRANSCRIPT));
      assert.match(result.content.text, /local_vision_unavailable/); assert.equal(result.receipt.images, 0);
    } else { assert.equal(result.receipt.outcome, 'failed'); assert.equal(result.receipt.code, 'local_vision_unavailable'); }
  }
});

test('audio-only media_understand never invokes local visual inference or emits native image content', async () => {
  const f = fixture({ onlyAudio: true }); registerUnderstandTool(f.ctx, f.app);
  const result = await f.transient.get('media_understand').run({ mediaRef: REF, visual: false, audio: ['speech'] },
    { id: 'trusted-session', signal: new AbortController().signal });
  assertTextOnly(result); assert.equal(result.receipt.outcome, 'completed'); assert.match(result.content.text, new RegExp(TRANSCRIPT));
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0].operation, 'understand');
  assert.equal(f.calls[0].input.visual, false);
});

test('cancelled local inference stays on the text route and does not reveal partial visual evidence', async () => {
  for (const [name, register] of registrations) {
    const f = fixture(); register(f.ctx, f.app);
    const controller = new AbortController(); controller.abort();
    const result = await f.transient.get(name).run({ mediaRef: REF }, { id: 'trusted-session', signal: controller.signal });
    assertTextOnly(result); assert.equal(result.receipt.outcome, 'failed'); assert.equal(result.receipt.code, 'cancelled');
    assert.doesNotMatch(result.content.text, new RegExp(DESCRIPTION + '|' + TRANSCRIPT));
  }
});
