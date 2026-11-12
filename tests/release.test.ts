/*! Copyright (c) 2026 iinukami and contributors.
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7: see LICENSE-ADDITIONAL.
 */
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { temporaryDirectory } from './temporary-directory.ts';

type Result = { ok: boolean; issues: string[] };
type Options = { root: string; materialsRoot?: string; checkBuild: boolean };
const { checkRelease } = await import(new URL('../scripts/check-release.mjs', import.meta.url).href) as {
  checkRelease: (options: Options) => Promise<Result>;
};
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const json = (value: unknown) => JSON.stringify(value, null, 2) + '\n';
async function put(file: string, content: string) {
  await mkdir(dirname(file), { recursive: true }); await writeFile(file, content);
}
type Material = { file: string; bytes: number; sha256: string };
type Review = {
  schemaVersion: number;
  target: { version: string; archiveSha256: string; files: Record<string, string> };
  components: { id: string; resolution: Record<string, string> }[];
  closureReview: {
    status: string; dependencyClosure: boolean; binaryCorrespondence: boolean;
    unresolved: string[]; reviewedBy: string; reviewedOn: string; record: Material;
  };
  delivery: { bundle: Material; sourceUrl: string; availabilityReviewed: boolean };
};

// This fixture exercises the release gate only. Its small invented objects and
// review statements are not a source distribution or a real licence assessment.
async function fixture(t: TestContext) {
  const { dir } = await temporaryDirectory(t);
  const fixtureRoot = join(dir, 'project'), materialsRoot = join(dir, 'materials');
  const runtime = join(fixtureRoot, 'runtime/ffmpeg/win32-x64');
  const runtimeFiles = {
    'ffmpeg.exe': 'synthetic executable one; never run\n',
    'ffprobe.exe': 'synthetic executable two; never run\n',
    LICENSE: 'synthetic licence fixture\n',
    'README.txt': 'External libraries:\nfoo\n\nExternal libraries providing hardware acceleration:\nhw\n\nLibraries:\navcodec\n',
  };
  const files = Object.fromEntries(Object.entries(runtimeFiles).map(([name, data]) => [name, { bytes: Buffer.byteLength(data), sha256: hash(data) }]));
  const pinned = { version: 'test-only', platform: 'win32', arch: 'x64', archiveSha256: hash('synthetic runtime archive'), files };
  for (const [name, data] of Object.entries(runtimeFiles)) await put(join(runtime, name), data);
  await put(join(fixtureRoot, 'vendor/ffmpeg.json'), json(pinned));
  await put(join(fixtureRoot, 'package.json'), json({ version: '0.0.0-test' }));
  const recordData = 'Synthetic reviewer checked an invented dependency closure.\n';
  const bundleData = 'Synthetic source attachment: fake code, recipes, licences and exclusion evidence.\n';
  const record = { file: 'review.txt', bytes: Buffer.byteLength(recordData), sha256: hash(recordData) };
  const bundle = { file: 'sources.txt', bytes: Buffer.byteLength(bundleData), sha256: hash(bundleData) };
  await put(join(materialsRoot, record.file), recordData); await put(join(materialsRoot, bundle.file), bundleData);
  const review: Review = {
    schemaVersion: 1,
    target: { version: pinned.version, archiveSha256: pinned.archiveSha256, files: Object.fromEntries(Object.entries(files).map(([name, item]) => [name, item.sha256])) },
    components: [
      ...['ffmpeg', 'foo'].map(id => ({ id, resolution: { kind: 'included', revision: 'synthetic-1', sourcePath: id + '/source.c', recipePath: id + '/build.sh', licensePath: id + '/LICENSE', patches: 'none-confirmed' } })),
      { id: 'hw', resolution: { kind: 'excluded', reason: 'Synthetic hardware interface reviewed separately.', evidencePath: 'hardware-review.txt' } },
    ],
    closureReview: { status: 'complete', dependencyClosure: true, binaryCorrespondence: true, unresolved: [], reviewedBy: 'Synthetic Test Reviewer', reviewedOn: '2026-11-12', record },
    delivery: { bundle, sourceUrl: 'https://example.invalid/releases/test/sources.txt', availabilityReviewed: true },
  };
  const saveReview = () => put(join(fixtureRoot, 'vendor/ffmpeg-source-review.json'), json(review));
  await saveReview();
  async function build(approved = true) {
    const out = join(fixtureRoot, 'dist/vision');
    const reviewData = json(review), marker = json({ binaryReleaseApproved: approved, reviewSha256: hash(reviewData), sourceBundleSha256: bundle.sha256 });
    const entries: Record<string, string> = { 'vendor/ffmpeg-source-review.json': reviewData, 'RELEASE-STATUS.json': marker, 'index.ts': '// synthetic plugin\n' };
    for (const [name, data] of Object.entries(runtimeFiles)) entries['runtime/ffmpeg/win32-x64/' + name] = data;
    for (const [name, data] of Object.entries(entries)) await put(join(out, name), data);
    await put(join(out, 'BUILD.json'), json({ version: '0.0.0-test', files: Object.fromEntries(Object.entries(entries).map(([name, data]) => [name, hash(data)])) }));
    return out;
  }
  return { dir, root: fixtureRoot, materialsRoot, runtime, pinned, review, saveReview, build,
    check: (checkBuild = false) => checkRelease({ root: fixtureRoot, materialsRoot, checkBuild }) };
}
function rejected(result: Result, pattern: RegExp) {
  assert.equal(result.ok, false); assert.match(result.issues.join('\n'), pattern);
}

