import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, cp, writeFile, readFile, rename, unlink, symlink } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { temporaryDirectory, root } from './temporary-directory.ts';
import { png } from './helpers.ts';

const host = resolve(root, '../whalelife');
const visualTools = ['vision_view', 'media_understand', 'screen_view'];

async function fixture(t: TestContext, baseline: 'current' | '213b52b') {
  const f = await temporaryDirectory(t);
  let source = host;
  if (baseline !== 'current') {
    source = join(f.dir, 'host'); await mkdir(source);
    const archive = join(f.dir, 'host.tar');
    const git = spawnSync('git', ['-C', host, 'archive', '--format=tar', '--output=' + archive,
      'refs/tags/' + baseline, 'core', 'package.json'], { encoding: 'utf8', windowsHide: true });
    assert.equal(git.status, 0, git.stderr);
    const tar = spawnSync('tar', ['-xf', archive, '-C', source], { encoding: 'utf8', windowsHide: true });
    assert.equal(tar.status, 0, tar.stderr);
    await symlink(join(host, 'node_modules'), join(source, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
  }
  let modelRequests = 0;
  // Any request is a failure: these settings tests must never run a model.
  const model = createServer((_req, res) => {
    modelRequests++;
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'unexpected synthetic model request' }));
  });
  f.cleanup.push(() => new Promise<void>(done => { model.closeAllConnections(); model.close(() => done()); }));
  await new Promise<void>(done => model.listen(0, '127.0.0.1', done));
  const run = join(f.dir, 'runtime');
  await mkdir(join(run, 'config'), { recursive: true });
  await mkdir(join(run, 'personas'), { recursive: true });
  await mkdir(join(run, 'plugins'), { recursive: true });
  await cp(join(root, 'dist/vision'), join(run, 'plugins/vision'), { recursive: true });
  const consumer = join(run, 'plugins/settings-probe'); await mkdir(consumer);
  await writeFile(join(consumer, 'plugin.yaml'), 'id: settings-probe\nname: Synthetic settings consumer\nversion: 1.0.0\ndescription: Isolated settings acceptance fixture\ndepends: [vision]\n');
  await writeFile(join(consumer, 'index.ts'), `export function apply(ctx) {
    // Cache the public service once: internal settings application must not revoke it.
    const vision = ctx.get('vision');
    ctx.web.api('/plugins/settings-probe/test', async (req, res) => {
      const send = (value, status = 200) => { res.statusCode = status; res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(value)); };
      try {
        let size = 0; const chunks = [];
        for await (const chunk of req) { size += chunk.length; if (size > 1024 * 1024) throw Error('fixture request too large'); chunks.push(chunk); }
        const input = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (input.action === 'capabilities') return send({ native: typeof ctx.tools.registerMultimodal === 'function', local: typeof ctx.tools.registerTransient === 'function' });
        if (input.action === 'session') return send({ id: await ctx.sessions.create('Synthetic settings application') });
        if (input.action === 'tools') return send(ctx.tools.list());
        if (input.action === 'status') return send(await vision.status());
        if (input.action === 'offer') return send(await vision.offerMedia(input.media));
        if (input.action === 'describe') return send(await vision.describe(input.media));
        if (input.action === 'invalidTool') {
          // Validation precedes media preparation and desktop capture in all three tools.
          return send(await ctx.tools.call(input.name, { question: String.fromCharCode(0) },
            { id: input.sessionId, permission: 'full' }));
        }
        throw Error('unknown fixture action');
      } catch (error) { send({ ok: false, code: error?.code || 'fixture_error' }, 400); }
    });
  }`);
  await writeFile(join(run, 'personas/a.md'), 'Synthetic persona; no real conversations or account data.\n');
  await writeFile(join(run, 'config/config.json'), JSON.stringify({
    log: { level: 'error' }, web: { port: 0 },
    providers: [{ id: 'mock', name: 'Synthetic local model', protocol: 'openai-compatible',
      base_url: `http://127.0.0.1:${(model.address() as { port: number }).port}/v1`, api_key: '', proxy_url: '', timeout_seconds: 3 }],
    models: [{ id: 'fixture', provider: 'mock', name: 'Synthetic vision', model: 'synthetic-vl', type: 'chat', enabled: true }],
    model_bindings: { chat: 'fixture' }, personas: { a: { name: 'Synthetic', file: 'personas/a.md', model: 'fixture', permission: 'full' } },
    channels: { web: { persona: 'a', permission: 'full' } }, memory: { root: 'memory' },
  }));
  const { boot } = await import(pathToFileURL(join(source, 'core/index.ts')).href);
  let app: any;
  f.cleanup.push(async () => { await app?.close(); });
  app = await boot(run);
  const base = `http://127.0.0.1:${app.web.server.address().port}`;
  assert.equal((await fetch(base + '/plugins/vision/state')).status, 401);
  const login = await fetch(base + '/api/login', { method: 'POST', body: '{}' });
  assert.equal(login.status, 200);
  const cookie = login.headers.get('set-cookie')!.split(';')[0];
  async function request(path: string, body?: unknown) {
    const response = await fetch(base + path, { method: body === undefined ? 'GET' : 'POST',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(30_000) });
    return { status: response.status, body: await response.json() as any };
  }
  async function state() {
    const response = await request('/plugins/vision/state');
    assert.equal(response.status, 200, JSON.stringify(response.body)); return response.body;
  }
  async function probe(action: string, extra: Record<string, unknown> = {}) {
    return request('/plugins/settings-probe/test', { action, ...extra });
  }
  const capabilities = await probe('capabilities');
  assert.equal(capabilities.status, 200, JSON.stringify(capabilities.body));
  if (baseline === 'current') assert.deepEqual(capabilities.body, { native: true, local: true });
  const session = await probe('session'); assert.equal(session.status, 200);
  const bytes = await png(), sessionId = session.body.id;
  async function offer() {
    const response = await probe('offer', { media: { sessionId, mime: 'image/png', base64: bytes.toString('base64') } });
    assert.equal(response.status, 200, JSON.stringify(response.body)); return response.body;
  }
  async function describe(mediaRef: string) { return probe('describe', { media: { sessionId, mediaRef } }); }
  async function routes(backend: 'main' | 'ollama') {
    const listed = await probe('tools'); assert.equal(listed.status, 200);
    const names = listed.body.map((tool: any) => tool.function.name);
    assert.equal(names.filter((name: string) => name === 'vision_status').length, 1);
    const supported = backend === 'main' ? capabilities.body.native : capabilities.body.local;
    for (const name of visualTools) {
      assert.equal(names.filter((value: string) => value === name).length, supported ? 1 : 0,
        `${name} must have precisely one supported registration after applying ${backend}`);
      if (!supported) continue;
      const response = await probe('invalidTool', { name, sessionId });
      assert.equal(response.status, 200, JSON.stringify(response.body));
      assert.equal(response.body.ok, true, JSON.stringify(response.body));
      if (backend === 'main') {
        assert.ok(Array.isArray(response.body.result), `${name} should retain the multimodal transport`);
        assert.ok(response.body.result.every((part: any) => part.type === 'text'));
        assert.match(JSON.stringify(response.body.result), /invalid_input/);
      } else {
        assert.deepEqual(Object.keys(response.body.result), ['text']);
        assert.match(response.body.result.text, /invalid_input/);
      }
    }
    assert.equal(modelRequests, 0, 'saving, applying and validation failures must not invoke any model');
  }
  return { run, request, state, probe, offer, describe, routes, modelRequests: () => modelRequests };
}

