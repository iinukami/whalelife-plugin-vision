/*! Copyright (c) 2026 iinukami and contributors.
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7: see LICENSE-ADDITIONAL.
 */
import { createReadStream } from 'node:fs';
import { mkdir, mkdtemp, lstat, realpath, writeFile, copyFile, rm, rename } from 'node:fs/promises';
import { resolve, join, dirname } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import release from '../vendor/ffmpeg.json' with { type: 'json' };
export const projectRoot = fileURLToPath(new URL('../', import.meta.url));
export const runtimeRoot = resolve(projectRoot, 'runtime/ffmpeg', `${release.platform}-${release.arch}`);
async function safeDirectory(directory) {
  await mkdir(directory, { recursive: true });
  if ((await lstat(directory)).isSymbolicLink() || resolve(await realpath(directory)) !== resolve(directory)) throw Error('Unsafe runtime directory');
}
async function hash(file) { const h = createHash('sha256'); for await (const part of createReadStream(file)) h.update(part); return h.digest('hex'); }
async function valid(directory) {
  try {
    await safeDirectory(directory);
    for (const [name, expected] of Object.entries(release.files)) {
      const file = join(directory, name), stat = await lstat(file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== expected.bytes || await hash(file) !== expected.sha256) return false;
    }
    return true;
  } catch { return false; }
}
export async function prepareRuntime() {
  if (process.platform !== release.platform || process.arch !== release.arch) throw Error('This release currently packages Windows x64; a verified runtime is required for another target');
  if (await valid(runtimeRoot)) return runtimeRoot;
  const cache = resolve(projectRoot, '.artifacts/ffmpeg-download'); await safeDirectory(cache);
  const archive = join(cache, release.archiveRoot + '.zip');
  let verified = false;
  try { const stat = await lstat(archive); verified = stat.isFile() && !stat.isSymbolicLink() && await hash(archive) === release.archiveSha256; } catch {}
  if (!verified) {
    const response = await fetch(release.archive, { signal: AbortSignal.timeout(180_000) });
    if (!response.ok || !response.body) throw Error('Cannot download the pinned FFmpeg runtime');
    const temporary = join(cache, 'download-' + randomUUID() + '.tmp');
    let size = 0;
    try {
      await writeFile(temporary, '', { flag: 'wx' });
      for await (const chunk of response.body) {
        size += chunk.byteLength; if (size > 160 * 1024 * 1024) throw Error('Runtime archive exceeds download limit');
        await writeFile(temporary, chunk, { flag: 'a' });
      }
      if (await hash(temporary) !== release.archiveSha256) throw Error('Runtime archive checksum mismatch');
      try { const stat = await lstat(archive); if (!stat.isFile() || stat.isSymbolicLink()) throw Error('Unsafe archive target'); await rm(archive); } catch (e) { if (e.code !== 'ENOENT') throw e; }
      await rename(temporary, archive);
    } finally { await rm(temporary, { force: true }); }
  }
  const stage = await mkdtemp(join(cache, 'extract-'));
  try {
    const members = Object.values(release.files).map(file => release.archiveRoot + '/' + file.member);
    const tar = join(process.env.SystemRoot || 'C:/Windows', 'System32/tar.exe');
    const result = spawnSync(tar, ['-xf', archive, '-C', stage, ...members], { windowsHide: true, encoding: 'utf8' });
    if (result.status !== 0) throw Error('Cannot extract verified runtime archive');
    const extracted = join(stage, release.archiveRoot);
    await safeDirectory(runtimeRoot);
    for (const [name, expected] of Object.entries(release.files)) {
      const source = join(extracted, expected.member), stat = await lstat(source);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== expected.bytes || await hash(source) !== expected.sha256) throw Error('Extracted runtime checksum mismatch');
      const target = join(runtimeRoot, name);
      try { if ((await lstat(target)).isSymbolicLink()) throw Error('Unsafe runtime file'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
      await copyFile(source, target);
    }
    if (!await valid(runtimeRoot)) throw Error('Runtime verification failed');
  } finally {
    if (dirname(resolve(stage)) !== cache || resolve(await realpath(cache)) !== cache || (await lstat(stage)).isSymbolicLink()) throw Error('Unsafe extraction cleanup');
    await rm(stage, { recursive: true, force: true });
  }
  return runtimeRoot;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await prepareRuntime(); console.log(`Prepared FFmpeg ${release.version} (${release.platform}/${release.arch})`);
}
