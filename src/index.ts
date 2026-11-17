/*! Copyright (c) 2026 iinukami and contributors.
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7: see LICENSE-ADDITIONAL.
 */
import type { Context, PluginHandler } from 'whalelife';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { Vision } from './runtime.ts';
import { configOf, defaults, visualDefaults, fail, safeError, VERSION, object, type Config, type VisionService } from './types.ts';
import { screenDefaults } from './screen.ts';
import { registerScreenTool } from './screen-tool.ts';
import { audioDefaults } from './audio-types.ts';
import { LocalVision, localVisionDefaults } from './local-vision.ts';
import { AudioEngine } from './audio-engine.ts';
import { registerUnderstandTool } from './understand-tool.ts';
import { settingsPage } from './page.ts';
import { registerViewTool } from './view-tool.ts';
import { VisualToolScope } from './visual-tool-scope.ts';

export async function apply(ctx: Context) {
  let app: Vision | undefined, config: Config = { ...defaults }, error: ReturnType<typeof safeError> | undefined;
  let pendingReload = false, applying = false;
  let appliedRevision: string | undefined, applyError: ReturnType<typeof safeError> | undefined;
  let owned: { app: Vision; tools: VisualToolScope } | undefined;
  const revision = () => createHash('sha256').update(JSON.stringify(config)).digest('hex');
  let saving = Promise.resolve();
  const enqueue = <T>(change: () => Promise<T>): Promise<T> => {
    const result = saving.then(change);
    saving = result.then(() => {}, () => {});
    return result;
  };
  const stopOwned = async () => {
    app = undefined;
    if (!owned) return;
    // Revoke the whole tool invocation before cancelling individual media operations.
    // Never overlap old and new stores: startup sweeps the same temporary directory.
    const previous = owned;
    previous.tools.close();
    const results = await Promise.allSettled([previous.tools.stop(), previous.app.stop()]);
    const failed = results.find(result => result.status === 'rejected');
    if (failed?.status === 'rejected') throw failed.reason;
    owned = undefined;
  };
  ctx.effect(() => async () => { await saving; await stopOwned(); });
  const startOwned = async () => {
    ctx.signal.throwIfAborted();
    const next = new Vision(fileURLToPath(new URL('../data/media/', import.meta.url)), config, ctx.signal);
    const tools = new VisualToolScope();
    owned = { app: next, tools };
    next.localVision = new LocalVision(config.visualUnderstanding, ctx.signal, id => ctx.models.connection(id));
    await next.start();
    // Missing/corrupt local speech resources never disable already working vision.
    try {
      next.audio = new AudioEngine(fileURLToPath(new URL('../data/audio-local/', import.meta.url)), config.audio, ctx.signal,
        id => ctx.models.connection(id));
      await next.audio.start();
    } catch (e) { next.audioInitializationError = safeError(e); }
    ctx.signal.throwIfAborted();
    const viewing = registerViewTool(ctx, next, tools);
    next.mainModelViewing = typeof ctx.tools.registerMultimodal === 'function';
    next.localDescriptionTools = config.visualUnderstanding?.backend === 'ollama' && viewing;
    registerUnderstandTool(ctx, next, tools);
    registerScreenTool(ctx, next, tools);
    ctx.signal.throwIfAborted();
    app = next;
  };
  const applySaved = async () => {
    ctx.signal.throwIfAborted();
    if (app && !applyError && appliedRevision === revision()) { pendingReload = false; return; }
    applying = true; applyError = undefined; appliedRevision = undefined; error = undefined;
    try {
      await stopOwned();
      await startOwned();
      appliedRevision = revision(); pendingReload = false;
    } catch (e) {
      error = applyError = safeError(e); pendingReload = true;
      try { await stopOwned(); } catch (cleanupError) { error = applyError = safeError(cleanupError); }
      throw e;
    } finally { applying = false; }
  };
  try {
    config = configOf(await ctx.config.read());
    await applySaved();
  } catch (e) { error ??= safeError(e); }
  ctx.signal.throwIfAborted();
  const status = () => app?.status() ?? { version: VERSION, mediaPreparation: false, mainModelViewing: false,
    ...(applying ? { code: 'settings_applying', error: '正在应用视听设置。' } : error) };
  const ready = () => {
    if (applying) fail('settings_applying', '正在应用视听设置，请稍后重试。');
    if (!app) fail('not_ready', '视觉插件配置或临时目录不可用，请检查插件设置。');
    return app!;
  };
  const service: VisionService = {
    status,
    offerMedia: (input, options) => ready().offerMedia(input, options),
    describe: (input, options) => ready().describe(input, options),
    prepare: (input, options) => ready().prepare(input, options),
    release: (input, options) => ready().release(input, options),
  };
  ctx.provide('vision', { ...service, audiovisualApiVersion: '1.0.0', understand: (input: Parameters<Vision['understand']>[0], options?: Parameters<Vision['understand']>[1]) => ready().understand(input, options) });
  ctx.tools.register({ name: 'vision_status', danger: 'safe', schema: {},
    description: '检查媒体准备、主模型原生查看和本地视觉描述状态。mainModelViewing 只表示宿主原生图片接口，localDescriptionTools 表示本地文字工具；配置存在不代表所选模型已经通过实际调用。',
    run: status });
  const wrap = (handler: PluginHandler): PluginHandler => async (req, res, context) => {
    try { await handler(req, res, context); }
    catch (e) { if (!res.headersSent) { res.statusCode = 400; res.setHeader('Content-Type', 'application/json; charset=utf-8'); res.end(JSON.stringify({ ok: false, ...safeError(e) })); } }
  };
  ctx.web.page('/plugins/vision/settings', (_req, res) => {
    res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.end(settingsPage);
  }, { title: '视听理解', settings: true, navigation: true });
  ctx.web.page('/plugins/vision/state', wrap(async (req, res) => {
    if (req.method !== 'GET') { res.statusCode = 405; res.end(); return; }
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    let models: { id: string; name: string; type: string }[] = [];
    try { models = ctx.models.list().map(m => ({ id: m.id, name: m.name, type: m.type })); } catch { /* No selected connection is probed here. */ }
    res.end(JSON.stringify({ status: status(), config, audioDefaults, visualDefaults, screenDefaults, localVisionDefaults, models,
      pendingReload, revision: revision(), applySupported: true, applying, appliedRevision, applyError }));
  }));
  ctx.web.api('/plugins/vision/config', wrap(async (req, res, { signal }) => {
    if (req.method !== 'POST') { res.statusCode = 405; res.end(); return; }
    if (!req.headers['content-type']?.startsWith('application/json')) fail('invalid_input', '需要 JSON 配置。');
    let length = 0;
    const parts: Buffer[] = [];
    for await (const chunk of req) { length += chunk.length; if (length > 8192) fail('invalid_input', '配置过大。'); parts.push(Buffer.from(chunk)); }
    signal.throwIfAborted();
    const body = JSON.parse(Buffer.concat(parts).toString('utf8'));
    const incoming = object(body.config);
    if (body.apply !== undefined && typeof body.apply !== 'boolean') fail('invalid_input', 'apply 必须是布尔值。');
    const result = await enqueue(async () => {
      signal.throwIfAborted(); ctx.signal.throwIfAborted();
      if (body.revision !== revision()) fail('conflict', '设置已被修改，请刷新后再保存。');
      const next = configOf({ ...incoming,
        ...(incoming.audio === undefined && config.audio ? { audio: config.audio } : {}),
        ...(incoming.visual === undefined && config.visual ? { visual: config.visual } : {}),
        ...(incoming.screen === undefined && config.screen ? { screen: config.screen } : {}),
        ...(incoming.visualUnderstanding === undefined && config.visualUnderstanding ? { visualUnderstanding: config.visualUnderstanding } : {}),
      });
      await ctx.config.save('config.json', next); config = next; pendingReload = true;
      // Once persisted, application belongs to the plugin lifetime, not the browser connection.
      if (body.apply === true) {
        try { await applySaved(); }
        catch { return { ok: false, saved: true, applied: false, reloadRequired: true, revision: revision(), ...applyError }; }
        return { ok: true, saved: true, applied: true, reloadRequired: false, revision: revision() };
      }
      return { ok: true, saved: true, applied: false, reloadRequired: true, revision: revision() };
    });
    res.statusCode = result.ok ? 200 : 400;
    res.setHeader('Content-Type', 'application/json; charset=utf-8'); res.end(JSON.stringify(result));
  }));
  ctx.web.api('/plugins/vision/apply', wrap(async (req, res, { signal }) => {
    if (req.method !== 'POST') { res.statusCode = 405; res.end(); return; }
    if (!req.headers['content-type']?.startsWith('application/json')) fail('invalid_input', '需要 JSON 请求。');
    let length = 0;
    const parts: Buffer[] = [];
    for await (const chunk of req) { length += chunk.length; if (length > 1024) fail('invalid_input', '应用请求过大。'); parts.push(Buffer.from(chunk)); }
    signal.throwIfAborted();
    const body = object(JSON.parse(Buffer.concat(parts).toString('utf8')));
    const result = await enqueue(async () => {
      signal.throwIfAborted(); ctx.signal.throwIfAborted();
      if (body.revision !== revision()) fail('conflict', '设置已被修改，请刷新后再应用。');
      try { await applySaved(); }
      catch { return { ok: false, saved: true, applied: false, reloadRequired: true, revision: revision(), ...applyError }; }
      return { ok: true, saved: true, applied: true, reloadRequired: false, revision: revision() };
    });
    res.statusCode = result.ok ? 200 : 400;
    res.setHeader('Content-Type', 'application/json; charset=utf-8'); res.end(JSON.stringify(result));
  }));
  ctx.web.api('/plugins/vision/audio/prepare', wrap(async (req, res, { signal }) => {
    if (req.method !== 'POST') { res.statusCode = 405; res.end(); return; }
    if (!req.headers['content-type']?.startsWith('application/json')) fail('invalid_input', '需要 JSON 请求。');
    let length = 0;
    for await (const chunk of req) { length += chunk.length; if (length > 1024) fail('invalid_input', '准备请求过大。'); }
    signal.throwIfAborted();
    const audio = ready().audio;
    if (!audio) fail('audio_unavailable', '声音模块尚未就绪。');
    // User-triggered resource jobs belong to plugin lifetime, not the response/poll request lifetime.
    void audio.prepareResources().catch(() => {});
    res.statusCode = 202; res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ ok: true, state: audio.status() }));
  }));
}
