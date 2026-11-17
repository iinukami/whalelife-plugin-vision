/*! Copyright (c) 2026 iinukami and contributors.
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7: see LICENSE-ADDITIONAL.
 */
import { spawn, type ChildProcessByStdio } from 'node:child_process';
import type { Readable } from 'node:stream';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { VisionError, type PreparedImage } from './types.ts';

export type ScreenSettings = { enabled: boolean; target: 'screen' | 'window'; seconds: number };
export const screenDefaults: ScreenSettings = { enabled: false, target: 'window', seconds: 10 };
export type ScreenInput = { mode?: 'snapshot' | 'observe'; target?: 'screen' | 'window'; seconds?: number };
type ScreenVisualSettings = { detail?: 'auto' | 'overview' | 'detail'; layout?: 'frames' | 'sheet';
  focus?: 'whole' | 'auto'; maxFrames?: number; sampleFps?: 1 | 2 | 4 | 6 };
export type ScreenRequest = { mode: 'snapshot' | 'observe'; target: 'screen' | 'window'; seconds: number;
  fps: number; maxSide: number };
export type ScreenFrame = { atSeconds: number; width: number; height: number; jpeg: Uint8Array;
  /** One token for this capture's target; never a title, path or user-provided handle. */
  targetId: string; capturedAt?: string };
export type ScreenSource = (request: ScreenRequest, signal: AbortSignal) => AsyncIterable<ScreenFrame>;
export type ScreenResult = {
  mode: 'snapshot' | 'observe'; target: 'screen' | 'window'; detail: 'overview' | 'detail';
  images: PreparedImage[];
  coverage: { requestedSeconds: number; fromSeconds: number; toSeconds: number; observedSeconds: number;
    selectedTimes: number[]; capturedFrames: number; requestedSampleIntervalSeconds: number | null;
    startedAt: string | null; endedAt: string | null; timelineComplete: false; audioIncluded: false };
  warnings: string[];
};

// Keep module initialization independent of types.ts, which also imports these config defaults.
const MAX_INPUT = 4 * 1024 * 1024;
const MAX_LINE = 6 * 1024 * 1024;
const MAX_IMAGE = 2 * 1024 * 1024;
const MAX_OUTPUT = 8 * 1024 * 1024;
const MAX_PIXELS = 40_000_000;
function error(code: string, message: string): never { throw new VisionError(code, message); }
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) error('invalid_input', '看屏参数必须是对象。');
  return value as Record<string, unknown>;
}
function finite(value: unknown, low: number, high: number, message: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < low || value > high) error('invalid_input', message);
  return value;
}
export function screenSettingsOf(value: unknown): ScreenSettings {
  if (value === undefined) return { ...screenDefaults };
  const o = record(value), result = { ...screenDefaults };
  if (o.enabled !== undefined) {
    if (typeof o.enabled !== 'boolean') error('invalid_config', '按需看屏开关无效。');
    result.enabled = o.enabled;
  }
  if (o.target !== undefined) {
    if (o.target !== 'window' && o.target !== 'screen') error('invalid_config', '看屏范围无效。');
    result.target = o.target;
  }
  if (o.seconds !== undefined) {
    result.seconds = finite(o.seconds, 2, 60, '持续观察时长须为 2–60 秒。');
    if (!Number.isInteger(result.seconds)) error('invalid_config', '默认观察时长须为整数秒。');
  }
  return result;
}

