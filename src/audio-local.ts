/*! Copyright (c) 2026 iinukami and contributors.
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7: see LICENSE-ADDITIONAL.
 */
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, mkdir, open, readFile, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { inflateRawSync } from 'node:zlib';
import manifest from '../vendor/sensevoice.json' with { type: 'json' };
import type { AudioEvidence, AudioSegment } from './audio-types.ts';
import { VisionError } from './types.ts';

type Asset = { name: string; url: string; bytes: number; sha256: string };
type ResourceManifest = { id: string; model: string; assets: Asset[] };
type Runner = (exe: string, args: string[], signal: AbortSignal) => Promise<Buffer>;
/** Dependency injection for isolated tests only; never populated from plugin/model/tool configuration. */
export type LocalSpeechDependencies = {
  manifest: ResourceManifest; fetch: typeof globalThis.fetch; run: Runner; platform: string;
};
type Phase = 'missing' | 'checking' | 'downloading' | 'verifying' | 'ready' | 'error' | 'stopped';
const EXE = 'llama-funasr-sensevoice.exe';
const MAX_OUTPUT = 64 * 1024;
const UUID = '[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}';
const OWNED_CLIP = new RegExp(`^\\.clip-${UUID}$`);
const OWNED_TEMP = new RegExp(`^(?:\\.prepare-|\\.old-|\\.clip-)${UUID}$`);
const err = (code: string, text: string) => new VisionError(code, text);
const cancelled = () => err('cancelled', '本地语音操作已取消。');
function check(signal: AbortSignal) { if (signal.aborted) throw cancelled(); }
function missing(e: unknown) { return (e as NodeJS.ErrnoException)?.code === 'ENOENT'; }
function sha256(b: Buffer) { return createHash('sha256').update(b).digest('hex'); }

async function directory(path: string, create = false) {
  if (create) {
    try { await lstat(path); }
    catch (e) {
      if (!missing(e)) throw e;
      // Check each existing ancestor before creating anything through it.
      await directory(dirname(path), true);
      try { await mkdir(path); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e; }
    }
  }
  const stat = await lstat(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || resolve(await realpath(path)) !== resolve(path))
    throw err('unsafe_storage', '本地语音资源目录异常。');
}
async function fileHash(path: string, bytes: number, signal: AbortSignal) {
  check(signal);
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== bytes)
    throw err('local_resource_invalid', '本地语音资源校验失败，请重新准备。');
  const hash = createHash('sha256');
  let size = 0;
  for await (const chunk of createReadStream(path)) {
    check(signal); size += chunk.length;
    if (size > bytes) throw err('local_resource_invalid', '本地语音资源校验失败，请重新准备。');
    hash.update(chunk);
  }
  if (size !== bytes) throw err('local_resource_invalid', '本地语音资源校验失败，请重新准备。');
  return hash.digest('hex');
}

function crc32(b: Buffer) {
  let crc = 0xffffffff;
  for (const byte of b) { crc ^= byte; for (let j = 0; j < 8; j++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0); }
  return (crc ^ 0xffffffff) >>> 0;
}

