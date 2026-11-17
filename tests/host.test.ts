import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, cp, writeFile, readFile, readdir, symlink } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { temporaryDirectory, root } from './temporary-directory.ts';
import { png } from './helpers.ts';
const host = resolve(root, '../whalelife');
for (const baseline of ['current', '213b52b']) test(`packaged plugin on ${baseline}: RPC, optional isolation, honest tools, settings and cleanup`, async t => {
  const f = await temporaryDirectory(t);
  let source = host;
  if (baseline !== 'current') {
    source = join(f.dir, 'host'); await mkdir(source);
    const archive = join(f.dir, 'host.tar');
    const git = spawnSync('git', ['-C', host, 'archive', '--format=tar', '--output=' + archive, baseline, 'core', 'package.json'], { encoding: 'utf8', windowsHide: true });
    assert.equal(git.status, 0, git.stderr);
    const tar = spawnSync('tar', ['-xf', archive, '-C', source], { encoding: 'utf8', windowsHide: true });
    assert.equal(tar.status, 0, tar.stderr);
    await symlink(join(host, 'node_modules'), join(source, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
  }
  const modelCalls: any[] = [];
  let viewRef: string | undefined;
  const server = createServer(async (req, res) => {
    if (req.method === 'GET') { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ data: [] })); return; }
    let raw = ''; for await (const chunk of req) raw += chunk;
    const request = JSON.parse(raw); modelCalls.push(request);
    if (viewRef) {
      const hasToolResult = request.messages.some((m: any) => m.role === 'tool');
      const delta = hasToolResult ? { content: 'TEMPORARY_VISUAL_REPLY_MARKER' } : { tool_calls: [{ index: 0, id: 'synthetic-vision-call', type: 'function', function: { name: 'vision_view', arguments: JSON.stringify({ mediaRef: viewRef }) } }] };
      res.setHeader('Content-Type', 'text/event-stream');
      res.end('data: ' + JSON.stringify({ choices: [{ delta, finish_reason: hasToolResult ? 'stop' : 'tool_calls' }], usage: { prompt_tokens: 20, completion_tokens: 4, total_tokens: 24 } }) + '\n\ndata: [DONE]\n\n');
      return;
    }
    if (request.stream) {
      res.setHeader('Content-Type', 'text/event-stream');
      res.end('data: ' + JSON.stringify({ choices: [{ delta: { content: 'isolated text still works' }, finish_reason: 'stop' }], usage: { prompt_tokens: 2, completion_tokens: 4, total_tokens: 6 } }) + '\n\ndata: [DONE]\n\n');
      return;
    }
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ choices: [{ message: { content: 'isolated text still works' }, finish_reason: 'stop' }], usage: { prompt_tokens: 2, completion_tokens: 4, total_tokens: 6 } }));
  });
  f.cleanup.push(() => new Promise<void>((done) => { server.closeAllConnections(); server.close(() => done()); }));
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const run = join(f.dir, 'runtime');
  await mkdir(join(run, 'config'), { recursive: true });
  await mkdir(join(run, 'plugins'), { recursive: true });
  await cp(join(root, 'dist/vision'), join(run, 'plugins/vision'), { recursive: true });
  const consumer = join(run, 'plugins/mock-source'); await mkdir(consumer);
  await writeFile(join(consumer, 'plugin.yaml'), 'id: mock-source\nname: Synthetic source\nversion: 1.0.0\ndescription: Isolated test fixture\noptionalDepends: [vision]\n');
  await writeFile(join(consumer, 'index.ts'), `export function apply(ctx) {
    let binding;
    if (typeof ctx.optional === 'function') ctx.optional('vision', next => { binding = next; });
    ctx.provide('mock-source', { ping() { return 'source text works'; }, available() { return !!binding; },
      async chat() { const sessionId = await ctx.sessions.create('Synthetic isolated chat'); return ctx.sessions.run({sessionId, text: 'synthetic isolated text request', persona: 'a', permission: 'full'}); },
      newSession() { return ctx.sessions.create('Synthetic vision session'); },
      view(sessionId) { return ctx.sessions.run({sessionId, text: 'synthetic vision request', persona: 'a', permission: 'full'}); },
      async offer(input) { return binding.service.offerMedia(input, {signal: binding.signal}); },
      async prepare(input) { const p = await binding.service.prepare(input, {signal: binding.signal}); return {images: p.images.length, width: p.images[0].width}; }
    });
  }`);
  await writeFile(join(run, 'config/config.json'), JSON.stringify({
    log: { level: 'error' }, web: { port: 0 },
    providers: [{ id: 'mock', name: 'Mock', protocol: 'openai-compatible', base_url: `http://127.0.0.1:${(server.address() as any).port}/v1`, api_key: 'synthetic-test-secret' }],
    models: [{ id: 'mock-chat', provider: 'mock', name: 'Mock', model: 'fixture', type: 'chat', enabled: true }],
    model_bindings: { chat: 'mock-chat' }, personas: { a: { name: 'Synthetic', file: 'personas/a.md', model: 'mock-chat', permission: 'full' } },
    channels: { web: { persona: 'a', permission: 'full' } }, memory: { root: 'memory' }
  }));
  const { boot } = await import(pathToFileURL(join(source, 'core/index.ts')).href);
  let app: any; f.cleanup.push(async () => { await app?.close(); });
  app = await boot(run);
  const record = app.runtime.records.get('vision');
  const native = typeof app.tools.registerMultimodal === 'function';
  if (baseline === 'current') assert.equal(native, true, 'current SDK must include the public multimodal contract for native integration coverage');
  assert.equal(record.status, 'active', record.error); assert.notEqual(record.execution.pid, process.pid);
  assert.equal(Object.keys(await app.memory.listSessionMeta()).length, 0);
  const url = `http://127.0.0.1:${app.web.server.address().port}`;
  assert.equal((await fetch(url + '/plugins/vision/state')).status, 401);
  const login = await fetch(url + '/api/login', { method: 'POST', body: '{}' });
  const cookie = login.headers.get('set-cookie')!.split(';')[0];
  const get = (path: string) => fetch(url + '/plugins/vision/' + path, { headers: { Cookie: cookie } });
  const post = (body: unknown) => fetch(url + '/plugins/vision/config', { method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  let state: any = await (await get('state')).json();
  assert.ok(state.status, JSON.stringify(state));
  assert.equal(state.status.mainModelViewing, native); assert.equal(state.status.mediaPreparation, true);
  assert.equal(state.status.decoder.ready, true);
  assert.deepEqual(Object.keys(state.config).sort(), ['maxMediaMiB', 'maxTotalMiB', 'ttlSeconds']);
  assert.doesNotMatch(await (await get('settings')).text(), /name="ffmpegPath"|name="ffprobePath"/);
  assert.match(await (await get('settings')).text(), /旧宿主显示主模型查看暂不可用/);
  assert.equal(app.tools.list().some((x: any) => x.function.name === 'vision_view'), native);
  assert.equal(app.tools.list().some((x: any) => x.function.name === 'screen_view'), native);
  assert.equal(state.status.screen.enabled, false);
  assert.equal(state.status.visual.detail, 'auto');
  if (native) assert.deepEqual(app.tools.list().find((x: any) => x.function.name === 'vision_view').function.parameters.required, ['mediaRef']);
  const svc = app.runtime.services.get('vision').value;
  const sourceSvc = app.runtime.services.get('mock-source').value;
  assert.equal(await sourceSvc.ping(), 'source text works');
  const bytes = await png();
  const input = { sessionId: await sourceSvc.newSession(), mime: 'image/png', base64: bytes.toString('base64') };
  const ref = baseline === 'current' ? await sourceSvc.offer(input) : await svc.offerMedia(input);
  const prepared = baseline === 'current' ? await sourceSvc.prepare({ sessionId: input.sessionId, mediaRef: ref.mediaRef })
    : { images: (await svc.prepare({ sessionId: input.sessionId, mediaRef: ref.mediaRef })).images.length };
  assert.equal(prepared.images, 1);
  await assert.rejects(svc.prepare({ sessionId: 'synthetic-session-b', mediaRef: ref.mediaRef }));
  const status = await app.tools.call('vision_status', {}, { id: input.sessionId, permission: 'full' });
  assert.equal(status.ok, true); assert.equal(status.result.mainModelViewing, native);
  assert.ok(!JSON.stringify(status).includes('base64')); assert.ok(!JSON.stringify(status).includes(ref.mediaRef));
  assert.equal(modelCalls.length, 0, 'media preparation must not invoke any model');
  if (native) {
    const screen = await app.tools.call('screen_view', { mode: 'snapshot' }, { id: input.sessionId, permission: 'full' });
    assert.ok(screen.result.every((part: any) => part.type === 'text'));
    assert.match(JSON.stringify(screen.result), /screen_disabled/);
    assert.equal(modelCalls.length, 0, 'disabled screen capture never starts a model request');
    const refused = await app.tools.call('vision_view', { mediaRef: ref.mediaRef, sessionId: input.sessionId }, { id: 'synthetic-other-session', permission: 'full' });
    assert.ok(!refused.result.some((part: any) => part.type === 'image'), 'model cannot override the trusted session');
    viewRef = ref.mediaRef;
    assert.match(await sourceSvc.view(input.sessionId), /TEMPORARY_VISUAL_REPLY_MARKER/);
    viewRef = undefined;
    assert.equal(modelCalls.length, 2);
    assert.ok(modelCalls.every(call => call.model === 'fixture'), 'keep the selected main model');
    const contents = modelCalls[1].messages.filter((m: any) => Array.isArray(m.content)).flatMap((m: any) => m.content);
    const image = contents.find((p: any) => p.type === 'image_url');
    assert.ok(image?.image_url.url.startsWith('data:image/jpeg;base64,'), 'actual HTTP request carries native visual input');
    assert.ok(!modelCalls[1].messages.filter((m: any) => m.role === 'tool').some((m: any) => m.content.includes('base64')));
    const stored: string[] = [];
    async function collect(path: string) {
      for (const file of await readdir(path, { withFileTypes: true })) {
        if (file.isDirectory()) await collect(join(path, file.name));
        else stored.push(await readFile(join(path, file.name), 'utf8'));
      }
    }
    await collect(join(run, 'memory')); await collect(join(run, 'logs'));
    const persisted = stored.join('\n');
    assert.ok(!persisted.includes(image.image_url.url));
    assert.ok(!persisted.includes(bytes.toString('base64')));
    assert.ok(persisted.includes('TEMPORARY_VISUAL_REPLY_MARKER'), 'ordinary chat keeps the final assistant answer; only temporary tool content is excluded');
    assert.ok(persisted.includes('prepare_visual_input'), 'only a truthful preparation receipt is persisted');
  }
  const visualConfig = { ...state.visualDefaults, detail: 'detail', focus: 'auto', maxFrames: 4, sampleFps: 4 };
  const screenConfig = { ...state.screenDefaults, enabled: true, target: 'screen', seconds: 5 };
  const saved = await post({ revision: state.revision, config: { ...state.config, ttlSeconds: 60, visual: visualConfig, screen: screenConfig } });
  assert.equal(saved.status, 200, await saved.text());
  const conflict = await post({ revision: state.revision, config: state.config });
  assert.equal(conflict.status, 400); assert.equal((await conflict.json() as any).code, 'conflict');
  state = await (await get('state')).json(); assert.equal(state.pendingReload, true); assert.equal(state.config.ttlSeconds, 60);
  assert.equal(state.status.ttlSeconds, 1800, 'saved config waits for reload');
  assert.equal(state.status.visual.detail, 'auto'); assert.equal(state.status.screen.enabled, false);
  const invalidVisual = await post({ revision: state.revision, config: { ...state.config, visual: { ...visualConfig, maxFrames: 1 } } });
  assert.equal(invalidVisual.status, 400);
  const legacySave = await post({ revision: state.revision, config: { ttlSeconds: 60, maxMediaMiB: 64, maxTotalMiB: 256 } });
  assert.equal(legacySave.status, 200);
  state = await (await get('state')).json();
  assert.deepEqual(state.config.visual, visualConfig, 'old settings clients preserve visual preferences');
  assert.deepEqual(state.config.screen, screenConfig, 'old settings clients preserve screen preferences');
  await app.runtime.action('vision', 'stop');
  assert.equal(await sourceSvc.ping(), 'source text works');
  assert.equal(app.runtime.records.get('mock-source').status, 'active');
  if (baseline === 'current') assert.equal(await sourceSvc.available(), false);
  assert.deepEqual(await readdir(join(run, 'plugins/vision/data/media')), []);
  await assert.rejects(svc.describe({ sessionId: input.sessionId, mediaRef: ref.mediaRef }));
  assert.ok(!app.tools.list().some((x: any) => x.function.name === 'vision_status'));
  assert.match(await sourceSvc.chat(), /isolated text still works/);
  assert.equal(modelCalls.length, native ? 3 : 1);
  assert.ok(!JSON.stringify(modelCalls.at(-1)).includes(bytes.toString('base64')));
  await app.runtime.action('vision', 'start');
  const fresh = app.runtime.services.get('vision').value;
  assert.equal((await fresh.status()).ttlSeconds, 60);
  assert.deepEqual((await fresh.status()).visual, visualConfig);
  assert.equal((await fresh.status()).screen.enabled, true, 'enabling settings alone does not capture');
  await assert.rejects(fresh.describe({ sessionId: input.sessionId, mediaRef: ref.mediaRef }));
  const disk = await readFile(join(run, 'plugins/vision/data/config.json'), 'utf8');
  assert.equal(JSON.parse(disk).ttlSeconds, 60);
});