test('an enabled dependency cannot be removed from the reviewed inventory to bypass its review', async t => {
  const f = await fixture(t);
  f.review.components = f.review.components.filter(component => component.id !== 'foo');
  await f.saveReview(); rejected(await f.check(), /依赖清单未覆盖/);
});

test('complete synthetic evidence passes material checks and a matching approved build', async t => {
  const f = await fixture(t);
  assert.deepEqual((await f.check()).issues, []);
  await f.build(); assert.equal((await f.check(true)).ok, true);
});

test('changing only the completion label does not satisfy unresolved source and closure review', async t => {
  const f = await fixture(t);
  f.review.components[0].resolution = { kind: 'pending' };
  f.review.closureReview.dependencyClosure = false;
  f.review.closureReview.binaryCorrespondence = false;
  f.review.closureReview.unresolved = ['unknown recipe'];
  f.review.closureReview.status = 'complete'; await f.saveReview();
  const result = await f.check();
  rejected(result, /组件尚未完成/); assert.match(result.issues.join('\n'), /人工审查尚未完成/);
});

test('review cannot authorize a different pinned runtime target', async t => {
  const f = await fixture(t);
  f.pinned.version = 'different-build'; await put(join(f.root, 'vendor/ffmpeg.json'), json(f.pinned));
  rejected(await f.check(), /没有绑定当前固定 FFmpeg 构建/);
});

test('modified runtime bytes invalidate the source-material release check', async t => {
  const f = await fixture(t); await writeFile(join(f.runtime, 'ffmpeg.exe'), 'tampered runtime');
  rejected(await f.check(), /固定 FFmpeg 缓存/);
});

test('source attachment bytes must match the reviewed digest', async t => {
  const f = await fixture(t); await writeFile(join(f.materialsRoot, f.review.delivery.bundle.file), 'other source attachment');
  rejected(await f.check(), /完整对应源码附件不存在、摘要不符或路径不安全/);
});

test('source attachment paths cannot escape the materials directory even with a matching digest', async t => {
  const f = await fixture(t), data = 'a real fixture file outside materials';
  await put(join(f.dir, 'outside.txt'), data);
  f.review.delivery.bundle = { file: '../outside.txt', bytes: Buffer.byteLength(data), sha256: hash(data) };
  await f.saveReview(); rejected(await f.check(), /完整对应源码附件不存在、摘要不符或路径不安全/);
});

test('tampering with a listed distribution file invalidates an otherwise approved build', async t => {
  const f = await fixture(t), out = await f.build(); await writeFile(join(out, 'index.ts'), '// tampered\n');
  rejected(await f.check(true), /发行目录不存在、已变动/);
});

test('unlisted files cannot be smuggled into an otherwise approved distribution', async t => {
  const f = await fixture(t), out = await f.build(); await put(join(out, 'data/private-fixture.txt'), 'synthetic only');
  rejected(await f.check(true), /发行目录不存在、已变动/);
});

test('a normal local build remains unreleasable even when its file hashes are valid', async t => {
  const f = await fixture(t); await f.build(false);
  rejected(await f.check(true), /普通 build 不是发布验收/);
});

test('the bundled FFmpeg program itself cannot be excluded from corresponding source', async t => {
  const f = await fixture(t);
  f.review.components[0].resolution = { kind: 'excluded', reason: 'synthetic unsupported exclusion', evidencePath: 'review.txt' };
  await f.saveReview(); rejected(await f.check(), /组件尚未完成/);
});

test('reviewed locations inside a source bundle must remain relative and cannot escape', async t => {
  const f = await fixture(t);
  for (const invalid of ['../build.sh', '/absolute/build.sh', 'C:/build.sh', 'folder\\build.sh']) {
    f.review.components[0].resolution.recipePath = invalid;
    await f.saveReview(); rejected(await f.check(), /组件尚未完成/);
  }
});
