/*! Copyright (c) 2026 iinukami and contributors.
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7: see LICENSE-ADDITIONAL.
 */
import { createHash } from 'node:crypto';
import { createReadStream, readFileSync, lstatSync, realpathSync, readdirSync } from 'node:fs';
import { resolve, join, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';

export const projectRoot = fileURLToPath(new URL('../', import.meta.url));
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const nonempty = value => typeof value === 'string' && value.trim().length > 0;
const validHash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const relativeName = name => nonempty(name) && !name.includes('\\') && !name.includes(':') && !name.startsWith('/')
  && !name.split('/').some(p => !p || p === '.' || p === '..');
function inside(root, name) {
  if (!relativeName(name)) throw Error('Unsafe material path');
  const absoluteRoot = resolve(root), result = resolve(absoluteRoot, name), rel = relative(absoluteRoot, result);
  if (!rel || isAbsolute(rel) || rel.startsWith('..')) throw Error('Unsafe material path');
  if (resolve(realpathSync(absoluteRoot)) !== absoluteRoot || lstatSync(absoluteRoot).isSymbolicLink()) throw Error('Linked material root');
  let current = absoluteRoot;
  for (const part of name.split('/')) { current = join(current, part); if (lstatSync(current).isSymbolicLink()) throw Error('Linked material path'); }
  return result;
}
async function digest(file) { const hash = createHash('sha256'); for await (const chunk of createReadStream(file)) hash.update(chunk); return hash.digest('hex'); }
function publicUrl(value) {
  try { const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash && url.pathname !== '/'; }
  catch { return false; }
}
export function externalNames(readme) {
  const names = ['ffmpeg'];
  for (const [start, end] of [['External libraries:', 'External libraries providing hardware acceleration:'], ['External libraries providing hardware acceleration:', 'Libraries:']]) {
    const section = readme.split(start)[1]?.split(end)[0];
    if (!section?.trim()) throw Error('Cannot identify dependency inventory in pinned README');
    names.push(...section.trim().split(/\s+/));
  }
  return [...new Set(names)].sort();
}

/** Offline release checks. Human review of source correspondence and licensing remains required. */
export async function checkRelease({ root = projectRoot, materialsRoot = join(root, '.artifacts/ffmpeg-sources'), checkBuild = true } = {}) {
  const issues = [], add = message => issues.push(message);
  let pinned, review, reviewBytes;
  try {
    pinned = JSON.parse(readFileSync(join(root, 'vendor/ffmpeg.json'), 'utf8'));
    reviewBytes = readFileSync(join(root, 'vendor/ffmpeg-source-review.json'));
    review = JSON.parse(reviewBytes.toString('utf8'));
  } catch { return { ok: false, issues: ['发行清单或源码审查记录缺失／格式错误。'] }; }
  const reviewSha256 = sha256(reviewBytes);
  if (review.schemaVersion !== 1) add('源码审查记录版本不支持。');
  const expectedTarget = { version: pinned.version, archiveSha256: pinned.archiveSha256, files: Object.fromEntries(Object.entries(pinned.files).map(([name, value]) => [name, value.sha256])) };
  if (!isDeepStrictEqual(review.target, expectedTarget)) add('源码审查记录没有绑定当前固定 FFmpeg 构建。');
  const runtime = join(root, 'runtime/ffmpeg', pinned.platform + '-' + pinned.arch);
  let required = [];
  try {
    for (const [name, item] of Object.entries(pinned.files)) {
      const file = inside(runtime, name);
      if (!lstatSync(file).isFile() || lstatSync(file).size !== item.bytes || await digest(file) !== item.sha256) throw Error('mismatch');
    }
    required = externalNames(readFileSync(join(runtime, 'README.txt'), 'utf8'));
  } catch { add('固定 FFmpeg 缓存缺失、被修改或含链接；不会在发行检查中下载或运行程序。'); }
  const components = Array.isArray(review.components) ? review.components : [];
  const ids = components.map(item => item.id);
  if (!required.length || ids.length !== new Set(ids).size || required.some(id => !ids.includes(id))) add('依赖清单未覆盖固定 README 中的全部项目。');
  let pending = 0;
  for (const component of components) {
    const resolution = component.resolution;
    if (resolution?.kind === 'included') {
      if (!nonempty(resolution.revision) || !relativeName(resolution.sourcePath) || !relativeName(resolution.recipePath) || !relativeName(resolution.licensePath)
        || !['included', 'none-confirmed'].includes(resolution.patches) || (resolution.patches === 'included' && !relativeName(resolution.patchPath))) pending++;
    } else if (resolution?.kind === 'excluded') {
      if (component.id === 'ffmpeg' || !nonempty(resolution.reason) || !relativeName(resolution.evidencePath)) pending++;
    } else pending++;
  }
  if (!components.length || pending) add(`${pending || '全部'} 个组件尚未完成源码、补丁、构建方式或排除依据审查。`);
  const closure = review.closureReview;
  if (closure?.status !== 'complete' || closure?.dependencyClosure !== true || closure?.binaryCorrespondence !== true
    || !Array.isArray(closure?.unresolved) || closure.unresolved.length || !nonempty(closure?.reviewedBy) || !/^\d{4}-\d{2}-\d{2}$/.test(closure?.reviewedOn || ''))
    add('完整依赖及与二进制对应关系的人工审查尚未完成。');
  async function artifact(item, label) {
    if (!item || !validHash(item.sha256) || !Number.isSafeInteger(item.bytes) || item.bytes <= 0) { add(label + '的文件、字节数或 SHA-256 未登记。'); return; }
    try {
      const file = inside(materialsRoot, item.file), stat = lstatSync(file);
      if (!stat.isFile() || stat.size !== item.bytes || await digest(file) !== item.sha256) throw Error('mismatch');
    } catch { add(label + '不存在、摘要不符或路径不安全。'); }
  }
  await artifact(closure?.record, '源码审查报告');
  await artifact(review.delivery?.bundle, '完整对应源码附件');
  if (!publicUrl(review.delivery?.sourceUrl)) add('未登记明确、无凭据的 HTTPS 源码附件下载地址。');
  // Never fetch this URL: availability and the archive's contents are release-review obligations.
  if (review.delivery?.availabilityReviewed !== true) add('源码附件的公开可获取性尚未核验。');
  if (checkBuild) {
    try {
      const out = join(root, 'dist/vision'), build = JSON.parse(readFileSync(inside(out, 'BUILD.json'), 'utf8'));
      const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
      if (build.version !== pkg.version || !build.files || typeof build.files !== 'object' || Array.isArray(build.files)) throw Error('manifest');
      const actual = [];
      const visit = directory => { for (const item of readdirSync(directory, { withFileTypes: true })) {
        const file = join(directory, item.name); if (item.isSymbolicLink()) throw Error('linked build');
        if (item.isDirectory()) visit(file); else if (item.isFile()) actual.push(relative(out, file).replaceAll('\\', '/')); else throw Error('special file');
      } };
      visit(out);
      if (JSON.stringify(actual.filter(f => f !== 'BUILD.json').sort()) !== JSON.stringify(Object.keys(build.files).sort())) throw Error('extra files');
      for (const [name, hash] of Object.entries(build.files)) if (!validHash(hash) || await digest(inside(out, name)) !== hash) throw Error('file mismatch');
      for (const [name, item] of Object.entries(pinned.files)) if (build.files['runtime/ffmpeg/' + pinned.platform + '-' + pinned.arch + '/' + name] !== item.sha256) throw Error('decoder mismatch');
      if (build.files['vendor/ffmpeg-source-review.json'] !== reviewSha256) throw Error('stale source review');
      const marker = JSON.parse(readFileSync(inside(out, 'RELEASE-STATUS.json'), 'utf8'));
      if (marker.binaryReleaseApproved !== true || marker.reviewSha256 !== reviewSha256 || marker.sourceBundleSha256 !== review.delivery?.bundle?.sha256) throw Error('local build');
    } catch { add('发行目录不存在、已变动或未经 build:release 检查；普通 build 不是发布验收。'); }
  }
  return { ok: !issues.length, issues, reviewSha256, sourceBundleSha256: review.delivery?.bundle?.sha256 ?? null };
}

export async function requireRelease(options = {}) {
  const result = await checkRelease(options);
  if (!result.ok) throw Error('含 FFmpeg 的二进制发行被阻止：\n- ' + result.issues.join('\n- '));
  return result;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.length && (args.length !== 2 || args[0] !== '--materials')) { console.error('Usage: node scripts/check-release.mjs [--materials directory]'); process.exitCode = 2; }
  else try {
    await requireRelease(args.length ? { materialsRoot: resolve(args[1]) } : {});
    console.log('发行材料、人工审查记录及发行文件摘要通过离线检查；上传前仍须核对源码下载入口。');
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
