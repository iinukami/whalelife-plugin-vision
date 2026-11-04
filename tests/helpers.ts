import type { TestContext } from 'node:test';
import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import sharp from 'sharp';
import { temporaryDirectory } from './temporary-directory.ts';
import { Vision } from '../src/runtime.ts';
import { defaults, type Config } from '../src/types.ts';
import { runProcess } from '../src/process.ts';
export async function fixture(t: TestContext, changes: Partial<Config> = {}, now?: () => number) {
  const temp = await temporaryDirectory(t);
  const controller = new AbortController();
  const app = new Vision(join(temp.dir, 'media'), { ...defaults, ...changes }, controller.signal, now);
  temp.cleanup.push(() => app.stop());
  await app.start();
  return { ...temp, controller, app };
}
export async function png() {
  const left = await sharp({ create: { width: 80, height: 60, channels: 3, background: '#ff0000' } }).png().toBuffer();
  const right = await sharp({ create: { width: 80, height: 60, channels: 3, background: '#0000ff' } }).png().toBuffer();
  return sharp({ create: { width: 160, height: 60, channels: 3, background: '#fff' } }).composite([{ input: left, left: 0, top: 0 }, { input: right, left: 80, top: 0 }]).png().toBuffer();
}
export async function gif() {
  const red = Buffer.alloc(20 * 20 * 3), blue = Buffer.alloc(red.length);
  for (let i = 0; i < red.length; i += 3) { red[i] = 255; blue[i + 2] = 255; }
  return sharp(Buffer.concat([red, blue]), { raw: { width: 20, height: 40, channels: 3, pageHeight: 20 } }).gif({ delay: [100, 900], loop: 0 }).toBuffer();
}
export async function movie(dir: string, duration = 4) {
  const path = join(dir, 'synthetic.mp4');
  await runProcess('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y',
    '-f', 'lavfi', '-i', 'color=c=red:s=160x90:r=10:d=1', '-f', 'lavfi', '-i', `color=c=blue:s=160x90:r=10:d=${duration - 1}`,
    '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=8000',
    '-filter_complex_threads', '1', '-filter_complex', '[0:v][1:v]concat=n=2:v=1:a=0[v]', '-map', '[v]', '-map', '2:a',
    '-t', String(duration), '-c:v', 'libx264', '-threads', '1', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-movflags', '+faststart', path],
    new AbortController().signal, 65536);
  return readFile(path);
}
export async function offer(app: Vision, bytes: Buffer, mime = 'image/png', sessionId = 'session-a') {
  return app.offerMedia({ sessionId, mime, base64: bytes.toString('base64') });
}
