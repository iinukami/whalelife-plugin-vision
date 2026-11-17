import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { OllamaManager, OLLAMA_MODEL } from '../src/ollama-manager.ts';
import { LocalVision, localVisionSettingsOf } from '../src/local-vision.ts';
import { temporaryDirectory } from './temporary-directory.ts';

async function settled(manager: OllamaManager) {
  const end = Date.now() + 3000;
  while (manager.status().busy && Date.now() < end) await delay(1);
  assert.equal(manager.status().busy, false, 'setup action should settle');
}
async function fixture(t: Parameters<typeof temporaryDirectory>[0], initial: { installed?: boolean; external?: boolean; model?: boolean } = {}) {
  const temp = await temporaryDirectory(t);
  let installed = !!initial.installed, external = !!initial.external, model = !!initial.model, owned = false, running = false;
  const calls: { url: string; body?: any }[] = [], lifecycle: string[] = [];
  const controls = { blockPull: false, badPull: false, badModel: false, inspectFails: false, partialPull: false, stopped: false, closeFailure: false,
    showFails: false, blockOwnedProbe: false, stopFailure: false, installCleanupFailure: false, pullText: undefined as string | undefined };
  const response = (body: unknown) => new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } });
  const manager = new OllamaManager(temp.dir, new AbortController().signal, {
    supported: true,
    installer: {
      inspect: async () => { if (controls.inspectFails) throw Error('synthetic failure'); return { installed, ...(installed ? { runtimeVersion: '0.40.16' } : {}) }; },
      prepare: async (signal, progress) => {
        signal.throwIfAborted(); lifecycle.push('install');
        if (controls.installCleanupFailure) await new Promise<void>((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(Error('SYNTHETIC_PRIVATE_TEMP_PATH cleanup failed')), { once: true });
        });
        progress?.({ phase: 'downloading_runtime', downloadedBytes: 10, totalBytes: 20 }); installed = true;
      },
      executable: async signal => { assert.ok(signal instanceof AbortSignal, 'verification must receive this action cancellation signal'); if (!installed) throw Error('not installed'); return 'synthetic-verified-ollama.exe'; },
    },
    process: {
      start: async () => { lifecycle.push('start'); owned = true; running = true; }, stop: async () => {
        lifecycle.push('stop'); running = false;
        if (controls.stopFailure) throw Error('SYNTHETIC_PRIVATE_PROCESS cleanup failed');
        owned = false;
      },
      running: () => running, owned: () => owned, close: async () => { lifecycle.push('close'); if (controls.closeFailure) { controls.closeFailure = false; throw Error('synthetic close failure'); } owned = false; running = false; controls.stopped = true; },
    },
    fetch: (async (url: any, options: any) => {
      const parsed = new URL(String(url)); const body = options.body ? JSON.parse(options.body) : undefined;
      calls.push({ url: parsed.href, body });
      options.signal.throwIfAborted();
      if (!(parsed.port === '11435' ? running : external)) throw Error('not listening');
      if (parsed.port === '11435' && controls.blockOwnedProbe) return await new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true }));
      if (parsed.pathname === '/api/version') return response({ version: '0.40.16' });
      if (parsed.pathname === '/api/tags') return response({ models: model ? [{ name: OLLAMA_MODEL }] : [] });
      if (parsed.pathname === '/api/show') return controls.showFails ? new Response('SYNTHETIC_PRIVATE_MODEL failure', { status: 500 }) : response(controls.badModel ? { remote_host: 'synthetic-remote', capabilities: ['vision'] } : { capabilities: ['vision'] });
      if (parsed.pathname === '/api/pull') {
        if (controls.blockPull) return await new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true }));
        if (controls.badPull) return new Response('{"error":"private synthetic upstream detail"}\n');
        model = true;
        if (controls.pullText !== undefined) {
          const bytes = new TextEncoder().encode(controls.pullText), middle = Math.floor(bytes.length / 2);
          return new Response(new ReadableStream({ start(controller) { controller.enqueue(bytes.slice(0, middle)); controller.enqueue(bytes.slice(middle)); controller.close(); } }));
        }
        return new Response(JSON.stringify({ status: 'pulling', digest: 'sha256:' + 'a'.repeat(64), total: 20, completed: 20 }) + '\n' + (controls.partialPull ? '' : '{"status":"success"}\n'));
      }
      throw Error('Unexpected endpoint: ' + parsed.pathname);
    }) as any,
  });
  temp.cleanup.push(() => manager.close());
  return { manager, calls, lifecycle, controls, exit: () => { owned = false; running = false; }, disconnect: () => { running = false; }, external: (value: boolean) => { external = value; } };
}

