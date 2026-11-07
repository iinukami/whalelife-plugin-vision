/*! Copyright (c) 2026 iinukami and contributors.
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7: see LICENSE-ADDITIONAL.
 */
import type { BundledDecoder } from './decoder.ts';
import type { StoredMedia } from './store.ts';
import { runProcess } from './process.ts';
import { MiB, fail, numberIn, type MediaInfo } from './types.ts';

const formats: Record<string, string> = {
  'audio/wav': 'wav', 'audio/mpeg': 'mp3', 'audio/flac': 'flac', 'audio/ogg': 'ogg',
  'audio/mp4': 'mov', 'video/mp4': 'mov', 'audio/webm': 'matroska', 'video/webm': 'matroska',
};
export const audioMimes = ['audio/wav', 'audio/mpeg', 'audio/flac', 'audio/ogg', 'audio/mp4', 'audio/webm'];
export function audioInput(path: string, mime: string): string[] {
  const format = formats[mime];
  if (!format) fail('unsupported_media', '音频格式不受支持。');
  return ['-protocol_whitelist', 'file,pipe', '-format_whitelist', format, '-f', format,
    ...(format === 'mov' ? ['-enable_drefs', '0', '-use_absolute_path', '0'] : []), '-i', path];
}
export async function inspectAudio(path: string, mime: string, decoder: BundledDecoder, signal: AbortSignal): Promise<MediaInfo> {
  const output = await runProcess(decoder.paths().ffprobePath,
    ['-v', 'error', ...audioInput(path, mime), '-show_entries', 'stream=codec_type,sample_rate,channels,duration:stream_disposition=attached_pic:format=duration', '-of', 'json'],
    signal, MiB, 15_000);
  let data: any;
  try { data = JSON.parse(output.toString('utf8')); } catch { fail('decode_failed', '音频元信息无效。'); }
  if (!Array.isArray(data.streams) || data.streams.some((s: any) => s.codec_type === 'video' && s.disposition?.attached_pic !== 1))
    fail('mime_mismatch', '请将带画面媒体作为视频交入。');
  const stream = data.streams.find((s: any) => s.codec_type === 'audio');
  if (!stream) fail('unsupported_media', '媒体没有可读取的音轨。');
  const duration = Number(data.format?.duration ?? stream.duration);
  if (!Number.isFinite(duration) || duration <= 0 || duration > 3600)
    fail('audio_duration', '只支持时长明确且不超过一小时的有限音频。');
  const rate = Number(stream.sample_rate), channels = Number(stream.channels);
  if (!Number.isInteger(rate) || rate < 8000 || rate > 192000 || !Number.isInteger(channels) || channels < 1 || channels > 8)
    fail('unsupported_media', '音轨采样率或声道数不受支持。');
  return { kind: 'audio', mime, width: 0, height: 0, durationSeconds: duration, frameCount: null, hasAudio: true, timing: 'container' };
}
export function audioRange(info: MediaInfo, input: { fromSeconds?: number; toSeconds?: number }) {
  const duration = info.durationSeconds;
  if (duration === null || !info.hasAudio) fail('no_audio', '该媒体没有音轨。');
  const from = numberIn(input.fromSeconds ?? 0, 0, duration, '开始时间');
  const to = numberIn(input.toSeconds ?? Math.min(duration, from + 30), 0, duration, '结束时间');
  if (to <= from || to - from > 60) fail('invalid_input', '每次听取范围必须大于零且不超过 60 秒。');
  return { fromSeconds: from, toSeconds: to, nextFromSeconds: to < duration ? to : null };
}
export function pcmWav(pcm: Buffer, sampleRate = 16000): Buffer {
  const header = Buffer.alloc(44);
  header.write('RIFF'); header.writeUInt32LE(pcm.length + 36, 4); header.write('WAVEfmt ', 8);
  header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24); header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34); header.write('data', 36); header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}
export async function extractAudio(entry: StoredMedia, range: ReturnType<typeof audioRange>, decoder: BundledDecoder, signal: AbortSignal) {
  const seconds = range.toSeconds - range.fromSeconds;
  const pcm = await runProcess(decoder.paths().ffmpegPath,
    ['-hide_banner', '-loglevel', 'error', '-nostdin', '-threads', '1', '-ss', range.fromSeconds.toFixed(6),
      ...audioInput(entry.path, entry.info.mime), '-t', seconds.toFixed(6), '-map', '0:a:0', '-vn', '-sn', '-dn',
      '-filter_threads', '1', '-af', 'aresample=16000:async=1:first_pts=0', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', '-f', 's16le', 'pipe:1'],
    signal, Math.ceil(seconds * 16000) * 2 + 65536, 30_000);
  if (!pcm.length || pcm.length % 2) fail('decode_failed', '所选区间没有完整的音频样本。');
  // Encoders can finish one sample beyond the requested duration; do not report coverage outside it.
  const bounded = pcm.subarray(0, Math.min(pcm.length, Math.ceil(seconds * 16000) * 2));
  const toSeconds = Math.min(range.toSeconds, range.fromSeconds + bounded.length / 32000);
  return { wav: pcmWav(bounded), coverage: { ...range, toSeconds, nextFromSeconds: toSeconds < entry.info.durationSeconds! ? toSeconds : null } };
}
