import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { deflateRawSync } from 'node:zlib';
import { temporaryDirectory } from './temporary-directory.ts';
import { OllamaInstaller, type OllamaRuntimeManifest, type OllamaInstallDependencies, type OllamaInstallProgress } from '../src/ollama-install.ts';
import pinned from '../vendor/ollama.json' with { type: 'json' };

const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
function crc32(bytes: Buffer) {
  let value = 0xffffffff;
  for (const byte of bytes) { value ^= byte; for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ ((value & 1) ? 0xedb88320 : 0); }
  return (value ^ 0xffffffff) >>> 0;
}
type ZipFile = { name: string; data?: Buffer; method?: number; attributes?: number; extra?: Buffer; localExtra?: Buffer; declaredBytes?: number; crc?: number; localName?: string; descriptor?: boolean };
const fixtureFiles = (): ZipFile[] => [
  { name: 'ollama.exe', data: Buffer.from('MZ-synthetic-ollama-executable') },
  { name: 'lib/' }, { name: 'lib/ollama/' },
  { name: 'lib/ollama/core.dll', data: Buffer.from('MZ-synthetic-core-library'), method: 8 },
  { name: 'lib/ollama/LICENSE', data: Buffer.from('Synthetic license notice, preserved verbatim.'), method: 8, descriptor: true },
  { name: 'lib/ollama/empty.txt', data: Buffer.alloc(0) },
];
function zip(files: ZipFile[]) {
  const contents: Buffer[] = [], index: Buffer[] = []; let offset = 0;
  for (const entry of files) {
    const name = Buffer.from(entry.name), localName = Buffer.from(entry.localName ?? entry.name), data = entry.data ?? Buffer.alloc(0);
    const method = entry.method ?? 0, packed = method === 8 ? deflateRawSync(data) : data, extra = entry.extra ?? Buffer.alloc(0);
    const localExtra = entry.localExtra ?? extra;
    const crc = entry.crc ?? crc32(data), size = entry.declaredBytes ?? data.length, flags = entry.descriptor ? 8 : 0;
    const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50); local.writeUInt16LE(20, 4); local.writeUInt16LE(flags, 6); local.writeUInt16LE(method, 8);
    if (!entry.descriptor) { local.writeUInt32LE(crc, 14); local.writeUInt32LE(packed.length, 18); local.writeUInt32LE(size, 22); }
    local.writeUInt16LE(localName.length, 26); local.writeUInt16LE(localExtra.length, 28);
    const descriptor = Buffer.alloc(entry.descriptor ? 16 : 0);
    if (entry.descriptor) { descriptor.writeUInt32LE(0x08074b50); descriptor.writeUInt32LE(crc, 4); descriptor.writeUInt32LE(packed.length, 8); descriptor.writeUInt32LE(size, 12); }
    const central = Buffer.alloc(46); central.writeUInt32LE(0x02014b50); central.writeUInt16LE(0x0314, 4); central.writeUInt16LE(20, 6);
    central.writeUInt16LE(flags, 8); central.writeUInt16LE(method, 10); central.writeUInt32LE(crc, 16); central.writeUInt32LE(packed.length, 20); central.writeUInt32LE(size, 24);
    central.writeUInt16LE(name.length, 28); central.writeUInt16LE(extra.length, 30);
    central.writeUInt32LE((entry.attributes ?? (entry.name.endsWith('/') ? 0x41ed0010 : 0x81a40020)) >>> 0, 38); central.writeUInt32LE(offset, 42);
    contents.push(local, localName, localExtra, packed, descriptor); index.push(central, name, extra);
    offset += local.length + localName.length + localExtra.length + packed.length + descriptor.length;
  }
  const directory = Buffer.concat(index), end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...contents, directory, end]);
}
function spec(bytes: Buffer): OllamaRuntimeManifest {
  return { ...pinned, bytes: bytes.length, sha256: digest(bytes), maxFiles: 32, maxFileBytes: 1024, maxExpandedBytes: 4096,
    requiredFiles: ['ollama.exe', 'lib/ollama/core.dll', 'lib/ollama/LICENSE'] };
}
function stream(bytes: Buffer, onCancel?: () => void): Response {
  let offset = 0;
  return new Response(new ReadableStream<Uint8Array>({ pull(controller) {
    if (offset === bytes.length) { controller.close(); return; }
    const next = Math.min(offset + 31, bytes.length); controller.enqueue(bytes.subarray(offset, next)); offset = next;
  }, cancel() { onCancel?.(); } }), { headers: { 'Content-Length': String(bytes.length) } });
}
async function fixture(t: TestContext, archive = zip(fixtureFiles()), overrides: Partial<OllamaInstallDependencies> = {}) {
  const f = await temporaryDirectory(t), root = join(f.dir, 'ollama'), lifetime = new AbortController();
  let requests = 0;
  const fetcher: typeof fetch = async (url, init) => {
    requests++; assert.equal(String(url), pinned.url); assert.equal(init?.redirect, 'manual'); return stream(archive);
  };
  const installer = new OllamaInstaller(root, lifetime.signal, { manifest: spec(archive), fetch: fetcher, platform: 'win32', arch: 'x64', ...overrides });
  f.cleanup.push(() => lifetime.abort());
  return { ...f, root, installer, lifetime, requests: () => requests };
}
async function noTemporaryFiles(root: string) {
  const names = await readdir(root).catch(error => { if (error.code === 'ENOENT') return []; throw error; });
  assert.ok(names.every(name => !name.startsWith('.prepare-')), 'owned failed staging directory must be removed');
}