for (const baseline of ['current', '213b52b'] as const) {
  test(`settings apply on ${baseline}: live screen preferences, backend replacement, legacy save, conflicts and failure recovery`,
    { timeout: 120_000 }, async t => {
      const f = await fixture(t, baseline);
      let state = await f.state();
      assert.equal(state.applySupported, true);
      assert.equal(state.ollamaSetup.busy, false);
      assert.equal(state.ollamaSetup.running, undefined, 'initialization must not probe or start a local service');
      const forbiddenSetup = await f.request('/plugins/vision/ollama/prepare', { url: 'https://example.invalid/arbitrary.exe' });
      assert.equal(forbiddenSetup.status, 400); assert.equal(forbiddenSetup.body.code, 'invalid_input');
      const externalStop = await f.request('/plugins/vision/ollama/stop', {});
      assert.equal(externalStop.status, 400); assert.equal(externalStop.body.code, 'ollama_not_owned');
      assert.equal(state.applying, false);
      assert.equal(state.pendingReload, false);
      assert.equal(state.appliedRevision, state.revision);
      assert.equal(state.status.screen.enabled, false);
      await f.routes('main');
      const initialReference = await f.offer();

      const enabled = { ...state.config, screen: { ...state.screenDefaults, enabled: true, target: 'window', seconds: 3 } };
      let response = await f.request('/plugins/vision/config', { config: enabled, revision: state.revision, apply: true });
      assert.equal(response.status, 200, JSON.stringify(response.body));
      assert.equal(response.body.saved, true); assert.equal(response.body.applied, true);
      assert.equal(response.body.reloadRequired, false);
      state = await f.state();
      assert.equal(state.revision, response.body.revision);
      assert.equal(state.appliedRevision, state.revision); assert.equal(state.pendingReload, false);
      assert.equal(state.applying, false); assert.equal(state.status.screen.enabled, true);
      assert.equal(state.status.screen.ready, state.status.screen.supported);
      assert.equal((await f.probe('status')).body.screen.enabled, true, 'cached public service observes the new instance');
      assert.equal((await f.describe(initialReference.mediaRef)).status, 400, 'a real apply invalidates old transient media');
      await f.routes('main'); // Invalid questions must not capture the newly enabled screen.

      const kept = await f.offer(), enabledRevision = state.revision;
      response = await f.request('/plugins/vision/config', { config: state.config, revision: state.revision, apply: true });
      assert.equal(response.status, 200, JSON.stringify(response.body));
      assert.equal(response.body.applied, true); assert.equal(response.body.revision, enabledRevision);
      assert.equal((await f.describe(kept.mediaRef)).status, 200, 'same applied configuration must not recreate the runtime');
      response = await f.request('/plugins/vision/apply', { revision: enabledRevision });
      assert.equal(response.status, 200, JSON.stringify(response.body));
      assert.equal((await f.describe(kept.mediaRef)).status, 200, 'explicit apply is also a no-op when already current');

      // Older clients keep save-only semantics until the explicit plugin-owned apply action.
      response = await f.request('/plugins/vision/config', { revision: enabledRevision,
        config: { ...state.config, screen: { ...state.config.screen, enabled: false } } });
      assert.equal(response.status, 200, JSON.stringify(response.body)); assert.equal(response.body.reloadRequired, true);
      state = await f.state();
      assert.equal(state.config.screen.enabled, false); assert.equal(state.status.screen.enabled, true);
      assert.equal(state.pendingReload, true); assert.equal(state.appliedRevision, enabledRevision);
      assert.equal((await f.describe(kept.mediaRef)).status, 200, 'legacy saving alone must not invalidate media');
      response = await f.request('/plugins/vision/apply', { revision: state.revision });
      assert.equal(response.status, 200, JSON.stringify(response.body)); assert.equal(response.body.applied, true);
      state = await f.state();
      assert.equal(state.status.screen.enabled, false); assert.equal(state.status.screen.ready, false);
      assert.equal(state.pendingReload, false); assert.equal(state.appliedRevision, state.revision);
      assert.equal((await f.describe(kept.mediaRef)).status, 400);

      for (const backend of ['ollama', 'main', 'ollama', 'main'] as const) {
        response = await f.request('/plugins/vision/config', { revision: state.revision, apply: true,
          config: { ...state.config, visualUnderstanding: { backend, modelId: 'fixture', maxTokens: 512 } } });
        assert.equal(response.status, 200, JSON.stringify(response.body)); assert.equal(response.body.applied, true);
        state = await f.state();
        assert.equal(state.status.localVision.backend, backend);
        assert.equal(state.config.visualUnderstanding.modelId, 'fixture');
        assert.equal(state.appliedRevision, state.revision); assert.equal(state.pendingReload, false);
        await f.routes(backend);
      }

      // Both requests use the same revision. The second must validate after the first has committed.
      const concurrentRevision = state.revision;
      const raced = await Promise.all([60, 90].map(ttlSeconds => f.request('/plugins/vision/config', {
        revision: concurrentRevision, apply: true, config: { ...state.config, ttlSeconds },
      })));
      assert.deepEqual(raced.map(result => result.status).sort(), [200, 400]);
      assert.equal(raced.find(result => result.status === 400)!.body.code, 'conflict');
      state = await f.state();
      assert.ok([60, 90].includes(state.config.ttlSeconds));
      assert.equal(state.status.ttlSeconds, state.config.ttlSeconds);
      response = await f.request('/plugins/vision/apply', { revision: concurrentRevision });
      assert.equal(response.status, 400); assert.equal(response.body.code, 'conflict');
      assert.equal((await f.state()).revision, state.revision, 'stale apply must not alter the saved state');
      await f.routes('main');

      // Failure injection touches only this isolated fixture's empty media directory.
      // Old stop succeeds with no media; the next store.init encounters a regular file.
      const mediaRoot = join(f.run, 'plugins/vision/data/media');
      const mediaBackup = join(f.run, 'plugins/vision/data/media-before-failed-apply');
      const previouslyApplied = state.appliedRevision;
      await rename(mediaRoot, mediaBackup);
      try {
        await writeFile(mediaRoot, 'SYNTHETIC_INITIALIZATION_FAILURE', { flag: 'wx' });
        response = await f.request('/plugins/vision/config', { revision: state.revision, apply: true,
          config: { ...state.config, screen: { ...state.config.screen, enabled: true } } });
        assert.equal(response.status, 400, JSON.stringify(response.body));
        assert.equal(response.body.ok, false); assert.equal(response.body.saved, true);
        assert.equal(response.body.applied, false); assert.equal(response.body.reloadRequired, true);
        assert.equal(typeof response.body.code, 'string');
        state = await f.state();
        assert.equal(state.revision, response.body.revision);
        assert.equal(state.config.screen.enabled, true); assert.equal(state.pendingReload, true);
        assert.equal(state.applying, false); assert.ok(state.applyError);
        assert.notEqual(state.appliedRevision, state.revision, 'startup failure must not claim the saved revision is active');
        assert.ok(state.appliedRevision === undefined || state.appliedRevision === previouslyApplied);
        const disk = JSON.parse(await readFile(join(f.run, 'plugins/vision/data/config.json'), 'utf8'));
        assert.deepEqual(disk, state.config, 'failure after saving remains accurately represented on disk');
      } finally {
        await unlink(mediaRoot);
        await rename(mediaBackup, mediaRoot);
      }
      response = await f.request('/plugins/vision/apply', { revision: state.revision });
      assert.equal(response.status, 200, JSON.stringify(response.body)); assert.equal(response.body.applied, true);
      state = await f.state();
      assert.equal(state.status.screen.enabled, true); assert.equal(state.pendingReload, false);
      assert.equal(state.appliedRevision, state.revision); assert.equal(state.applyError, undefined);
      assert.equal((await f.probe('status')).body.screen.enabled, true, 'cached service survives failed apply and retry');
      await f.routes('main');
      assert.equal(f.modelRequests(), 0);
    });
}
