/*! Copyright (c) 2026 iinukami and contributors.
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7: see LICENSE-ADDITIONAL.
 */
import { mkdir, realpath, lstat, readdir, writeFile, unlink } from 'node:fs/promises';
import { resolve, join, dirname } from 'node:path';
import { randomBytes } from 'node:crypto';
import { fail, identity, reference, MiB, type Config, type MediaInfo, type MediaOffer } from './types.ts';

export type StoredMedia = { ref: string; session: string; path: string; size: number; expires: number; info: MediaInfo; pins: number; removed: boolean };
const unavailable = () => fail('media_unavailable', '媒体引用无效、已过期或不属于本会话。');
export class MediaStore {
  root: string;
  config: Config;
  entries = new Map<string, StoredMedia>();
  reservedBytes = 0;
  reservedCount = 0;
  reservedBySession = new Map<string, number>();
  stopped = false;
  now: () => number;
  constructor(root: string, config: Config, now = Date.now) { this.root = resolve(root); this.config = config; this.now = now; }
  async checkRoot() {
    if ((await lstat(this.root)).isSymbolicLink() || resolve(await realpath(this.root)) !== this.root)
      fail('unsafe_storage', '视觉临时目录不能是符号链接或重解析路径。');
  }
  async init() {
    await mkdir(this.root, { recursive: true });
    await this.checkRoot();
    // This dedicated directory contains only our opaque transient blobs. Unknown files stay untouched.
    for (const name of await readdir(this.root)) if (/^vis_[a-f0-9]{48}\.media$/.test(name)) await this.removeFile(join(this.root, name));
  }
  async removeFile(path: string) {
    await this.checkRoot();
    if (dirname(resolve(path)) !== this.root || !/^vis_[a-f0-9]{48}\.media$/.test(path.split(/[\\/]/).at(-1)!))
      fail('unsafe_storage', '拒绝清理视觉临时目录之外的文件。');
    try {
      if (!(await lstat(path)).isFile() || (await lstat(path)).isSymbolicLink()) fail('unsafe_storage', '拒绝操作异常临时文件。');
      await unlink(path);
    } catch (error: any) { if (error.code !== 'ENOENT') throw error; }
  }
  summary() { return { items: this.entries.size, bytes: [...this.entries.values()].reduce((n, e) => n + e.size, 0) }; }
  async offer(session: string, bytes: Buffer, inspect: (path: string) => Promise<MediaInfo>, signal: AbortSignal): Promise<MediaOffer> {
    identity(session); signal.throwIfAborted();
    if (this.stopped) fail('stopped', '视觉插件已停用。');
    if (!bytes.length || bytes.length > this.config.maxMediaMiB * MiB) fail('media_size', '媒体超过单文件容量限制。');
    const used = this.summary();
    const own = [...this.entries.values()].filter(e => e.session === session);
    if (used.bytes + this.reservedBytes + bytes.length > this.config.maxTotalMiB * MiB || used.items + this.reservedCount >= 64 || own.length + (this.reservedBySession.get(session) ?? 0) >= 16)
      fail('quota', '视觉临时容量已满，请释放旧引用或等待过期。');
    this.reservedBytes += bytes.length; this.reservedCount++;
    this.reservedBySession.set(session, (this.reservedBySession.get(session) ?? 0) + 1);
    const ref = 'vis_' + randomBytes(24).toString('hex'), path = join(this.root, ref + '.media');
    let retained = false;
    try {
      await this.checkRoot(); signal.throwIfAborted();
      await writeFile(path, bytes, { flag: 'wx', mode: 0o600, signal });
      const info = await inspect(path);
      signal.throwIfAborted();
      if (this.stopped) fail('stopped', '视觉插件已停用。');
      const e: StoredMedia = { ref, session, path, size: bytes.length, expires: this.now() + this.config.ttlSeconds * 1000, info, pins: 0, removed: false };
      this.entries.set(ref, e); retained = true;
      return this.public(e);
    } finally {
      this.reservedBytes -= bytes.length; this.reservedCount--;
      const remaining = (this.reservedBySession.get(session) ?? 1) - 1;
      if (remaining) this.reservedBySession.set(session, remaining); else this.reservedBySession.delete(session);
      if (!retained) await this.removeFile(path);
    }
  }
  public(e: StoredMedia): MediaOffer { return { mediaRef: e.ref, expiresAt: new Date(e.expires).toISOString(), info: { ...e.info } }; }
  lookup(session: unknown, ref: unknown) {
    identity(session); reference(ref);
    const e = this.entries.get(ref as string);
    if (this.stopped || !e || e.session !== session || e.removed || e.expires <= this.now()) unavailable();
    return e!;
  }
  async use<T>(session: string, ref: string, signal: AbortSignal, fn: (e: StoredMedia) => Promise<T>): Promise<T> {
    signal.throwIfAborted();
    const e = this.lookup(session, ref); e.pins++;
    try {
      await this.checkRoot();
      const stat = await lstat(e.path);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== e.size) fail('unsafe_storage', '临时媒体文件已改变。');
      const result = await fn(e);
      signal.throwIfAborted(); this.lookup(session, ref);
      return result;
    } finally {
      e.pins--;
      if (e.removed && e.pins === 0) { await this.removeFile(e.path); this.entries.delete(e.ref); }
    }
  }
  async release(session: string, ref: string) {
    const e = this.lookup(session, ref); e.removed = true;
    if (!e.pins) { await this.removeFile(e.path); this.entries.delete(e.ref); }
    return { released: true };
  }
  async sweep() {
    for (const e of this.entries.values()) if (e.expires <= this.now() || e.removed || this.stopped) {
      e.removed = true;
      if (!e.pins) { await this.removeFile(e.path); this.entries.delete(e.ref); }
    }
  }
  async stop() { this.stopped = true; await this.sweep(); }
}