test('fixed official runtime metadata pins the exact release, size and digest', () => {
  assert.equal(pinned.version, '0.40.16'); assert.equal(pinned.bytes, 1618244995);
  assert.equal(pinned.url, 'https://github.com/ollama/ollama/releases/download/v0.40.16/ollama-windows-amd64.zip');
  assert.equal(pinned.sha256, '50fcf5ad54277f2fa5d173ebfc93bcb017adbc0c9ef2314daabc96ca9e6aa64e');
});

test('streamed install validates ZIP, preserves notices, records all files and does not redownload a valid runtime', async t => {
  const f = await fixture(t), progress: OllamaInstallProgress[] = [];
  assert.deepEqual(await f.installer.inspect(), { installed: false });
  await mkdir(join(f.root, 'models'), { recursive: true }); await writeFile(join(f.root, 'models', 'keep'), 'model marker');
  await f.installer.prepare(new AbortController().signal, value => progress.push(value));
  assert.deepEqual(await f.installer.inspect(), { installed: true, runtimeVersion: '0.40.16' });
  assert.equal(await f.installer.executable(), join(f.root, 'runtime/v0.40.16/ollama.exe'));
  assert.equal(await readFile(join(f.installer.runtime, 'lib/ollama/LICENSE'), 'utf8'), 'Synthetic license notice, preserved verbatim.');
  const record = JSON.parse(await readFile(join(f.installer.runtime, '.ollama-install.json'), 'utf8'));
  assert.equal(record.schema, 1); assert.equal(record.archiveSha256, digest(zip(fixtureFiles())));
  assert.deepEqual(record.files.map((file: { path: string }) => file.path), fixtureFiles().filter(file => !file.name.endsWith('/')).map(file => file.name));
  for (const item of record.files) assert.equal(item.sha256, digest(await readFile(join(f.installer.runtime, item.path))));
  for (const phase of ['downloading_runtime', 'extracting']) {
    const events = progress.filter(value => value.phase === phase);
    assert.equal(events[0].downloadedBytes, 0); assert.equal(events.at(-1)!.downloadedBytes, events.at(-1)!.totalBytes);
    assert.ok(events.every((value, index) => !index || value.downloadedBytes >= events[index - 1].downloadedBytes));
  }
  await f.installer.prepare(new AbortController().signal); assert.equal(f.requests(), 1);
  assert.equal(await readFile(join(f.root, 'models/keep'), 'utf8'), 'model marker'); await noTemporaryFiles(f.root);
});

