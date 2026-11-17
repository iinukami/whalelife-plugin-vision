/*! Copyright (c) 2026 iinukami and contributors.
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7: see LICENSE-ADDITIONAL.
 */
import sharp, { type Sharp, type Metadata, type OverlayOptions } from 'sharp';
import { readFile } from 'node:fs/promises';
import { runProcess } from './process.ts';
import { selectSamples } from './sampling.ts';
import { suggestFocus, type FocusDecision } from './focus.ts';
import { MAX_PIXELS, MAX_OUTPUT, MAX_FRAMES, MiB, fail, numberIn, cropOf,
  type MediaInfo, type PrepareInput, type PreparedMedia, type PreparedImage, type Crop, type VisualSettings } from './types.ts';
import type { BundledDecoder } from './decoder.ts';
import type { StoredMedia } from './store.ts';
import { inspectAudio } from './audio-media.ts';

const GRID_W = 64, GRID_H = 36, GRID_BYTES = GRID_W * GRID_H * 3;
const IMAGE_OPTIONS = { limitInputPixels: MAX_PIXELS, failOn: 'warning' as const };
type DecodedFrame = { bytes: Buffer; atSeconds: number | null; reason: string };
type SamplingOptions = { maxFrames: number; sampleFps: number; automaticFocus: boolean };

function selectVisualSamples(grids: Uint8Array[], times: number[], info: MediaInfo, options: SamplingOptions) {
  const focus: FocusDecision = options.automaticFocus
    ? suggestFocus(grids, times, { width: info.width, height: info.height, gridWidth: GRID_W, gridHeight: GRID_H })
    : { reason: '未请求自动聚焦。' };
  if (focus.suggestion && options.maxFrames < 3) {
    delete focus.suggestion; focus.reason = '本次帧数预算优先保留首尾全景，没有追加局部图。';
  }
  const overviewBudget = options.maxFrames - (focus.suggestion ? 1 : 0);
  return { ...selectSamples(grids, times, overviewBudget), focus };
}

