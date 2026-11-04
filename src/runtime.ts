/*! Copyright (c) 2026 iinukami and contributors.
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7: see LICENSE-ADDITIONAL.
 */
import { MediaStore } from './store.ts';
import { BundledDecoder } from './decoder.ts';
import { inspectMedia, prepareMedia } from './media.ts';
import { VERSION, MiB, identity, reference, object, fail, safeError, VisionError,
  type Config, type VisionService, type CallOptions, type PrepareInput } from './types.ts';

export class Vision implements VisionService {
  config: Config;
  store: MediaStore;
  controller = new AbortController();
  signal: AbortSignal;
  pending = new Set<Promise<unknown>>();
  closed = false;
  mainModelViewing = false;
  cleanupFailed = false;
  timer?: ReturnType<typeof setInterval>;
  stopPromise?: Promise<void>;
  decoder: BundledDecoder;
  constructor(root: string, config: Config, signal: AbortSignal, now?: () => number, decoder = new BundledDecoder()) {
    this.config = config; this.store = new MediaStore(root, config, now);
    this.decoder = decoder;
    this.signal = AbortSignal.any([signal, this.controller.signal]);
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
      reason: this.mainModelViewing ? 'ready' : 'multimodal_required',
      modelSupport: 'selected_provider_must_accept_images',
      message: this.mainModelViewing ? '可通过 vision_view 将图片和视频采样画面交给当前主模型。' : '媒体准备服务可用；主模型查看等待宿主公开多模态工具接口。',
      supported: ['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'video/mp4', 'video/webm'],
      videoDecoder: this.decoder.ready ? 'bundled' : 'unavailable', decoder: this.decoder.status(), ...this.store.summary(), activeOperations: this.pending.size,
      ttlSeconds: this.config.ttlSeconds, maxMediaMiB: this.config.maxMediaMiB,
      maxTotalMiB: this.config.maxTotalMiB, cleanupFailed: this.cleanupFailed };
  }
  private operation<T>(run: (signal: AbortSignal) => Promise<T>, options?: CallOptions): Promise<T> {
    const task = (async () => {
      let combined: AbortSignal | undefined;
      try {
        if (this.closed || this.signal.aborted) fail('stopped', '视觉插件已停用。');
        if (this.pending.size >= 2) fail('busy', '视觉处理繁忙，请稍后重试。');
        combined = AbortSignal.any([this.signal, AbortSignal.timeout(120_000), ...(options?.signal ? [options.signal] : [])]);
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
      return this.store.use(session, ref, signal, entry => prepareMedia(entry, input, this.decoder, signal));
    }, options);
  }
  release(input: { sessionId: string; mediaRef: string }, options?: CallOptions) {
    return this.operation(async () => { const o = object(input); return this.store.release(identity(o.sessionId), reference(o.mediaRef)); }, options);
  }
  stop(): Promise<void> {
    if (this.stopPromise) return this.stopPromise;
    this.closed = true;
    this.controller.abort();
    if (this.timer) clearInterval(this.timer);
    this.stopPromise = (async () => {
      await Promise.allSettled([...this.pending]);
      try { await this.store.stop(); } catch (error) { this.cleanupFailed = true; throw error; }
    })();
    return this.stopPromise;
  }
}
