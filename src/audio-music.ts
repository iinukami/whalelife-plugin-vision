/*! Copyright (c) 2026 iinukami and contributors.
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7: see LICENSE-ADDITIONAL.
 */
import { Worker } from 'node:worker_threads';
import { VisionError } from './types.ts';
import type { AudioEvidence } from './audio-types.ts';

export type MusicTask = 'rhythm' | 'melody' | 'chords' | 'structure';
export type MusicResult = Partial<Record<MusicTask, AudioEvidence>>;
const allowed = new Set<MusicTask>(['rhythm', 'melody', 'chords', 'structure']);

/** The coordinator serializes local work. A disposable worker keeps DSP off the plugin event loop. */
export async function analyzeMusic(wav: Buffer, tasks: MusicTask[], signal: AbortSignal): Promise<MusicResult> {
  if (signal.aborted) throw new VisionError('cancelled', '音乐分析已取消。');
  if (!Buffer.isBuffer(wav) || wav.length < 44 || wav.length > 2 * 1024 * 1024
    || !Array.isArray(tasks) || tasks.length < 1 || tasks.length > 4 || tasks.some(task => !allowed.has(task)))
    throw new VisionError('invalid_audio', '音乐分析需要不超过 60 秒的 16 kHz 单声道 PCM16 WAV 和有效分析项目。');
  // Never transfer the caller's Buffer slab: decoding/other tasks may still own it.
  const bytes = new Uint8Array(wav);
  let worker: Worker;
  try {
    worker = new Worker(new URL('./audio-music-worker.ts', import.meta.url), {
      workerData: { wav: bytes, tasks: [...new Set(tasks)] }, transferList: [bytes.buffer],
      execArgv: [], stdout: true, stderr: true,
      resourceLimits: { maxOldGenerationSizeMb: 64, maxYoungGenerationSizeMb: 16, stackSizeMb: 4 },
    });
  } catch { throw new VisionError('music_unavailable', '本地音乐分析进程无法启动。'); }
  // Worker diagnostics must not leak media or filesystem paths into the host logs.
  worker.stdout?.resume(); worker.stderr?.resume();
  return new Promise<MusicResult>((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error, result?: MusicResult) => {
      if (settled) return;
      settled = true; clearTimeout(timer); signal.removeEventListener('abort', onAbort);
      // Resolve only after the worker is gone, so cancellation releases the local execution slot.
      void worker.terminate().then(() => {
        if (error) reject(error); else resolve(result!);
      }, () => reject(new VisionError('music_cleanup_failed', '音乐分析进程未能正常清理。')));
    };
    const onAbort = () => finish(new VisionError('cancelled', '音乐分析已取消。'));
    const timer = setTimeout(() => finish(new VisionError('music_timeout', '本地音乐分析超时。')), 45_000);
    timer.unref();
    signal.addEventListener('abort', onAbort, { once: true });
    worker.once('message', (message: unknown) => {
      if (signal.aborted) { onAbort(); return; }
      const output = message as { ok?: boolean; result?: MusicResult; code?: string };
      if (output?.ok !== true || !output.result || typeof output.result !== 'object') {
        finish(new VisionError(output?.code === 'invalid_audio' ? 'invalid_audio' : 'music_failed',
          output?.code === 'invalid_audio' ? '音乐分析仅接受不超过 60 秒的 16 kHz 单声道 PCM16 WAV。' : '本地音乐分析未完成。'));
        return;
      }
      if (Buffer.byteLength(JSON.stringify(output.result)) > 48 * 1024) {
        finish(new VisionError('output_limit', '音乐分析结果超过容量限制。')); return;
      }
      finish(undefined, output.result);
    });
    worker.once('error', () => finish(new VisionError('music_failed', '本地音乐分析未完成。')));
    worker.once('exit', () => { if (!settled) finish(new VisionError('music_failed', '本地音乐分析进程提前结束。')); });
    if (signal.aborted) onAbort();
  });
}
