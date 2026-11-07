/*! Copyright (c) 2026 iinukami and contributors.
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7: see LICENSE-ADDITIONAL.
 */
import type { ModelConnection } from 'whalelife';
import { LocalSpeech } from './audio-local.ts';
import { transcribeCloud, understandCloud } from './audio-cloud.ts';
import { analyzeMusic } from './audio-music.ts';
import { audioDefaults, type AudioSettings, type AudioTask, type AudioEvidence, type AudioOutcome } from './audio-types.ts';
import { fail, safeError } from './types.ts';

type LocalBackend = Pick<LocalSpeech, 'start' | 'status' | 'prepare' | 'transcribe' | 'stop'>;
type Adapters = {
  local: LocalBackend;
  transcribe: typeof transcribeCloud;
  understand: typeof understandCloud;
  music: typeof analyzeMusic;
};
type MusicTask = Exclude<AudioTask, 'speech' | 'sound'>;
const musicTasks = new Set<AudioTask>(['rhythm', 'melody', 'chords', 'structure']);
function cut(text: string, bytes: number) {
  const buffer = Buffer.from(text, 'utf8');
  if (buffer.length <= bytes) return text;
  let end = bytes;
  while (end > 0 && (buffer[end] & 0xc0) === 0x80) end--;
  return buffer.subarray(0, end).toString('utf8');
}
/** Tool output has a bounded, truthful projection. A truncated result never claims complete coverage of words. */
function evidenceForMedia(value: AudioEvidence, from: number, duration: number): AudioEvidence {
  if (!value || typeof value.text !== 'string' || !Array.isArray(value.warnings)) fail('invalid_audio_result', '声音后端返回了无效结果。');
  const result: AudioEvidence = { ...value, warnings: value.warnings.filter(w => typeof w === 'string').map(w => cut(w, 500)).slice(0, 8) };
  if (result.segments) result.segments = result.segments.map(s => {
    if (!Number.isFinite(s.startSeconds) || !Number.isFinite(s.endSeconds) || s.startSeconds < 0 || s.endSeconds < s.startSeconds || s.endSeconds > duration + 0.1 || typeof s.text !== 'string')
      fail('invalid_audio_result', '声音后端返回了范围之外的时间标记。');
    return { startSeconds: from + s.startSeconds, endSeconds: from + Math.min(duration, s.endSeconds), text: s.text };
  });
  if (Buffer.byteLength(JSON.stringify(result)) > 6 * 1024) {
    // Preserve useful music candidates and their uncertainty before dropping bulky detail.
    if (result.details) {
      result.details = Object.fromEntries(Object.entries(result.details).map(([key, value]) =>
        [key, Array.isArray(value) ? value.slice(0, 8) : value]));
      result.details.truncated = true;
    }
    if (result.segments) result.segments = result.segments.slice(0, 8);
    result.warnings = ['资料超过单项容量，已截断：长列表只保留前 8 项。请缩小范围补听；不能当作完整转写或完整音乐分析。',
      ...result.warnings.slice(0, 5).map(w => cut(w, 300))];
    if (Buffer.byteLength(JSON.stringify(result)) > 6 * 1024) {
      result.text = cut(result.text, 2500);
      delete result.details;
      delete result.segments;
      result.events = result.events?.slice(0, 8).map(e => cut(e, 80));
      result.timing = 'clip';
    }
  }
  return result;
}