test('initialization and state polling never download, start or probe a service', async t => {
  const f = await fixture(t, { installed: true }); await f.manager.init();
  for (let i = 0; i < 10; i++) f.manager.status();
  assert.equal(f.manager.status().installed, true); assert.equal(f.manager.status().running, undefined);
  assert.deepEqual(f.calls, []); assert.deepEqual(f.lifecycle, []);
  assert.throws(() => f.manager.connection(), { code: 'ollama_not_ready' });
});
test('explicit prepare reuses an existing ready local model and cannot stop the other application', async t => {
  const f = await fixture(t, { external: true, model: true }); await f.manager.init();
  await f.manager.action('prepare'); await settled(f.manager);
  assert.equal(f.manager.status().phase, 'ready'); assert.equal(f.manager.status().owned, false);
  assert.deepEqual(f.lifecycle, []); assert.equal(f.calls.some(call => call.url.endsWith('/api/pull')), false);
  assert.equal(f.manager.connection().base_url, 'http://127.0.0.1:11434/v1');
  await assert.rejects(f.manager.action('stop'), { code: 'ollama_not_owned' });
  await f.manager.close(); assert.deepEqual(f.lifecycle, ['close']);
});

test('a failing model show does not erase an identified external service or trigger a second runtime install', async t => {
  const f = await fixture(t, { external: true, model: true }); f.controls.showFails = true;
  await f.manager.action('check'); await settled(f.manager);
  assert.equal(f.manager.status().running, true); assert.equal(f.manager.status().owned, false); assert.equal(f.manager.status().modelReady, false);
  assert.match(f.manager.status().detail!, /模型信息检查失败/); assert.deepEqual(f.lifecycle, []);
  await f.manager.action('prepare'); await settled(f.manager);
  assert.deepEqual(f.lifecycle, [], 'model metadata failure must never imply that Ollama itself is missing');
  assert.deepEqual(f.calls.filter(call => call.url.endsWith('/api/pull')).map(call => call.url), ['http://127.0.0.1:11434/api/pull']);
  assert.equal(f.manager.status().phase, 'error'); assert.equal(f.manager.status().running, true); assert.equal(f.manager.status().owned, false);
  assert.doesNotMatch(JSON.stringify(f.manager.status()), /SYNTHETIC_PRIVATE_MODEL/);
  await assert.rejects(f.manager.action('stop'), { code: 'ollama_not_owned' });
});
test('one explicit preparation installs the runtime, opens its service and pulls only the fixed model', async t => {
  const f = await fixture(t); await f.manager.init(); await f.manager.action('prepare'); await settled(f.manager);
  const state = f.manager.status();
  assert.equal(state.phase, 'ready'); assert.equal(state.installed, true); assert.equal(state.owned, true); assert.equal(state.modelReady, true);
  assert.deepEqual(f.lifecycle, ['install', 'start']);
  assert.deepEqual(f.calls.filter(call => call.url.endsWith('/api/pull')).map(call => call.body), [{ model: OLLAMA_MODEL, stream: true }]);
  assert.equal(f.calls.some(call => call.url.endsWith('/api/chat')), false);
  assert.equal(f.manager.connection().base_url, 'http://127.0.0.1:11435/v1');
  await f.manager.action('stop'); assert.equal(f.manager.status().running, false); assert.equal(f.manager.status().installed, true);
  await f.manager.action('start'); await settled(f.manager); assert.equal(f.manager.status().phase, 'ready');
  assert.equal(f.lifecycle.filter(event => event === 'install').length, 1);
});
test('start alone never installs runtime or silently downloads a missing model', async t => {
  const f = await fixture(t, { installed: true }); await f.manager.init(); await f.manager.action('start'); await settled(f.manager);
  assert.equal(f.manager.status().running, true); assert.equal(f.manager.status().modelReady, false);
  assert.equal(f.manager.status().phase, 'idle'); assert.deepEqual(f.lifecycle, ['start']);
  assert.equal(f.calls.some(call => call.url.endsWith('/api/pull')), false);
});
test('closing the owned console removes ready status and prevents a stale managed connection', async t => {
  const f = await fixture(t, { installed: true, model: true }); await f.manager.init();
  await f.manager.action('start'); await settled(f.manager); f.exit();
  assert.equal(f.manager.status().running, false); assert.equal(f.manager.status().phase, 'stopped');
  assert.throws(() => f.manager.connection(), { code: 'ollama_not_ready' });
});