/** Inspect every entry, but extract only the one expected executable. No archive paths reach the filesystem. */
export function senseVoiceExecutable(zip: Buffer): Buffer {
  const invalid = () => err('local_resource_invalid', '本地语音组件压缩包无效。');
  try {
    let end = -1;
    for (let i = zip.length - 22; i >= Math.max(0, zip.length - 65557); i--) {
      if (zip.readUInt32LE(i) === 0x06054b50 && i + 22 + zip.readUInt16LE(i + 20) === zip.length) { end = i; break; }
    }
    if (end < 0 || zip.readUInt16LE(end + 4) || zip.readUInt16LE(end + 6)) throw invalid();
    const count = zip.readUInt16LE(end + 10), central = zip.readUInt32LE(end + 16);
    if (!count || count > 64 || count !== zip.readUInt16LE(end + 8) || central + zip.readUInt32LE(end + 12) !== end) throw invalid();
    let p = central, found: Buffer | undefined, declared = 0;
    const names = new Set<string>();
    for (let n = 0; n < count; n++) {
      if (zip.readUInt32LE(p) !== 0x02014b50) throw invalid();
      const flags = zip.readUInt16LE(p + 8), method = zip.readUInt16LE(p + 10);
      const crc = zip.readUInt32LE(p + 16), packed = zip.readUInt32LE(p + 20), size = zip.readUInt32LE(p + 24);
      const nameLen = zip.readUInt16LE(p + 28), extraLen = zip.readUInt16LE(p + 30), commentLen = zip.readUInt16LE(p + 32);
      const offset = zip.readUInt32LE(p + 42), mode = zip.readUInt32LE(p + 38) >>> 16;
      const name = zip.subarray(p + 46, p + 46 + nameLen).toString('utf8');
      const parts = name.replaceAll('\\', '/').split('/');
      if (!name || name.length > 240 || /[\x00-\x1f:]/.test(name) || /^[\\/]/.test(name) ||
          parts.some((v, i) => v === '..' || v === '.' || (!v && i !== parts.length - 1) || /[. ]$/.test(v)) ||
          parts.some(v => /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(v)) ||
          names.has(name.toLowerCase()) || (mode & 0xf000) === 0xa000 || (flags & 1) || ![0, 8].includes(method)) throw invalid();
      names.add(name.toLowerCase()); declared += size;
      if (declared > 128 * 1024 * 1024 || size > 64 * 1024 * 1024 || offset + 30 > central) throw invalid();
      if (zip.readUInt32LE(offset) !== 0x04034b50 || zip.readUInt16LE(offset + 8) !== method ||
          zip.readUInt16LE(offset + 6) !== flags) throw invalid();
      const localNameLen = zip.readUInt16LE(offset + 26), localExtraLen = zip.readUInt16LE(offset + 28);
      const localName = zip.subarray(offset + 30, offset + 30 + localNameLen).toString('utf8');
      const data = offset + 30 + localNameLen + localExtraLen;
      if (localName !== name || data + packed > central) throw invalid();
      if (parts.at(-1) === EXE) {
        if (found || size > 32 * 1024 * 1024 || size < 2) throw invalid();
        const compressed = zip.subarray(data, data + packed);
        found = method === 0 ? Buffer.from(compressed) : inflateRawSync(compressed, { maxOutputLength: size });
        if (found.length !== size || crc32(found) !== crc || found.toString('ascii', 0, 2) !== 'MZ') throw invalid();
      }
      p += 46 + nameLen + extraLen + commentLen;
      if (p > end) throw invalid();
    }
    if (p !== end || !found) throw invalid();
    return found;
  } catch { throw invalid(); }
}

function allowedUrl(value: string) {
  const u = new URL(value);
  const hosts = ['github.com', 'release-assets.githubusercontent.com', 'objects.githubusercontent.com', 'huggingface.co'];
  if (u.protocol !== 'https:' || u.username || u.password || (u.port && u.port !== '443') ||
      !(hosts.includes(u.hostname) || u.hostname.endsWith('.hf.co') || u.hostname === 'cdn-lfs.huggingface.co'))
    throw err('local_download_failed', '资源下载地址不符合固定来源要求。');
  return u.href;
}

async function download(asset: Asset, path: string, signal: AbortSignal, fetcher: typeof fetch, progress: (n: number) => void) {
  let url = allowedUrl(asset.url), response: Response | undefined;
  for (let redirects = 0; redirects <= 5; redirects++) {
    check(signal);
    response = await fetcher(url, { signal, redirect: 'manual', headers: { 'Accept-Encoding': 'identity' } });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get('location'); await response.body?.cancel();
      if (!location || redirects === 5) throw err('local_download_failed', '资源下载重定向失败。');
      url = allowedUrl(new URL(location, url).href); continue;
    }
    break;
  }
  if (!response?.ok || !response.body) {
    await response?.body?.cancel().catch(() => {});
    throw err('local_download_failed', '资源下载失败，请稍后重试。');
  }
  const advertised = response.headers.get('content-length');
  if (advertised !== null && Number(advertised) !== asset.bytes) {
    await response.body.cancel(); throw err('local_resource_invalid', '资源下载大小校验失败。');
  }
  const handle = await open(path, 'wx').catch(async e => { await response!.body!.cancel().catch(() => {}); throw e; });
  const reader = response.body.getReader();
  const hash = createHash('sha256'); let size = 0;
  try {
    while (true) {
      check(signal); const { value, done } = await reader.read(); if (done) break;
      size += value.byteLength;
      if (size > asset.bytes) throw err('local_resource_invalid', '资源下载超过声明大小。');
      hash.update(value); await handle.writeFile(value); progress(value.byteLength);
    }
    check(signal);
    if (size !== asset.bytes || hash.digest('hex') !== asset.sha256) throw err('local_resource_invalid', '资源下载摘要校验失败。');
    await handle.sync();
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); await handle.close(); }
}

