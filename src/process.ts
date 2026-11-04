/*! Copyright (c) 2026 iinukami and contributors.
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7: see LICENSE-ADDITIONAL.
 */
import { spawn } from 'node:child_process';
import { VisionError } from './types.ts';

/** No shell, no inherited stdin, bounded output/time, and only kill our own child. */
export function runProcess(executable: string, args: string[], signal: AbortSignal, maxBytes: number, timeoutMs = 30_000): Promise<Buffer> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    let failure: Error | undefined;
    let size = 0;
    const chunks: Buffer[] = [];
    const stop = (error: Error) => {
      failure ??= error;
      child.kill('SIGKILL');
    };
    const onAbort = () => stop(new VisionError('cancelled', '视觉处理已取消。'));
    const timer = setTimeout(() => stop(new VisionError('decoder_timeout', '媒体解码超时。')), timeoutMs);
    timer.unref();
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) onAbort();
    child.stdout.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBytes) stop(new VisionError('output_limit', '解码输出超过大小限制。'));
      else if (!failure) chunks.push(chunk);
    });
    // Decoder diagnostics can include paths or media text; drain without retaining/logging.
    child.stderr.resume();
    child.on('error', () => { failure ??= new VisionError('decoder_unavailable', '内置视频组件无法启动，请重新安装完整视觉插件。'); });
    child.once('close', (code) => {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      if (failure) reject(failure);
      else if (code !== 0) reject(new VisionError('decode_failed', '媒体无法解码或格式不受支持。'));
      else resolve(Buffer.concat(chunks));
    });
  });
}