async function buffered(pipeline: Sharp, signal: AbortSignal): Promise<Buffer> {
  signal.throwIfAborted();
  const abort = () => pipeline.destroy();
  signal.addEventListener('abort', abort, { once: true });
  try { const bytes = await pipeline.timeout({ seconds: 10 }).toBuffer(); signal.throwIfAborted(); return bytes; }
  catch { signal.throwIfAborted(); fail('decode_failed', '图片无法解码或处理超时。'); }
  finally { signal.removeEventListener('abort', abort); pipeline.destroy(); }
}
function mimeOf(bytes: Buffer, requested: string): string {
  if (bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) return 'image/png';
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (/^GIF8[79]a$/.test(bytes.subarray(0, 6).toString('ascii'))) return 'image/gif';
  if (bytes.subarray(0, 4).toString() === 'RIFF' && bytes.subarray(8, 12).toString() === 'WEBP') return 'image/webp';
  if (bytes.subarray(0, 4).toString() === 'RIFF' && bytes.subarray(8, 12).toString() === 'WAVE') return 'audio/wav';
  if (bytes.subarray(0, 4).toString() === 'fLaC') return 'audio/flac';
  if (bytes.subarray(0, 4).toString() === 'OggS') return 'audio/ogg';
  if (bytes.subarray(0, 3).toString() === 'ID3' || (bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0 && (bytes[1] & 6) !== 0)) return 'audio/mpeg';
  if (bytes.subarray(4, 8).toString() === 'ftyp') return requested === 'audio/mp4' ? 'audio/mp4' : 'video/mp4';
  if (bytes.subarray(0, 4).equals(Buffer.from([0x1a,0x45,0xdf,0xa3]))) return requested === 'audio/webm' ? 'audio/webm' : 'video/webm';
  fail('unsupported_media', '支持常见图片、MP4/WebM 视频，以及 WAV/MP3/FLAC/OGG/M4A/WebM 音频。');
}
function checkPixels(w: number, h: number) {
  if (!Number.isInteger(w) || !Number.isInteger(h) || w < 1 || h < 1 || w * h > MAX_PIXELS || w > 16384 || h > 16384)
    fail('media_dimensions', '媒体画面尺寸超过限制。');
}
async function imageMetadata(bytes: Buffer): Promise<Metadata> {
  try { return await sharp(bytes, IMAGE_OPTIONS).metadata(); }
  catch { fail('decode_failed', '图片无法解码或尺寸过大。'); }
}
function frameDelays(meta: Metadata): { starts: number[]; duration: number; estimated: boolean } {
  const count = meta.pages ?? 1;
  let t = 0, estimated = false;
  const starts: number[] = [];
  for (let i = 0; i < count; i++) {
    starts.push(t);
    let delay = meta.delay?.[i];
    if (!delay || delay < 10 || !Number.isFinite(delay)) { delay = 100; estimated = true; }
    t += delay / 1000;
  }
  return { starts, duration: t, estimated };
}
function hasApng(bytes: Buffer): boolean {
  let offset = 8;
  while (offset + 12 <= bytes.length) {
    const size = bytes.readUInt32BE(offset);
    if (size > bytes.length - offset - 12) break;
    if (bytes.subarray(offset + 4, offset + 8).toString() === 'acTL') return true;
    offset += size + 12;
  }
  return false;
}
function demuxer(mime: string) { return mime === 'video/mp4' ? 'mov' : 'matroska'; }
function decoderInput(path: string, mime: string) {
  return ['-protocol_whitelist', 'file,pipe', '-format_whitelist', demuxer(mime), '-f', demuxer(mime),
    ...(mime === 'video/mp4' ? ['-enable_drefs', '0', '-use_absolute_path', '0'] : []), '-i', path];
}
async function probe(path: string, mime: string, decoder: BundledDecoder, signal: AbortSignal): Promise<MediaInfo> {
  const result = await runProcess(decoder.paths().ffprobePath, ['-v', 'error', ...decoderInput(path, mime),
    '-show_entries', 'stream=codec_type,width,height,duration,nb_frames:stream_tags=rotate:stream_side_data=rotation:format=duration', '-of', 'json'], signal, MiB, 15_000);
  let data: any;
  try { data = JSON.parse(result.toString('utf8')); } catch { fail('decode_failed', '视频元信息无效。'); }
  const video = data.streams?.find((s: any) => s.codec_type === 'video');
  if (!video) fail('unsupported_media', '媒体中没有可读取的视频画面。');
  let width = Number(video.width), height = Number(video.height);
  checkPixels(width, height);
  const duration = Number(data.format?.duration ?? video.duration);
  if (!Number.isFinite(duration) || duration <= 0 || duration > 3600) fail('video_duration', '只支持时长明确且不超过一小时的有限视频。');
  const rotation = Number(video.side_data_list?.find((s: any) => s.rotation !== undefined)?.rotation ?? video.tags?.rotate ?? 0);
  if (Math.abs(rotation) % 180 === 90) [width, height] = [height, width];
  const frames = Number(video.nb_frames);
  return { kind: 'video', mime, width, height, durationSeconds: duration,
    frameCount: Number.isSafeInteger(frames) && frames > 0 ? frames : null,
    hasAudio: data.streams.some((s: any) => s.codec_type === 'audio'), timing: 'container' };
}
export async function inspectMedia(bytes: Buffer, path: string, requestedMime: string, decoder: BundledDecoder, signal: AbortSignal): Promise<MediaInfo> {
  signal.throwIfAborted();
  const mime = mimeOf(bytes, requestedMime);
  if (mime !== requestedMime) fail('mime_mismatch', '声明的媒体类型与文件内容不一致。');
  if (mime.startsWith('video/')) return probe(path, mime, decoder, signal);
  if (mime.startsWith('audio/')) return inspectAudio(path, mime, decoder, signal);
  if (bytes.length > 25 * MiB) fail('media_size', '图片或动图不得超过 25 MiB。');
  const meta = await imageMetadata(bytes);
  const expected = { 'image/png': 'png', 'image/jpeg': 'jpeg', 'image/gif': 'gif', 'image/webp': 'webp' }[mime];
  if (meta.format !== expected) fail('mime_mismatch', '图片解码格式不匹配。');
  const count = meta.pages ?? 1;
  if (count > 2000) fail('animation_limit', '动图帧数超过 2000 帧。');
  if (mime === 'image/png' && hasApng(bytes)) fail('unsupported_animation', '本版本暂不支持 APNG，请来源插件提供视频或 GIF。');
  const width = meta.width!, height = meta.pageHeight ?? meta.height!;
  checkPixels(width, height);
  // Decode a real frame now; metadata-only validation accepts some truncated images.
  await buffered(sharp(bytes, { ...IMAGE_OPTIONS, page: 0, pages: 1 }).resize(8, 8, { fit: 'inside' }).png(), signal);
  const timing = frameDelays(meta);
  if (count > 1 && timing.duration > 3600) fail('video_duration', '动图时长超过一小时。');
  const swapped = count === 1 && [5,6,7,8].includes(meta.orientation ?? 0);
  return { kind: count > 1 ? 'animation' : 'image', mime,
    width: swapped ? height : width, height: swapped ? width : height,
    durationSeconds: count > 1 ? timing.duration : null, frameCount: count, hasAudio: false,
    timing: count === 1 ? 'still' : timing.estimated ? 'estimated' : 'frame-delays' };
}