/** Fixed CLI, no shell, bounded output/time. Upstream can print compute failure then exit 0. */
export async function runSenseVoiceProcess(exe: string, args: string[], signal: AbortSignal): Promise<Buffer> {
  check(signal);
  return new Promise((resolvePromise, reject) => {
    const child = spawn(exe, args, { windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    let failure: Error | undefined, bytes = 0, diagnostic = '';
    const chunks: Buffer[] = [];
    const stop = (e: Error) => { failure ??= e; child.kill('SIGKILL'); };
    const abort = () => stop(cancelled());
    const timer = setTimeout(() => stop(err('local_inference_timeout', '本地语音识别超时。')), 180_000); timer.unref();
    signal.addEventListener('abort', abort, { once: true }); if (signal.aborted) abort();
    child.stdout.on('data', (b: Buffer) => {
      bytes += b.length;
      if (bytes > MAX_OUTPUT) stop(err('output_limit', '本地语音输出超过限制。'));
      else if (!failure) chunks.push(b);
    });
    child.stderr.on('data', (b: Buffer) => {
      diagnostic = (diagnostic + b.toString('utf8')).slice(-4096);
      if (/compute failed|read audio failed|load gguf failed|vad failed|missing args/.test(diagnostic))
        stop(err('local_inference_failed', '本地语音识别失败。'));
    });
    child.on('error', () => { failure ??= err('local_runtime_unavailable', '本地语音组件无法启动，请检查组件准备状态。'); });
    child.once('close', code => {
      clearTimeout(timer); signal.removeEventListener('abort', abort); diagnostic = '';
      if (failure) reject(failure);
      else if (code !== 0) reject(err('local_inference_failed', '本地语音识别失败。'));
      else resolvePromise(Buffer.concat(chunks));
    });
  });
}

function wavDuration(wav: Buffer) {
  const invalid = () => err('invalid_audio', '需要不超过 60 秒的 16 kHz 单声道 PCM16 WAV。');
  try {
    if (wav.length < 44 || wav.length > 60 * 32000 + 8192 || wav.toString('ascii', 0, 4) !== 'RIFF' ||
        wav.toString('ascii', 8, 12) !== 'WAVE' || wav.readUInt32LE(4) + 8 !== wav.length) throw invalid();
    let format = false, samples = 0, seen = false, p = 12;
    while (p + 8 <= wav.length) {
      const type = wav.toString('ascii', p, p + 4), size = wav.readUInt32LE(p + 4), end = p + 8 + size;
      if (end > wav.length) throw invalid();
      if (type === 'fmt ') {
        if (format || size < 16 || wav.readUInt16LE(p + 8) !== 1 || wav.readUInt16LE(p + 10) !== 1 ||
            wav.readUInt32LE(p + 12) !== 16000 || wav.readUInt32LE(p + 16) !== 32000 ||
            wav.readUInt16LE(p + 20) !== 2 || wav.readUInt16LE(p + 22) !== 16) throw invalid();
        format = true;
      }
      if (type === 'data') { if (seen || size % 2) throw invalid(); seen = true; samples = size / 2; }
      p = end + (size % 2);
    }
    if (!format || !seen || p !== wav.length || samples < 400 || samples > 60 * 16000) throw invalid();
    return samples / 16000;
  } catch { throw invalid(); }
}

export function parseSenseVoiceSrt(output: Buffer, duration: number): AudioEvidence {
  if (output.length > MAX_OUTPUT) throw err('output_limit', '本地语音输出超过限制。');
  const raw = output.toString('utf8').replace(/^\uFEFF/, '').replaceAll('\r\n', '\n').trim();
  const segments: AudioSegment[] = [], events = new Set<string>();
  const eventNames: Record<string, string> = { BGM: '音乐', Music: '音乐', Applause: '掌声', Laughter: '笑声', Cry: '哭声',
    Crying: '哭声', Cough: '咳嗽', Coughing: '咳嗽', Sneeze: '喷嚏', Sneezing: '喷嚏', Breath: '呼吸声' };
  const invalid = () => err('local_output_invalid', '本地语音返回格式无效。');
  const time = (s: string) => { const [h, m, sec, ms] = s.split(/[:,]/).map(Number); if (m > 59 || sec > 59) throw invalid(); return h * 3600 + m * 60 + sec + ms / 1000; };
  let length = 0, blocks = 0;
  if (raw) for (const block of raw.split(/\n\s*\n/)) {
    const match = /^(\d+)\n(\d{2}:\d{2}:\d{2},\d{3}) --> (\d{2}:\d{2}:\d{2},\d{3})\n([\s\S]+)$/.exec(block);
    if (!match || ++blocks > 256) throw invalid();
    const start = time(match[2]), end = time(match[3]);
    if (start < 0 || end <= start || start >= duration || end > duration + 0.15 || (segments.length && start < segments.at(-1)!.endSeconds - 0.05)) throw invalid();
    const text = match[4].replace(/<\|([^|<>]{1,40})\|>/g, (_all, tag: string) => {
      if (eventNames[tag]) events.add(eventNames[tag]); return '';
    }).replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '').trim();
    length += text.length;
    if (length > 12000) throw err('output_limit', '本地语音转写文本超过限制。');
    if (text) segments.push({ startSeconds: start, endSeconds: Math.min(end, duration), text });
  }
  return { text: segments.map(s => s.text).join('\n'), timing: 'segment', segments, events: [...events],
    warnings: ['时间范围来自语音活动分段，不是逐字对齐；事件标签仅覆盖识别片段，不能代表完整环境声分析。',
      ...(!segments.length ? ['本片段未得到可用语音转写；不据此断言没有声音。'] : [])],
    details: { model: 'SenseVoiceSmall q8', backend: 'cpu', fixedThreads: 8, timestampSource: 'vad_segments' } };
}

/** root is this plugin's dedicated data/audio-local directory. Start never installs/downloads. */
export class LocalSpeech {
  private readonly root: string;
  private readonly deps: LocalSpeechDependencies;
  private readonly abort = new AbortController();
  private readonly signal: AbortSignal;
  private phase: Phase = 'missing';
  private ready = false;
  private downloaded = 0;
  private errorText: string | undefined;
  private preparing?: Promise<void>;
  private running?: Promise<AudioEvidence>;
  private stopTask?: Promise<void>;
  private readonly version: string;
  private expectedExecutable?: { bytes: number; sha256: string };
  constructor(root: string, signal: AbortSignal, dependencies: Partial<LocalSpeechDependencies> = {}) {
    this.root = resolve(root);
    this.deps = { manifest, fetch: globalThis.fetch, run: runSenseVoiceProcess, platform: `${process.platform}-${process.arch}`, ...dependencies };
    this.signal = AbortSignal.any([signal, this.abort.signal]);
    this.version = join(this.root, this.deps.manifest.id);
    if (!/^[a-z0-9-]{1,80}$/.test(this.deps.manifest.id) || this.deps.manifest.assets.length !== 3 ||
        this.deps.manifest.assets.some(a => !/^[a-z0-9.-]+$/.test(a.name) || a.name !== basename(a.name) ||
          !Number.isSafeInteger(a.bytes) || a.bytes <= 0 || a.bytes > 512 * 1024 * 1024 || !/^[a-f0-9]{64}$/.test(a.sha256)))
      throw err('local_resource_invalid', '本地语音资源声明无效。');
  }
  status() {
    return { ready: this.ready && !this.signal.aborted, phase: this.signal.aborted ? 'stopped' : this.phase,
      downloadBytes: this.downloaded, totalBytes: this.deps.manifest.assets.reduce((sum, a) => sum + a.bytes, 0),
      model: this.deps.manifest.model, fixedThreads: 8, backend: 'cpu', supported: this.deps.platform === 'win32-x64',
      ...(this.errorText ? { error: this.errorText } : {}) };
  }
  private supported() {
    check(this.signal);
    if (this.deps.platform !== 'win32-x64') throw err('local_platform_unsupported', '本地语音组件当前仅支持 Windows x64。');
  }
  private async verify(signal: AbortSignal) {
    await directory(this.root); await directory(this.version);
    for (const asset of this.deps.manifest.assets) {
      if (await fileHash(join(this.version, asset.name), asset.bytes, signal) !== asset.sha256)
        throw err('local_resource_invalid', '本地语音资源摘要不匹配，请重新准备。');
    }
    // The archive is still hashed above on every use. Cache only its derived executable digest,
    // avoiding repeated synchronous ZIP decompression/CRC; never trust a persisted digest cache.
    if (!this.expectedExecutable) {
      const executable = senseVoiceExecutable(await readFile(join(this.version, 'runtime.zip')));
      this.expectedExecutable = { bytes: executable.length, sha256: sha256(executable) };
    }
    if (await fileHash(join(this.version, EXE), this.expectedExecutable.bytes, signal) !== this.expectedExecutable.sha256)
      throw err('local_resource_invalid', '本地语音可执行组件校验失败。');
    check(signal);
  }
  async start() {
    if (this.running || this.preparing) throw err('busy', '本地语音组件正在处理另一项任务。');
    this.phase = 'checking'; this.ready = false; this.errorText = undefined;
    try { this.supported(); await this.cleanupClips(this.signal); await this.verify(this.signal); this.ready = true; this.phase = 'ready'; }
    catch (e) {
      if (this.signal.aborted) { this.phase = 'stopped'; return; }
      this.phase = missing(e) ? 'missing' : 'error';
      if (!missing(e)) this.errorText = e instanceof VisionError ? e.message : '本地语音资源检查失败。';
    }
  }
  prepare(): Promise<void> {
    if (this.preparing) return this.preparing;
    if (this.running) return Promise.reject(err('busy', '本地语音正在识别，请稍后准备资源。'));
    this.preparing = this.install().finally(() => { this.preparing = undefined; });
    return this.preparing;
  }
  private async removeOwned(path: string) {
    if (dirname(resolve(path)) !== this.root || !OWNED_TEMP.test(basename(path)))
      throw err('unsafe_storage', '本地语音清理路径异常。');
    await directory(this.root);
    const st = await lstat(path).catch(e => { if (missing(e)) return undefined; throw e; });
    if (!st) return;
    if (!st.isDirectory() || st.isSymbolicLink()) throw err('unsafe_storage', '本地语音清理目录异常。');
    await rm(path, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
  private async cleanupClips(signal: AbortSignal) {
    check(signal);
    try { await directory(this.root); } catch (e) { if (missing(e)) return; throw e; }
    for (const name of await readdir(this.root)) {
      check(signal);
      if (!OWNED_CLIP.test(name)) continue;
      const path = join(this.root, name); await directory(path);
      const children = await readdir(path);
      if (children.some(child => child !== 'input.wav'))
        throw err('unsafe_storage', '本地语音临时目录包含未知文件，未清理。');
      if (children.length) {
        const input = await lstat(join(path, 'input.wav'));
        if (!input.isFile() || input.isSymbolicLink())
          throw err('unsafe_storage', '本地语音临时文件异常，未清理。');
      }
      await this.removeOwned(path);
    }
  }
  private async install() {
    let stage: string | undefined, backup: string | undefined;
    const signal = AbortSignal.any([this.signal, AbortSignal.timeout(15 * 60_000)]);
    this.ready = false; this.errorText = undefined; this.downloaded = 0;
    try {
      this.supported();
      await this.cleanupClips(signal);
      try { await this.verify(signal); this.ready = true; this.phase = 'ready'; return; }
      catch (e) { if (signal.aborted || (e instanceof VisionError && e.code === 'unsafe_storage')) throw e; }
      await directory(this.root, true);
      stage = join(this.root, `.prepare-${randomUUID()}`); await mkdir(stage);
      this.phase = 'downloading';
      for (const asset of this.deps.manifest.assets) {
        await download(asset, join(stage, asset.name), signal, this.deps.fetch, n => { this.downloaded += n; });
      }
      this.phase = 'verifying'; check(signal);
      const executable = senseVoiceExecutable(await readFile(join(stage, 'runtime.zip')));
      await writeFile(join(stage, EXE), executable, { flag: 'wx' });
      this.expectedExecutable = { bytes: executable.length, sha256: sha256(executable) };
      check(signal);
      const existing = await lstat(this.version).catch(e => { if (missing(e)) return undefined; throw e; });
      if (existing) {
        await directory(this.version);
        backup = join(this.root, `.old-${randomUUID()}`); await rename(this.version, backup);
      }
      try { await rename(stage, this.version); stage = undefined; }
      catch (e) { if (backup) { await rename(backup, this.version); backup = undefined; } throw e; }
      check(signal); this.ready = true; this.phase = 'ready';
    } catch (e) {
      this.ready = false; this.phase = this.signal.aborted ? 'stopped' : 'error';
      const safe = signal.aborted ? cancelled() : e instanceof VisionError ? e : err('local_download_failed', '本地语音资源准备失败，请稍后重试。');
      this.errorText = safe.message; throw safe;
    } finally {
      try { if (stage) await this.removeOwned(stage); if (backup) await this.removeOwned(backup); }
      catch { this.ready = false; this.phase = this.signal.aborted ? 'stopped' : 'error'; this.errorText = '本地语音临时资源未能清理。'; throw err('cleanup_failed', this.errorText); }
    }
  }
  transcribe(wav: Buffer, signal: AbortSignal, threads = 8): Promise<AudioEvidence> {
    if (this.running || this.preparing) return Promise.reject(err('busy', '本地语音组件正在处理另一项任务。'));
    this.running = this.recognize(wav, signal, threads).finally(() => { this.running = undefined; });
    return this.running;
  }
  private async recognize(wav: Buffer, request: AbortSignal, threads: number) {
    const signal = AbortSignal.any([this.signal, request]); let temp: string | undefined;
    try {
      check(signal); this.supported();
      if (!this.ready) throw err('local_not_ready', '请先在插件设置中准备本地语音资源。');
      const duration = wavDuration(wav);
      try { await this.verify(signal); }
      catch (e) {
        if (signal.aborted) throw cancelled();
        this.ready = false; this.phase = 'error'; this.errorText = '本地语音资源校验失败，请重新准备。';
        throw e instanceof VisionError ? e : err('local_resource_invalid', this.errorText);
      }
      temp = join(this.root, `.clip-${randomUUID()}`); await mkdir(temp);
      const input = join(temp, 'input.wav'); await writeFile(input, wav, { flag: 'wx' }); check(signal);
      const args = ['-m', join(this.version, 'sensevoice-small-q8.gguf'), '-a', input,
        '--vad', join(this.version, 'fsmn-vad.gguf'), '--vad-maxseg', '30000', '--backend', 'cpu', '--srt', '--keep-tags'];
      const output = await this.deps.run(join(this.version, EXE), args, signal); check(signal);
      const result = parseSenseVoiceSrt(output, duration);
      if (threads !== 8) result.warnings.push('当前固定版本使用 8 个 CPU 线程，传入的线程数未生效。');
      return result;
    } catch (e) {
      if (signal.aborted) throw cancelled();
      if (e instanceof VisionError) throw e;
      throw err('local_inference_failed', '本地语音识别失败。');
    } finally { if (temp) await this.removeOwned(temp); }
  }
  stop(): Promise<void> {
    if (!this.stopTask) {
      this.abort.abort(); this.ready = false; this.phase = 'stopped';
      this.stopTask = Promise.allSettled([this.preparing, this.running]).then(() => {});
    }
    return this.stopTask;
  }
}