test('a disconnected owned console retains its stop action until process cleanup is confirmed', async t => {
  const f = await fixture(t, { installed: true, model: true });
  await f.manager.action('start'); await settled(f.manager); f.disconnect();
  const state = f.manager.status();
  assert.equal(state.owned, true); assert.equal(state.running, false); assert.equal(state.cleanupPending, true); assert.equal(state.modelReady, false);
  assert.throws(() => f.manager.connection(), { code: 'ollama_not_ready' });
  await f.manager.action('stop'); assert.equal(f.manager.status().owned, false); assert.equal(f.manager.status().cleanupPending, false);
  assert.equal(f.manager.status().phase, 'stopped'); assert.equal(f.lifecycle.filter(value => value === 'stop').length, 1);
});

test('cancellation cannot hide failed startup cleanup and stopping can be retried after the visible process exits', async t => {
  const f = await fixture(t, { installed: true }); f.controls.blockOwnedProbe = true; f.controls.stopFailure = true;
  await f.manager.action('start');
  const deadline = Date.now() + 3000;
  while (!f.lifecycle.includes('start') && Date.now() < deadline) await delay(1);
  assert.ok(f.lifecycle.includes('start'));
  await f.manager.action('cancel');
  const state = f.manager.status();
  assert.equal(state.phase, 'error'); assert.equal(state.error?.code, 'ollama_stop_failed');
  assert.equal(state.busy, false); assert.equal(state.owned, true); assert.equal(state.running, false); assert.equal(state.cleanupPending, true);
  assert.doesNotMatch(JSON.stringify(state), /SYNTHETIC_PRIVATE_PROCESS|已取消本次准备/);
  assert.throws(() => f.manager.connection(), { code: 'ollama_not_ready' });
  f.controls.stopFailure = false; await f.manager.action('stop');
  assert.equal(f.manager.status().phase, 'stopped'); assert.equal(f.manager.status().owned, false); assert.equal(f.manager.status().cleanupPending, false);
});

test('cancellation cannot hide an installer cleanup failure or call it a successful cancel', async t => {
  const f = await fixture(t); f.controls.installCleanupFailure = true;
  await f.manager.action('prepare');
  const deadline = Date.now() + 3000;
  while (!f.lifecycle.includes('install') && Date.now() < deadline) await delay(1);
  assert.ok(f.lifecycle.includes('install')); await f.manager.action('cancel');
  assert.equal(f.manager.status().phase, 'error'); assert.equal(f.manager.status().error?.code, 'ollama_cleanup_failed'); assert.equal(f.manager.status().busy, false);
  assert.doesNotMatch(JSON.stringify(f.manager.status()), /SYNTHETIC_PRIVATE_TEMP_PATH|已取消本次准备/);
  assert.equal(f.lifecycle.includes('start'), false);
  f.controls.installCleanupFailure = false; await f.manager.action('prepare'); await settled(f.manager);
  assert.equal(f.manager.status().phase, 'ready');
});
test('cancel aborts the active pull, rejects duplicate actions, keeps completed resources and supports retry', async t => {
  const f = await fixture(t, { external: true }); f.controls.blockPull = true;
  await f.manager.action('prepare');
  while (!f.calls.some(call => call.url.endsWith('/api/pull'))) await delay(1);
  await assert.rejects(f.manager.action('prepare'), { code: 'ollama_busy' });
  await assert.rejects(f.manager.action('start'), { code: 'ollama_busy' });
  await f.manager.action('cancel'); assert.equal(f.manager.status().busy, false);
  assert.match(f.manager.status().detail!, /取消本次/); assert.deepEqual(f.lifecycle, []);
  f.controls.blockPull = false; await f.manager.action('prepare'); await settled(f.manager);
  assert.equal(f.manager.status().phase, 'ready');
});
for (const failure of ['badPull', 'partialPull', 'badModel'] as const) test(`${failure} never reports a model ready or leaks upstream text`, async t => {
  const f = await fixture(t, { external: true }); f.controls[failure] = true;
  await f.manager.action('prepare'); await settled(f.manager);
  assert.equal(f.manager.status().phase, 'error'); assert.ok(f.manager.status().error);
  assert.doesNotMatch(JSON.stringify(f.manager.status()), /private synthetic/);
  assert.throws(() => f.manager.connection(), { code: 'ollama_not_ready' });
});

