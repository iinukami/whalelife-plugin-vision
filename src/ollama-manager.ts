/*! Copyright (c) 2026 iinukami and contributors.
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7: see LICENSE-ADDITIONAL.
 */
import type { ModelConnection } from 'whalelife';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Agent, fetch } from 'undici';
import { OllamaInstaller } from './ollama-install.ts';
import { OllamaProcess } from './ollama-process.ts';
import { fail, safeError, VisionError } from './types.ts';

export const OLLAMA_MODEL = 'qwen3-vl:2b';
type Phase = 'idle' | 'checking' | 'downloading_runtime' | 'extracting' | 'starting' | 'downloading_model' | 'ready' | 'error' | 'stopped';
export type OllamaSetupState = {
  supported: boolean; busy: boolean; phase: Phase; installed: boolean; running?: boolean; owned: boolean;
  modelReady?: boolean; model: string; runtimeVersion?: string; downloadedBytes: number; totalBytes: number;
  cleanupPending?: boolean; detail?: string; error?: ReturnType<typeof safeError>;
};
type Installer = Pick<OllamaInstaller, 'inspect' | 'prepare' | 'executable'>;
type Process = Pick<OllamaProcess, 'start' | 'stop' | 'running' | 'owned' | 'close'>;
/** Test-only dependencies; never filled from browser, model or tool input. */
export type OllamaManagerDependencies = {
  installer?: Installer; process?: Process; fetch?: typeof fetch; supported?: boolean;
  ownedOrigin?: string; existingOrigin?: string; startupTimeoutMs?: number;
};

export class OllamaManager {
  private readonly controller = new AbortController();
  private readonly signal: AbortSignal;
  private readonly installer: Installer;
  private readonly process: Process;
  private readonly dispatcher = new Agent({ connect: { timeout: 2000 } });
  private readonly request: typeof fetch;
  private readonly ownedOrigin: string;
  private readonly existingOrigin: string;
  private readonly startupTimeoutMs: number;
  private readonly models: string;
  private value: OllamaSetupState;
  private origin?: string;
  private job?: Promise<void>;
  private jobController?: AbortController;
  private closing?: Promise<void>;