test('official Windows ZIP metadata shape supports DOS attributes and central-only NTFS timestamp extras', async t => {
  // Official v0.40.16 Range metadata: 80 entries, flags=0, methods=0/8,
  // DOS attrs=0x10/0x20, central extra=0x000a, sampled local extras empty; no ZIP64.
  const ntfs = Buffer.alloc(36); ntfs.writeUInt16LE(0x000a); ntfs.writeUInt16LE(32, 2); ntfs.writeUInt16LE(1, 8); ntfs.writeUInt16LE(24, 10);
  const archive = zip(fixtureFiles().map(file => ({ ...file, descriptor: false, extra: ntfs, localExtra: Buffer.alloc(0), attributes: file.name.endsWith('/') ? 0x10 : 0x20 })));
  const f = await fixture(t, archive); await f.installer.prepare(new AbortController().signal);
  assert.equal(await f.installer.executable(), join(f.installer.runtime, 'ollama.exe'));
});

for (const name of ['../outside', '/absolute', 'C:/absolute', 'lib\\outside', 'lib//outside', 'lib/../outside', 'lib./outside', 'CON.txt', 'lib/aux', 'file:stream', 'lib/space ', '.OLLAMA-INSTALL.JSON']) {
  test(`unsafe archive member ${JSON.stringify(name)} is rejected before installation`, async t => {
    const f = await fixture(t, zip([...fixtureFiles(), { name, data: Buffer.from('untrusted') }]));
    await assert.rejects(f.installer.prepare(new AbortController().signal), { code: 'ollama_runtime_invalid' });
    assert.deepEqual(await f.installer.inspect(), { installed: false }); await noTemporaryFiles(f.root);
  });
}

for (const [label, additions] of [
  ['case-fold duplicate', [{ name: 'OlLaMa.ExE', data: Buffer.from('MZ-bad') }]],
  ['symlink mode', [{ name: 'escape', data: Buffer.from('../outside'), attributes: 0xa1ff0000 }]],
  ['Windows reparse flag', [{ name: 'escape', attributes: 0x400 }]],
  ['file used as parent directory', [{ name: 'parent', data: Buffer.from('x') }, { name: 'parent/child', data: Buffer.from('x') }]],
  ['Unicode alternate-name extra', [{ name: 'extra', extra: Buffer.from([0x75, 0x70, 0, 0]) }]],
  ['disagreeing local name', [{ name: 'first', localName: 'other', data: Buffer.from('x') }]],
] as [string, ZipFile[]][]) {
  test(`${label} is rejected by metadata validation`, async t => {
    const f = await fixture(t, zip([...fixtureFiles(), ...additions]));
    await assert.rejects(f.installer.prepare(new AbortController().signal), { code: 'ollama_runtime_invalid' }); await noTemporaryFiles(f.root);
  });
}

test('bounded extraction rejects a deflate stream that exceeds its declared size and rejects corrupt CRC', async t => {
  for (const bad of [
    { name: 'bomb', data: Buffer.alloc(1024 * 1024, 65), method: 8, declaredBytes: 1 },
    { name: 'corrupt', data: Buffer.from('payload'), crc: 123 },
  ]) {
    const f = await fixture(t, zip([...fixtureFiles(), bad]));
    await assert.rejects(f.installer.prepare(new AbortController().signal));
    assert.deepEqual(await f.installer.inspect(), { installed: false }); await noTemporaryFiles(f.root);
  }
});

