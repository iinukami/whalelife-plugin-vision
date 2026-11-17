import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import { settingsPage } from '../src/page.ts';

// A small DOM/fetch fixture executes the shipped page script without opening a
// browser, capturing a desktop, starting a host, or contacting any model.
class OptionFixture {
  textContent: string;
  value: string;
  constructor(text: string, value: string) { this.textContent = text; this.value = value; }
}
type EventFixture = { target: ElementFixture; preventDefault(): void };
type Listener = (event: EventFixture) => unknown;
class ElementFixture {
  tagName = '';
  textContent = '';
  hidden = false;
  disabled = false;
  open = false;
  dataset: Record<string, string> = {};
  options: OptionFixture[] = [];
  parentElement: ElementFixture | undefined;
  elements = { namedItem: (_name: string): ElementFixture | undefined => undefined };
  controls: ElementFixture[] = [];
  listeners = new Map<string, Listener[]>();
  private currentValue = '';
  get value(): string { return this.currentValue; }
  set value(value: unknown) { this.currentValue = String(value); }
  replaceChildren(...options: OptionFixture[]) { this.options = options; this.value = options[0]?.value ?? ''; }
  add(option: OptionFixture) { this.options.push(option); }
  removeAttribute(name: string) { if (name === 'value') this.value = ''; }
  querySelectorAll(selector: string) { assert.equal(selector, 'input,select'); return this.controls; }
  addEventListener(type: string, listener: Listener) {
    const handlers = this.listeners.get(type) ?? []; handlers.push(listener); this.listeners.set(type, handlers);
  }
  async emit(type: string, target = this) {
    for (const listener of this.listeners.get(type) ?? []) await listener({ target, preventDefault() {} });
  }
}

function fixtureState(): any {
  return {
    revision: 'initial-revision', pendingReload: false,
    config: { ttlSeconds: 1800, maxMediaMiB: 64, maxTotalMiB: 256,
      audio: { speechBackend: 'local', musicBackend: 'local', speechModelId: 'saved-stt', understandingModelId: 'saved-omni', resourceProxyUrl: 'http://127.0.0.1:7890/' } },
    visualDefaults: { detail: 'auto', layout: 'frames', focus: 'whole', maxFrames: 8, sampleFps: 2 },
    screenDefaults: { enabled: false, target: 'window', seconds: 10 },
    audioDefaults: { speechBackend: 'local', musicBackend: 'local', speechModelId: '', understandingModelId: '', resourceProxyUrl: '' },
    models: [{ id: 'saved-stt', name: 'Synthetic STT', type: 'stt' }, { id: 'saved-omni', name: 'Synthetic Omni', type: 'custom' }],
    status: {
      mediaPreparation: true, mainModelViewing: true, decoder: { ready: true },
      visual: { detail: 'auto', layout: 'frames', focus: 'whole', maxFrames: 8, sampleFps: 2 },
      screen: { enabled: false, supported: true, busy: false },
      audio: { speechBackend: 'local', musicBackend: 'local', speechCloudConfigured: true, understandingCloudConfigured: true,
        local: { supported: true, ready: false, phase: 'missing', downloadBytes: 0, totalBytes: 260887284, fixedThreads: 8 } }
    }
  };
}