  constructor(root: string, parent: AbortSignal, deps: OllamaManagerDependencies = {}) {
    this.signal = AbortSignal.any([parent, this.controller.signal]);
    this.installer = deps.installer ?? new OllamaInstaller(root, this.signal);
    this.process = deps.process ?? new OllamaProcess(root, this.signal);
    this.request = deps.fetch ?? fetch;
    this.ownedOrigin = deps.ownedOrigin ?? 'http://127.0.0.1:11435';
    this.existingOrigin = deps.existingOrigin ?? 'http://127.0.0.1:11434';
    this.startupTimeoutMs = deps.startupTimeoutMs ?? 30000;
    this.models = join(root, 'models');
    this.value = { supported: deps.supported ?? (process.platform === 'win32' && process.arch === 'x64'),
      busy: false, phase: 'idle', installed: false, owned: false, model: OLLAMA_MODEL, downloadedBytes: 0, totalBytes: 0 };
  }
  status(): OllamaSetupState {
    // A closed window is not proof that its owned process tree has finished cleanup.
    if (this.process.owned() && !this.process.running()) {
      this.origin = undefined;
      this.value = { ...this.value, owned: true, running: false, modelReady: false, cleanupPending: true,
        ...(this.value.busy || this.value.phase === 'error' ? {} : { phase: 'stopped', detail: 'Ollama 窗口已关闭，仍需确认插件启动资源已清理；可重试停止。' }) };
    } else if (this.value.owned && !this.process.owned()) {
      this.origin = undefined;
      this.value = { ...this.value, owned: false, running: false, modelReady: undefined, cleanupPending: false,
        ...(this.value.busy || this.value.phase === 'error' ? {} : { phase: 'stopped', detail: '插件启动的 Ollama 窗口已关闭。' }) };
    }
    return { ...this.value, ...(this.value.error ? { error: { ...this.value.error } } : {}) };
  }
  async init() {
    try { Object.assign(this.value, await this.installer.inspect()); }
    catch (error) { this.value.error = safeError(error); this.value.phase = 'error'; }
  }
  private async json(origin: string, path: string, body: unknown, signal: AbortSignal) {
    const response = await this.request(origin + path, { method: body === undefined ? 'GET' : 'POST',
      dispatcher: this.dispatcher, redirect: 'manual', signal: AbortSignal.any([signal, AbortSignal.timeout(5000)]),
      headers: { 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    try {
      if (!response.ok || !response.body) fail('ollama_connection', '本机 Ollama 未返回有效响应。');
      const chunks: Uint8Array[] = []; let length = 0;
      for await (const part of response.body) {
        length += part.length; if (length > 2 * 1024 * 1024) fail('ollama_response', '本机 Ollama 响应超过限制。');
        chunks.push(part);
      }
      const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (!value || typeof value !== 'object' || Array.isArray(value)) fail('ollama_response', '本机 Ollama 响应无效。');
      return value as Record<string, any>;
    } finally { await response.body?.cancel().catch(() => {}); }
  }
  private async probe(signal: AbortSignal): Promise<boolean> {
    if (this.process.owned() && !this.process.running()) { this.status(); return false; }
    // Do not lose an owned but unhealthy run by switching to another application's service.
    for (const origin of this.process.owned() ? [this.ownedOrigin] : [this.ownedOrigin, this.existingOrigin]) {
      signal.throwIfAborted();
      try {
        const version = await this.json(origin, '/api/version', undefined, signal);
        if (typeof version.version !== 'string' || !/^\d+\.\d+\.\d+[\w.+-]*$/.test(version.version)) continue;
        const tags = await this.json(origin, '/api/tags', undefined, signal);
        if (!Array.isArray(tags.models)) continue;
        let modelReady = false, modelCheckFailed = false;
        if (tags.models.some((model: any) => model?.name === OLLAMA_MODEL || model?.model === OLLAMA_MODEL)) {
          try {
            const model = await this.json(origin, '/api/show', { model: OLLAMA_MODEL }, signal);
            modelReady = ['remote_model', 'remote_host'].every(key => model[key] === undefined || model[key] === '')
              && Array.isArray(model.capabilities) && model.capabilities.includes('vision');
          } catch { signal.throwIfAborted(); modelCheckFailed = true; }
        }
        signal.throwIfAborted();
        this.origin = origin; this.value.running = true; this.value.modelReady = modelReady;
        this.value.owned = origin === this.ownedOrigin && this.process.owned();
        this.value.cleanupPending = false;
        this.value.runtimeVersion = version.version;
        this.value.detail = (this.value.owned ? '由插件启动的本地服务。' : '复用已有本地服务；插件不会关闭它。')
          + (modelCheckFailed ? '服务已识别，但固定模型信息检查失败，请重新准备或检查原服务。' : '');
        return true;
      } catch { if (signal.aborted) signal.throwIfAborted(); }
    }
    this.origin = undefined; this.value.running = false; this.value.owned = this.process.owned(); this.value.modelReady = false;
    this.value.cleanupPending = this.value.owned;
    this.value.detail = this.value.owned ? '插件启动的控制台尚未通过服务检查，可停止后重试。' : '尚未检测到可用的本机 Ollama 服务。';
    return false;
  }
  private stopFailed(): VisionError {
    this.origin = undefined; this.value.owned = this.process.owned(); this.value.running = this.process.running();
    this.value.modelReady = false; this.value.cleanupPending = this.process.owned();
    const error = new VisionError('ollama_stop_failed', '插件启动的 Ollama 资源尚未确认清理完成，请重试停止；未接管其他应用的服务。');
    this.value.phase = 'error'; this.value.error = safeError(error); this.value.detail = '停止尚未完成，插件保留对自有资源的清理责任。';
    return error;
  }
  private async stopOwned() {
    try { await this.process.stop(); }
    catch { throw this.stopFailed(); }
    this.origin = undefined; this.value.running = false; this.value.owned = false;
    this.value.modelReady = undefined; this.value.cleanupPending = false;
  }
  private async start(signal: AbortSignal) {
    if (this.process.owned() && !this.process.running()) await this.stopOwned();
    if (await this.probe(signal)) return;
    if (!this.value.supported) fail('ollama_platform', '一键安装和启动当前支持 Windows x64；其他平台可接入已有模型连接。');
    const executable = await this.installer.executable(signal);
    this.value.phase = 'starting'; this.value.detail = '正在打开本地 Ollama 控制台…';
    const cancelStart = () => { void this.process.stop().catch(() => {}); };
    signal.addEventListener('abort', cancelStart, { once: true });
    try {
      signal.throwIfAborted();
      await this.process.start(executable, this.models);
      const deadline = Date.now() + this.startupTimeoutMs;
      while (Date.now() < deadline) {
        signal.throwIfAborted();
        if (!this.process.running()) fail('ollama_start_failed', 'Ollama 控制台已退出，请检查窗口中的错误后重试。');
        if (await this.probe(signal)) {
          if (!this.value.owned) fail('ollama_port_conflict', '本地端口被其他服务占用，未接管该服务。');
          return;
        }
        await delay(250, undefined, { signal });
      }
      fail('ollama_start_failed', 'Ollama 启动未在限定时间内就绪。');
    } catch (error) {
      await this.stopOwned();
      if (signal.aborted) throw new VisionError('cancelled', 'Ollama 启动已取消，插件启动资源已清理。');
      throw error;
    }
    finally { signal.removeEventListener('abort', cancelStart); }
  }
  private async pull(signal: AbortSignal) {
    const origin = this.origin;
    if (!origin) fail('ollama_not_ready', '请先启动本地 Ollama。');
    this.value.phase = 'downloading_model'; this.value.downloadedBytes = 0; this.value.totalBytes = 0;
    this.value.detail = '正在从 Ollama 官方模型库准备固定视觉模型；已有完整文件会复用。';
    const bounded = AbortSignal.any([signal, AbortSignal.timeout(2 * 60 * 60 * 1000)]);
    const response = await this.request(origin + '/api/pull', { method: 'POST', dispatcher: this.dispatcher,
      redirect: 'manual', signal: bounded, headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: OLLAMA_MODEL, stream: true }) });
    const layers = new Map<string, { total: number; completed: number }>();
    let buffer = '', bytes = 0, lastStatus = '', aggregate: { total: number; completed: number } | undefined;
    const line = (text: string) => {
      if (!text.trim()) return;
      const part = JSON.parse(text);
      if (!part || typeof part !== 'object' || Array.isArray(part) || part.error || typeof part.status !== 'string') fail('ollama_model_download', '模型准备失败，请检查 Ollama 窗口或网络后重试。');
      lastStatus = part.status;
      if (part.digest !== undefined) {
        const isAggregate = part.digest === 'sha256:model' && part.status === 'pulling model';
        // Official ProgressResponse omits zero byte fields; transfer progress uses a fixed aggregate marker.
        const total = part.total === undefined ? 0 : part.total, completed = part.completed === undefined ? 0 : part.completed;
        if (typeof part.digest !== 'string' || (!isAggregate && !/^sha256:[a-f0-9]{64}$/.test(part.digest)) || !Number.isSafeInteger(total) || total < 0 || total > 8 * 1024 ** 3
          || !Number.isSafeInteger(completed) || completed < 0 || completed > total)
          fail('ollama_response', '模型下载进度无效，已停止本次请求。');
        if (isAggregate) aggregate = { total, completed };
        else layers.set(part.digest, { total, completed });
        if (layers.size > 64) fail('ollama_response', '模型下载分片数量异常。');
        const layerTotal = [...layers.values()].reduce((n, layer) => n + layer.total, 0);
        this.value.totalBytes = aggregate?.total ?? layerTotal;
        this.value.downloadedBytes = aggregate?.completed ?? [...layers.values()].reduce((n, layer) => n + layer.completed, 0);
        if (this.value.totalBytes > 8 * 1024 ** 3 || layerTotal > 8 * 1024 ** 3) fail('ollama_response', '模型下载容量超过限制。');
      }
    };
    try {
      if (!response.ok || !response.body) fail('ollama_model_download', 'Ollama 未接受模型下载请求。');
      const decoder = new TextDecoder();
      for await (const chunk of response.body) {
        bounded.throwIfAborted(); bytes += chunk.length;
        if (bytes > 32 * 1024 * 1024) fail('ollama_response', '模型下载状态响应超过限制。');
        buffer += decoder.decode(chunk, { stream: true });
        let end: number;
        while ((end = buffer.indexOf('\n')) !== -1) { const next = buffer.slice(0, end); buffer = buffer.slice(end + 1); if (next.length > 65536) fail('ollama_response', '模型下载状态行超过限制。'); line(next); }
        if (buffer.length > 65536) fail('ollama_response', '模型下载状态行超过限制。');
      }
      buffer += decoder.decode(); line(buffer);
      if (lastStatus !== 'success') fail('ollama_model_download', '模型下载未确认完成，请重试准备。');
    } finally { await response.body?.cancel().catch(() => {}); }
    if (!await this.probe(signal) || !this.value.modelReady) fail('ollama_model_not_ready', '模型下载后未通过本地视觉能力检查。');
  }
  async action(action: 'check' | 'prepare' | 'start' | 'stop' | 'cancel'): Promise<void> {
    this.signal.throwIfAborted();
    if (action === 'cancel') { this.jobController?.abort(); await this.job; return; }
    if (this.job || this.value.busy) fail('ollama_busy', '本地模型正在准备或检查，请等待或取消当前操作。');
    if (action === 'stop') {
      if (!this.process.owned()) fail('ollama_not_owned', '这是已有服务，请从它原来的窗口或应用停止；插件不会接管。');
      this.value.busy = true;
      try { await this.stopOwned(); this.value.error = undefined; this.value.phase = 'stopped'; this.value.detail = '本地服务已停止，已下载文件保留。'; }
      finally { this.value.busy = false; }
      return;
    }
    const controller = new AbortController(); this.jobController = controller;
    const signal = AbortSignal.any([this.signal, controller.signal]);
    this.value.busy = true; this.value.error = undefined; this.value.phase = 'checking';
    const job = Promise.resolve().then(async () => {
      if (action !== 'check' && this.process.owned() && !this.process.running()) await this.stopOwned();
      Object.assign(this.value, await this.installer.inspect());
      if (action === 'check') await this.probe(signal);
      else {
        if (action === 'prepare' && !await this.probe(signal)) {
          if (!this.value.supported) fail('ollama_platform', '一键准备当前支持 Windows x64；可使用已有模型连接。');
          if (!this.value.installed) await this.installer.prepare(signal, progress => Object.assign(this.value, progress));
          Object.assign(this.value, await this.installer.inspect());
        }
        await this.start(signal);
        if (action === 'prepare' && !this.value.modelReady) await this.pull(signal);
      }
      this.value.phase = this.value.running && this.value.modelReady ? 'ready' : 'idle';
    }).catch(error => {
      if (signal.aborted && ((error instanceof VisionError && error.code === 'cancelled') || (error instanceof Error && error.name === 'AbortError'))) {
        this.value.phase = this.value.running && this.value.modelReady ? 'ready' : 'idle';
        this.value.detail = '已取消本次准备请求，已安装组件和完整模型保留；其他客户端共享的下载可能仍在继续。';
      } else {
        const reported = signal.aborted && !(error instanceof VisionError)
          ? new VisionError('ollama_cleanup_failed', 'Ollama 操作停止时发生资源清理错误，尚未确认清理完成，请检查后重试。') : error;
        this.value.error = safeError(reported); this.value.phase = 'error';
      }
    }).finally(() => {
      if (this.job === job) { this.job = undefined; this.jobController = undefined; this.value.busy = false; }
    });
    this.job = job;
  }
  connection(): ModelConnection {
    const state = this.status();
    if (!this.origin || !state.running || !state.modelReady) fail('ollama_not_ready', '请在视听设置检测、准备并启动本地视觉模型。');
    return { id: 'vision-managed-local', name: '插件准备的本地视觉模型', model: OLLAMA_MODEL, type: 'custom',
      provider_id: 'vision-local-runtime', provider_name: '插件本地运行组件', protocol: 'openai-compatible',
      base_url: this.origin + '/v1', api_key: '', proxy_url: '', timeout_seconds: 240,
      parameters: {}, dimensions: null, context_window: 8192 };
  }
  close(): Promise<void> {
    this.controller.abort(); this.jobController?.abort();
    if (this.closing) return this.closing;
    const closing = (async () => {
      await this.job;
      const stopped = await Promise.allSettled([this.process.close(), this.dispatcher.destroy()]);
      const failed = stopped.find(result => result.status === 'rejected');
      if (failed?.status === 'rejected') throw failed.reason;
    })().catch(error => { if (this.closing === closing) this.closing = undefined; throw error; });
    this.closing = closing;
    return closing;
  }
}