test('archive hash, count, expanded-size and required-file limits prevent installation', async t => {
  const archive = zip(fixtureFiles());
  for (const changes of [{ sha256: '0'.repeat(64) }, { maxFiles: 2 }, { maxExpandedBytes: 5 }, { maxFileBytes: 5 }, { requiredFiles: ['missing.exe'] }]) {
    const f = await fixture(t, archive, { manifest: { ...spec(archive), ...changes } });
    await assert.rejects(f.installer.prepare(new AbortController().signal), { code: 'ollama_runtime_invalid' }); await noTemporaryFiles(f.root);
  }
});

test('download refuses wrong lengths, excess bytes and encoded responses; no partial installation survives', async t => {
  const archive = zip(fixtureFiles());
  for (const response of [
    () => new Response(archive, { headers: { 'Content-Length': String(archive.length + 1) } }),
    () => new Response(archive.subarray(0, -1)),
    () => new Response(Buffer.concat([archive, Buffer.from('extra')])),
    () => new Response(archive, { headers: { 'Content-Encoding': 'gzip' } }),
  ]) {
    const f = await fixture(t, archive, { fetch: async () => response() });
    await assert.rejects(f.installer.prepare(new AbortController().signal), { code: 'ollama_runtime_invalid' }); await noTemporaryFiles(f.root);
  }
});

test('download allows only bounded HTTPS GitHub release redirects', async t => {
  const archive = zip(fixtureFiles());
  for (const location of ['http://github.com/unsafe', 'https://evil.invalid/unsafe', 'https://github.com:444/unsafe', 'https://user:password@github.com/unsafe']) {
    let calls = 0;
    const f = await fixture(t, archive, { fetch: async () => { calls++; return new Response(null, { status: 302, headers: { location } }); } });
    await assert.rejects(f.installer.prepare(new AbortController().signal), { code: 'ollama_download_failed' });
    assert.equal(calls, 1); await noTemporaryFiles(f.root);
  }
  let calls = 0;
  const looping = await fixture(t, archive, { fetch: async () => { calls++; return new Response(null, { status: 302, headers: { location: pinned.url } }); } });
  await assert.rejects(looping.installer.prepare(new AbortController().signal), { code: 'ollama_download_failed' }); assert.equal(calls, 6);
  const targets: string[] = [];
  const valid = await fixture(t, archive, { fetch: async url => {
    targets.push(String(url)); return targets.length === 1 ? new Response(null, { status: 302, headers: { location: 'https://release-assets.githubusercontent.com/synthetic' } }) : stream(archive);
  } });
  await valid.installer.prepare(new AbortController().signal); assert.equal(targets.length, 2); await noTemporaryFiles(valid.root);
});

test('caller cancellation during extraction removes only its own stage and preserves other runtime/model data', async t => {
  const f = await fixture(t), caller = new AbortController();
  await mkdir(join(f.root, 'runtime/v0.0.1'), { recursive: true }); await writeFile(join(f.root, 'runtime/v0.0.1/keep'), 'previous runtime');
  await mkdir(join(f.root, 'models')); await writeFile(join(f.root, 'models/keep'), 'existing model');
  await assert.rejects(f.installer.prepare(caller.signal, progress => { if (progress.phase === 'extracting' && progress.downloadedBytes) caller.abort(); }), { code: 'cancelled' });
  await noTemporaryFiles(f.root); assert.deepEqual(await f.installer.inspect(), { installed: false });
  assert.equal(await readFile(join(f.root, 'runtime/v0.0.1/keep'), 'utf8'), 'previous runtime');
  assert.equal(await readFile(join(f.root, 'models/keep'), 'utf8'), 'existing model');
});

