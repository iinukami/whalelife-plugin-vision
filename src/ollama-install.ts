/*! Copyright (c) 2026 iinukami and contributors.
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7: see LICENSE-ADDITIONAL.
 */
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { lstat, mkdir, open, readFile, readdir, realpath, rename, rm, writeFile, type FileHandle } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createInflateRaw } from 'node:zlib';
import manifest from '../vendor/ollama.json' with { type: 'json' };
import { VisionError } from './types.ts';

export type OllamaInstallProgress = { phase: 'downloading_runtime' | 'extracting'; downloadedBytes: number; totalBytes: number };
export type OllamaRuntimeManifest = Pick<typeof manifest, 'version' | 'platform' | 'arch' | 'url' | 'bytes' | 'sha256' | 'maxFiles' | 'maxExpandedBytes' | 'maxFileBytes' | 'requiredFiles'>;
/** Isolated synthetic tests only. Never read these overrides from settings, pages or tools. */
export type OllamaInstallDependencies = {
  manifest: OllamaRuntimeManifest; fetch: typeof fetch; platform: string; arch: string; timeoutMs: number;
};
type Entry = { path: string; directory: boolean; bytes: number; packed: number; crc: number; method: number; flags: number; offset: number; data: number };
type InstalledFile = { path: string; bytes: number; sha256: string };
type InstallRecord = { schema: 1; version: string; archiveBytes: number; archiveSha256: string; files: InstalledFile[] };
const RECORD = '.ollama-install.json';
const TEMP = /^\.prepare-[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const invalid = () => new VisionError('ollama_runtime_invalid', 'Ollama 组件校验失败，未安装或启动。');
const installedInvalid = () => new VisionError('ollama_runtime_invalid', '现有 Ollama 运行组件未通过校验，需人工检查或移走该版本组件目录后重新准备；已有模型和文件未被改动。');
const unsafe = () => new VisionError('unsafe_storage', 'Ollama 组件目录异常，已停止操作。');
function check(signal: AbortSignal) { if (signal.aborted) throw new VisionError('cancelled', 'Ollama 组件准备已取消或超时。'); }
function missing(error: unknown) { return (error as NodeJS.ErrnoException)?.code === 'ENOENT'; }

/** Check every ancestor, including existing directories, before creating or using a child. */
async function directory(path: string, create = false): Promise<void> {
  const absolute = resolve(path), parent = dirname(absolute);
  if (parent !== absolute) await directory(parent, create);
  let stat;
  try { stat = await lstat(absolute); }
  catch (error) {
    if (!create || !missing(error)) throw error;
    try { await mkdir(absolute); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    stat = await lstat(absolute);
  }
  if (!stat.isDirectory() || stat.isSymbolicLink() || resolve(await realpath(absolute)) !== absolute) throw unsafe();
}
async function regular(path: string, bytes?: number) {
  await directory(dirname(path));
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || (bytes !== undefined && stat.size !== bytes)) throw invalid();
  return stat;
}
function member(value: string, allowDirectory = true) {
  if (!value || value.length > 240 || /[^\x20-\x7e]|[\\:<>"|?*]/.test(value) || value.startsWith('/') || value === RECORD) throw invalid();
  const isDirectory = value.endsWith('/');
  if (isDirectory && !allowDirectory) throw invalid();
  const parts = (isDirectory ? value.slice(0, -1) : value).split('/');
  if (parts.some(part => !part || part === '.' || part === '..' || /[. ]$/.test(part) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) throw invalid();
  return value;
}
function extra(buffer: Buffer) {
  let at = 0;
  while (at < buffer.length) {
    if (at + 4 > buffer.length) throw invalid();
    const tag = buffer.readUInt16LE(at), length = buffer.readUInt16LE(at + 2);
    // Timestamps and UID/GID only. Reject alternate names, links and ZIP64 indirection.
    if (![0x5455, 0x7875, 0x000a].includes(tag) || at + 4 + length > buffer.length) throw invalid();
    at += 4 + length;
  }
}
async function readAt(file: FileHandle, length: number, position: number) {
  if (!Number.isSafeInteger(length) || length < 0 || length > 2 * 1024 * 1024 || position < 0) throw invalid();
  const bytes = Buffer.alloc(length);
  let at = 0;
  while (at < length) { const n = (await file.read(bytes, at, length - at, position + at)).bytesRead; if (!n) throw invalid(); at += n; }
  return bytes;
}

/** Parse bounded ZIP metadata before writing any extracted file. ZIP64/multi-disk are intentionally unsupported. */
async function entries(path: string, spec: OllamaRuntimeManifest, signal: AbortSignal): Promise<Entry[]> {
  await regular(path, spec.bytes);
  const file = await open(path, 'r');
  try {
    const tailLength = Math.min(spec.bytes, 65557), tailOffset = spec.bytes - tailLength;
    const tail = await readAt(file, tailLength, tailOffset);
    let end = -1;
    for (let at = tail.length - 22; at >= 0; at--) if (tail.readUInt32LE(at) === 0x06054b50 && at + 22 + tail.readUInt16LE(at + 20) === tail.length) { end = at; break; }
    if (end < 0 || tail.readUInt16LE(end + 4) || tail.readUInt16LE(end + 6)) throw invalid();
    const count = tail.readUInt16LE(end + 10), centralBytes = tail.readUInt32LE(end + 12), centralOffset = tail.readUInt32LE(end + 16);
    if (!count || count > spec.maxFiles || count === 0xffff || count !== tail.readUInt16LE(end + 8) || centralBytes > 2 * 1024 * 1024 || centralOffset + centralBytes !== tailOffset + end) throw invalid();
    const central = await readAt(file, centralBytes, centralOffset), result: Entry[] = [], names = new Map<string, boolean>();
    let at = 0, total = 0;
    for (let index = 0; index < count; index++) {
      check(signal);
      if (at + 46 > central.length || central.readUInt32LE(at) !== 0x02014b50) throw invalid();
      const flags = central.readUInt16LE(at + 8), method = central.readUInt16LE(at + 10), crc = central.readUInt32LE(at + 16);
      const packed = central.readUInt32LE(at + 20), bytes = central.readUInt32LE(at + 24), nameLength = central.readUInt16LE(at + 28);
      const extraLength = central.readUInt16LE(at + 30), commentLength = central.readUInt16LE(at + 32), attributes = central.readUInt32LE(at + 38);
      const offset = central.readUInt32LE(at + 42), next = at + 46 + nameLength + extraLength + commentLength;
      if (next > central.length || central.readUInt16LE(at + 34) || flags & ~0x080e || ![0, 8].includes(method) || [packed, bytes, offset].includes(0xffffffff)) throw invalid();
      const name = member(central.subarray(at + 46, at + 46 + nameLength).toString('utf8')), isDirectory = name.endsWith('/');
      const mode = attributes >>> 16, kind = mode & 0xf000, key = (isDirectory ? name.slice(0, -1) : name).toLowerCase();
      if (names.has(key) || key === RECORD || (attributes & 0x400) || ![0, 0x8000, 0x4000].includes(kind) ||
          (kind === 0x4000 && !isDirectory) || (kind === 0x8000 && isDirectory) || (isDirectory && (bytes || packed))) throw invalid();
      names.set(key, isDirectory); total += bytes;
      if (bytes > spec.maxFileBytes || total > spec.maxExpandedBytes || packed > spec.bytes || (method === 0 && bytes !== packed) || offset + 30 > centralOffset) throw invalid();
      extra(central.subarray(at + 46 + nameLength, at + 46 + nameLength + extraLength));
      const local = await readAt(file, 30, offset);
      if (local.readUInt32LE(0) !== 0x04034b50 || local.readUInt16LE(6) !== flags || local.readUInt16LE(8) !== method) throw invalid();
      const localNameLength = local.readUInt16LE(26), localExtraLength = local.readUInt16LE(28), data = offset + 30 + localNameLength + localExtraLength;
      if (data + packed > centralOffset) throw invalid();
      const localName = await readAt(file, localNameLength, offset + 30);
      if (localName.toString('utf8') !== name) throw invalid();
      extra(await readAt(file, localExtraLength, offset + 30 + localNameLength));
      const localCrc = local.readUInt32LE(14), localPacked = local.readUInt32LE(18), localBytes = local.readUInt32LE(22);
      if (flags & 8) {
        if ((localCrc && localCrc !== crc) || (localPacked && localPacked !== packed) || (localBytes && localBytes !== bytes)) throw invalid();
      } else if (localCrc !== crc || localPacked !== packed || localBytes !== bytes) throw invalid();
      result.push({ path: name, directory: isDirectory, bytes, packed, crc, method, flags, offset, data }); at = next;
    }
    if (at !== central.length) throw invalid();
    for (const [name] of names) {
      const parts = name.split('/'); parts.pop();
      while (parts.length) { if (names.get(parts.join('/')) === false) throw invalid(); parts.pop(); }
    }
    const ordered = [...result].sort((a, b) => a.offset - b.offset);
    for (let i = 0; i < ordered.length; i++) {
      const current = ordered[i], limit = ordered[i + 1]?.offset ?? centralOffset;
      let dataEnd = current.data + current.packed;
      if (current.flags & 8) {
        if (dataEnd + 12 > limit) throw invalid();
        const descriptor = await readAt(file, Math.min(16, limit - dataEnd), dataEnd);
        const shift = descriptor.readUInt32LE(0) === 0x08074b50 ? 4 : 0;
        if (descriptor.length < shift + 12 || descriptor.readUInt32LE(shift) !== current.crc || descriptor.readUInt32LE(shift + 4) !== current.packed || descriptor.readUInt32LE(shift + 8) !== current.bytes) throw invalid();
        dataEnd += shift + 12;
      }
      if (dataEnd > limit) throw invalid();
    }
    if (spec.requiredFiles.some(name => names.get(name.toLowerCase()) !== false)) throw invalid();
    return result;
  } catch (error) { check(signal); if (error instanceof VisionError) throw error; throw invalid(); }
  finally { await file.close(); }
}

const crcTable = Uint32Array.from({ length: 256 }, (_, index) => {
  let value = index; for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ ((value & 1) ? 0xedb88320 : 0); return value >>> 0;
});
async function extract(archive: string, output: string, list: Entry[], signal: AbortSignal, progress: (bytes: number) => void) {
  const files: InstalledFile[] = []; let expanded = 0;
  for (const item of list) {
    check(signal);
    const target = join(output, item.path);
    // Directories are structural; create only parents of recorded files.
    if (item.directory) continue;
    await directory(dirname(target), true);
    let size = 0, crc = 0xffffffff; const hash = createHash('sha256');
    const meter = new Transform({ transform(chunk: Buffer, _encoding, callback) {
      try {
        check(signal); size += chunk.length;
        if (size > item.bytes) throw invalid();
        hash.update(chunk); for (const value of chunk) crc = (crc >>> 8) ^ crcTable[(crc ^ value) & 0xff];
        expanded += chunk.length; progress(expanded); callback(null, chunk);
      } catch (error) { callback(error as Error); }
    } });
    if (!item.packed) {
      if (item.bytes || item.crc) throw invalid();
      await writeFile(target, Buffer.alloc(0), { flag: 'wx', mode: 0o600, signal });
    } else {
      const source = createReadStream(archive, { start: item.data, end: item.data + item.packed - 1, highWaterMark: 64 * 1024, signal });
      const destination = createWriteStream(target, { flags: 'wx', mode: 0o600, signal });
      if (item.method === 8) await pipeline(source, createInflateRaw(), meter, destination, { signal });
      else await pipeline(source, meter, destination, { signal });
    }
    if (size !== item.bytes || ((crc ^ 0xffffffff) >>> 0) !== item.crc) throw invalid();
    await regular(target, item.bytes);
    files.push({ path: item.path, bytes: item.bytes, sha256: hash.digest('hex') });
  }
  return files;
}

function allowedUrl(value: string) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443') ||
      !['github.com', 'release-assets.githubusercontent.com', 'objects.githubusercontent.com'].includes(url.hostname))
    throw new VisionError('ollama_download_failed', 'Ollama 下载地址不符合固定来源要求。');
  return url.href;
}
async function download(spec: OllamaRuntimeManifest, target: string, signal: AbortSignal, fetcher: typeof fetch, progress: (n: number) => void) {
  let url = allowedUrl(spec.url), response: Response | undefined;
  for (let redirects = 0; redirects <= 5; redirects++) {
    check(signal);
    response = await fetcher(url, { signal, redirect: 'manual', headers: { 'Accept-Encoding': 'identity' } });
    if (![301, 302, 303, 307, 308].includes(response.status)) break;
    const location = response.headers.get('location'); await response.body?.cancel();
    if (!location || redirects === 5) throw new VisionError('ollama_download_failed', 'Ollama 下载重定向未完成。');
    url = allowedUrl(new URL(location, url).href);
  }
  if (response?.status !== 200 || !response.body) { await response?.body?.cancel().catch(() => {}); throw new VisionError('ollama_download_failed', 'Ollama 组件下载未完成，请稍后重试。'); }
  const advertised = response.headers.get('content-length'), encoding = response.headers.get('content-encoding');
  if ((advertised !== null && (!/^\d+$/.test(advertised) || Number(advertised) !== spec.bytes)) || (encoding && encoding !== 'identity')) {
    await response.body.cancel(); throw invalid();
  }
  let file: FileHandle | undefined; const reader = response.body.getReader(), hash = createHash('sha256'); let size = 0;
  const abort = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener('abort', abort, { once: true });
  try {
    check(signal); await directory(dirname(target)); file = await open(target, 'wx', 0o600);
    while (true) {
      check(signal); const next = await reader.read(); check(signal); if (next.done) break;
      size += next.value.byteLength; if (size > spec.bytes) throw invalid();
      hash.update(next.value); await file.writeFile(next.value); progress(size);
    }
    if (size !== spec.bytes || hash.digest('hex') !== spec.sha256) throw invalid();
    await file.sync();
  } finally { signal.removeEventListener('abort', abort); await reader.cancel().catch(() => {}); reader.releaseLock(); await file?.close(); }
}
async function hashFile(path: string, bytes: number, signal: AbortSignal) {
  await regular(path, bytes); check(signal); let size = 0; const hash = createHash('sha256');
  for await (const chunk of createReadStream(path, { signal })) { check(signal); size += chunk.length; if (size > bytes) throw invalid(); hash.update(chunk); }
  if (size !== bytes) throw invalid(); return hash.digest('hex');
}

export class OllamaInstaller {
  readonly root: string;
  readonly runtime: string;
  private readonly signal: AbortSignal;
  private readonly deps: OllamaInstallDependencies;
  private pending?: Promise<void>;
  constructor(root: string, signal: AbortSignal, deps: Partial<OllamaInstallDependencies> = {}) {
    this.root = resolve(root); this.signal = signal;
    if (dirname(this.root) === this.root) throw unsafe();
    this.deps = { manifest, fetch: globalThis.fetch, platform: process.platform, arch: process.arch, timeoutMs: 60 * 60 * 1000, ...deps };
    if (!/^\d+\.\d+\.\d+$/.test(this.deps.manifest.version)) throw invalid();
    this.runtime = join(this.root, 'runtime', 'v' + this.deps.manifest.version);
  }
  private supported() {
    if (this.deps.platform !== this.deps.manifest.platform || this.deps.arch !== this.deps.manifest.arch)
      throw new VisionError('unsupported_platform', '自动准备 Ollama 目前仅支持 Windows x64。');
  }
  private async record(): Promise<InstallRecord> {
    await directory(this.runtime);
    const path = join(this.runtime, RECORD), stat = await regular(path);
    if (stat.size > 1024 * 1024) throw invalid();
    let value: InstallRecord;
    try { value = JSON.parse(await readFile(path, 'utf8')); } catch { throw invalid(); }
    const spec = this.deps.manifest;
    if (value?.schema !== 1 || value.version !== spec.version || value.archiveBytes !== spec.bytes || value.archiveSha256 !== spec.sha256 || !Array.isArray(value.files) || !value.files.length || value.files.length > spec.maxFiles) throw invalid();
    const names = new Set<string>(); let total = 0;
    for (const file of value.files) {
      if (typeof file?.path !== 'string' || !Number.isSafeInteger(file.bytes) || file.bytes < 0 || file.bytes > spec.maxFileBytes || typeof file.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(file.sha256)) throw invalid();
      member(file.path, false); const key = file.path.toLowerCase();
      if (key === RECORD || names.has(key)) throw invalid(); names.add(key); total += file.bytes;
    }
    if (total > spec.maxExpandedBytes || spec.requiredFiles.some(name => !names.has(name.toLowerCase()))) throw invalid();
    return value;
  }
  async inspect(): Promise<{ installed: boolean; runtimeVersion?: string }> {
    try {
      this.supported(); const record = await this.record();
      for (const name of this.deps.manifest.requiredFiles) { const file = record.files.find(file => file.path === name); if (!file) throw invalid(); await regular(join(this.runtime, name), file.bytes); }
      return { installed: true, runtimeVersion: this.deps.manifest.version };
    } catch (error) {
      if (missing(error) || (error instanceof VisionError && ['ollama_runtime_invalid', 'unsupported_platform'].includes(error.code))) return { installed: false };
      throw error;
    }
  }
  /** Verify every recorded executable/library before a process may be started; status polling only uses inspect(). */
  async executable(signal: AbortSignal = this.signal): Promise<string> {
    const combined = AbortSignal.any([signal, this.signal]);
    try {
      this.supported(); check(combined); const record = await this.record();
      const expected = new Map(record.files.map(file => [file.path, file]));
      const directories = new Set<string>();
      for (const file of record.files) {
        const parts = file.path.split('/'); parts.pop();
        while (parts.length) { directories.add(parts.join('/')); parts.pop(); }
      }
      const walk = async (path: string, prefix = ''): Promise<void> => {
        await directory(path);
        for (const name of await readdir(path)) {
          check(combined); const relative = prefix + name, target = join(path, name), stat = await lstat(target);
          if (!prefix && name === RECORD) continue;
          if (stat.isSymbolicLink()) throw unsafe();
          if (stat.isDirectory()) { if (!directories.has(relative)) throw invalid(); await walk(target, relative + '/'); continue; }
          const item = expected.get(relative); if (!item) throw invalid();
          await regular(target, item.bytes);
          if (/\.(exe|dll)$/i.test(item.path) && await hashFile(target, item.bytes, combined) !== item.sha256) throw invalid();
          expected.delete(relative);
        }
      };
      await walk(this.runtime); if (expected.size) throw invalid(); check(combined);
      return join(this.runtime, 'ollama.exe');
    } catch (error) {
      check(combined);
      if (error instanceof VisionError && ['unsupported_platform', 'unsafe_storage'].includes(error.code)) throw error;
      throw installedInvalid();
    }
  }
  prepare(signal: AbortSignal, onProgress: (progress: OllamaInstallProgress) => void = () => {}): Promise<void> {
    if (this.pending) return Promise.reject(new VisionError('ollama_setup_busy', 'Ollama 组件正在准备，请等待完成。'));
    const task = this.prepareOnce(AbortSignal.any([signal, this.signal, AbortSignal.timeout(this.deps.timeoutMs)]), onProgress);
    this.pending = task; void task.then(() => { if (this.pending === task) this.pending = undefined; }, () => { if (this.pending === task) this.pending = undefined; });
    return task;
  }
  private async prepareOnce(signal: AbortSignal, progress: (value: OllamaInstallProgress) => void) {
    let stage: string | undefined;
    try {
      this.supported(); check(signal);
      if ((await this.inspect()).installed) {
        try { await this.executable(signal); }
        catch (error) {
          check(signal); if (error instanceof VisionError && error.code === 'unsafe_storage') throw error;
          throw installedInvalid();
        }
        check(signal); return;
      }
      await directory(this.root, true); await directory(join(this.root, 'runtime'), true); check(signal);
      try { await lstat(this.runtime); throw new VisionError('ollama_runtime_invalid', '现有 Ollama 组件目录未通过校验，需人工检查或移走该版本组件目录后重新准备；未覆盖或删除该目录。'); }
      catch (error) { if (!missing(error)) throw error; }
      const candidate = join(this.root, '.prepare-' + randomUUID()); await mkdir(candidate); stage = candidate; await directory(stage);
      const archive = join(stage, 'runtime.zip'), output = join(stage, 'runtime'), spec = this.deps.manifest;
      progress({ phase: 'downloading_runtime', downloadedBytes: 0, totalBytes: spec.bytes });
      await download(spec, archive, signal, this.deps.fetch, downloadedBytes => progress({ phase: 'downloading_runtime', downloadedBytes, totalBytes: spec.bytes }));
      const list = await entries(archive, spec, signal), totalBytes = list.reduce((total, item) => total + item.bytes, 0);
      await directory(output, true); progress({ phase: 'extracting', downloadedBytes: 0, totalBytes });
      const files = await extract(archive, output, list, signal, downloadedBytes => progress({ phase: 'extracting', downloadedBytes, totalBytes }));
      const record: InstallRecord = { schema: 1, version: spec.version, archiveBytes: spec.bytes, archiveSha256: spec.sha256, files };
      check(signal); await directory(output);
      await writeFile(join(output, RECORD), JSON.stringify(record) + '\n', { flag: 'wx', mode: 0o600, signal });
      await directory(join(this.root, 'runtime')); check(signal);
      await rename(output, this.runtime);
    } catch (error) {
      check(signal); if (error instanceof VisionError) throw error;
      throw new VisionError('ollama_install_failed', 'Ollama 组件准备未完成，请检查网络和可用磁盘空间后重试。');
    } finally {
      if (stage) {
        await directory(this.root);
        if (dirname(stage) !== this.root || !TEMP.test(stage.slice(this.root.length + 1))) throw unsafe();
        await directory(stage);
        // Never scan/delete another attempt or follow a replacement directory link.
        await rm(stage, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
      }
    }
  }
}
