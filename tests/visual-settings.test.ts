import { test } from 'node:test';
import assert from 'node:assert/strict';
import { configOf, defaults, visualDefaults, visualSettingsOf } from '../src/types.ts';
import { screenDefaults } from '../src/screen.ts';
import { registerScreenTool } from '../src/screen-tool.ts';
import { registerViewTool } from '../src/view-tool.ts';
import { registerUnderstandTool } from '../src/understand-tool.ts';
import { VisionError } from '../src/types.ts';
import type { Context } from 'whalelife';
import type { Vision } from '../src/runtime.ts';

test('visual and screen settings preserve old defaults and reject invalid bounded choices', () => {
  assert.deepEqual(configOf({}), defaults);
  assert.deepEqual(configOf({ visual: {}, screen: {} }), { ...defaults, visual: visualDefaults, screen: screenDefaults });
  for (const visual of [{ detail: 'ultra' }, { layout: 'grid' }, { focus: 'last' }, { maxFrames: 1 }, { maxFrames: 9 }, { maxFrames: 2.5 }, { sampleFps: 3 }, { sampleFps: '2' }]) {
    assert.throws(() => visualSettingsOf(visual));
  }
  for (const screen of [{ enabled: 'true' }, { target: 'all' }, { seconds: 61 }, { seconds: NaN }]) assert.throws(() => configOf({ screen }));
  const configured = configOf({ audio: { speechBackend: 'cloud', speechModelId: 'fixture', resourceProxyUrl: 'http://127.0.0.1:7890' }, visual: { focus: 'auto' }, screen: { enabled: true } });
  assert.equal(configured.audio?.speechModelId, 'fixture');
  assert.equal(configured.audio?.resourceProxyUrl, 'http://127.0.0.1:7890/');
  assert.equal(configured.visual?.focus, 'auto'); assert.equal(configured.screen?.enabled, true);
});

function registry() {
  const tools = new Map<string, any>();
  const ctx = { tools: { registerMultimodal: (tool: any) => tools.set(tool.name, tool) } } as unknown as Context;
  return { tools, ctx };
}

test('both existing visual tools forward new preferences and use only the trusted session', async () => {
  const { tools, ctx } = registry(), calls: any[] = [], signal = new AbortController().signal;
  const fake = { prepare: async (input: unknown, options: unknown) => { calls.push({ input, options }); throw new VisionError('synthetic', 'Synthetic failure'); },
    understand: async (input: unknown, options: unknown) => { calls.push({ input, options }); throw new VisionError('synthetic', 'Synthetic failure'); } } as unknown as Vision;
  registerViewTool(ctx, fake); registerUnderstandTool(ctx, fake);
  for (const name of ['vision_view', 'media_understand']) {
    await tools.get(name).run({ sessionId: 'untrusted-override', mediaRef: 'fixture', focus: 'auto', maxFrames: 4, sampleFps: 6 }, { id: 'trusted', signal });
    const call = calls.at(-1);
    assert.equal(call.input.sessionId, 'trusted'); assert.equal(call.options.signal, signal);
    assert.equal(call.input.focus, 'auto'); assert.equal(call.input.maxFrames, 4); assert.equal(call.input.sampleFps, 6);
  }
});

test('screen tool returns native transient images, keeps receipt minimal and requires a trusted session', async () => {
  const { tools, ctx } = registry(), calls: any[] = [], signal = new AbortController().signal;
  const fake = { captureScreen: async (input: unknown, options: unknown) => { calls.push({ input, options }); return {
    mode: 'snapshot', target: 'window', detail: 'detail', coverage: { selectedTimes: [0] }, warnings: ['Synthetic fixture'],
    images: [{ mime: 'image/jpeg', base64: Buffer.from('synthetic-image-only').toString('base64'), width: 3, height: 2,
      frames: [{ index: 1, atSeconds: 0, reason: 'snapshot', rect: { x: 0, y: 0, width: 3, height: 2 } }] }],
  }; } } as unknown as Vision;
  assert.equal(registerScreenTool(ctx, fake), true);
  const tool = tools.get('screen_view');
  const missing = await tool.run({ mode: 'snapshot', sessionId: 'model-value' }, {});
  assert.equal(missing.receipt.code, 'invalid_session'); assert.equal(calls.length, 0);
  const result = await tool.run({ mode: 'snapshot', target: 'window', sessionId: 'model-value' }, { id: 'trusted', signal });
  assert.equal(calls.length, 1); assert.equal(calls[0].options.signal, signal);
  assert.equal(calls[0].input.sessionId, undefined);
  assert.equal(result.content[1].type, 'image'); assert.equal(Buffer.from(result.content[1].data).toString(), 'synthetic-image-only');
  assert.equal(result.content[1].detail, 'high');
  assert.deepEqual(result.receipt, { action: 'view_screen', outcome: 'prepared', mode: 'snapshot', target: 'window', images: 1 });
  assert.equal(registerScreenTool({ tools: {} } as Context, fake), false, 'old host is not downgraded to a base64 JSON tool');
});