type ScreenChild = ChildProcessByStdio<null, Readable, Readable>;
/** Fixed executable/script/argument vector. No shell and no screenshots written to disk. */
function spawnWindowsCapture(request: ScreenRequest): ScreenChild {
  const executable = join(process.env.SystemRoot || 'C:/Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
  const script = fileURLToPath(new URL('./capture-screen.ps1', import.meta.url));
  return spawn(executable, ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-File', script, '-Mode', request.mode, '-Target', request.target, '-Seconds', String(request.seconds),
    '-Fps', String(request.fps), '-MaxSide', String(request.maxSide)],
  { windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
}
/** Internal transport seam for synthetic-child tests; never exposed in plugin settings or tool arguments. */
export function screenProcessSource(start: (request: ScreenRequest) => ScreenChild = spawnWindowsCapture): ScreenSource {
  return (request, signal) => processFrames(request, signal, start);
}
async function* processFrames(request: ScreenRequest, signal: AbortSignal,
  start: (request: ScreenRequest) => ScreenChild): AsyncGenerator<ScreenFrame> {
  signal.throwIfAborted();
  const child = start(request);
  let failure: Error | undefined, closed = false;
  const done = new Promise<number | null>(resolve => {
    child.on('error', () => { failure ??= new VisionError('screen_unavailable', '无法启动 Windows 看屏组件。'); });
    child.once('close', code => { closed = true; resolve(code); });
  });
  const cancel = () => { if (!closed) child.kill('SIGKILL'); };
  signal.addEventListener('abort', cancel, { once: true });
  if (signal.aborted) cancel();
  child.stderr.resume(); // Native diagnostics may contain desktop details; never retain or echo them.
  let buffer = Buffer.alloc(0), frames = 0;
  try {
    for await (const bytes of child.stdout) {
      signal.throwIfAborted();
      buffer = Buffer.concat([buffer, bytes as Buffer]);
      let newline: number;
      while ((newline = buffer.indexOf(10)) !== -1) {
        if (newline > MAX_LINE) error('screen_output_limit', '看屏组件输出超过限制。');
        const line = buffer.subarray(0, newline).toString('utf8').trim();
        buffer = buffer.subarray(newline + 1);
        if (!line) continue;
        let parsed: Record<string, unknown>;
        try { parsed = record(JSON.parse(line)); } catch { error('screen_failed', '看屏组件返回无效数据。'); }
        if (parsed.type === 'error') {
          if (parsed.code === 'target_unavailable') error('screen_target_unavailable', '选定窗口已关闭、最小化或不可见；本次看屏未完成。');
          error('screen_failed', '无法读取所选屏幕区域，请检查桌面会话和系统权限。');
        }
        if (parsed.type !== 'frame' || typeof parsed.jpeg !== 'string' || parsed.jpeg.length > Math.ceil(MAX_INPUT / 3) * 4 ||
          !parsed.jpeg.length || parsed.jpeg.length % 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(parsed.jpeg))
          error('screen_failed', '看屏组件返回无效图像。');
        if (++frames > Math.ceil(request.seconds * request.fps) + 4) error('screen_output_limit', '看屏采样数量超过限制。');
        yield { jpeg: Buffer.from(parsed.jpeg, 'base64'), width: parsed.width as number, height: parsed.height as number,
          atSeconds: parsed.atSeconds as number, targetId: parsed.targetId as string, capturedAt: parsed.capturedAt as string };
      }
      if (buffer.length > MAX_LINE) error('screen_output_limit', '看屏组件输出超过限制。');
    }
    const code = await done;
    signal.throwIfAborted();
    if (failure) throw failure;
    if (buffer.toString('utf8').trim() || code !== 0) error('screen_failed', '看屏组件未完整结束，本次结果未交付。');
  } finally {
    signal.removeEventListener('abort', cancel);
    if (!closed) cancel();
    await done;
  }
}

type Selected = { at: number; stamp: string | null; jpeg: Buffer; width: number; height: number; score: number };
/** A separate object per plugin instance; no global frame cache, paths or session-shared screenshots. */
export class ScreenCapture {
  readonly settings: ScreenSettings;
  private readonly controller = new AbortController();
  private readonly signal: AbortSignal;
  private readonly source: ScreenSource;
  private readonly supported: boolean;
  private pending?: Promise<ScreenResult>;
  constructor(settings: ScreenSettings | undefined, signal: AbortSignal,
    options: { source?: ScreenSource; platform?: string } = {}) {
    this.settings = screenSettingsOf(settings);
    this.signal = AbortSignal.any([signal, this.controller.signal]);
    this.source = options.source ?? screenProcessSource();
    this.supported = (options.platform ?? process.platform) === 'win32';
  }
  status() {
    return { enabled: this.settings.enabled, supported: this.supported, busy: !!this.pending,
      ready: this.settings.enabled && this.supported && !this.signal.aborted,
      target: this.settings.target, seconds: this.settings.seconds, mode: 'on_demand', audioIncluded: false };
  }
  async capture(input: ScreenInput, signal: AbortSignal, visual: ScreenVisualSettings = {}): Promise<ScreenResult> {
    if (this.signal.aborted) error('stopped', '看屏已停用。');
    if (!this.settings.enabled) error('screen_disabled', '按需看屏尚未开启，请在视听设置中启用。');
    if (!this.supported) error('unsupported_platform', '按需看屏当前仅支持 Windows 桌面。');
    if (this.pending) error('screen_busy', '已有看屏任务正在执行，请稍后重试。');
    const o = record(input), mode = o.mode ?? 'snapshot', target = o.target ?? this.settings.target;
    if (mode !== 'snapshot' && mode !== 'observe') error('invalid_input', '看屏方式无效。');
    if (target !== 'window' && target !== 'screen') error('invalid_input', '看屏范围无效。');
    if (mode === 'snapshot' && o.seconds !== undefined) error('invalid_input', '单次截图不接受持续观察时长。');
    const seconds = mode === 'observe' ? finite(o.seconds ?? this.settings.seconds, 2, 60, '持续观察时长须为 2–60 秒。') : 0;
    const maxFrames = finite(visual.maxFrames ?? 8, 2, 8, '看屏输出帧数须为 2–8。');
    if (!Number.isInteger(maxFrames)) error('invalid_input', '看屏输出帧数须为整数。');
    const fps = visual.sampleFps ?? 2;
    if (![1, 2, 4, 6].includes(fps)) error('invalid_input', '看屏采样频率无效。');
    const detail = visual.detail === undefined || visual.detail === 'auto' ? mode === 'snapshot' ? 'detail' : 'overview' : visual.detail;
    if (detail !== 'overview' && detail !== 'detail') error('invalid_input', '看屏画质无效。');
    const request: ScreenRequest = { mode, target, seconds, fps, maxSide: detail === 'detail' ? 1600 : 640 };
    const combined = AbortSignal.any([this.signal, signal, AbortSignal.timeout(seconds * 1000 + 30_000)]);
    const task = Promise.resolve().then(() => this.collect(request, maxFrames, detail, visual.layout, combined)).catch(e => {
      if (combined.aborted) throw new VisionError('cancelled', '看屏已取消或超时。');
      if (e instanceof VisionError) throw e;
      throw new VisionError('screen_failed', '看屏未完成；未返回屏幕正文或路径。');
    });
    this.pending = task;
    try { return await task; } finally { if (this.pending === task) this.pending = undefined; }
  }
  private async collect(request: ScreenRequest, maxFrames: number, detail: 'overview' | 'detail',
    layout: ScreenVisualSettings['layout'], signal: AbortSignal): Promise<ScreenResult> {
    signal.throwIfAborted();
    let first: Selected | undefined, last: Selected | undefined, targetId: string | undefined, previousGrid: Buffer | undefined;
    const buckets = new Map<number, Selected>(), bucketCount = maxFrames - 2;
    let count = 0;
    for await (const frame of this.source(request, signal)) {
      signal.throwIfAborted();
      if (++count > (request.mode === 'snapshot' ? 1 : Math.ceil(request.seconds * request.fps) + 4))
        error('screen_output_limit', '看屏采样数量超过限制。');
      if (!(frame.jpeg instanceof Uint8Array) || !frame.jpeg.length || frame.jpeg.byteLength > MAX_INPUT ||
        !Number.isInteger(frame.width) || !Number.isInteger(frame.height) || frame.width < 1 || frame.height < 1 ||
        frame.width * frame.height > MAX_PIXELS) error('screen_output_limit', '看屏图像大小或尺寸超过限制。');
      const at = finite(frame.atSeconds, 0, request.seconds + 5, '看屏时间记录无效。');
      if (last && at <= last.at || !last && at > 1) error('screen_failed', '看屏时间顺序或起点无效。');
      if (typeof frame.targetId !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(frame.targetId))
        error('screen_failed', '看屏目标记录无效。');
      if (targetId !== undefined && frame.targetId !== targetId) error('screen_target_changed', '看屏目标发生变化，本次结果未交付。');
      targetId = frame.targetId;
      const pipeline = sharp(frame.jpeg, { limitInputPixels: MAX_PIXELS, failOn: 'warning' });
      const meta = await pipeline.metadata();
      if (meta.format !== 'jpeg' || meta.width !== frame.width || meta.height !== frame.height || (meta.pages ?? 1) !== 1)
        error('screen_failed', '看屏图像与尺寸信息不匹配。');
      const grid = await pipeline.clone().resize(64, 36, { fit: 'contain', background: '#000' }).removeAlpha().raw().toBuffer();
      let score = 0;
      if (previousGrid) { for (let i = 0; i < grid.length; i++) score += Math.abs(grid[i] - previousGrid[i]); score /= grid.length * 255; }
      previousGrid = grid;
      const rendered = await pipeline.clone().resize(request.maxSide, request.maxSide, { fit: 'inside', withoutEnlargement: true })
        .jpeg({ quality: 85 }).toBuffer({ resolveWithObject: true });
      signal.throwIfAborted();
      if (rendered.data.length > MAX_IMAGE) error('screen_output_limit', '单张看屏图片超过限制，请降低画质。');
      const item: Selected = { at, stamp: typeof frame.capturedAt === 'string' &&
        /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(frame.capturedAt) && Number.isFinite(Date.parse(frame.capturedAt)) ? frame.capturedAt : null,
      jpeg: rendered.data, width: rendered.info.width, height: rendered.info.height, score };
      first ??= item;
      last = item;
      if (request.mode === 'observe' && bucketCount > 0 && count > 1 && at < request.seconds) {
        const bucket = Math.min(bucketCount - 1, Math.floor(at / request.seconds * bucketCount));
        const before = buckets.get(bucket);
        if (!before || item.score > before.score) buckets.set(bucket, item);
      }
    }
    signal.throwIfAborted();
    if (!first || !last) error('screen_failed', '本次没有取得屏幕画面。');
    if (request.mode === 'observe' && last.at < request.seconds)
      error('screen_incomplete', '看屏提前结束，未覆盖请求的观察时段。');
    const selected = [...new Map([first, ...buckets.values(), last].map(frame => [frame.at, frame])).values()].sort((a, b) => a.at - b.at);
    if (selected.reduce((n, frame) => n + frame.jpeg.length, 0) > MAX_OUTPUT) error('screen_output_limit', '看屏图片总量超过限制，请降低画质或帧数。');
    const images: PreparedImage[] = selected.map((frame, i) => ({ mime: 'image/jpeg', base64: frame.jpeg.toString('base64'),
      width: frame.width, height: frame.height, frames: [{ index: i + 1, atSeconds: frame.at,
        reason: frame === first ? 'first' : frame === last ? 'last' : 'screen-change',
        rect: { x: 0, y: 0, width: frame.width, height: frame.height } }] }));
    const warnings = ['仅在本次调用后采集，不包含调用前的画面；只提供画面，没有录音。',
      request.target === 'window' ? '采集开始时固定前台窗口的可见屏幕区域；不会随前台切换换目标，遮挡内容无法恢复。' : '采集主屏幕的可见画面，不包含其他显示器。'];
    if (request.mode === 'observe') warnings.push('这是有时间标记的采样；采样密度是目标值，负载可能使实际间隔变长，以 selectedTimes 为准。快速动作或小范围变化可能遗漏，不能声称观看了每一帧。');
    if (layout === 'sheet') warnings.push('看屏使用独立图片保留文字细节，本次未拼图。');
    return { mode: request.mode, target: request.target, detail, images, warnings,
      coverage: { requestedSeconds: request.seconds, fromSeconds: first.at, toSeconds: last.at, observedSeconds: last.at - first.at,
        selectedTimes: selected.map(frame => frame.at), capturedFrames: count,
        requestedSampleIntervalSeconds: request.mode === 'observe' ? 1 / request.fps : null,
        startedAt: first.stamp, endedAt: last.stamp, timelineComplete: false, audioIncluded: false } };
  }
  async stop(): Promise<void> { this.controller.abort(); await this.pending?.catch(() => {}); }
}
