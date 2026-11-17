import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import type { Context, MultimodalToolOutput, ToolDefinition, ToolSession } from 'whalelife';
import type { Vision } from '../src/runtime.ts';
import type { CallOptions, PreparedMedia } from '../src/types.ts';
import { VisualToolScope } from '../src/visual-tool-scope.ts';
import { registerVisualTool } from '../src/visual-route.ts';
import { registerViewTool } from '../src/view-tool.ts';
import { registerUnderstandTool } from '../src/understand-tool.ts';
import { registerScreenTool } from '../src/screen-tool.ts';

type Output = MultimodalToolOutput<Record<string, unknown>>;
const SECRET = 'SYNTHETIC_OLD_VISUAL_DESCRIPTION';
const IMAGE = Buffer.from('SYNTHETIC_OLD_VISUAL_BYTES');
const session: ToolSession = { id: 'trusted-session', permission: 'full', personaId: 'fixture-persona' };
function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function output(images = true): Output {
  return { content: [{ type: 'text', text: SECRET }, ...(images ? [{ type: 'image' as const, mimeType: 'image/png' as const, data: IMAGE }] : [])],
    receipt: { action: 'fixture', outcome: 'prepared', description: SECRET } };
}
function tool(run: ToolDefinition<unknown, Output>['run']): ToolDefinition<unknown, Output> {
  return { name: 'fixture_visual', description: 'synthetic visual tool', schema: { type: 'object' }, danger: 'safe', run };
}
function assertCancelled(result: unknown, transient = false) {
  const value = result as { content: Output['content'] | { text: string }; receipt: Record<string, unknown> };
  assert.equal(value.receipt.outcome, 'failed'); assert.equal(value.receipt.code, 'cancelled');
  const text = transient ? (value.content as { text: string }).text : ((value.content as Output['content'])[0] as { text: string }).text;
  if (transient) assert.deepEqual(Object.keys(value.content), ['text']);
  else assert.deepEqual(value.content, [{ type: 'text', text }]);
  assert.equal(typeof text, 'string'); assert.equal(JSON.parse(text).code, 'cancelled');
  const wire = JSON.stringify(value);
  assert.match(wire, /cancelled/); assert.ok(!wire.includes(SECRET)); assert.ok(!wire.includes(IMAGE.toString()));
  assert.ok(!wire.includes(IMAGE.toString('base64'))); assert.doesNotMatch(wire, /"type":"image"|image_url/);
}
function registry(onRegister?: () => void) {
  const native = new Map<string, ToolDefinition<unknown, unknown>>();
  const transient = new Map<string, ToolDefinition<unknown, unknown>>();
  const disposed: string[] = [];
  function add<A, R>(map: Map<string, ToolDefinition<unknown, unknown>>, definition: ToolDefinition<A, R>) {
    map.set(definition.name, definition as ToolDefinition<unknown, unknown>);
    onRegister?.();
    return () => { disposed.push(definition.name); map.delete(definition.name); };
  }
  const tools: Pick<Context['tools'], 'registerMultimodal' | 'registerTransient'> = {
    registerMultimodal: definition => add(native, definition), registerTransient: definition => add(transient, definition),
  };
  return { ctx: { tools } as Context, native, transient, disposed };
}
function app(local: boolean): Vision {
  return { config: { visualUnderstanding: { backend: local ? 'ollama' : 'main', modelId: 'fixture', maxTokens: 512 } } } as Vision;
}

test('scope preserves a live tool result and trusted session fields while composing cancellation', async t => {
  const scope = new VisualToolScope(); t.after(() => scope.stop());
  const controller = new AbortController(), result = output(), args = { question: 'synthetic' };
  const originalSession = { ...session, signal: controller.signal, transientContext: true };
  const original = tool((received, current) => {
    assert.equal(received, args); assert.equal(current.id, session.id); assert.equal(current.personaId, session.personaId);
    assert.equal(current.permission, 'full'); assert.equal(current.transientContext, true);
    assert.notEqual(current.signal, controller.signal); assert.equal(current.signal?.aborted, false);
    assert.equal(originalSession.signal, controller.signal);
    return result;
  });
  const wrapped = scope.wrap(original);
  assert.equal(wrapped.name, original.name); assert.equal(wrapped.schema, original.schema);
  assert.equal(await wrapped.run(args, originalSession), result);
});

