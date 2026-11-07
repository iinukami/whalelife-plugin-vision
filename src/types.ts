/*! Copyright (c) 2026 iinukami and contributors.
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7: see LICENSE-ADDITIONAL.
 */
import { audioDefaults, type AudioSettings, type AudioTask, type AudioOutcome } from './audio-types.ts';
export const VERSION = '0.2.0';
export const MiB = 1024 * 1024;
export const MAX_PIXELS = 40_000_000;
export const MAX_OUTPUT = 8 * MiB;
export const MAX_FRAMES = 8;
export type MediaKind = 'image' | 'animation' | 'video' | 'audio';
export type MediaInfo = {
  kind: MediaKind; mime: string; width: number; height: number;
  durationSeconds: number | null; frameCount: number | null;
  hasAudio: boolean; timing: 'container' | 'frame-delays' | 'estimated' | 'still';
};
export type MediaOffer = { mediaRef: string; expiresAt: string; info: MediaInfo };
export type Crop = { x: number; y: number; width: number; height: number };
export type PrepareInput = {
  sessionId: string; mediaRef: string; fromSeconds?: number; toSeconds?: number;
  atSeconds?: number; detail?: 'overview' | 'detail'; layout?: 'frames' | 'sheet'; crop?: Crop;
};
export type PreparedImage = {
  mime: 'image/jpeg'; base64: string; width: number; height: number;
  frames: { index: number; atSeconds: number | null; reason: string;
    rect: { x: number; y: number; width: number; height: number } }[];
};
/** Trusted service output, NEVER an ordinary JSON model-tool result. */
export type PreparedMedia = {
  mediaRef: string; info: MediaInfo; images: PreparedImage[];
  coverage: { fromSeconds: number | null; toSeconds: number | null; nextFromSeconds: number | null;
    sampled: boolean; audioIncluded: false; sampleIntervalSeconds: number | null;
    selectedTimes: number[]; omittedCandidates: number; timelineComplete: false };
  detail: 'overview' | 'detail'; crop: Crop | null; warnings: string[];
};
export type CallOptions = { signal?: AbortSignal };
export type UnderstandInput = PrepareInput & { visual?: boolean; audio?: AudioTask[] };
export type UnderstoodMedia = {
  mediaRef: string; info: MediaInfo;
  visual?: PreparedMedia;
  visualError?: { code: string; error: string };
  audio: {
    status: 'completed' | 'partial' | 'failed' | 'not_requested' | 'no_audio';
    coverage: { fromSeconds: number; toSeconds: number; nextFromSeconds: number | null } | null;
    tasks: AudioOutcome[];
    code?: string; error?: string;
  };
  status: 'completed' | 'partial' | 'failed';
};
export interface VisionService {
  status(): Record<string, unknown>;
  offerMedia(input: { sessionId: string; base64: string; mime: string }, options?: CallOptions): Promise<MediaOffer>;
  describe(input: { sessionId: string; mediaRef: string }, options?: CallOptions): Promise<MediaOffer>;
  prepare(input: PrepareInput, options?: CallOptions): Promise<PreparedMedia>;
  release(input: { sessionId: string; mediaRef: string }, options?: CallOptions): Promise<{ released: boolean }>;
}
export interface AudiovisualService extends VisionService {
  readonly audiovisualApiVersion: '1.0.0';
  understand(input: UnderstandInput, options?: CallOptions): Promise<UnderstoodMedia>;
}
export type Config = { ttlSeconds: number; maxMediaMiB: number; maxTotalMiB: number; audio?: AudioSettings };
export const defaults: Config = { ttlSeconds: 1800, maxMediaMiB: 64, maxTotalMiB: 256 };
export class VisionError extends Error {
  code: string;
  constructor(code: string, message: string) { super(message); this.name = 'VisionError'; this.code = code; }
}
export function fail(code: string, message: string): never { throw new VisionError(code, message); }
export function safeError(error: unknown) {
  if (error instanceof VisionError) return { code: error.code, error: error.message };
  if (error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError'))
    return { code: 'cancelled', error: '视觉处理已取消或超时。' };
  return { code: 'processing_failed', error: '媒体处理失败；未返回媒体正文。' };
}
export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('invalid_input', '参数必须是对象。');
  return value as Record<string, unknown>;
}
export function identity(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 200 || /[\x00-\x1f]/.test(value))
    fail('invalid_session', '需要固定的有效会话 ID。');
  return value;
}
export function reference(value: unknown): string {
  if (typeof value !== 'string' || !/^vis_[a-f0-9]{48}$/.test(value)) fail('media_unavailable', '媒体引用无效、已过期或不属于本会话。');
  return value;
}
export function numberIn(value: unknown, min: number, max: number, name: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max)
    fail('invalid_input', `${name} 超出允许范围。`);
  return value;
}
export function configOf(value: unknown): Config {
  const o = object(value);
  const result = { ...defaults };
  for (const [key, low, high] of [['ttlSeconds', 30, 7200], ['maxMediaMiB', 1, 64], ['maxTotalMiB', 1, 512]] as const) {
    if (o[key] !== undefined) result[key] = numberIn(o[key], low, high, key);
    if (!Number.isInteger(result[key])) fail('invalid_config', '容量和有效期必须为整数。');
  }
  if (result.maxTotalMiB < result.maxMediaMiB) fail('invalid_config', '总容量不能小于单份媒体容量。');
  if (o.audio !== undefined) {
    const a = object(o.audio);
    const next = { ...audioDefaults };
    for (const key of ['speechBackend', 'musicBackend'] as const) {
      if (a[key] !== undefined) {
        if (a[key] !== 'local' && a[key] !== 'cloud') fail('invalid_config', '音频后端选择无效。');
        next[key] = a[key];
      }
    }
    for (const key of ['speechModelId', 'understandingModelId'] as const) {
      if (a[key] !== undefined) {
        if (typeof a[key] !== 'string' || a[key].length > 200 || /[\x00-\x1f\x7f]/.test(a[key])) fail('invalid_config', '模型配置 ID 无效。');
        next[key] = a[key].trim();
      }
    }
    result.audio = next;
  }
  // Legacy decoder paths are deliberately ignored; saved media limits remain valid.
  return result;
}
export function cropOf(value: unknown): Crop | undefined {
  if (value === undefined) return;
  const o = object(value);
  const crop = { x: numberIn(o.x, 0, 1, '裁剪 x'), y: numberIn(o.y, 0, 1, '裁剪 y'),
    width: numberIn(o.width, 0.001, 1, '裁剪宽度'), height: numberIn(o.height, 0.001, 1, '裁剪高度') };
  if (crop.x + crop.width > 1 + 1e-9 || crop.y + crop.height > 1 + 1e-9) fail('invalid_input', '裁剪区域超出画面。');
  return crop;
}
