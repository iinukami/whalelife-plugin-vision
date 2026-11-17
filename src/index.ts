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
import { AudioEngine } from './audio-engine.ts';
import { registerUnderstandTool } from './understand-tool.ts';
import { settingsPage } from './page.ts';
import { registerViewTool } from './view-tool.ts';

export async function apply(ctx: Context) {
  let app: Vision | undefined, config: Config = { ...defaults }, error: ReturnType<typeof safeError> | undefined;
  let pendingReload = false;
  const revision = () => createHash('sha256').update(JSON.stringify(config)).digest('hex');
  let saving = Promise.resolve();
  ctx.effect(() => async () => { await saving.catch(() => {}); await app?.stop(); });
  try {
    config = configOf(await ctx.config.read());
    ctx.signal.throwIfAborted();
    app = new Vision(fileURLToPath(new URL('../data/media/', import.meta.url)), config, ctx.signal);
    await app.start();
    // Missing/corrupt local speech resources never disable already working vision.
    try {
      app.audio = new AudioEngine(fileURLToPath(new URL('../data/audio-local/', import.meta.url)), config.audio, ctx.signal,
        id => ctx.models.connection(id));
      await app.audio.start();
    } catch (e) { app.audioInitializationError = safeError(e); }
  } catch (e) { error = safeError(e); await app?.stop(); app = undefined; }
  ctx.signal.throwIfAborted();
  const status = () => app?.status() ?? { version: VERSION, mediaPreparation: false, mainModelViewing: false, ...error };
  const ready = () => { if (!app) fail('not_ready', '视觉插件配置或临时目录不可用，请检查插件设置。'); return app!; };
  const service: VisionService = {
    status,
    offerMedia: (input, options) => ready().offerMedia(input, options),
    describe: (input, options) => ready().describe(input, options),
    prepare: (input, options) => ready().prepare(input, options),
    release: (input, options) => ready().release(input, options),
  };
  ctx.provide('vision', { ...service, audiovisualApiVersion: '1.0.0', understand: (input: Parameters<Vision['understand']>[0], options?: Parameters<Vision['understand']>[1]) => ready().understand(input, options) });
  if (app) app.mainModelViewing = registerViewTool(ctx, app);
  if (app) registerUnderstandTool(ctx, app);
  if (app) registerScreenTool(ctx, app);
  ctx.tools.register({ name: 'vision_status', danger: 'safe', schema: {},
    description: '检查媒体准备和主模型查看能力。mainModelViewing 表示宿主提供原生图片工具接口；所选模型仍须支持图片。准备完成不代表模型已经理解图片或视频。',
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
    res.end(JSON.stringify({ status: status(), config, audioDefaults, visualDefaults, screenDefaults, models, pendingReload, revision: revision() }));
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
    const next = configOf({ ...incoming,
      ...(incoming.audio === undefined && config.audio ? { audio: config.audio } : {}),
      ...(incoming.visual === undefined && config.visual ? { visual: config.visual } : {}),
      ...(incoming.screen === undefined && config.screen ? { screen: config.screen } : {}),
    });
    const change = saving.then(async () => {
      signal.throwIfAborted(); ctx.signal.throwIfAborted();
      if (body.revision !== revision()) fail('conflict', '设置已被修改，请刷新后再保存。');
      await ctx.config.save('config.json', next); config = next; pendingReload = true;
    });
    saving = change.catch(() => {});
    await change;
    res.setHeader('Content-Type', 'application/json; charset=utf-8'); res.end(JSON.stringify({ ok: true, reloadRequired: true }));
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