test('close prevents deferred entry and retained old functions from entering the runtime', async () => {
  const scope = new VisualToolScope(); let calls = 0;
  const oldRun = scope.wrap(tool(() => { calls++; return output(); })).run;
  const queued = oldRun({}, session);
  scope.close();
  assertCancelled(await queued); assertCancelled(await oldRun({}, session));
  await scope.stop(); assert.equal(calls, 0);
});

test('close synchronously revokes entries and stop waits for an uncooperative run before discarding its images', async t => {
  const scope = new VisualToolScope(), started = deferred(), finish = deferred<Output>();
  t.after(async () => { finish.resolve(output()); await scope.stop(); });
  let signal: AbortSignal | undefined, disposed = 0, stopped = false;
  scope.add(() => { disposed++; });
  const pending = scope.wrap(tool((_args, current) => { signal = current.signal; started.resolve(); return finish.promise; })).run({}, session);
  await started.promise;
  const stopping = scope.stop().then(() => { stopped = true; });
  assert.equal(signal?.aborted, true); assert.equal(disposed, 1);
  await setImmediate(); assert.equal(stopped, false);
  scope.close(); assert.equal(disposed, 1);
  finish.resolve(output()); assertCancelled(await pending); await stopping;
  assert.equal(stopped, true);
});

test('caller cancellation suppresses late output and never cancels another call in the scope', async t => {
  const scope = new VisualToolScope(), started = deferred(), finish = deferred<Output>(), caller = new AbortController();
  t.after(async () => { finish.resolve(output()); await scope.stop(); });
  let observed: AbortSignal | undefined;
  const wrapped = scope.wrap(tool((_args, current) => { observed = current.signal; started.resolve(); return finish.promise; }));
  const pending = wrapped.run({}, { ...session, signal: caller.signal });
  await started.promise; caller.abort(); assert.equal(observed?.aborted, true);
  finish.resolve(output()); assertCancelled(await pending);
  const live = await scope.wrap(tool(() => output())).run({}, session);
  assert.equal(live.receipt?.outcome, 'prepared');
  let calls = 0;
  assertCancelled(await scope.wrap(tool(() => { calls++; return output(); })).run({}, { ...session, signal: caller.signal }));
  assert.equal(calls, 0);
});

test('late rejection after closure is a safe cancellation result, not an escaping host fault', async t => {
  const scope = new VisualToolScope(), started = deferred(), finish = deferred<Output>();
  t.after(async () => { finish.resolve(output()); await scope.stop(); });
  const pending = scope.wrap(tool(() => { started.resolve(); return finish.promise; })).run({}, session);
  await started.promise; const stopping = scope.stop();
  finish.reject(new Error(SECRET)); assertCancelled(await pending); await stopping;
});

test('stop tracks every invocation across separate preparation and description awaits', async t => {
  const scope = new VisualToolScope(), prepared = deferred(), described = deferred<Output>(), entered = deferred();
  const second = deferred<Output>(), secondEntered = deferred(); let finished = false;
  t.after(async () => { prepared.resolve(); described.resolve(output(false)); second.resolve(output()); await scope.stop(); });
  const first = scope.wrap(tool(async () => { await prepared.promise; entered.resolve(); return await described.promise; })).run({}, session);
  const other = scope.wrap(tool(() => { secondEntered.resolve(); return second.promise; })).run({}, session);
  prepared.resolve(); await Promise.all([entered.promise, secondEntered.promise]);
  const stopping = scope.stop().then(() => { finished = true; });
  described.resolve(output(false)); assertCancelled(await first);
  await setImmediate(); assert.equal(finished, false, 'the second complete invocation is still running');
  second.resolve(output()); assertCancelled(await other); await stopping;
});

test('the local projection is inside the scope and a close during projection replaces the whole result', async () => {
  const scope = new VisualToolScope(); let converted = 0;
  const wrapped = scope.wrap(tool(() => output(false)), value => {
    converted++;
    if (value.receipt?.code !== 'cancelled') scope.close();
    return { content: { text: value.content.map(part => part.type === 'text' ? part.text : '').join('\n') }, receipt: value.receipt };
  });
  assertCancelled(await wrapped.run({}, session), true); await scope.stop(); assert.equal(converted, 2);
});

