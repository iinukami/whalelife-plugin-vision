import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, copyFile, open } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { temporaryDirectory, root } from './temporary-directory.ts';
import { movie } from './helpers.ts';
import { BundledDecoder, bundledRoot } from '../src/decoder.ts';

test('packaged video decode works with an empty PATH and ignores legacy executable settings', async t => {
  const f = await temporaryDirectory(t); await movie(f.dir);
  const module = pathToFileURL(join(root, 'dist/vision/src/runtime.ts')).href;
  const types = pathToFileURL(join(root, 'dist/vision/src/types.ts')).href;
  const script = `import { readFile } from 'node:fs/promises';
    import { Vision } from ${JSON.stringify(module)}; import { configOf } from ${JSON.stringify(types)};
    const app = new Vision(${JSON.stringify(join(f.dir, 'without-path'))}, configOf({ffmpegPath:'must-not-run',ffprobePath:'must-not-run'}), new AbortController().signal);
    try { await app.start(); const bytes=await readFile(${JSON.stringify(join(f.dir,'synthetic.mp4'))});
      const ref=await app.offerMedia({sessionId:'isolated',mime:'video/mp4',base64:bytes.toString('base64')});
      const p=await app.prepare({sessionId:'isolated',mediaRef:ref.mediaRef,atSeconds:2});
      console.log(JSON.stringify({status:app.status(),kind:ref.info.kind,images:p.images.length}));
    } finally { await app.stop(); }`;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], { env: { ...process.env, PATH: '' }, windowsHide: true, encoding: 'utf8', timeout: 20_000 });
  assert.equal(result.status, 0, result.stderr);
  const data = JSON.parse(result.stdout);
  assert.equal(data.status.decoder.ready, true); assert.equal(data.status.decoder.source, 'bundled');
  assert.equal(data.kind, 'video'); assert.equal(data.images, 1);
  assert.ok(!JSON.stringify(data.status).includes(bundledRoot));
});

test('a modified bundled executable is rejected before it can be run', async t => {
  const f = await temporaryDirectory(t), decoderRoot = join(f.dir, 'decoder'); await mkdir(decoderRoot);
  for (const name of ['ffmpeg.exe','ffprobe.exe']) await copyFile(join(bundledRoot,name),join(decoderRoot,name));
  const file = await open(join(decoderRoot, 'ffmpeg.exe'), 'r+');
  try { await file.write(Buffer.from([0]), 0, 1, 0); } finally { await file.close(); }
  const decoder = new BundledDecoder(decoderRoot); await decoder.start(new AbortController().signal);
  assert.equal(decoder.ready, false); assert.equal(decoder.problem, 'decoder_unavailable');
  assert.throws(() => decoder.paths(), { code: 'decoder_unavailable' });
});