async function page(initial = fixtureState()) {
  const ids = new Map<string, ElementFixture>(), fields = new Map<string, ElementFixture>();
  for (const match of settingsPage.matchAll(/<([a-z][\w-]*)\b([^>]*)>/gi)) {
    const attributes = new Map(Array.from(match[2].matchAll(/([\w-]+)(?:="([^"]*)")?/g), x => [x[1], x[2] ?? '']));
    const node = new ElementFixture(); node.tagName = match[1].toUpperCase();
    node.hidden = attributes.has('hidden'); node.disabled = attributes.has('disabled'); node.open = attributes.has('open');
    node.value = attributes.get('value') ?? '';
    if (attributes.has('id')) ids.set(attributes.get('id')!, node);
    if (['INPUT', 'SELECT'].includes(node.tagName) && attributes.has('name')) fields.set(attributes.get('name')!, node);
  }
  for (const select of settingsPage.matchAll(/<select\b[^>]*name="([^"]+)"[^>]*>([\s\S]*?)<\/select>/g)) {
    const options = Array.from(select[2].matchAll(/<option\b[^>]*value="([^"]*)"[^>]*>([^<]*)<\/option>/g), m => new OptionFixture(m[2], m[1]));
    fields.get(select[1])!.replaceChildren(...options);
  }
  const element = (id: string) => { const found = ids.get(id); assert.ok(found, 'page element #' + id); return found; };
  const field = (name: string) => { const found = fields.get(name); assert.ok(found, 'page field ' + name); return found; };
  const form = element('settings'); form.elements.namedItem = name => fields.get(name); form.controls = Array.from(fields.values());
  const requests: { path: string; method: string; body?: any }[] = [];
  const state = structuredClone(initial);
  let poll: (() => unknown) | undefined, timer = false;
  const exits: (() => unknown)[] = [];
  const controls = { failRead: false, failPrepare: false };
  const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
  const fetchFixture = async (path: string, options?: { method?: string; body?: string }) => {
    const method = options?.method ?? 'GET', body = options?.body ? JSON.parse(options.body) : undefined;
    requests.push({ path, method, body });
    if (path === '/plugins/vision/state' && method === 'GET') return controls.failRead ? json({}, 503) : json(state);
    if (path === '/plugins/vision/config' && method === 'POST') {
      if (body.revision !== state.revision) return json({ ok: false, code: 'conflict', error: '设置已被修改，请刷新后再保存。' }, 400);
      state.config = structuredClone(body.config);
      if (state.config.audio.resourceProxyUrl) state.config.audio.resourceProxyUrl = new URL(state.config.audio.resourceProxyUrl).href;
      state.revision += '-saved'; state.pendingReload = true;
      return json({ ok: true, reloadRequired: true });
    }
    if (path === '/plugins/vision/audio/prepare' && method === 'POST') {
      if (controls.failPrepare) return json({ ok: false, error: '合成资源准备失败' }, 503);
      Object.assign(state.status.audio.local, { phase: 'downloading', downloadBytes: 1024 });
      return json({ ok: true }, 202);
    }
    throw Error('Unexpected request: ' + method + ' ' + path);
  };
  class FormDataFixture extends Map<string, string> {
    constructor(node: ElementFixture) { super(Array.from(fields).filter(([, input]) => !input.disabled).map(([name, input]) => [name, input.value])); assert.equal(node, form); }
  }
  const script = settingsPage.match(/<script type="module">([\s\S]*?)<\/script>/)![1];
  await runInNewContext('(async()=>{' + script + '\n})()', {
    document: { querySelector: (selector: string) => { assert.match(selector, /^#/); return element(selector.slice(1)); }, hidden: false },
    FormData: FormDataFixture, Option: OptionFixture, fetch: fetchFixture,
    setInterval: (fn: () => unknown, milliseconds: number) => { assert.equal(milliseconds, 2000); poll = fn; timer = true; return 1; },
    clearInterval: (id: number) => { assert.equal(id, 1); timer = false; },
    addEventListener: (name: string, fn: () => unknown) => { assert.equal(name, 'pagehide'); exits.push(fn); }
  }, { filename: 'vision-settings-page.js', timeout: 1000 });
  return {
    state, requests, controls, element, field,
    async edit(name: string, value: string) { field(name).value = value; await form.emit('input', field(name)); await form.emit('change', field(name)); },
    submit: () => form.emit('submit'),
    prepare: () => element('prepare').emit('click'),
    async poll() { assert.ok(poll); poll(); await new Promise<void>(done => setImmediate(done)); },
    close() { for (const fn of exits) fn(); assert.equal(timer, false); }
  };
}

test('settings initialize legacy config without collection and keep visual readiness independent of speech resources', async t => {
  const initial = fixtureState(); delete initial.config.audio;
  const h = await page(initial); t.after(() => h.close());
  assert.equal(h.field('visualDetail').value, 'auto'); assert.equal(h.field('visualMaxFrames').value, '8');
  assert.equal(h.field('visualSampleFps').value, '2'); assert.equal(h.field('screenEnabled').value, 'false');
  assert.equal(h.field('screenTarget').value, 'window'); assert.equal(h.field('screenSeconds').value, '10');
  assert.equal(h.field('speechBackend').value, 'local'); assert.equal(h.field('speechModelId').value, ''); assert.equal(h.field('resourceProxyUrl').value, '');
  assert.equal(h.field('visualUnderstandingBackend').value, 'main'); assert.equal(h.field('localVisionModelId').value, '');
  assert.equal(h.field('localVisionMaxTokens').value, '512'); assert.equal(h.element('localVisionOptions').hidden, true);
  assert.equal(h.element('localVisionAdvanced').hidden, true, 'old state without new defaults keeps main-model mode');
  assert.equal(h.element('screenOptions').hidden, true); assert.equal(h.element('save').disabled, true);
  assert.match(h.element('state').textContent, /画面准备已就绪/);
  assert.match(h.element('imageState').textContent, /接口已支持/);
  assert.match(h.element('imageHint').textContent, /仍须支持图片.*未测试/);
  assert.match(h.element('speechState').textContent, /尚未就绪/);
  assert.equal(h.element('prepare').disabled, false);
  assert.deepEqual(h.requests.map(r => r.path), ['/plugins/vision/state']);
  assert.match(settingsPage, /href="\/#plugins" target="_top"/);
});

test('saving visual and screen choices retains hidden sound settings and reads normalized config back without changing runtime status', async t => {
  const initial = fixtureState(); initial.models = [];
  const h = await page(initial); t.after(() => h.close());
  assert.equal(h.element('speechCloud').hidden, true);
  assert.ok(h.field('speechModelId').options.some(option => option.value === 'saved-stt'));
  await h.edit('visualDetail', 'detail'); await h.edit('visualLayout', 'sheet'); await h.edit('visualFocus', 'auto');
  await h.edit('visualMaxFrames', '4'); await h.edit('visualSampleFps', '6');
  await h.edit('screenEnabled', 'true'); await h.edit('screenTarget', 'screen'); await h.edit('screenSeconds', '24');
  await h.edit('resourceProxyUrl', 'http://127.0.0.1:7890');
  assert.equal(h.element('screenOptions').hidden, false);
  assert.match(h.element('screenState').textContent, /未开启/, 'draft must not look enabled at runtime');
  await h.submit();
  const posted = h.requests.find(r => r.path === '/plugins/vision/config')!.body.config;
  assert.deepEqual(posted.visual, { detail: 'detail', layout: 'sheet', focus: 'auto', maxFrames: 4, sampleFps: 6 });
  assert.deepEqual(posted.screen, { enabled: true, target: 'screen', seconds: 24 });
  assert.deepEqual(posted.audio, { ...initial.config.audio, resourceProxyUrl: 'http://127.0.0.1:7890' });
  assert.equal(h.field('resourceProxyUrl').value, 'http://127.0.0.1:7890/');
  assert.equal(h.element('save').disabled, true); assert.equal(h.element('manage').hidden, false);
  assert.match(h.element('saveState').textContent, /等待重载/); assert.match(h.element('visualCurrent').textContent, /自动画质.*全景优先.*最多 8 帧/);
  assert.match(h.element('screenState').textContent, /未开启/);
  assert.equal(h.element('prepare').disabled, true, 'pending reload blocks resource preparation');
  await h.edit('screenEnabled', 'false'); assert.equal(h.element('screenOptions').hidden, true);
  await h.submit();
  const last = h.requests.filter(r => r.path === '/plugins/vision/config').at(-1)!.body.config;
  assert.deepEqual(last.screen, { enabled: false, target: 'screen', seconds: 24 }, 'hidden screen choices are retained');
  assert.deepEqual(last.audio, initial.config.audio);
});

test('polling and config conflicts preserve draft fields, saved revision, and actual running screen status', async t => {
  const h = await page(); t.after(() => h.close());
  await h.edit('visualFocus', 'auto'); await h.edit('screenEnabled', 'true'); await h.edit('screenSeconds', '30');
  await h.edit('speechBackend', 'cloud'); await h.edit('speechModelId', '');
  assert.equal(h.element('speechWarning').hidden, false);
  h.state.revision = 'concurrent-revision'; h.state.config.visual = { ...h.state.visualDefaults, detail: 'overview' };
  h.state.status.screen = { enabled: true, supported: true, busy: true };
  await h.poll();
  assert.equal(h.field('visualDetail').value, 'auto'); assert.equal(h.field('visualFocus').value, 'auto');
  assert.equal(h.field('screenSeconds').value, '30'); assert.match(h.element('screenState').textContent, /正在采集/);
  await h.submit();
  assert.equal(h.requests.find(r => r.path === '/plugins/vision/config')!.body.revision, 'initial-revision');
  assert.equal(h.element('saveError').hidden, false); assert.match(h.element('saveError').textContent, /设置已被修改/);
  assert.equal(h.field('screenEnabled').value, 'true'); assert.equal(h.field('visualFocus').value, 'auto');
  assert.equal(h.field('speechModelId').disabled, false); assert.equal(h.element('save').disabled, false);
  await h.poll(); assert.equal(h.field('screenSeconds').value, '30');
});

test('read failures preserve inputs and capability warnings distinguish unsupported platforms, decoder, and audio failures', async t => {
  const initial = fixtureState(); initial.status.audio = { unavailable: true, error: '合成声音模块错误' };
  initial.status.screen.supported = false; initial.status.decoder.ready = false;
  const h = await page(initial); t.after(() => h.close());
  assert.match(h.element('imageState').textContent, /接口已支持/); assert.match(h.element('videoState').textContent, /解码组件未就绪/);
  assert.match(h.element('screenState').textContent, /当前平台不支持/);
  assert.match(h.element('localError').textContent, /合成声音模块错误/); assert.equal(h.element('prepare').disabled, true);
  await h.edit('screenEnabled', 'true'); assert.equal(h.element('screenWarning').hidden, false);
  await h.edit('visualLayout', 'sheet'); h.controls.failRead = true; await h.poll();
  assert.equal(h.field('visualLayout').value, 'sheet'); assert.equal(h.element('save').disabled, true);
  assert.match(h.element('saveState').textContent, /连接中断/);
  h.controls.failRead = false; h.state.status.mainModelViewing = false; h.state.status.screen.supported = true; await h.poll();
  assert.match(h.element('imageState').textContent, /主模型查看暂不可用/);
  assert.match(h.element('screenWarning').textContent, /多模态接口/);
  assert.equal(h.field('visualLayout').value, 'sheet'); assert.equal(h.element('save').disabled, false);
});

test('resource preparation remains explicit and respects proxy drafts, progress, retry, and readiness', async t => {
  const h = await page(); t.after(() => h.close());
  await h.edit('resourceProxyUrl', 'http://127.0.0.1:9000/');
  assert.equal(h.element('prepare').disabled, true); assert.match(h.element('prepareNotice').textContent, /先保存并重载/);
  await h.prepare(); assert.equal(h.requests.some(r => r.path.endsWith('/audio/prepare')), false);
  await h.edit('resourceProxyUrl', 'http://127.0.0.1:7890/');
  assert.equal(h.element('prepare').disabled, false); assert.equal(h.element('prepareNotice').textContent, '');
  h.controls.failPrepare = true; await h.prepare();
  assert.match(h.element('prepareNotice').textContent, /合成资源准备失败/); assert.equal(h.element('prepare').disabled, false);
  h.controls.failPrepare = false; await h.prepare();
  assert.equal(h.element('prepare').disabled, true); assert.equal(h.element('downloadArea').hidden, false);
  assert.deepEqual(h.requests.filter(r => r.path.endsWith('/audio/prepare')).map(r => r.body), [{}, {}]);
  Object.assign(h.state.status.audio.local, { phase: 'ready', ready: true, downloadBytes: 260887284 }); await h.poll();
  assert.equal(h.element('prepare').disabled, true); assert.equal(h.element('downloadArea').hidden, true);
  assert.equal(h.element('prepareNotice').textContent, ''); assert.match(h.element('speechState').textContent, /已就绪/);
  assert.ok(h.requests.every(r => ['/plugins/vision/state', '/plugins/vision/config', '/plugins/vision/audio/prepare'].includes(r.path)));
});

function localVisionState(): any {
  const state = fixtureState();
  state.localVisionDefaults = { backend: 'main', modelId: '', maxTokens: 512 };
  state.config.visualUnderstanding = { backend: 'ollama', modelId: 'local-vision', maxTokens: 512 };
  state.models.push({ id: 'local-vision', name: 'Synthetic local vision', type: 'chat' });
  state.status.localVision = { backend: 'ollama', configured: true, busy: false };
  state.status.localDescriptionTools = true;
  return state;
}

test('local description uses transient text capability without requiring main-model images or claiming the connection was tested', async t => {
  const initial = localVisionState();
  initial.status.mainModelViewing = false; initial.status.screen.enabled = true;
  initial.config.screen = { ...initial.screenDefaults, enabled: true };
  initial.status.localVision.available = false;
  const h = await page(initial); t.after(() => h.close());
  assert.equal(h.element('localVisionOptions').hidden, false); assert.equal(h.element('localVisionAdvanced').hidden, false);
  assert.equal(h.element('localVisionWarning').hidden, true); assert.equal(h.element('screenWarning').hidden, true);
  assert.match(h.element('imageState').textContent, /已选择本地模型.*调用时检查/);
  assert.match(h.element('imageHint').textContent, /只收到描述文字.*未测试/);
  assert.doesNotMatch(h.element('imageHint').textContent, /主模型.*须支持图片/);
  assert.match(h.element('screenState').textContent, /已开启.*按需采集/);
  assert.match(h.element('localVisionCurrent').textContent, /原图不发送给主模型/);
  assert.match(h.element('visualUnderstandingHelp').textContent, /文本费用.*漏细节.*不会自动切回/);
  assert.match(h.element('state').textContent, /已选择本地画面描述.*检查兼容性/);
  assert.doesNotMatch(h.element('state').textContent, /已就绪|已通过/);
  h.state.status.localVision.busy = true; await h.poll();
  assert.match(h.element('imageState').textContent, /正在生成本地描述/);
  assert.deepEqual(h.requests.map(r => r.path), ['/plugins/vision/state', '/plugins/vision/state']);
});

test('switching understanding backends retains hidden model IDs and all sound, visual and screen configuration until reload', async t => {
  const initial = localVisionState();
  initial.config.visualUnderstanding = { backend: 'main', modelId: 'removed-local-model', maxTokens: 768 };
  initial.config.visual = { ...initial.visualDefaults, layout: 'sheet', focus: 'auto', maxFrames: 4, sampleFps: 6 };
  initial.config.screen = { enabled: false, target: 'screen', seconds: 25 };
  initial.status.localVision.backend = 'main';
  initial.models.push({ id: 'embedding-only', name: 'Synthetic embedding', type: 'embedding' });
  const h = await page(initial); t.after(() => h.close());
  assert.equal(h.element('localVisionOptions').hidden, true);
  assert.ok(h.field('localVisionModelId').options.some(option => option.value === 'removed-local-model'));
  assert.ok(h.field('localVisionModelId').options.some(option => option.value === 'local-vision'));
  assert.ok(h.field('localVisionModelId').options.some(option => option.value === 'saved-omni'));
  assert.ok(!h.field('localVisionModelId').options.some(option => ['saved-stt', 'embedding-only'].includes(option.value)));
  await h.edit('ttlSeconds', '1200'); await h.submit();
  assert.deepEqual(h.requests.find(r => r.path.endsWith('/config'))!.body.config.visualUnderstanding, initial.config.visualUnderstanding);
  await h.edit('visualUnderstandingBackend', 'ollama'); await h.edit('localVisionModelId', 'local-vision');
  await h.edit('localVisionMaxTokens', '1024');
  assert.equal(h.element('localVisionOptions').hidden, false);
  assert.match(h.element('visualModeBadge').textContent, /主模型直接看/, 'draft is not running configuration');
  await h.submit();
  const posted = h.requests.filter(r => r.path.endsWith('/config')).at(-1)!.body.config;
  assert.deepEqual(posted.visualUnderstanding, { backend: 'ollama', modelId: 'local-vision', maxTokens: 1024 });
  assert.deepEqual(posted.audio, initial.config.audio); assert.deepEqual(posted.visual, initial.config.visual); assert.deepEqual(posted.screen, initial.config.screen);
  assert.match(h.element('saveState').textContent, /等待重载/); assert.match(h.element('visualModeBadge').textContent, /主模型直接看/);
  h.state.pendingReload = false; h.state.status.localVision.backend = 'ollama'; h.state.status.mainModelViewing = false;
  await h.poll(); assert.match(h.element('visualModeBadge').textContent, /本地 Ollama 描述/);
  await h.edit('visualUnderstandingBackend', 'main'); assert.equal(h.element('localVisionOptions').hidden, true);
  assert.equal(h.element('localVisionAdvanced').hidden, true); await h.submit();
  const last = h.requests.filter(r => r.path.endsWith('/config')).at(-1)!.body.config;
  assert.deepEqual(last.visualUnderstanding, { backend: 'main', modelId: 'local-vision', maxTokens: 1024 });
  assert.deepEqual(last.audio, initial.config.audio); assert.deepEqual(last.visual, initial.config.visual); assert.deepEqual(last.screen, initial.config.screen);
  assert.match(h.element('visualModeBadge').textContent, /本地 Ollama 描述/, 'saved main mode still waits for reload');
});

test('local-mode drafts survive polling and a stale-revision conflict without changing runtime state', async t => {
  const initial = localVisionState(); initial.status.mainModelViewing = false;
  const h = await page(initial); t.after(() => h.close());
  await h.edit('localVisionModelId', 'saved-omni'); await h.edit('localVisionMaxTokens', '128');
  h.state.revision = 'concurrent-local-change';
  h.state.config.visualUnderstanding = { backend: 'main', modelId: 'different-config', maxTokens: 768 };
  await h.poll();
  assert.equal(h.field('visualUnderstandingBackend').value, 'ollama');
  assert.equal(h.field('localVisionModelId').value, 'saved-omni'); assert.equal(h.field('localVisionMaxTokens').value, '128');
  await h.submit();
  assert.equal(h.requests.find(r => r.path.endsWith('/config'))!.body.revision, 'initial-revision');
  assert.match(h.element('saveError').textContent, /设置已被修改/);
  assert.equal(h.field('localVisionModelId').value, 'saved-omni'); assert.equal(h.field('localVisionMaxTokens').value, '128');
  assert.equal(h.field('localVisionModelId').disabled, false); assert.match(h.element('visualModeBadge').textContent, /本地 Ollama 描述/);
});

test('switching to main restores only invalid hidden local budgets and keeps model choices in submitted config', async t => {
  for (const savedBudget of [768, undefined]) {
    const initial = savedBudget === undefined ? fixtureState() : localVisionState();
    if (savedBudget !== undefined) initial.config.visualUnderstanding.maxTokens = savedBudget;
    const h = await page(initial); t.after(() => h.close());
    const expectedBudget = savedBudget ?? 512;
    for (const invalidBudget of ['', '127', '1025', '128.5', 'not-a-number']) {
      await h.edit('visualUnderstandingBackend', 'ollama');
      await h.edit('localVisionModelId', 'saved-omni');
      await h.edit('localVisionMaxTokens', invalidBudget);
      assert.equal(h.field('localVisionMaxTokens').value, invalidBudget, 'visible invalid input remains editable');
      await h.edit('visualUnderstandingBackend', 'main');
      assert.equal(h.element('localVisionAdvanced').hidden, true);
      assert.equal(h.field('localVisionMaxTokens').value, String(expectedBudget));
      assert.equal(h.field('localVisionMaxTokens').disabled, false, 'hidden budget must remain in FormData');
      assert.equal(h.field('localVisionModelId').value, 'saved-omni');
      await h.submit();
      const posted = h.requests.filter(r => r.path.endsWith('/config')).at(-1)!.body.config;
      assert.deepEqual(posted.visualUnderstanding, { backend: 'main', modelId: 'saved-omni', maxTokens: expectedBudget });
      assert.deepEqual(posted.audio, initial.config.audio);
    }
    await h.edit('visualUnderstandingBackend', 'ollama');
    await h.edit('localVisionMaxTokens', '256');
    await h.edit('visualUnderstandingBackend', 'main');
    assert.equal(h.field('localVisionMaxTokens').value, '256', 'valid unsaved budget survives hiding');
    await h.submit();
    assert.deepEqual(h.requests.filter(r => r.path.endsWith('/config')).at(-1)!.body.config.visualUnderstanding,
      { backend: 'main', modelId: 'saved-omni', maxTokens: 256 });
  }
});

test('missing local selection or transient support never falls back to the available main-model image interface', async t => {
  const initial = localVisionState(); initial.config.visualUnderstanding.modelId = '';
  initial.config.screen = { ...initial.screenDefaults, enabled: true };
  initial.status.localVision = { backend: 'ollama', configured: false, busy: false, available: true };
  initial.status.screen.enabled = true;
  const h = await page(initial); t.after(() => h.close());
  assert.equal(h.element('localVisionWarning').hidden, false);
  assert.match(h.element('imageState').textContent, /待选择本地看图模型/);
  assert.match(h.element('screenState').textContent, /待选择本地模型/);
  assert.match(h.element('screenWarning').textContent, /尚未选择模型/);
  assert.match(h.element('state').textContent, /尚未选择模型/);
  h.state.status.localVision.configured = true; h.state.status.localDescriptionTools = false; await h.poll();
  assert.match(h.element('imageState').textContent, /本地描述需宿主支持/);
  assert.match(h.element('screenWarning').textContent, /临时文字工具接口/);
  assert.match(h.element('state').textContent, /需宿主文字工具支持/);
  assert.ok(h.requests.every(r => r.path === '/plugins/vision/state'), 'rendering never starts a local model or automatic fallback');
});