test('one failed disposer does not skip other entries or abort cleanup; stop reports only a safe error', async () => {
  const scope = new VisualToolScope(); const calls: number[] = [];
  scope.add(() => { calls.push(1); throw new Error(SECRET); }); scope.add(() => { calls.push(2); });
  assert.doesNotThrow(() => scope.close());
  scope.add(() => { calls.push(3); });
  assert.deepEqual(calls, [1, 2, 3]);
  await assert.rejects(scope.stop(), error => error instanceof Error && /撤销失败/.test(error.message) && !error.message.includes(SECRET));
});

for (const local of [false, true]) {
  test(`${local ? 'local' : 'main'} registration tracks its disposer and rejects a retained function after closure`, async () => {
    const scope = new VisualToolScope(), f = registry(); let calls = 0;
    const definition = tool(() => { calls++; return output(!local); });
    assert.equal(registerVisualTool(f.ctx, app(local), definition, scope), true);
    const entries = local ? f.transient : f.native;
    const old = entries.get(definition.name)!;
    const live = await old.run({}, session); assert.match(JSON.stringify(live), new RegExp(SECRET));
    scope.close(); assert.equal(entries.size, 0); assert.deepEqual(f.disposed, [definition.name]);
    assertCancelled(await old.run({}, session), local); await scope.stop(); assert.equal(calls, 1);
  });

  test(`${local ? 'local' : 'main'} registration disposal handles closure during registration itself`, async () => {
    const scope = new VisualToolScope(), f = registry(() => scope.close());
    registerVisualTool(f.ctx, app(local), tool(() => output(!local)), scope);
    assert.equal(f.native.size + f.transient.size, 0); assert.deepEqual(f.disposed, ['fixture_visual']); await scope.stop();
  });

  for (const [name, register] of [['vision_view', registerViewTool], ['media_understand', registerUnderstandTool], ['screen_view', registerScreenTool]] as const) {
    test(`${name} forwards the scope to its ${local ? 'local' : 'main'} public route`, async () => {
      const scope = new VisualToolScope(), f = registry();
      assert.equal(register(f.ctx, app(local), scope), true);
      const old = (local ? f.transient : f.native).get(name)!;
      scope.close(); assert.deepEqual(f.disposed, [name]);
      // The fixture has no runtime methods: this must fail before entering any old runtime.
      assertCancelled(await old.run({ mediaRef: 'synthetic-reference' }, session), local); await scope.stop();
    });
  }
}

test('real local view route keeps preparation, description and text transport in one pending call', async t => {
  const scope = new VisualToolScope(), f = registry(), prepared = deferred<PreparedMedia>(), describing = deferred(), described = deferred<{ backend: 'ollama'; text: string; truncated: boolean }>();
  t.after(async () => { described.resolve({ backend: 'ollama', text: SECRET, truncated: false }); await scope.stop(); });
  let seenSignal: AbortSignal | undefined, stopped = false;
  const runtime = Object.assign(app(true), {
    prepare: async () => prepared.promise,
    describeVisual: async (_images: unknown, _question: unknown, options: CallOptions) => {
      seenSignal = options.signal; describing.resolve(); return described.promise;
    },
  });
  registerViewTool(f.ctx, runtime, scope);
  const running = f.transient.get('vision_view')!.run({ mediaRef: 'vis_' + 'ab'.repeat(24) }, session);
  prepared.resolve({ mediaRef: 'vis_' + 'ab'.repeat(24), images: [], coverage: {}, warnings: [], info: { kind: 'image' }, crop: null } as unknown as PreparedMedia);
  await describing.promise;
  const stopping = scope.stop().then(() => { stopped = true; });
  assert.equal(seenSignal?.aborted, true); await setImmediate(); assert.equal(stopped, false);
  described.resolve({ backend: 'ollama', text: SECRET, truncated: false });
  assertCancelled(await running, true); await stopping;
});

test('omitting the scope keeps native registration identity and the original caller signal', async () => {
  const f = registry(), controller = new AbortController();
  const definition = tool((_args, current) => { assert.equal(current.signal, controller.signal); return output(); });
  registerVisualTool(f.ctx, app(false), definition);
  assert.equal(f.native.get(definition.name), definition);
  await f.native.get(definition.name)!.run({}, { ...session, signal: controller.signal });
  const local = registry(); registerVisualTool(local.ctx, app(true), tool((_args, current) => {
    assert.equal(current.signal, controller.signal); return output(false);
  }));
  const result = await local.transient.get('fixture_visual')!.run({}, { ...session, signal: controller.signal });
  assert.match(JSON.stringify(result), new RegExp(SECRET)); assert.deepEqual(local.disposed, []);
});