test('a stalled body is cancelled at the preparation deadline and concurrent preparation is refused', { timeout: 5000 }, async t => {
  const archive = zip(fixtureFiles()); let cancelled = false, enter!: () => void;
  const entered = new Promise<void>(resolve => { enter = resolve; });
  // Keep the synthetic producer alive until cleanup; AbortSignal.timeout itself is unref'd.
  const keepAlive = setInterval(() => {}, 1000); t.after(() => clearInterval(keepAlive));
  const f = await fixture(t, archive, { timeoutMs: 100, fetch: async () => {
    enter(); return new Response(new ReadableStream({ cancel() { cancelled = true; } }));
  } });
  const pending = f.installer.prepare(new AbortController().signal);
  await entered;
  await assert.rejects(f.installer.prepare(new AbortController().signal), { code: 'ollama_setup_busy' });
  await assert.rejects(pending, { code: 'cancelled' }); assert.equal(cancelled, true); await noTemporaryFiles(f.root);
});

test('unsupported platforms never fetch or create the runtime directory', async t => {
  const f = await fixture(t, undefined, { platform: 'linux' });
  await assert.rejects(f.installer.prepare(new AbortController().signal), { code: 'unsupported_platform' });
  assert.equal(f.requests(), 0); assert.deepEqual(await f.installer.inspect(), { installed: false });
  await assert.rejects(readdir(f.root), { code: 'ENOENT' });
});

test('a replaced ancestor junction is refused without touching its external target', async t => {
  const f = await fixture(t), target = join(f.dir, 'outside'); await mkdir(target);
  await writeFile(join(target, 'keep'), 'must remain'); await symlink(target, f.root, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(f.installer.prepare(new AbortController().signal), { code: 'unsafe_storage' });
  assert.equal(f.requests(), 0); assert.deepEqual(await readdir(target), ['keep']);
});

test('startup rechecks bytes and rejects a same-size changed executable or an unrecorded DLL', async t => {
  const f = await fixture(t); await f.installer.prepare(new AbortController().signal);
  const executable = await f.installer.executable(), bytes = await readFile(executable);
  const changed = Buffer.from(bytes); changed[changed.length - 1] ^= 1; await writeFile(executable, changed);
  await assert.rejects(f.installer.executable(), { code: 'ollama_runtime_invalid' });
  await assert.rejects(f.installer.prepare(new AbortController().signal), error => (error as { code?: string }).code === 'ollama_runtime_invalid' && String(error).includes('人工'));
  assert.equal(f.requests(), 1, 'invalid installed bytes must never be silently overwritten');
  await writeFile(executable, bytes); await writeFile(join(f.installer.runtime, 'lib/ollama/extra.dll'), 'MZ-unlisted');
  await assert.rejects(f.installer.executable(), { code: 'ollama_runtime_invalid' });
});

test('same-size changed dynamic libraries and forged installation paths cannot be used at startup', async t => {
  const f = await fixture(t); await f.installer.prepare(new AbortController().signal);
  const dll = join(f.installer.runtime, 'lib/ollama/core.dll'), original = await readFile(dll), modified = Buffer.from(original);
  modified[modified.length - 1] ^= 1; await writeFile(dll, modified);
  await assert.rejects(f.installer.executable(), { code: 'ollama_runtime_invalid' });
  await writeFile(dll, original);
  const path = join(f.installer.runtime, '.ollama-install.json'), record = JSON.parse(await readFile(path, 'utf8'));
  record.files.push({ path: '../outside.dll', bytes: 1, sha256: 'a'.repeat(64) }); await writeFile(path, JSON.stringify(record));
  assert.deepEqual(await f.installer.inspect(), { installed: false });
  await assert.rejects(f.installer.executable(), { code: 'ollama_runtime_invalid' });
});

test('a pre-existing unverified version directory is preserved and never mistaken for an installation', async t => {
  const f = await fixture(t); await mkdir(f.installer.runtime, { recursive: true }); await writeFile(join(f.installer.runtime, 'keep'), 'unowned');
  assert.deepEqual(await f.installer.inspect(), { installed: false });
  await assert.rejects(f.installer.prepare(new AbortController().signal), { code: 'ollama_runtime_invalid' });
  assert.equal(await readFile(join(f.installer.runtime, 'keep'), 'utf8'), 'unowned'); assert.equal(f.requests(), 0);
});