for (const baseline of ['current', '213b52b']) test(`local visual routing on ${baseline}: loopback Ollama, text-only main input, settings compatibility and transient isolation`, { timeout: 60_000 }, async t => {
  const f = await temporaryDirectory(t);
  let source = host;
  if (baseline !== 'current') {
    source = join(f.dir, 'host'); await mkdir(source);
    const archive = join(f.dir, 'host.tar');
    const git = spawnSync('git', ['-C', host, 'archive', '--format=tar', '--output=' + archive, 'refs/tags/' + baseline, 'core', 'package.json'], { encoding: 'utf8', windowsHide: true });
    assert.equal(git.status, 0, git.stderr);
    const tar = spawnSync('tar', ['-xf', archive, '-C', source], { encoding: 'utf8', windowsHide: true });
    assert.equal(tar.status, 0, tar.stderr);
    await symlink(join(host, 'node_modules'), join(source, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
  }
  const localDescription = 'SYNTHETIC_OLLAMA_VISUAL_EVIDENCE_NOT_FOR_ARCHIVE';
  const finalReply = 'SYNTHETIC_MAIN_REPLY_AFTER_LOCAL_VISION';
  const personaMarker = 'SYNTHETIC_LOCAL_VISION_MAIN_PERSONA';
  const question = 'Which synthetic color is visible?';
  const mainKey = 'synthetic-main-local-route-key', localKey = 'synthetic-local-route-key';
  const mainCalls: any[] = [], localCalls: { url: string; body: any; authorization: string | undefined }[] = [], events: any[] = [];
  let viewRef = '', normalReply = false;
  const server = createServer(async (req, res) => {
    if (req.method === 'GET') { res.setHeader('Content-Type', 'application/json'); res.end('{"data":[]}'); return; }
    let raw = ''; for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw || '{}');
    if (req.url === '/api/show' || req.url === '/api/chat') {
      localCalls.push({ url: req.url, body, authorization: req.headers.authorization });
      res.setHeader('Content-Type', 'application/json');
      res.end(req.url === '/api/show' ? JSON.stringify({ capabilities: ['vision', 'completion'] })
        : JSON.stringify({ model: 'synthetic-local-vision', message: { role: 'assistant', content: localDescription },
          done: true, done_reason: 'stop', prompt_eval_count: 17, eval_count: 8 }));
      return;
    }
    if (req.url !== '/main/v1/chat/completions') { res.statusCode = 404; res.end(); return; }
    mainCalls.push(body);
    const answered = normalReply || body.messages.some((message: any) => message.role === 'tool');
    const delta = answered ? { content: normalReply ? 'SYNTHETIC_LOCAL_VISION_FOLLOWUP' : finalReply }
      : { tool_calls: [{ index: 0, id: 'synthetic-local-vision-call', type: 'function',
        function: { name: 'vision_view', arguments: JSON.stringify({ mediaRef: viewRef, question }) } }] };
    res.setHeader('Content-Type', 'text/event-stream');
    res.end('data: ' + JSON.stringify({ choices: [{ delta, finish_reason: answered ? 'stop' : 'tool_calls' }],
      usage: { prompt_tokens: 20, completion_tokens: 4, total_tokens: 24 } }) + '\n\ndata: [DONE]\n\n');
  });
  f.cleanup.push(() => new Promise<void>(done => { server.closeAllConnections(); server.close(() => done()); }));
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  const port = (server.address() as { port: number }).port, run = join(f.dir, 'runtime');
  await mkdir(join(run, 'config'), { recursive: true });
  await mkdir(join(run, 'plugins'), { recursive: true });
  await cp(join(root, 'dist/vision'), join(run, 'plugins/vision'), { recursive: true });
  await mkdir(join(run, 'plugins/vision/data'), { recursive: true });
  const localConfig = { backend: 'ollama', modelId: 'fixture', maxTokens: 512 };
  await writeFile(join(run, 'plugins/vision/data/config.json'), JSON.stringify({ ttlSeconds: 1800, maxMediaMiB: 64,
    maxTotalMiB: 256, visualUnderstanding: localConfig }));
  const consumer = join(run, 'plugins/mock-local-source'); await mkdir(consumer);
  await writeFile(join(consumer, 'plugin.yaml'), 'id: mock-local-source\nname: Synthetic local vision source\nversion: 1.0.0\ndescription: Isolated test fixture\n');
  await writeFile(join(consumer, 'index.ts'), `export function apply(ctx) {
    ctx.provide('mock-local-source', {
      newSession: () => ctx.sessions.create('Synthetic local visual session'),
      run: (sessionId, text) => ctx.sessions.run({ sessionId, text, persona: 'a', permission: 'full' }),
    });
  }`);
  await writeFile(join(run, 'a.md'), personaMarker);
  await writeFile(join(run, 'config/config.json'), JSON.stringify({
    log: { level: 'error' }, web: { port: 0 },
    providers: [
      { id: 'main', name: 'Synthetic main', protocol: 'openai-compatible', base_url: `http://127.0.0.1:${port}/main/v1`, api_key: mainKey },
      { id: 'local', name: 'Synthetic local', protocol: 'openai-compatible', base_url: `http://127.0.0.1:${port}/v1`, api_key: localKey,
        proxy_url: '', timeout_seconds: 10 },
    ],
    models: [
      { id: 'selected-main', provider: 'main', name: 'Selected main', model: 'synthetic-main-model', type: 'chat', enabled: true },
      { id: 'fixture', provider: 'local', name: 'Synthetic local vision', model: 'synthetic-local-vision', type: 'chat', enabled: true },
    ],
    model_bindings: { chat: 'selected-main' }, personas: { a: { name: 'Synthetic', file: 'a.md', model: 'selected-main', permission: 'full' } },
    channels: { web: { persona: 'a', permission: 'full' } }, memory: { root: 'memory' },
  }));
  const { boot } = await import(pathToFileURL(join(source, 'core/index.ts')).href);
  let app: any; f.cleanup.push(async () => { await app?.close(); });
  app = await boot(run);
  app.runtime.events.on('tool/called', (event: any) => events.push(event));
  const record = app.runtime.records.get('vision');
  assert.equal(record.status, 'active', record.error); assert.notEqual(record.execution.pid, process.pid);
  const transientSupported = typeof app.tools.registerTransient === 'function';
  if (baseline === 'current') assert.equal(transientSupported, true);
  const registered = app.tools.list().map((tool: any) => tool.function.name);
  for (const name of ['vision_view', 'media_understand', 'screen_view']) assert.equal(registered.includes(name), transientSupported);
  const url = `http://127.0.0.1:${app.web.server.address().port}`;
  const login = await fetch(url + '/api/login', { method: 'POST', body: '{}' });
  const cookie = login.headers.get('set-cookie')!.split(';')[0];
  const getState = async () => (await fetch(url + '/plugins/vision/state', { headers: { Cookie: cookie } })).json() as Promise<any>;
  const state = await getState();
  assert.equal(state.status.localDescriptionTools, transientSupported);
  assert.equal(state.status.localVision.backend, 'ollama');
  assert.deepEqual(state.config.visualUnderstanding, localConfig);
  assert.equal(localCalls.length, 0, 'startup and state polling must not contact local models');
  const oldSave = await fetch(url + '/plugins/vision/config', { method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ revision: state.revision, config: { ttlSeconds: 60, maxMediaMiB: 64, maxTotalMiB: 256 } }) });
  assert.equal(oldSave.status, 200);
  const saved = await getState();
  assert.deepEqual(saved.config.visualUnderstanding, localConfig, 'an older settings client must not erase the explicit local route');
  assert.equal(saved.pendingReload, true); assert.equal(saved.status.ttlSeconds, 1800);
  assert.ok(!JSON.stringify(saved).includes(mainKey) && !JSON.stringify(saved).includes(localKey));
  if (!transientSupported) {
    assert.equal(localCalls.length, 0); assert.equal(mainCalls.length, 0);
    assert.equal(state.status.mediaPreparation, true, 'old hosts retain media preparation but do not downgrade local text to persistent tools');
    return;
  }
  const service = app.runtime.services.get('vision').value, sourceService = app.runtime.services.get('mock-local-source').value;
  const sessionId = await sourceService.newSession(), otherSessionId = await sourceService.newSession();
  const bytes = await png();
  const offered = await service.offerMedia({ sessionId, mime: 'image/png', base64: bytes.toString('base64') });
  const refused = await app.tools.call('vision_view', { mediaRef: offered.mediaRef, sessionId }, { id: otherSessionId, permission: 'full' });
  assert.match(JSON.stringify(refused), /media_unavailable/); assert.equal(localCalls.length, 0);
  viewRef = offered.mediaRef;
  assert.equal(await sourceService.run(sessionId, 'SYNTHETIC_LOCAL_VISION_REQUEST'), finalReply);
  assert.equal(mainCalls.length, 2); assert.deepEqual(localCalls.map(call => call.url), ['/api/show', '/api/chat']);
  assert.equal(localCalls[0].body.model, 'synthetic-local-vision');
  const local = localCalls[1].body, localWire = JSON.stringify(local);
  assert.equal(local.model, 'synthetic-local-vision'); assert.equal(local.options.num_predict, 512); assert.equal(local.stream, false);
  assert.equal(local.messages.length, 2); assert.equal(local.messages[1].images.length, 1);
  const jpegBytes = Buffer.from(local.messages[1].images[0], 'base64');
  assert.deepEqual([...jpegBytes.subarray(0, 3)], [255, 216, 255], 'local provider alone receives the prepared JPEG');
  assert.ok(localWire.includes(question));
  for (const marker of [personaMarker, mainKey, localKey, 'SYNTHETIC_LOCAL_VISION_REQUEST']) assert.ok(!localWire.includes(marker));
  assert.ok(localCalls.every(call => call.authorization === undefined), 'local adapter does not forward unrelated provider credentials');
  assert.ok(mainCalls.every(call => call.model === 'synthetic-main-model'));
  assert.ok(mainCalls.every(call => JSON.stringify(call.messages).includes(personaMarker)), 'main persona stays on the main request');
  const mainWire = JSON.stringify(mainCalls);
  assert.ok(mainWire.includes(localDescription));
  assert.doesNotMatch(mainWire, /"type":"image_url"|data:image\//);
  assert.ok(!mainWire.includes(bytes.toString('base64')));
  assert.ok(!mainWire.includes(local.messages[1].images[0]));
  const toolMessage = mainCalls[1].messages.find((message: any) => message.role === 'tool');
  assert.equal(typeof toolMessage.content, 'string'); assert.ok(toolMessage.content.includes(localDescription));
  await app.runtime.events.drain();
  const toolEvents = events.filter(event => event.name === 'vision_view');
  assert.equal(toolEvents.length, 2); assert.ok(toolEvents.every(event => event.transient === true));
  assert.ok(toolEvents.some(event => event.result?.backend === 'ollama'));
  assert.ok(!JSON.stringify(toolEvents).includes(localDescription));
  const persisted: string[] = [];
  async function collect(directory: string) {
    for (const file of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, file.name);
      if (file.isDirectory()) await collect(path); else persisted.push(await readFile(path, 'utf8'));
    }
  }
  await collect(join(run, 'memory')); await collect(join(run, 'logs'));
  const archive = persisted.join('\n');
  assert.ok(archive.includes(finalReply)); assert.ok(archive.includes('prepare_visual_input'));
  for (const marker of [localDescription, question, bytes.toString('base64'), local.messages[1].images[0], mainKey, localKey]) assert.ok(!archive.includes(marker));
  normalReply = true;
  await sourceService.run(sessionId, 'SYNTHETIC_LOCAL_VISION_FOLLOWUP_REQUEST');
  assert.ok(!JSON.stringify(mainCalls.at(-1)).includes(localDescription));
  assert.equal(localCalls.length, 2, 'later text-only turns do not replay local inference');
  await app.runtime.action('vision', 'stop');
  assert.deepEqual(await readdir(join(run, 'plugins/vision/data/media')), []);
});