function timeRange(input: PrepareInput, info: MediaInfo) {
  if (input.atSeconds !== undefined && (input.fromSeconds !== undefined || input.toSeconds !== undefined))
    fail('invalid_input', '指定时刻与时间段不能同时使用。');
  if (info.kind === 'image') {
    if (input.atSeconds !== undefined || input.fromSeconds !== undefined || input.toSeconds !== undefined)
      fail('invalid_input', '静态图片没有视频时间轴。');
    return { from: null, to: null, at: null, next: null };
  }
  const duration = info.durationSeconds!;
  if (input.atSeconds !== undefined) {
    const at = numberIn(input.atSeconds, 0, duration, '查看时刻');
    if (at >= duration) fail('invalid_input', '查看时刻必须早于媒体结束。');
    return { from: at, to: at, at, next: null };
  }
  const from = numberIn(input.fromSeconds ?? 0, 0, duration, '开始时间');
  const to = numberIn(input.toSeconds ?? Math.min(duration, from + 30), 0, duration, '结束时间');
  if (to <= from || to - from > 60) fail('invalid_input', '每次查看的时间段必须大于零且不超过 60 秒。');
  return { from, to, at: null, next: to < duration ? to : null };
}
function pixelCrop(width: number, height: number, crop: Crop) {
  const left = Math.min(width - 1, Math.floor(crop.x * width)), top = Math.min(height - 1, Math.floor(crop.y * height));
  return { left, top, width: Math.max(1, Math.min(width - left, Math.round(crop.width * width))),
    height: Math.max(1, Math.min(height - top, Math.round(crop.height * height))) };
}
async function videoFrame(path: string, mime: string, at: number, size: number, decoder: BundledDecoder, signal: AbortSignal,
  sourceRegion?: { width: number; height: number; crop: Crop }) {
  const rect = sourceRegion && pixelCrop(sourceRegion.width, sourceRegion.height, sourceRegion.crop);
  // Crop decoded source pixels before resizing so a small region in a large video stays readable.
  const filter = rect
    ? `crop=${rect.width}:${rect.height}:${rect.left}:${rect.top}:exact=1,scale='min(iw,${size})':'min(ih,${size})':force_original_aspect_ratio=decrease`
    : `scale=${size}:${size}:force_original_aspect_ratio=decrease`;
  return runProcess(decoder.paths().ffmpegPath, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-threads', '1',
    '-ss', at.toFixed(6), ...decoderInput(path, mime), '-map', '0:v:0', '-an', '-sn', '-dn', '-frames:v', '1',
    '-filter_threads', '1', '-vf', filter,
    '-threads', '1', '-c:v', 'mjpeg', '-q:v', '2', '-f', 'image2pipe', 'pipe:1'], signal, 8 * MiB);
}
async function videoSamples(entry: StoredMedia, from: number, to: number, decoder: BundledDecoder, signal: AbortSignal, options: SamplingOptions) {
  const raw = await runProcess(decoder.paths().ffmpegPath, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-threads', '1',
    '-ss', from.toFixed(6), ...decoderInput(entry.path, entry.info.mime), '-t', (to - from).toFixed(6),
    '-map', '0:v:0', '-an', '-sn', '-dn', '-filter_threads', '1', '-vf',
    `setpts=PTS-STARTPTS,fps=${options.sampleFps}:start_time=0:round=down,scale=${GRID_W}:${GRID_H}:force_original_aspect_ratio=decrease,pad=${GRID_W}:${GRID_H}:(ow-iw)/2:(oh-ih)/2,format=rgb24`,
    '-threads', '1', '-f', 'rawvideo', 'pipe:1'], signal, (Math.ceil((to - from) * options.sampleFps) + 2) * GRID_BYTES);
  if (!raw.length) return { samples: [{ atSeconds: from, reason: 'first' as const, score: 1 }], omittedCandidates: 0,
    focus: { reason: '变化样本不足，保留全景。' } as FocusDecision };
  if (raw.length % GRID_BYTES) fail('decode_failed', '所选时间段没有完整的可解码画面。');
  const grids: Uint8Array[] = [], times: number[] = [];
  for (let offset = 0; offset < raw.length; offset += GRID_BYTES) {
    const time = from + grids.length / options.sampleFps;
    if (time >= to) break;
    grids.push(raw.subarray(offset, offset + GRID_BYTES)); times.push(time);
  }
  signal.throwIfAborted();
  return selectVisualSamples(grids, times, entry.info, options);
}
async function animationSamples(bytes: Buffer, from: number, to: number, info: MediaInfo, signal: AbortSignal, options: SamplingOptions) {
  const meta = await imageMetadata(bytes), timing = frameDelays(meta);
  const grids: Uint8Array[] = [], times: number[] = [];
  for (let step = 0; from + step / options.sampleFps < to; step++) {
    const at = from + step / options.sampleFps;
    signal.throwIfAborted();
    const page = pageAt(timing.starts, at);
    grids.push(await buffered(sharp(bytes, { ...IMAGE_OPTIONS, page, pages: 1 }).resize(GRID_W, GRID_H, { fit: 'contain', background: '#000' }).removeAlpha().raw(), signal));
    times.push(at);
  }
  return { ...selectVisualSamples(grids, times, info, options), timing };
}
function pageAt(starts: number[], at: number) {
  let page = 0;
  for (let i = 1; i < starts.length && starts[i] <= at; i++) page = i;
  return page;
}
async function renderFrame(frame: DecodedFrame, detail: string, crop: Crop | undefined, signal: AbortSignal) {
  let bytes = await buffered(sharp(frame.bytes, IMAGE_OPTIONS).autoOrient().png(), signal);
  let pipe = sharp(bytes, IMAGE_OPTIONS);
  if (crop) {
    const meta = await imageMetadata(bytes);
    pipe = pipe.extract(pixelCrop(meta.width!, meta.height!, crop));
  }
  const maxSide = detail === 'detail' ? 1600 : 640;
  bytes = await buffered(pipe.resize(maxSide, maxSide, { fit: 'inside', withoutEnlargement: true }).flatten({ background: '#ffffff' }).jpeg({ quality: 85 }), signal);
  if (bytes.length > 2 * MiB) fail('output_limit', '单张准备图像过大，请使用概览或裁剪。');
  const meta = await imageMetadata(bytes);
  // Retain only the rendered bytes and temporal metadata, not the large source buffer.
  return { bytes, width: meta.width!, height: meta.height!, frame: { atSeconds: frame.atSeconds, reason: frame.reason } };
}

