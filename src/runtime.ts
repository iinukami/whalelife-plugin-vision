/*! Copyright (c) 2026 iinukami and contributors.
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7: see LICENSE-ADDITIONAL.
 */
import { MediaStore } from './store.ts';
import { BundledDecoder } from './decoder.ts';
import { inspectMedia, prepareMedia } from './media.ts';
import { audioRange, extractAudio, audioMimes } from './audio-media.ts';
import { audioTasks, type AudioTask } from './audio-types.ts';
import type { AudioEngine } from './audio-engine.ts';
import type { LocalVision } from './local-vision.ts';
import { localVisionDefaults } from './local-vision.ts';
import { ScreenCapture, screenDefaults, type ScreenInput } from './screen.ts';
import { VERSION, MiB, identity, reference, object, fail, safeError, VisionError, visualDefaults,
  type Config, type VisionService, type CallOptions, type PrepareInput, type UnderstandInput, type UnderstoodMedia, type PreparedImage } from './types.ts';

export class Vision implements VisionService {
  config: Config;
  store: MediaStore;
  controller = new AbortController();
  signal: AbortSignal;
  pending = new Set<Promise<unknown>>();
  closed = false;
  mainModelViewing = false;
  localDescriptionTools = false;
  localVision?: LocalVision;
  cleanupFailed = false;
  timer?: ReturnType<typeof setInterval>;
  stopPromise?: Promise<void>;
  decoder: BundledDecoder;
  audio?: AudioEngine;
  screen: ScreenCapture;
  audioInitializationError?: { code: string; error: string };
  constructor(root: string, config: Config, signal: AbortSignal, now?: () => number, decoder = new BundledDecoder()) {
    this.config = config; this.store = new MediaStore(root, config, now);
    this.decoder = decoder;
    this.signal = AbortSignal.any([signal, this.controller.signal]);
    this.screen = new ScreenCapture(config.screen ?? screenDefaults, this.signal);
  }
  async start() {
    this.signal.throwIfAborted();
    await this.store.init();
    await this.decoder.start(this.signal);
    this.signal.throwIfAborted();
    this.timer = setInterval(() => { void this.store.sweep().catch(() => { this.cleanupFailed = true; }); }, 30_000);
    this.timer.unref();
  }
  status() {
    return { version: VERSION, serviceVersion: '1.0.0', mediaPreparation: !this.closed && !this.signal.aborted,
      mainModelViewing: this.mainModelViewing && !this.closed && !this.signal.aborted,
      localDescriptionTools: this.localDescriptionTools && !this.closed && !this.signal.aborted,
      localVision: this.localVision?.status() ?? { backend: this.config.visualUnderstanding?.backend ?? localVisionDefaults.backend, configured: false, busy: false },
      reason: this.config.visualUnderstanding?.backend === 'ollama' ? this.localDescriptionTools ? 'local_description_selected' : 'transient_required' : this.mainModelViewing ? 'ready' : 'multimodal_required',
      modelSupport: this.config.visualUnderstanding?.backend === 'ollama' ? 'local_model_must_accept_images_main_receives_text' : 'selected_provider_must_accept_images',
      message: this.config.visualUnderstanding?.backend === 'ollama'
        ? '已选择本地视觉描述；主模型只收到文字。配置存在不代表 Ollama 或模型已通过实际调用。'
        : this.mainModelViewing ? '可通过 vision_view 将图片和视频采样画面交给当前主模型。' : '媒体准备服务可用；主模型查看等待宿主公开多模态工具接口。',
      supported: ['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'video/mp4', 'video/webm', ...audioMimes],
      audiovisualServiceVersion: '1.0.0', audio: this.audio?.status() ?? { unavailable: true, ...this.audioInitializationError },
      visual: { ...visualDefaults, ...this.config.visual }, screen: this.screen.status(),
      videoDecoder: this.decoder.ready ? 'bundled' : 'unavailable', decoder: this.decoder.status(), ...this.store.summary(), activeOperations: this.pending.size,
      ttlSeconds: this.config.ttlSeconds, maxMediaMiB: this.config.maxMediaMiB,
      maxTotalMiB: this.config.maxTotalMiB, cleanupFailed: this.cleanupFailed };
  }
  private operation<T>(run: (signal: AbortSignal) => Promise<T>, options?: CallOptions, timeout = 120_000): Promise<T> {
    const task = (async () => {
      let combined: AbortSignal | undefined;
      try {
        if (this.closed || this.signal.aborted) fail('stopped', '视觉插件已停用。');
        if (this.pending.size >= 2) fail('busy', '视觉处理繁忙，请稍后重试。');
        combined = AbortSignal.any([this.signal, AbortSignal.timeout(timeout), ...(options?.signal ? [options.signal] : [])]);
        if (combined.aborted) fail('cancelled', '视觉处理已取消。');
        return await run(combined);
      }
      catch (error) { if (combined?.aborted) throw new VisionError('cancelled', '视觉处理已取消或超时。'); const safe = safeError(error); throw new VisionError(safe.code, safe.error); }
    })();
    this.pending.add(task);
    void task.then(() => this.pending.delete(task), () => this.pending.delete(task));
    return task;
  }
  offerMedia(input: { sessionId: string; base64: string; mime: string }, options?: CallOptions) {
    return this.operation(async signal => {
      const o = object(input); const session = identity(o.sessionId);
      if (typeof o.base64 !== 'string' || !o.base64.length || o.base64.length > Math.ceil(this.config.maxMediaMiB * MiB / 3) * 4)
        fail('media_size', '媒体字节为空或超过限制。');
      if (o.base64.length % 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(o.base64))
        fail('invalid_encoding', '媒体必须使用标准 base64 编码。');
      // Check unused pad bits without allocating a second media-sized base64 string.
      const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
      const padding = o.base64.endsWith('==') ? 2 : o.base64.endsWith('=') ? 1 : 0;
      if (padding && alphabet.indexOf(o.base64[o.base64.length - padding - 1]) % (padding === 2 ? 16 : 4) !== 0)
        fail('invalid_encoding', '媒体编码不规范。');
      const bytes = Buffer.from(o.base64, 'base64');
      if (typeof o.mime !== 'string') fail('invalid_input', '需要媒体 MIME 类型。');
      const mime = o.mime;
      return this.store.offer(session, bytes, path => inspectMedia(bytes, path, mime, this.decoder, signal), signal);
    }, options);
  }
  describe(input: { sessionId: string; mediaRef: string }, options?: CallOptions) {
    return this.operation(async () => { const o = object(input); return this.store.public(this.store.lookup(o.sessionId, o.mediaRef)); }, options);
  }
  prepare(input: PrepareInput, options?: CallOptions) {
    return this.operation(async signal => {
      const o = object(input);
      const session = identity(o.sessionId), ref = reference(o.mediaRef);
      return this.store.use(session, ref, signal, entry => prepareMedia(entry, input, this.decoder, signal, this.config.visual));
    }, options);
  }
  understand(input: UnderstandInput, options?: CallOptions): Promise<UnderstoodMedia> {
    return this.operation(async signal => {
      const o = object(input), session = identity(o.sessionId), ref = reference(o.mediaRef);
      if (o.visual !== undefined && typeof o.visual !== 'boolean') fail('invalid_input', '画面开关无效。');
      if (o.audio !== undefined && (!Array.isArray(o.audio) || o.audio.length > audioTasks.length || o.audio.some(t => !audioTasks.includes(t))))
        fail('invalid_input', '声音分析项目无效。');
      return this.store.use(session, ref, signal, async entry => {
        const visual = input.visual ?? entry.info.kind !== 'audio';
        const tasks: AudioTask[] = [...new Set(input.audio ?? (entry.info.hasAudio && input.atSeconds === undefined ? ['speech' as const] : []))];
        if (tasks.length && input.atSeconds !== undefined) fail('invalid_input', '听声音请指定时间段；单帧补看不同时听声音。');
        if (!visual && !tasks.length) fail('invalid_input', '至少选择画面或一种声音分析。');
        const range = tasks.length && entry.info.hasAudio ? audioRange(entry.info, input) : null;
        const result: UnderstoodMedia = { mediaRef: ref, info: { ...entry.info }, status: 'completed',
          audio: { status: tasks.length ? 'no_audio' : 'not_requested', coverage: range, tasks: [] } };
        if (visual) {
          try { result.visual = await prepareMedia(entry, input, this.decoder, signal, this.config.visual); }
          catch (error) { signal.throwIfAborted(); result.visualError = safeError(error); }
        }
        if (range) {
          try {
            if (!this.audio) fail('audio_unavailable', '声音模块尚未就绪，请检查视听设置。');
            const clip = await extractAudio(entry, range, this.decoder, signal);
            result.audio.coverage = clip.coverage;
            result.audio.tasks = await this.audio.analyze(clip.wav, tasks, clip.coverage.fromSeconds,
              clip.coverage.toSeconds - clip.coverage.fromSeconds, signal);
            const done = result.audio.tasks.filter(t => t.status === 'completed').length;
            result.audio.status = done === tasks.length ? 'completed' : done ? 'partial' : 'failed';
          } catch (error) { signal.throwIfAborted(); result.audio = { ...result.audio, status: 'failed', ...safeError(error) }; }
        }
        signal.throwIfAborted();
        const failed = !!result.visualError || ['partial', 'failed'].includes(result.audio.status);
        const completed = !!result.visual || result.audio.tasks.some(t => t.status === 'completed') || result.audio.status === 'no_audio';
        result.status = failed ? completed ? 'partial' : 'failed' : 'completed';
        return result;
      });
    }, options, 240_000);
  }
  release(input: { sessionId: string; mediaRef: string }, options?: CallOptions) {
    return this.operation(async () => { const o = object(input); return this.store.release(identity(o.sessionId), reference(o.mediaRef)); }, options);
  }
  captureScreen(input: ScreenInput, options?: CallOptions) {
    return this.operation(signal => this.screen.capture(input, signal, { ...visualDefaults, ...this.config.visual }), options);
  }
  describeVisual(images: PreparedImage[], question?: string, options?: CallOptions, media?: { sessionId: string; mediaRef: string }) {
    return this.operation(signal => {
      if (!this.localVision) fail('local_vision_unavailable', '本地视觉模块不可用，请检查设置。');
      const run = () => this.localVision!.describe(images, question, signal);
      // Keep the source reference live through local inference and reject a late result after release/expiry.
      return media ? this.store.use(identity(media.sessionId), reference(media.mediaRef), signal, run) : run();
    }, options, 240_000);
  }
  stop(): Promise<void> {
    if (this.stopPromise) return this.stopPromise;
    this.closed = true;
    this.controller.abort();
    if (this.timer) clearInterval(this.timer);
    this.stopPromise = (async () => {
      await this.screen.stop();
      await this.localVision?.stop();
      await this.audio?.stop();
      await Promise.allSettled([...this.pending]);
      try { await this.store.stop(); } catch (error) { this.cleanupFailed = true; throw error; }
    })();
    return this.stopPromise;
  }
}
