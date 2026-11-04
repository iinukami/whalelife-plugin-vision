/*! Copyright (c) 2026 iinukami and contributors.
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7: see LICENSE-ADDITIONAL.
 */
import { createReadStream } from 'node:fs';
import { lstat, realpath } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import release from '../vendor/ffmpeg.json' with { type: 'json' };
import { fail } from './types.ts';
import { runProcess } from './process.ts';

export type DecoderPaths = { ffmpegPath: string; ffprobePath: string };
export const bundledRoot = fileURLToPath(new URL(`../runtime/ffmpeg/${release.platform}-${release.arch}/`, import.meta.url));
/** Paths are internal to this package; never use PATH or saved user decoder paths. */
export class BundledDecoder {
  root: string;
  ready = false;
  problem: 'decoder_unavailable' | 'unsupported_platform' | null = 'decoder_unavailable';
  constructor(root = bundledRoot) { this.root = resolve(root); }
  async start(signal: AbortSignal) {
    this.ready = false;
    if (process.platform !== release.platform || process.arch !== release.arch) { this.problem = 'unsupported_platform'; return; }
    try {
      signal.throwIfAborted();
      if ((await lstat(this.root)).isSymbolicLink() || resolve(await realpath(this.root)) !== this.root) throw Error('Invalid runtime directory');
      for (const name of ['ffmpeg.exe', 'ffprobe.exe'] as const) {
        const file = join(this.root, name), expected = release.files[name], stat = await lstat(file);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== expected.bytes) throw Error('Invalid runtime file');
        const h = createHash('sha256');
        for await (const part of createReadStream(file, { signal })) h.update(part);
        if (h.digest('hex') !== expected.sha256) throw Error('Invalid runtime checksum');
        const output = await runProcess(file, ['-version'], signal, 32 * 1024, 5000);
        if (!output.toString('utf8').startsWith(`${name.slice(0, -4)} version ${release.version}-${release.variant}`)) throw Error('Invalid runtime version');
      }
      this.problem = null; this.ready = true;
    } catch { signal.throwIfAborted(); this.problem = 'decoder_unavailable'; }
  }
  paths(): DecoderPaths {
    if (!this.ready) fail('decoder_unavailable', this.problem === 'unsupported_platform' ? '此安装包的视频组件不支持当前系统，请使用对应系统的插件安装包。' : '内置视频组件缺失、损坏或无法启动，请重新安装完整视觉插件。');
    return { ffmpegPath: join(this.root, 'ffmpeg.exe'), ffprobePath: join(this.root, 'ffprobe.exe') };
  }
  status() { return { ready: this.ready, source: 'bundled', version: release.version, problem: this.problem }; }
}
