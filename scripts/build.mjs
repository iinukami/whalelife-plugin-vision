/*! Copyright (c) 2026 iinukami and contributors.
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7: see LICENSE-ADDITIONAL.
 */
import { mkdirSync, existsSync, lstatSync, realpathSync, rmSync, cpSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, dirname, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { prepareRuntime } from './prepare-runtime.mjs';
import { requireRelease } from './check-release.mjs';
const buildArgs = process.argv.slice(2);
if (buildArgs.some(arg => arg !== '--release') || buildArgs.length > 1) throw Error('Usage: node scripts/build.mjs [--release]');
const releaseBuild = buildArgs.includes('--release');
// Validate source materials before any download, removal or replacement of dist.
const approval = releaseBuild ? await requireRelease({ checkBuild: false }) : null;
const decoderRoot = await prepareRuntime();
const root = resolve(fileURLToPath(new URL('../', import.meta.url)));
const dist = join(root, 'dist'), out = join(dist, 'vision');
mkdirSync(dist, { recursive: true });
if (lstatSync(dist).isSymbolicLink() || resolve(realpathSync(dist)) !== dist) throw Error('Unsafe build root');
if (existsSync(out)) {
  if (dirname(resolve(out)) !== dist || lstatSync(out).isSymbolicLink() || resolve(realpathSync(out)) !== out || existsSync(join(out, 'data')))
    throw Error('Refusing to replace an unsafe build or user data');
  rmSync(out, { recursive: true });
}
mkdirSync(out);
for (const file of ['src', 'vendor', 'index.ts', 'plugin.yaml', 'package.json', 'package-lock.json', 'README.md', 'CONTRACT.md', 'CORE-REQUEST.md', 'LICENSE', 'LICENSE-ADDITIONAL', 'NOTICE.md', 'THIRD_PARTY_NOTICES.md'])
  cpSync(join(root, file), join(out, file), { recursive: true });
mkdirSync(join(out, 'runtime/ffmpeg/win32-x64'), { recursive: true });
for (const file of ['ffmpeg.exe', 'ffprobe.exe', 'LICENSE', 'README.txt'])
  cpSync(join(decoderRoot, file), join(out, 'runtime/ffmpeg/win32-x64', file));
const npm = join(dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js');
const result = spawnSync(process.execPath, [npm, 'ls', '--omit=dev', '--all', '--parseable'], { cwd: root, encoding: 'utf8', windowsHide: true });
if (result.status !== 0) throw Error('Cannot resolve production dependencies');
for (const entry of result.stdout.trim().split(/\r?\n/).slice(1)) {
  const rel = relative(root, entry);
  if (!rel.startsWith('node_modules') || rel.split(/[\\/]/).includes('..') || lstatSync(entry).isSymbolicLink()) throw Error('Unsafe dependency path');
  cpSync(entry, join(out, rel), { recursive: true });
}
writeFileSync(join(out, 'RELEASE-STATUS.json'), JSON.stringify({
  binaryReleaseApproved: !!approval, reviewSha256: approval?.reviewSha256 ?? null,
  sourceBundleSha256: approval?.sourceBundleSha256 ?? null,
  note: approval ? 'Offline material checks passed; verify source download availability before upload.' : 'Local build only. Run npm run build:release before binary distribution.'
}, null, 2) + '\n');
const files = {};
function visit(directory) {
  for (const item of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, item.name);
    if (item.isSymbolicLink()) throw Error('Build contains a symbolic link');
    if (item.isDirectory()) visit(path);
    else files[relative(out, path).replaceAll('\\', '/')] = createHash('sha256').update(readFileSync(path)).digest('hex');
  }
}
visit(out);
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
writeFileSync(join(out, 'BUILD.json'), JSON.stringify({ version: pkg.version, node: process.version, platform: process.platform, arch: process.arch, files }, null, 2) + '\n');
if (releaseBuild) await requireRelease();
console.log(`Built ${Object.keys(files).length} files in dist/vision (${process.platform}/${process.arch})`);
if (!releaseBuild) console.log('Local build only: binary release materials have not been approved.');