test('official pull progress supports omitted zero fields and transfer aggregate totals without double counting', async t => {
  const f = await fixture(t, { external: true }), digest = 'sha256:' + 'a'.repeat(64);
  f.controls.pullText = [
    { status: 'pulling manifest' }, { status: 'pulling aaaaaaaaaaaa', digest },
    { status: 'pulling aaaaaaaaaaaa', digest, total: 10 },
    { status: 'pulling aaaaaaaaaaaa', digest, total: 10, completed: 10 },
    { status: 'pulling model', digest: 'sha256:model', total: 20 },
    { status: 'pulling model', digest: 'sha256:model', total: 20, completed: 20 },
    { status: 'verifying sha256 digest' }, { status: 'writing manifest' }, { status: 'success' },
  ].map(value => JSON.stringify(value)).join('\n') + '\n';
  await f.manager.action('prepare'); await settled(f.manager);
  assert.equal(f.manager.status().phase, 'ready'); assert.equal(f.manager.status().totalBytes, 20); assert.equal(f.manager.status().downloadedBytes, 20);
});

for (const [label, progress] of [
  ['wrong aggregate status', [{ status: 'anything', digest: 'sha256:model', total: 20 }]],
  ['oversized aggregate', [{ status: 'pulling model', digest: 'sha256:model', total: 9 * 1024 ** 3 }]],
  ['aggregate cannot hide excessive layer totals', [
    { status: 'pulling model', digest: 'sha256:model', total: 7 * 1024 ** 3 },
    { status: 'pulling a', digest: 'sha256:' + 'a'.repeat(64), total: 5 * 1024 ** 3 },
    { status: 'pulling b', digest: 'sha256:' + 'b'.repeat(64), total: 5 * 1024 ** 3 },
  ]],
  ['false terminal success', [{ status: 'success' }, { status: 'pulling manifest' }]],
] as const) test(`${label} does not bypass pull validation or make an unverified model ready`, async t => {
  const f = await fixture(t, { external: true });
  f.controls.pullText = progress.map(value => JSON.stringify(value)).join('\n') + '\n';
  await f.manager.action('prepare'); await settled(f.manager);
  assert.equal(f.manager.status().phase, 'error'); assert.throws(() => f.manager.connection(), { code: 'ollama_not_ready' });
});
test('close aborts setup before disposing owned process and network dispatcher', async t => {
  const f = await fixture(t, { external: true }); f.controls.blockPull = true;
  await f.manager.action('prepare'); while (!f.calls.some(call => call.url.endsWith('/api/pull'))) await delay(1);
  await f.manager.close(); assert.equal(f.controls.stopped, true); assert.equal(f.manager.status().busy, false);
  await assert.rejects(f.manager.action('start'));
});
test('a failed process close can retry cleanup while the setup manager remains closed', async t => {
  const f = await fixture(t); f.controls.closeFailure = true;
  await assert.rejects(f.manager.close(), /synthetic close failure/);
  await assert.rejects(f.manager.action('start'));
  await f.manager.close(); assert.equal(f.controls.stopped, true);
  assert.deepEqual(f.lifecycle, ['close', 'close']);
});
test('managed source is explicit, validates its enum and leaves legacy settings intact', () => {
  assert.deepEqual(localVisionSettingsOf({ backend: 'ollama', modelId: 'existing', maxTokens: 512 }), { backend: 'ollama', modelId: 'existing', maxTokens: 512 });
  assert.throws(() => localVisionSettingsOf({ source: 'remote' }), { code: 'local_vision_config' });
  const local = new LocalVision({ backend: 'ollama', modelId: '', maxTokens: 512, source: 'managed' }, new AbortController().signal,
    () => { throw Error('Managed source must not read a host model connection'); });
  assert.equal(local.status().configured, true); assert.equal(local.status().source, 'managed');
});
