import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import sharp from 'sharp';
import type { ModelConnection } from 'whalelife';
import type { PreparedImage } from '../src/types.ts';
import { LocalVision, localVisionDefaults, localVisionSettingsOf, type LocalVisionSettings } from '../src/local-vision.ts';

const signal = () => new AbortController().signal;
const settings: LocalVisionSettings = { backend: 'ollama', modelId: 'synthetic-vision', maxTokens: 256 };
const privateMarker = 'SUPPLIER_PRIVATE_MARKER';
const goodShow = { capabilities: ['completion', 'vision'] };
const goodChat = { done: true, done_reason: 'stop', message: { role: 'assistant', content: '合成画面中有一个红色方块。' } };

test('explicit managed source describes a synthetic image without reading or changing a host connection', async t => {
  const f = await mock(t);
  let hostReads = 0, managedReads = 0;
  const app = new LocalVision({ backend: 'ollama', source: 'managed', modelId: 'retained-existing-choice', maxTokens: 512 }, signal(),
    () => { hostReads++; throw Error('Unexpected host connection'); }, () => { managedReads++; return f.connection; });
  t.after(() => app.stop());
  assert.equal(app.status().configured, true);
  assert.equal((await app.describe([await picture()], '合成画面中是什么？', signal())).text, goodChat.message.content);
  assert.equal(hostReads, 0); assert.equal(managedReads, 1);
  assert.deepEqual(f.requests.map(request => request.path), ['/api/show', '/api/chat']);
  assert.equal(f.requests[1].body.think, false);
});
type Request = { path: string; headers: IncomingMessage['headers']; body: any };

