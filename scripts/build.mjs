/*! Copyright (c) 2026 iinukami and contributors.
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7: see LICENSE-ADDITIONAL.
 */
import { mkdirSync, existsSync, lstatSync, realpathSync, rmSync, cpSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, dirname, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
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
for (const file of ['src', 'index.ts', 'plugin.yaml', 'package.json', 'package-lock.json', 'README.md', 'CONTRACT.md', 'CORE-REQUEST.md', 'LICENSE', 'LICENSE-ADDITIONAL', 'NOTICE.md', 'THIRD_PARTY_NOTICES.md'])
  cpSync(join(root, file), join(out, file), { recursive: true });
const npm = join(dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js');
const result = spawnSync(process.execPath, [npm, 'ls', '--omit=dev', '--all', '--parseable'], { cwd: root, encoding: 'utf8', windowsHide: true });
if (result.status !== 0) throw Error('Cannot resolve production dependencies');
for (const entry of result.stdout.trim().split(/\r?\n/).slice(1)) {
  const rel = relative(root, entry);
  if (!rel.startsWith('node_modules') || rel.split(/[\\/]/).includes('..') || lstatSync(entry).isSymbolicLink()) throw Error('Unsafe dependency path');
  cpSync(entry, join(out, rel), { recursive: true });
}
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
console.log(`Built ${Object.keys(files).length} files in dist/vision (${process.platform}/${process.arch})`);