export async function prepareMedia(entry: StoredMedia, input: PrepareInput, decoder: BundledDecoder, signal: AbortSignal, settings?: VisualSettings): Promise<PreparedMedia> {
  signal.throwIfAborted();
  if (entry.info.kind === 'audio') fail('no_visual', '该媒体只有声音，请使用统一视听入口。');
  const range = timeRange(input, entry.info);
  const configuredDetail = settings?.detail ?? 'auto';
  if (!['auto', 'overview', 'detail'].includes(configuredDetail)) fail('invalid_input', '默认画质无效。');
  const detail = input.detail ?? (configuredDetail === 'auto' ? (range.at === null ? 'overview' : 'detail') : configuredDetail);
  const layout = input.layout ?? settings?.layout ?? 'frames';
  if (!['overview', 'detail'].includes(detail) || !['frames', 'sheet'].includes(layout)) fail('invalid_input', '画质或布局无效。');
  const crop = cropOf(input.crop);
  const focusMode = input.focus ?? settings?.focus ?? 'whole';
  if (focusMode !== 'whole' && focusMode !== 'auto') fail('invalid_input', '聚焦方式无效。');
  const maxFrames = numberIn(input.maxFrames ?? settings?.maxFrames ?? MAX_FRAMES, 2, MAX_FRAMES, '画面数量');
  if (!Number.isInteger(maxFrames)) fail('invalid_input', '画面数量必须为整数。');
  const sampleFps = input.sampleFps ?? settings?.sampleFps ?? 2;
  if (![1, 2, 4, 6].includes(sampleFps)) fail('invalid_input', '采样频率须为每秒 1、2、4 或 6 次。');
  const sampling = { maxFrames, sampleFps, automaticFocus: focusMode === 'auto' && !crop };
  let focus: FocusDecision = { reason: crop ? '使用显式裁剪区域，未再自动裁剪。'
    : entry.info.kind === 'image' ? '静态图片没有时序变化，保留全图。'
    : range.at !== null ? '单独时刻没有时序变化，保留全图。' : '未请求自动聚焦。' };
  type Rendered = Awaited<ReturnType<typeof renderFrame>> & { role?: 'overview' | 'focus'; crop?: Crop };
  const rendered: Rendered[] = [];
  const add = async (frame: DecodedFrame, region = crop, role?: 'overview' | 'focus', alreadyCropped = false) => {
    const item = await renderFrame(frame, role === 'focus' ? 'detail' : detail, alreadyCropped ? undefined : region, signal);
    rendered.push({ ...item, ...(role ? { role } : {}), ...(region ? { crop: region } : {}) });
  };
  const overviewRole = focusMode === 'auto' && !crop ? 'overview' as const : undefined;
  let omitted = 0;
  if (entry.info.kind === 'image') await add({ bytes: await readFile(entry.path, { signal }), atSeconds: null, reason: 'still' }, crop, overviewRole);
  else if (entry.info.kind === 'video') {
    const selection = range.at !== null ? { samples: [{ atSeconds: range.at, reason: 'requested', score: 0 }], omittedCandidates: 0, focus }
      : await videoSamples(entry, range.from!, range.to!, decoder, signal, sampling);
    omitted = selection.omittedCandidates;
    if (sampling.automaticFocus) focus = selection.focus;
    for (const sample of selection.samples) {
      // Keep enough pixels for a requested crop; cropping after overview scaling loses small text.
      const size = crop ? 4096 : detail === 'detail' ? 1600 : 640;
      await add({ bytes: await videoFrame(entry.path, entry.info.mime, sample.atSeconds, size, decoder, signal), atSeconds: sample.atSeconds, reason: sample.reason }, crop, overviewRole);
    }
    if (focus.suggestion) {
      const { atSeconds, crop: region } = focus.suggestion;
      await add({ bytes: await videoFrame(entry.path, entry.info.mime, atSeconds, 1600, decoder, signal,
        { width: entry.info.width, height: entry.info.height, crop: region }), atSeconds, reason: 'focus' }, region, 'focus', true);
    }
  } else {
    const bytes = await readFile(entry.path, { signal });
    const selection = range.at !== null ? { samples: [{ atSeconds: range.at, reason: 'requested', score: 0 }], omittedCandidates: 0,
      timing: frameDelays(await imageMetadata(bytes)), focus } : await animationSamples(bytes, range.from!, range.to!, entry.info, signal, sampling);
    omitted = selection.omittedCandidates;
    if (sampling.automaticFocus) focus = selection.focus;
    for (const sample of selection.samples) {
      const page = pageAt(selection.timing.starts, sample.atSeconds);
      await add({ bytes: await buffered(sharp(bytes, { ...IMAGE_OPTIONS, page, pages: 1 }).png(), signal),
        atSeconds: sample.atSeconds, reason: sample.reason }, crop, overviewRole);
    }
    if (focus.suggestion) {
      const { atSeconds, crop: region } = focus.suggestion;
      const page = pageAt(selection.timing.starts, atSeconds);
      await add({ bytes: await buffered(sharp(bytes, { ...IMAGE_OPTIONS, page, pages: 1 }).png(), signal),
        atSeconds, reason: 'focus' }, region, 'focus');
    }
  }
  if (!rendered.length) fail('decode_failed', '没有可返回的画面。');
  const overviews = rendered.filter(item => item.role !== 'focus'), details = rendered.filter(item => item.role === 'focus');
  const images: PreparedImage[] = [];
  if (layout === 'sheet' && overviews.length > 1) {
    const cell = detail === 'detail' ? 800 : 480, columns = Math.min(2, overviews.length);
    const width = columns * cell, height = Math.ceil(overviews.length / columns) * (cell + 28);
    const composite: OverlayOptions[] = [];
    const descriptors: PreparedImage['frames'] = [];
    for (let i = 0; i < overviews.length; i++) {
      const item = overviews[i], x = (i % columns) * cell, y = Math.floor(i / columns) * (cell + 28);
      const thumb = await buffered(sharp(item.bytes).resize(cell, cell, { fit: 'contain', background: '#ffffff' }), signal);
      const text = `${i + 1} | ${item.frame.atSeconds === null ? 'image' : item.frame.atSeconds.toFixed(2) + 's'}`;
      composite.push({ input: thumb, left: x, top: y + 28 }, { input: Buffer.from(`<svg width="${cell}" height="28"><rect width="100%" height="100%" fill="white"/><text x="8" y="20" font-size="16" fill="black">${text}</text></svg>`), left: x, top: y });
      descriptors.push({ index: i + 1, atSeconds: item.frame.atSeconds, reason: item.frame.reason,
        ...(item.role ? { role: item.role } : {}), ...(item.crop ? { crop: item.crop } : {}), rect: { x, y: y + 28, width: cell, height: cell } });
    }
    const bytes = await buffered(sharp({ create: { width, height, channels: 3, background: '#fff' } }).composite(composite).jpeg({ quality: 85 }), signal);
    if (bytes.length > 4 * MiB) fail('output_limit', '拼图超过宿主单图限制，请改为独立画面或概览画质。');
    images.push({ mime: 'image/jpeg', base64: bytes.toString('base64'), width, height, frames: descriptors });
  } else for (const [i, item] of overviews.entries()) images.push({ mime: 'image/jpeg', base64: item.bytes.toString('base64'), width: item.width, height: item.height,
    frames: [{ index: i + 1, atSeconds: item.frame.atSeconds, reason: item.frame.reason,
      ...(item.role ? { role: item.role } : {}), ...(item.crop ? { crop: item.crop } : {}), rect: { x: 0, y: 0, width: item.width, height: item.height } }] });
  for (const [i, item] of details.entries()) images.push({ mime: 'image/jpeg', base64: item.bytes.toString('base64'), width: item.width, height: item.height,
    frames: [{ index: overviews.length + i + 1, atSeconds: item.frame.atSeconds, reason: 'focus', role: 'focus', crop: item.crop,
      rect: { x: 0, y: 0, width: item.width, height: item.height } }] });
  if (images.reduce((n, i) => n + Buffer.byteLength(i.base64, 'base64'), 0) > MAX_OUTPUT) fail('output_limit', '返回图像总大小超过 8 MiB。');
  signal.throwIfAborted();
  const animated = entry.info.kind !== 'image';
  const warnings = animated ? ['仅包含画面采样，不能声称看过每一帧。时间标记是采样请求位置，快速动作和小面积变化可能遗漏。', '未包含音频或转写。'] : [];
  if (entry.info.timing === 'estimated') warnings.push('动图部分帧缺少有效延时，时间位置按默认帧延时估算。');
  if (omitted) warnings.push('候选画面超过本次上限；可缩短时间段或按时刻补看。');
  if (layout === 'sheet') warnings.push('拼图可能缩小文字和细节，可改为独立画面或指定时刻高清查看。');
  if (focusMode === 'auto') warnings.push('自动聚焦只依据采样中的局部变化；未找到区域不代表没有内容，细小或短暂变化仍可能遗漏。');
  return { mediaRef: entry.ref, info: { ...entry.info }, images, detail, crop: crop ?? null, warnings,
    ...(focusMode === 'auto' ? { focus: { mode: focusMode, applied: details.length > 0, reason: focus.reason } } : {}),
    coverage: { fromSeconds: range.from, toSeconds: range.to, nextFromSeconds: range.next,
      sampled: animated, audioIncluded: false, sampleIntervalSeconds: animated && range.at === null ? 1 / sampleFps : null,
      selectedTimes: [...new Set(rendered.flatMap(item => item.frame.atSeconds === null ? [] : [item.frame.atSeconds]))].sort((a, b) => a - b), omittedCandidates: omitted, timelineComplete: false } };
}