function json(res: ServerResponse, value: unknown) {
  res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(value));
}
async function mock(t: TestContext, handle?: (request: Request, res: ServerResponse) => void | Promise<void>) {
  const requests: Request[] = [];
  const server = createServer(async (req, res) => {
    try {
      const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(chunk);
      const request = { path: req.url!, headers: req.headers, body: JSON.parse(Buffer.concat(chunks).toString()) };
      requests.push(request);
      if (handle) await handle(request, res);
      else json(res, request.path === '/api/show' ? goodShow : goodChat);
    } catch { if (!res.headersSent) res.statusCode = 500; res.end('synthetic server failure'); }
  });
  t.after(() => new Promise<void>(done => { server.closeAllConnections(); server.close(() => done()); }));
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  const port = (server.address() as { port: number }).port;
  const connection: ModelConnection = {
    id: settings.modelId, name: 'Synthetic vision', model: 'synthetic-vl:small', type: 'chat',
    provider_id: 'fixture', provider_name: 'Synthetic local service', protocol: 'openai-compatible',
    base_url: `http://127.0.0.1:${port}/v1/`, api_key: 'synthetic-private-key', proxy_url: '',
    timeout_seconds: 3, parameters: {}, dimensions: null, context_window: null,
  };
  return { connection, requests, port };
}
function engine(t: TestContext, connection: ModelConnection | ((id: string) => Promise<ModelConnection>), configured = settings, lifetime = signal()) {
  const app = new LocalVision(configured, lifetime, typeof connection === 'function' ? connection : async () => connection);
  t.after(() => app.stop()); return app;
}
async function picture(atSeconds: number | null = 0): Promise<PreparedImage> {
  const bytes = await sharp({ create: { width: 32, height: 20, channels: 3, background: '#dd2233' } }).jpeg().toBuffer();
  return { mime: 'image/jpeg', base64: bytes.toString('base64'), width: 32, height: 20,
    frames: [{ index: 1, atSeconds, reason: 'first', role: 'overview', rect: { x: 0, y: 0, width: 32, height: 20 } }] };
}
function expectCode(wanted: string) {
  return (error: any) => {
    assert.equal(error.code, wanted);
    assert.doesNotMatch(String(error), /SUPPLIER_PRIVATE_MARKER|synthetic-private-key|http:\/\/|https:\/\//);
    return true;
  };
}
function latch() {
  let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

test('local vision configuration defaults to the existing main model and initialization performs no model lookup', async t => {
  assert.deepEqual(localVisionDefaults, { backend: 'main', modelId: '', maxTokens: 512 });
  assert.deepEqual(localVisionSettingsOf(undefined), localVisionDefaults);
  assert.deepEqual(localVisionSettingsOf({}), localVisionDefaults);
  for (const value of [null, [], 'ollama', { backend: 'cloud' }, { backend: null }, { modelId: null }, { maxTokens: null },
    { modelId: 42 }, { maxTokens: 127 }, { maxTokens: 1025 }, { maxTokens: 256.5 }])
    assert.throws(() => localVisionSettingsOf(value), expectCode('local_vision_config'));
  let lookups = 0;
  const app = engine(t, async () => { lookups++; throw Error(privateMarker); }, { ...localVisionDefaults });
  assert.doesNotMatch(JSON.stringify(app.status()), /base_url|api_key|proxy_url|SUPPLIER_PRIVATE_MARKER/);
  assert.equal(lookups, 0);
  await assert.rejects(app.describe([await picture()], undefined, signal()), expectCode('local_vision_disabled'));
  assert.equal(lookups, 0);
});

test('one bounded local request receives all images plus temporal and crop metadata, without private parameters or credentials', async t => {
  const f = await mock(t, (req, res) => json(res, req.path === '/api/show' ? goodShow : {
    ...goodChat, prompt_eval_count: 17, eval_count: 12, message: { ...goodChat.message, thinking: privateMarker },
  }));
  const app = engine(t, { ...f.connection, parameters: { model: 'injected-model', messages: [{ content: privateMarker }],
    tools: [{ name: 'forbidden' }], num_predict: -1, keep_alive: '99h', stream: true, think: true } });
  const whole = await picture(1.5), focus = await picture(2.5);
  focus.frames[0] = { ...focus.frames[0], index: 2, reason: 'focus', role: 'focus', crop: { x: .25, y: .1, width: .5, height: .5 } };
  const result = await app.describe([whole, focus], '红色方块在哪里？', signal());
  assert.deepEqual(result, { backend: 'ollama', text: goodChat.message.content, truncated: false, images: 2,
    usage: { prompt_tokens: 17, completion_tokens: 12, total_tokens: 29 } });
  assert.deepEqual(f.requests.map(req => req.path), ['/api/show', '/api/chat']);
  assert.deepEqual(f.requests[0].body, { model: f.connection.model });
  const request = f.requests[1], body = request.body;
  assert.equal(body.model, f.connection.model); assert.equal(body.stream, false); assert.equal(body.keep_alive, '1m');
  assert.equal(body.think, false);
  assert.equal(body.options.num_predict, 256); assert.equal(body.options.temperature, 0);
  assert.equal(body.tools, undefined); assert.equal(request.headers.authorization, undefined); assert.equal(request.headers.cookie, undefined);
  const user = body.messages.find((message: any) => message.role === 'user');
  assert.deepEqual(user.images, [whole.base64, focus.base64]);
  const prompt = body.messages.map((message: any) => message.content).join('\n');
  assert.match(prompt, /红色方块在哪里/); assert.match(prompt, /1\.5/); assert.match(prompt, /2\.5/);
  assert.match(prompt, /focus/); assert.match(prompt, /0\.25/); assert.match(prompt, /crop/);
  assert.match(prompt, /不.*授权|不.*指令/); assert.match(prompt, /不确定|看不清|候选/);
  assert.doesNotMatch(JSON.stringify(body), /SUPPLIER_PRIVATE_MARKER|injected-model|99h|forbidden|synthetic-private-key/);
  assert.doesNotMatch(JSON.stringify(result), /thinking|SUPPLIER_PRIVATE_MARKER/);
});

test('each operation resolves the explicitly selected configuration again and checks model capabilities again', async t => {
  const f = await mock(t); let lookups = 0;
  const app = engine(t, async id => { assert.equal(id, settings.modelId); lookups++; return { ...f.connection, model: `local-model-${lookups}` }; });
  const image = await picture();
  await app.describe([image], undefined, signal()); await app.describe([image], undefined, signal());
  assert.equal(lookups, 2); assert.deepEqual(f.requests.map(req => req.path), ['/api/show', '/api/chat', '/api/show', '/api/chat']);
  assert.equal(f.requests[0].body.model, 'local-model-1'); assert.equal(f.requests[2].body.model, 'local-model-2');
});

test('missing selection and unavailable configured models are explicit and never call a default model', async t => {
  const f = await mock(t), image = await picture(); let lookups = 0;
  const absent = engine(t, async () => { lookups++; return f.connection; }, { ...settings, modelId: '' });
  await assert.rejects(absent.describe([image], undefined, signal()), expectCode('local_vision_model_required'));
  assert.equal(lookups, 0);
  const unavailable = engine(t, async () => { lookups++; throw Error(privateMarker); });
  await assert.rejects(unavailable.describe([image], undefined, signal()), expectCode('local_vision_model_unavailable'));
  assert.equal(lookups, 1); assert.equal(f.requests.length, 0);
});

test('nonlocal addresses, ambiguous loopback spellings, proxies and unsupported connection types fail before sending media', async t => {
  const f = await mock(t), image = await picture();
  for (const base_url of ['http://example.invalid/v1', 'https://127.0.0.1/v1', 'http://127.1/v1', 'http://2130706433/v1',
    'http://0x7f000001/v1', 'http://127.0.0.2/v1', 'http://user:SUPPLIER_PRIVATE_MARKER@127.0.0.1/v1',
    f.connection.base_url + '?token=SUPPLIER_PRIVATE_MARKER', f.connection.base_url + '#private', `http://127.0.0.1:${f.port}/nested/v1`]) {
    const app = engine(t, { ...f.connection, base_url });
    await assert.rejects(app.describe([image], undefined, signal()), expectCode('local_vision_not_local'));
  }
  await assert.rejects(engine(t, { ...f.connection, proxy_url: `http://127.0.0.1:${f.port}` }).describe([image], undefined, signal()), expectCode('local_vision_not_local'));
  for (const changed of [{ protocol: 'ollama' }, { type: 'image' as const }])
    await assert.rejects(engine(t, { ...f.connection, ...changed }).describe([image], undefined, signal()), expectCode('local_vision_unsupported'));
  assert.equal(f.requests.length, 0);
});

test('localhost and root base paths use the native local API without forwarding the stored API key', async t => {
  const f = await mock(t), image = await picture();
  const app = engine(t, { ...f.connection, base_url: `http://localhost:${f.port}/`, type: 'custom' });
  await app.describe([image], undefined, signal());
  assert.deepEqual(f.requests.map(req => req.path), ['/api/show', '/api/chat']);
  assert.ok(f.requests.every(req => req.headers.authorization === undefined));
});

test('cloud model labels are rejected before network use, including cloud tags on an otherwise local connection', async t => {
  const f = await mock(t), image = await picture();
  for (const model of ['qwen-vl:cloud', 'qwen-vl:8b-cloud', 'cloud/model:small', 'qwen-vl:8b-CLOUD'])
    await assert.rejects(engine(t, { ...f.connection, model }).describe([image], undefined, signal()), expectCode('local_vision_remote'));
  assert.equal(f.requests.length, 0);
});

test('remote aliases and missing vision capability stop after metadata inspection and never upload pictures', async t => {
  let show: any = goodShow;
  const f = await mock(t, (_req, res) => json(res, show)), image = await picture();
  const app = engine(t, f.connection);
  for (const extra of [{ remote_model: 'remote-vl' }, { remote_host: 'https://SUPPLIER_PRIVATE_MARKER.invalid' }, { remote_model: null }]) {
    show = { ...goodShow, ...extra };
    await assert.rejects(app.describe([image], undefined, signal()), expectCode('local_vision_remote'));
  }
  for (const capabilities of [undefined, [], ['completion'], 'vision']) {
    show = { capabilities };
    await assert.rejects(app.describe([image], undefined, signal()), expectCode('local_vision_unsupported'));
  }
  assert.equal(f.requests.length, 7); assert.ok(f.requests.every(req => req.path === '/api/show'));
  assert.ok(f.requests.every(req => !JSON.stringify(req.body).includes(image.base64)));
});

test('invalid questions, image counts, encoded pixels and metadata fail before model requests', async t => {
  const f = await mock(t), app = engine(t, f.connection), image = await picture();
  for (const images of [[], Array(9).fill(image), [{ ...image, mime: 'image/png' }], [{ ...image, base64: 'not base64' }],
    [{ ...image, base64: Buffer.from('not a jpeg').toString('base64') }], [{ ...image, width: Number.NaN }],
    [{ ...image, frames: [] }], [{ ...image, frames: [{ ...image.frames[0], atSeconds: Number.NaN }] }]])
    await assert.rejects(app.describe(images as PreparedImage[], undefined, signal()), expectCode('local_vision_input'));
  await assert.rejects(app.describe([image], 'x'.repeat(1001), signal()), expectCode('local_vision_input'));
  await assert.rejects(app.describe([image], 7 as any, signal()), expectCode('local_vision_input'));
  assert.equal(f.requests.length, 0);
});

test('per-image and total image byte limits reject oversized inputs before uploading', async t => {
  const f = await mock(t), app = engine(t, f.connection), image = await picture();
  const makeLarge = (size: number) => {
    const bytes = Buffer.alloc(size); bytes[0] = 0xff; bytes[1] = 0xd8; bytes[2] = 0xff;
    bytes[bytes.length - 2] = 0xff; bytes[bytes.length - 1] = 0xd9;
    return { ...image, base64: bytes.toString('base64') };
  };
  await assert.rejects(app.describe([makeLarge(4 * 1024 * 1024 + 1)], undefined, signal()), expectCode('local_vision_input'));
  await assert.rejects(app.describe(Array(3).fill(makeLarge(3 * 1024 * 1024)), undefined, signal()), expectCode('local_vision_input'));
  assert.equal(f.requests.length, 0);
});

test('the token limit is reported as truncation while unreported usage stays unknown', async t => {
  let response: any = { ...goodChat, done_reason: 'length' };
  const f = await mock(t, (req, res) => json(res, req.path === '/api/show' ? goodShow : response));
  const app = engine(t, f.connection), image = await picture();
  const limited = await app.describe([image], undefined, signal());
  assert.equal(limited.truncated, true); assert.equal(limited.text, goodChat.message.content); assert.equal(limited.usage, undefined);
  response = { ...goodChat, eval_count: settings.maxTokens, prompt_eval_count: -1 };
  const counted = await app.describe([image], undefined, signal());
  assert.equal(counted.truncated, true); assert.deepEqual(counted.usage, { completion_tokens: settings.maxTokens });
});

test('unfinished, empty, tool-bearing and malformed responses never become successful visual evidence', async t => {
  let response: any;
  const f = await mock(t, (req, res) => json(res, req.path === '/api/show' ? goodShow : response));
  const app = engine(t, f.connection), image = await picture();
  for (const bad of [{ ...goodChat, done: false }, { ...goodChat, done_reason: 'unknown' },
    { ...goodChat, message: { role: 'assistant', content: '   ' } },
    { ...goodChat, message: { role: 'assistant', content: privateMarker, tool_calls: [{ function: { name: 'delete' } }] } },
    { error: privateMarker }, null, []]) {
    response = bad;
    await assert.rejects(app.describe([image], undefined, signal()), expectCode('local_vision_response'));
  }
  response = { ...goodChat, remote_model: 'remote-vl', remote_host: 'https://SUPPLIER_PRIVATE_MARKER.invalid' };
  await assert.rejects(app.describe([image], undefined, signal()), expectCode('local_vision_remote'));
  assert.equal(f.requests.length, 16, 'each attempt is exactly one inspection plus one inference, without fallback');
});

test('reply byte and text limits are enforced without exposing oversized service content', async t => {
  let kind: 'text' | 'body' | 'json' = 'text';
  const f = await mock(t, (req, res) => {
    if (req.path === '/api/show') { json(res, goodShow); return; }
    if (kind === 'text') json(res, { ...goodChat, message: { role: 'assistant', content: privateMarker + 'x'.repeat(16 * 1024) } });
    else if (kind === 'body') json(res, { ...goodChat, padding: 'x'.repeat(1024 * 1024) });
    else { res.setHeader('Content-Type', 'application/json'); res.end('{SUPPLIER_PRIVATE_MARKER'); }
  });
  const app = engine(t, f.connection), image = await picture();
  await assert.rejects(app.describe([image], undefined, signal()), expectCode('local_vision_output_limit'));
  kind = 'body'; await assert.rejects(app.describe([image], undefined, signal()), expectCode('local_vision_output_limit'));
  kind = 'json'; await assert.rejects(app.describe([image], undefined, signal()), expectCode('local_vision_response'));
});

test('HTTP failures and redirects neither replay inference nor forward images to another destination', async t => {
  const destination = await mock(t); let status = 503, inspectionSucceeds = false;
  const f = await mock(t, (req, res) => {
    if (inspectionSucceeds && req.path === '/api/show') { json(res, goodShow); return; }
    res.statusCode = status; res.setHeader('Location', destination.connection.base_url);
    res.end(privateMarker + ' synthetic-private-key');
  });
  const app = engine(t, f.connection), image = await picture();
  await assert.rejects(app.describe([image], undefined, signal()), expectCode('local_vision_http'));
  status = 307; await assert.rejects(app.describe([image], undefined, signal()), expectCode('local_vision_http'));
  assert.equal(f.requests.length, 2); assert.ok(f.requests.every(req => req.path === '/api/show'));
  inspectionSucceeds = true;
  await assert.rejects(app.describe([image], undefined, signal()), expectCode('local_vision_http'));
  assert.equal(f.requests.length, 4); assert.deepEqual(f.requests.slice(2).map(req => req.path), ['/api/show', '/api/chat']);
  assert.equal(destination.requests.length, 0);
});

test('caller cancellation aborts inspection before image upload and aborts an active inference without retry', { timeout: 3000 }, async t => {
  let phase: 'show' | 'chat' = 'show', received = latch(), closed = latch();
  const f = await mock(t, (req, res) => {
    if (phase === 'chat' && req.path === '/api/show') json(res, goodShow);
    else { res.once('close', closed.resolve); received.resolve(); }
  });
  const app = engine(t, f.connection), image = await picture();
  const first = new AbortController(), inspection = app.describe([image], undefined, first.signal);
  await received.promise; first.abort(privateMarker);
  await assert.rejects(inspection, expectCode('cancelled')); assert.equal(f.requests.length, 1);
  await closed.promise;
  phase = 'chat'; received = latch(); closed = latch();
  const next = new AbortController(), inference = app.describe([image], undefined, next.signal);
  await received.promise; next.abort(privateMarker);
  await assert.rejects(inference, expectCode('cancelled')); assert.equal(f.requests.length, 3);
  await closed.promise;
  const already = new AbortController(); already.abort(privateMarker);
  await assert.rejects(app.describe([image], undefined, already.signal), expectCode('cancelled'));
  assert.equal(f.requests.length, 3);
});

test('a single operation timeout covers metadata and inference, with no retry or model substitution', async t => {
  let phase: 'show' | 'chat' = 'show';
  const f = await mock(t, (req, res) => { if (phase === 'chat' && req.path === '/api/show') json(res, goodShow); });
  const app = engine(t, { ...f.connection, timeout_seconds: .04 }), image = await picture();
  await assert.rejects(app.describe([image], undefined, signal()), expectCode('local_vision_timeout'));
  assert.equal(f.requests.length, 1);
  phase = 'chat';
  await assert.rejects(app.describe([image], undefined, signal()), expectCode('local_vision_timeout'));
  assert.equal(f.requests.length, 3);
});

test('only one local operation may run at a time and cancellation releases the slot', async t => {
  const received = latch(); let hold = true;
  const f = await mock(t, (req, res) => {
    if (req.path === '/api/show') json(res, goodShow);
    else if (hold) received.resolve(); else json(res, goodChat);
  });
  const app = engine(t, f.connection), image = await picture(), controller = new AbortController();
  const first = app.describe([image], undefined, controller.signal); await received.promise;
  await assert.rejects(app.describe([image], undefined, signal()), expectCode('local_vision_busy'));
  assert.equal(f.requests.length, 2);
  controller.abort(); await assert.rejects(first, expectCode('cancelled'));
  hold = false; const next = await app.describe([image], undefined, signal());
  assert.equal(next.text, goodChat.message.content); assert.equal(f.requests.length, 4);
});

test('stop cancels a pending connection lookup and prevents later calls without needing the lookup to settle', async t => {
  const entered = latch(); let lookups = 0;
  const app = engine(t, async () => { lookups++; entered.resolve(); return new Promise<ModelConnection>(() => {}); });
  const image = await picture(), work = app.describe([image], undefined, signal());
  const rejected = assert.rejects(work, expectCode('cancelled'));
  await entered.promise; await app.stop(); await rejected;
  await assert.rejects(app.describe([image], undefined, signal()), expectCode('cancelled'));
  assert.equal(lookups, 1);
});

test('lifetime cancellation closes an active request and stop waits for local work cleanup', async t => {
  const received = latch(), lifetime = new AbortController();
  const f = await mock(t, (req, res) => { if (req.path === '/api/show') json(res, goodShow); else received.resolve(); });
  const app = engine(t, f.connection, settings, lifetime.signal), image = await picture();
  const pending = app.describe([image], undefined, signal()), rejected = assert.rejects(pending, expectCode('cancelled'));
  await received.promise; lifetime.abort(privateMarker); await app.stop(); await rejected;
  assert.equal(f.requests.length, 2);
});


test('local vision requests no thinking so a bounded answer budget can produce visual evidence', async t => {
  const f = await mock(t, (req, res) => {
    if (req.path === '/api/show') return json(res, {
      capabilities: ['completion', 'vision', 'thinking'], thinking: { values: [true, false], default: true },
    });
    const disabled = req.body.think === false;
    json(res, { done: true, done_reason: disabled ? 'stop' : 'length', eval_count: disabled ? 12 : settings.maxTokens,
      message: { role: 'assistant', content: disabled ? goodChat.message.content : '', thinking: privateMarker } });
  });
  const app = engine(t, { ...f.connection, parameters: { think: true, options: { think: true } } });
  const result = await app.describe([await picture()], undefined, signal());
  assert.equal(result.text, goodChat.message.content); assert.equal(result.truncated, false);
  assert.deepEqual(f.requests.map(req => req.path), ['/api/show', '/api/chat']);
  assert.equal(f.requests[1].body.think, false); assert.equal(f.requests[1].body.options.think, undefined);
  assert.doesNotMatch(JSON.stringify(result), /thinking|SUPPLIER_PRIVATE_MARKER/);
});

test('a model ignoring the no-thinking request cannot substitute its thinking for an empty answer', async t => {
  const f = await mock(t, (req, res) => json(res, req.path === '/api/show' ? goodShow : {
    done: true, done_reason: 'length', eval_count: settings.maxTokens,
    message: { role: 'assistant', content: '', thinking: privateMarker },
  }));
  const app = engine(t, f.connection);
  await assert.rejects(app.describe([await picture()], undefined, signal()), expectCode('local_vision_response'));
  assert.equal(f.requests.length, 2); assert.equal(f.requests[1].body.think, false);
});