export class AudioEngine {
  settings: AudioSettings;
  adapters: Adapters;
  controller = new AbortController();
  signal: AbortSignal;
  private tail: Promise<unknown> = Promise.resolve();
  private localJobs = 0;
  private preparation?: Promise<void>;
  private connection: (id: string) => ModelConnection;
  constructor(root: string, settings: AudioSettings | undefined, signal: AbortSignal,
    connection: (id: string) => ModelConnection, adapters: Partial<Adapters> = {}) {
    this.connection = connection;
    this.settings = { ...audioDefaults, ...settings };
    this.signal = AbortSignal.any([signal, this.controller.signal]);
    this.adapters = { local: adapters.local ?? new LocalSpeech(root, this.signal, {}, this.settings.resourceProxyUrl),
      transcribe: adapters.transcribe ?? transcribeCloud, understand: adapters.understand ?? understandCloud, music: adapters.music ?? analyzeMusic };
  }
  async start() { await this.adapters.local.start(); }
  status() {
    return { local: this.adapters.local.status(), localJobs: this.localJobs, localConcurrency: 1,
      speechBackend: this.settings.speechBackend, musicBackend: this.settings.musicBackend,
      speechCloudConfigured: !!this.settings.speechModelId, understandingCloudConfigured: !!this.settings.understandingModelId,
      automaticFallback: false };
  }
  /** Only the authenticated settings action calls this; tools/startup never prepare resources. */
  prepareResources() {
    this.signal.throwIfAborted();
    if (!this.preparation) {
      const task = this.adapters.local.prepare();
      this.preparation = task;
      void task.catch(() => {}).finally(() => { if (this.preparation === task) this.preparation = undefined; });
    }
    return this.preparation;
  }
  private selected(id: string): ModelConnection {
    if (!id) fail('audio_model_required', '请在视听设置中为该用途选择模型。');
    try { return this.connection(id); }
    catch { fail('audio_model_unavailable', '所选声音模型配置不存在、已停用或不可读取，请检查原配置。'); }
  }
  private serial<T>(signal: AbortSignal, run: () => Promise<T>): Promise<T> {
    signal.throwIfAborted();
    if (this.localJobs >= 4) fail('audio_busy', '本地声音任务已满，请等待当前任务结束。');
    this.localJobs++;
    const job = this.tail.then(async () => { signal.throwIfAborted(); return run(); });
    this.tail = job.then(() => {}, () => {});
    return new Promise<T>((resolve, reject) => {
      const abort = () => reject(new Error('cancelled'));
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
      void job.then(resolve, reject).finally(() => { this.localJobs--; signal.removeEventListener('abort', abort); });
    });
  }
  async analyze(wav: Buffer, tasks: AudioTask[], fromSeconds: number, durationSeconds: number, signal: AbortSignal): Promise<AudioOutcome[]> {
    const bounded = AbortSignal.any([this.signal, signal]);
    const outcomes: AudioOutcome[] = [];
    let music: Partial<Record<MusicTask, AudioEvidence>> | undefined;
    let musicError: unknown;
    const requestedMusic = tasks.filter(t => musicTasks.has(t)) as MusicTask[];
    for (const task of tasks) {
      bounded.throwIfAborted();
      const backend = task === 'speech' ? this.settings.speechBackend : task === 'sound' ? 'cloud' : this.settings.musicBackend;
      try {
        let evidence: AudioEvidence;
        if (task === 'speech') {
          evidence = backend === 'local'
            ? await this.serial(bounded, () => this.adapters.local.transcribe(wav, bounded))
            : await this.adapters.transcribe(wav, this.selected(this.settings.speechModelId), bounded);
        } else if (backend === 'cloud') {
          evidence = await this.adapters.understand(wav, this.selected(this.settings.understandingModelId), task, bounded);
        } else {
          if (!music && !musicError) {
            try { music = await this.serial(bounded, () => this.adapters.music(wav, requestedMusic, bounded)); }
            catch (error) { musicError = error; }
          }
          if (musicError) throw musicError;
          const found = music?.[task as MusicTask];
          if (!found) fail('audio_analysis_failed', '所选音乐分析没有返回结果。');
          evidence = found;
        }
        bounded.throwIfAborted();
        outcomes.push({ task, backend, status: 'completed', evidence: evidenceForMedia(evidence, fromSeconds, durationSeconds) });
      } catch (error) {
        bounded.throwIfAborted();
        outcomes.push({ task, backend, status: 'failed', ...safeError(error) });
      }
    }
    return outcomes;
  }
  async stop() {
    this.controller.abort();
    await this.adapters.local.stop();
    await Promise.allSettled([this.tail, ...(this.preparation ? [this.preparation] : [])]);
  }
}
