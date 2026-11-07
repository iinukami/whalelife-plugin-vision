/*! Copyright (c) 2026 iinukami and contributors.
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7: see LICENSE-ADDITIONAL.
 */
import { parentPort, workerData } from 'node:worker_threads';
import type { AudioEvidence, AudioSegment } from './audio-types.ts';
import type { MusicResult, MusicTask } from './audio-music.ts';

const SAMPLE_RATE = 16_000, FFT_SIZE = 4096, SPECTRAL_HOP = 2048;
const names = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const round = (n: number, places = 3) => Number(n.toFixed(places));
const clamp = (n: number, min = 0, max = 1) => Math.min(max, Math.max(min, n));
const mean = (values: ArrayLike<number>) => {
  let sum = 0; for (let i = 0; i < values.length; i++) sum += values[i]; return values.length ? sum / values.length : 0;
};
const quantile = (values: number[], q: number) => {
  const sorted = values.slice().sort((a, b) => a - b);
  return sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * q))] : 0;
};
const db = (rms: number) => round(Math.max(-120, 20 * Math.log10(Math.max(rms, 1e-6))), 1);
function evidence(text: string, details: Record<string, unknown>, warnings: string[], segments?: AudioSegment[]): AudioEvidence {
  return { text, timing: segments ? 'segment' : 'clip', details: { timeOrigin: 'clip_start', ...details }, warnings, ...(segments ? { segments } : {}) };
}
function insufficient(task: MusicTask, reason: 'silence' | 'short' | 'weak'): AudioEvidence {
  const message = reason === 'silence' ? '所选片段接近静音，未取得可用音乐特征。'
    : reason === 'short' ? '所选片段太短，无法形成可靠的音乐特征估计。' : '所选片段未形成足够稳定的音乐特征，不能据此给出确定结论。';
  return evidence(message, { task, status: 'insufficient_evidence', reason }, ['这是当前片段的信号分析结果；没有识别到不等于原媒体不存在该特征。']);
}

/** Decode only the documented intermediate format, including FFmpeg's bounded pipe WAV data length. */
function readWav(value: unknown): Float64Array {
  if (!(value instanceof Uint8Array) || value.byteLength < 44 || value.byteLength > 2 * 1024 * 1024) throw Error('invalid_audio');
  const bytes = Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  if (bytes.toString('ascii', 0, 4) !== 'RIFF' || bytes.toString('ascii', 8, 12) !== 'WAVE') throw Error('invalid_audio');
  const declared = bytes.readUInt32LE(4);
  if (declared !== 0xffffffff && declared + 8 !== bytes.length) throw Error('invalid_audio');
  let format = false, data: Buffer | undefined, offset = 12, chunks = 0;
  while (offset + 8 <= bytes.length && ++chunks <= 128) {
    const tag = bytes.toString('ascii', offset, offset + 4), length = bytes.readUInt32LE(offset + 4);
    const start = offset + 8, size = tag === 'data' && length === 0xffffffff ? bytes.length - start : length;
    if (size > bytes.length - start) throw Error('invalid_audio');
    if (tag === 'fmt ') {
      if (format || size < 16 || size > 40 || bytes.readUInt16LE(start) !== 1 || bytes.readUInt16LE(start + 2) !== 1
        || bytes.readUInt32LE(start + 4) !== SAMPLE_RATE || bytes.readUInt32LE(start + 8) !== SAMPLE_RATE * 2
        || bytes.readUInt16LE(start + 12) !== 2 || bytes.readUInt16LE(start + 14) !== 16) throw Error('invalid_audio');
      format = true;
    } else if (tag === 'data') {
      if (data || !format || !size || size % 2 || size > SAMPLE_RATE * 2 * 60) throw Error('invalid_audio');
      data = bytes.subarray(start, start + size);
    } else if (size > 64 * 1024) throw Error('invalid_audio');
    offset = start + size + (size % 2);
  }
  if (!format || !data || offset !== bytes.length) throw Error('invalid_audio');
  const samples = new Float64Array(data.length / 2);
  for (let i = 0; i < samples.length; i++) samples[i] = data.readInt16LE(i * 2) / 32768;
  return samples;
}
function rmsAt(samples: Float64Array, start: number, length: number): number {
  let sum = 0, count = 0;
  for (let i = start; i < Math.min(start + length, samples.length); i++) { sum += samples[i] ** 2; count++; }
  return count ? Math.sqrt(sum / count) : 0;
}

function rhythm(samples: Float64Array): AudioEvidence {
  const duration = samples.length / SAMPLE_RATE;
  if (duration < 4) return insufficient('rhythm', 'short');
  const hop = 160, envelope = new Float64Array(Math.ceil(samples.length / hop));
  let smooth = 0, max = 0;
  for (let i = 0; i < envelope.length; i++) {
    const rms = rmsAt(samples, i * hop, hop);
    envelope[i] = Math.max(0, rms - smooth); smooth = smooth * 0.75 + rms * 0.25;
    max = Math.max(max, envelope[i]);
  }
  const avg = mean(envelope), variance = mean(envelope.map(x => (x - avg) ** 2));
  const threshold = Math.max(0.001, max * 0.12, avg + Math.sqrt(variance) * 0.6);
  const onsets: number[] = [];
  for (let i = 1; i < envelope.length - 1; i++) {
    if (envelope[i] < threshold || envelope[i] < envelope[i - 1] || envelope[i] <= envelope[i + 1]) continue;
    const prior = onsets.at(-1);
    if (prior !== undefined && (i - prior) * 0.01 < 0.15) {
      if (envelope[i] > envelope[prior]) onsets[onsets.length - 1] = i;
    } else onsets.push(i);
  }
  if (onsets.length < 4) return insufficient('rhythm', 'weak');
  const scores: { bpm: number; strength: number; lag: number }[] = [];
  for (let lag = 25; lag <= 150; lag++) {
    let product = 0, left = 0, right = 0;
    for (let i = lag; i < envelope.length; i++) {
      product += envelope[i] * envelope[i - lag]; left += envelope[i] ** 2; right += envelope[i - lag] ** 2;
    }
    scores.push({ bpm: 6000 / lag, strength: product / Math.max(1e-12, Math.sqrt(left * right)), lag });
  }
  const peaks = scores.filter((s, i) => s.strength > 0.4
    && (i === 0 || s.strength >= scores[i - 1].strength) && (i === scores.length - 1 || s.strength >= scores[i + 1].strength));
  if (!peaks.length) return insufficient('rhythm', 'weak');
  const intervals = onsets.slice(1).map((x, i) => (x - onsets[i]) * 0.01);
  const observedBpm = 60 / quantile(intervals, 0.5);
  const bestStrength = Math.max(...peaks.map(p => p.strength));
  const plausible = peaks.filter(p => p.strength >= bestStrength * 0.8);
  plausible.sort((a, b) => Math.abs(Math.log2(a.bpm / observedBpm)) - Math.abs(Math.log2(b.bpm / observedBpm)));
  const best = plausible[0];
  peaks.sort((a, b) => b.strength - a.strength);
  const selected = [best, ...peaks.filter(p => p !== best)].slice(0, 3);
  const ambiguous = selected.some(p => p !== best && p.strength >= best.strength * 0.8);
  return evidence(`能量起音呈现约 ${round(best.bpm, 1)} BPM 的周期候选${ambiguous ? '，存在半速、倍速或其他节拍解释' : ''}。`, {
    method: 'energy_onset_autocorrelation', bpm: round(best.bpm, 1), ambiguous,
    candidates: selected.map(p => ({ bpm: round(p.bpm, 1), periodicity: round(p.strength) })),
    onsetCount: onsets.length, onsetsSeconds: onsets.slice(0, 120).map(i => round(i * 0.01, 2)),
    omittedOnsets: Math.max(0, onsets.length - 120), timeResolutionSeconds: 0.01, meter: 'unknown',
  }, ['周期性数值表示包络的自相关程度，不是节拍正确概率。', '没有判断拍号或小节强拍；连奏、切分、弱鼓和强压缩音乐可能无法可靠估计。']);
}

/** Radix-2 transform, bounded fixed-size scratch storage, original implementation. */
function fft(real: Float64Array, imaginary: Float64Array) {
  const n = real.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { [real[i], real[j]] = [real[j], real[i]]; [imaginary[i], imaginary[j]] = [imaginary[j], imaginary[i]]; }
  }
  for (let length = 2; length <= n; length <<= 1) {
    const angle = -2 * Math.PI / length, wr = Math.cos(angle), wi = Math.sin(angle);
    for (let start = 0; start < n; start += length) {
      let ur = 1, ui = 0;
      for (let j = 0; j < length / 2; j++) {
        const a = start + j, b = a + length / 2;
        const vr = real[b] * ur - imaginary[b] * ui, vi = real[b] * ui + imaginary[b] * ur;
        real[b] = real[a] - vr; imaginary[b] = imaginary[a] - vi; real[a] += vr; imaginary[a] += vi;
        const next = ur * wr - ui * wi; ui = ur * wi + ui * wr; ur = next;
      }
    }
  }
}
type Spectrum = { time: number; rms: number; chroma: number[]; centroid: number; flatness: number };
function spectra(samples: Float64Array): Spectrum[] {
  const frames: Spectrum[] = [], real = new Float64Array(FFT_SIZE), imaginary = new Float64Array(FFT_SIZE);
  const window = Float64Array.from({ length: FFT_SIZE }, (_, i) => 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (FFT_SIZE - 1)));
  for (let start = 0; start < samples.length; start += SPECTRAL_HOP) {
    imaginary.fill(0);
    for (let i = 0; i < FFT_SIZE; i++) real[i] = (samples[start + i] ?? 0) * window[i];
    fft(real, imaginary);
    let weight = 0, centroid = 0, logarithm = 0, bins = 0;
    const chroma = new Array<number>(12).fill(0);
    for (let bin = 16; bin < FFT_SIZE / 2; bin++) {
      const frequency = bin * SAMPLE_RATE / FFT_SIZE;
      const power = real[bin] ** 2 + imaginary[bin] ** 2;
      weight += power; centroid += frequency * power; logarithm += Math.log(Math.max(1e-12, power)); bins++;
      if (frequency >= 65 && frequency <= 1600) {
        const midi = 69 + 12 * Math.log2(frequency / 440), nearest = Math.round(midi);
        if (Math.abs(midi - nearest) < 0.4) chroma[((nearest % 12) + 12) % 12] += power;
      }
    }
    frames.push({ time: start / SAMPLE_RATE, rms: rmsAt(samples, start, FFT_SIZE), chroma,
      centroid: centroid / Math.max(weight, 1e-12), flatness: Math.exp(logarithm / bins) / Math.max(weight / bins, 1e-12) });
  }
  return frames;
}
function cosine(a: number[], b: number[]) {
  let dot = 0, aa = 0, bb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; aa += a[i] ** 2; bb += b[i] ** 2; }
  return dot / Math.max(1e-12, Math.sqrt(aa * bb));
}

function melody(samples: Float64Array): AudioEvidence {
  const duration = samples.length / SAMPLE_RATE;
  if (duration < 0.5) return insufficient('melody', 'short');
  // Four-sample averaging before decimation limits aliasing; pitch search stays below 1 kHz.
  const low = new Float64Array(Math.floor(samples.length / 4));
  for (let i = 0; i < low.length; i++) low[i] = (samples[4 * i] + samples[4 * i + 1] + samples[4 * i + 2] + samples[4 * i + 3]) / 4;
  const points: { time: number; frequency: number; midi: number; periodicity: number }[] = [];
  let tested = 0;
  for (let start = 0; start + 1024 <= low.length; start += 400) {
    tested++;
    let energy = 0;
    for (let i = 0; i < 1024; i++) energy += low[start + i] ** 2;
    if (energy / 1024 < 1e-6) continue;
    const difference = new Float64Array(64), normalized = new Float64Array(64);
    let running = 0;
    for (let lag = 1; lag < 64; lag++) {
      let sum = 0;
      for (let i = 0; i < 960; i++) sum += (low[start + i] - low[start + i + lag]) ** 2;
      difference[lag] = sum; running += sum;
      normalized[lag] = running > 0 ? sum * lag / running : 1;
    }
    let chosen = 0;
    for (let lag = 4; lag < 63; lag++) {
      if (normalized[lag] < 0.18 && normalized[lag] <= normalized[lag - 1] && normalized[lag] <= normalized[lag + 1]) { chosen = lag; break; }
    }
    if (!chosen) continue;
    const left = difference[chosen - 1], middle = difference[chosen], right = difference[chosen + 1];
    const denominator = left - 2 * middle + right;
    const adjusted = chosen + (Math.abs(denominator) > 1e-12 ? clamp(0.5 * (left - right) / denominator, -0.5, 0.5) : 0);
    const frequency = 4000 / adjusted;
    if (frequency < 65 || frequency > 1000) continue;
    const midi = Math.round(69 + 12 * Math.log2(frequency / 440));
    points.push({ time: start / 4000 + 0.128, frequency, midi, periodicity: 1 - normalized[chosen] });
  }
  if (points.length < 3 || points.length / Math.max(1, tested) < 0.1) return insufficient('melody', 'weak');
  const runs: { start: number; end: number; midi: number; frequencies: number[]; periodicities: number[] }[] = [];
  for (const point of points) {
    const prior = runs.at(-1);
    if (prior && prior.midi === point.midi && point.time - prior.end <= 0.16) {
      prior.end = Math.min(duration, point.time + 0.05); prior.frequencies.push(point.frequency); prior.periodicities.push(point.periodicity);
    } else runs.push({ start: Math.max(0, point.time - 0.05), end: Math.min(duration, point.time + 0.05), midi: point.midi,
      frequencies: [point.frequency], periodicities: [point.periodicity] });
  }
  const stable = runs.filter(run => run.frequencies.length >= 2);
  if (!stable.length) return insufficient('melody', 'weak');
  const note = (midi: number) => `${names[midi % 12]}${Math.floor(midi / 12) - 1}`;
  const retained = stable.slice(0, 64);
  const pitches = points.map(point => point.midi), lowNote = note(quantile(pitches, 0.05)), highNote = note(quantile(pitches, 0.95));
  return evidence(`当前片段可提取部分主导周期音高，主要范围约 ${lowNote}–${highNote}；不能据此认定完整的人声旋律。`, {
    method: 'period_difference_dominant_pitch', range: { low: lowNote, high: highNote },
    acceptedFrameRatio: round(points.length / tested), timeStepSeconds: 0.1, frameDurationSeconds: 0.256,
    notes: retained.map(run => ({ startSeconds: round(run.start), endSeconds: round(run.end), note: note(run.midi),
      frequencyHz: round(quantile(run.frequencies, 0.5), 1), periodicity: round(mean(run.periodicities)) })), omittedNotes: stable.length - retained.length,
  }, ['未进行人声分离；混音中的伴奏、和声或倍频可能被当作主导音高。', '周期性和接受比例不是音符正确概率；此结果不是完整乐谱或精确演唱音域。'],
  retained.map(run => ({ startSeconds: round(run.start), endSeconds: round(run.end), text: `${note(run.midi)}，主导周期音高估计` })));
}

type ChordWindow = { startSeconds: number; endSeconds: number; label: string | null; candidates: { label: string; templateScore: number }[]; templateMargin: number; status: string };
function chords(frames: Spectrum[], duration: number): AudioEvidence {
  if (duration < 1) return insufficient('chords', 'short');
  const windows: ChordWindow[] = [];
  for (let start = 0; start < duration; start += 1) {
    const selected = frames.filter(frame => frame.time >= start && frame.time < start + 1);
    if (!selected.length) continue;
    const chroma = new Array<number>(12).fill(0);
    for (const frame of selected) for (let i = 0; i < 12; i++) chroma[i] += frame.chroma[i];
    const sum = chroma.reduce((a, b) => a + b, 0), max = Math.max(...chroma);
    const support = chroma.filter(value => value > max * 0.12).length;
    const ranked: { label: string; score: number; inside: number }[] = [];
    for (let root = 0; root < 12; root++) for (const [suffix, third] of [['maj', 4], ['min', 3]] as const) {
      const template = new Array<number>(12).fill(0);
      template[root] = 1; template[(root + third) % 12] = 1; template[(root + 7) % 12] = 1;
      ranked.push({ label: `${names[root]}:${suffix}`, score: cosine(chroma, template),
        inside: (chroma[root] + chroma[(root + third) % 12] + chroma[(root + 7) % 12]) / Math.max(sum, 1e-12) });
    }
    ranked.sort((a, b) => b.score - a.score);
    const first = ranked[0], margin = first.score - ranked[1].score;
    const usable = sum > 1e-6 && support >= 3 && support <= 7 && mean(selected.map(frame => frame.rms)) > 0.001
      && mean(selected.map(frame => frame.flatness)) < 0.25 && first.score >= 0.78 && first.inside >= 0.65;
    windows.push({ startSeconds: round(start), endSeconds: round(Math.min(start + 1, duration)), label: usable && margin >= 0.08 ? first.label : null,
      candidates: usable ? ranked.slice(0, 3).map(candidate => ({ label: candidate.label, templateScore: round(candidate.score) })) : [],
      templateMargin: usable ? round(margin) : 0, status: !usable ? 'insufficient_evidence' : margin < 0.08 ? 'ambiguous' : 'candidate' });
  }
  const candidates = windows.filter(window => window.label !== null);
  return evidence(candidates.length ? '片段中有可匹配的大、小三和弦候选；以下标签仅为频谱模板估计。' : '没有取得足够明确的三和弦证据；保留不确定性，不给片段指定和弦。', {
    method: 'spectral_chroma_triad_templates', status: candidates.length ? 'estimated' : 'insufficient_evidence', windows,
    timeResolutionSeconds: 1, supportedQualities: ['major_triad', 'minor_triad'],
  }, ['模板分数和分差不是正确概率；没有定调、低音分离、转位或七和弦识别。', '单音、噪声、复杂和弦、配器与泛音可能导致无法判断或误判。']);
}

function structure(samples: Float64Array, frames: Spectrum[]): AudioEvidence {
  const duration = samples.length / SAMPLE_RATE;
  if (duration < 2) return insufficient('structure', 'short');
  const blocks: { time: number; rms: number; chroma: number[]; centroid: number }[] = [];
  for (let start = 0; start < duration; start += 0.5) {
    const selected = frames.filter(frame => frame.time >= start && frame.time < start + 0.5);
    const chroma = new Array<number>(12).fill(0);
    for (const frame of selected) for (let i = 0; i < 12; i++) chroma[i] += frame.chroma[i];
    blocks.push({ time: start, rms: rmsAt(samples, Math.round(start * SAMPLE_RATE), SAMPLE_RATE / 2), chroma,
      centroid: mean(selected.map(frame => frame.centroid)) });
  }
  const cuts: { time: number; score: number; reason: string }[] = [];
  for (let i = 1; i < blocks.length; i++) {
    const a = blocks[i - 1], b = blocks[i];
    if (a.rms < 0.001 && b.rms < 0.001) continue;
    const energy = clamp(Math.abs(db(a.rms) - db(b.rms)) / 12);
    const colour = clamp(1 - cosine(a.chroma, b.chroma));
    const centroid = a.centroid > 30 && b.centroid > 30 ? clamp(Math.abs(Math.log2(b.centroid / a.centroid))) : 0;
    const score = energy + colour * 0.7 + centroid * 0.7;
    if (score < 0.5) continue;
    const cut = { time: b.time, score, reason: energy >= 0.5 ? 'energy_change' : 'spectral_change' };
    const previous = cuts.at(-1);
    if (previous && cut.time - previous.time < 1) { if (cut.score > previous.score) cuts[cuts.length - 1] = cut; }
    else cuts.push(cut);
  }
  const retained = cuts.slice().sort((a, b) => b.score - a.score).slice(0, 12).sort((a, b) => a.time - b.time);
  const edges = [0, ...retained.map(cut => cut.time), duration];
  const overall = rmsAt(samples, 0, samples.length);
  const segments = edges.slice(0, -1).map((start, index) => {
    const end = edges[index + 1], rms = rmsAt(samples, Math.round(start * SAMPLE_RATE), Math.round((end - start) * SAMPLE_RATE));
    return { startSeconds: round(start), endSeconds: round(end), rmsDbFs: db(rms),
      relativeEnergy: rms < 0.001 ? 'near_silence' : rms < overall * 0.65 ? 'low' : rms > overall * 1.3 ? 'high' : 'medium' };
  });
  return evidence(retained.length ? `检测到 ${retained.length} 个能量或频谱变化候选位置，可供进一步补听。` : '当前片段没有检测到明显的能量或频谱分段变化。', {
    method: 'energy_and_spectral_change', changePoints: retained.map(cut => ({ atSeconds: round(cut.time), reason: cut.reason })),
    segments, omittedChangePoints: cuts.length - retained.length, timeResolutionSeconds: 0.5,
  }, ['变化点仅来自半秒能量与频谱比较，时间边界是近似值。', '没有识别主歌、副歌、桥段或整首曲式；所选片段外的结构未知。']);
}

try {
  const samples = readWav(workerData?.wav);
  const tasks = workerData?.tasks as MusicTask[];
  if (!Array.isArray(tasks) || tasks.length < 1 || tasks.length > 4 || tasks.some(task => !['rhythm', 'melody', 'chords', 'structure'].includes(task))) throw Error('invalid_audio');
  const result: MusicResult = {};
  const silent = rmsAt(samples, 0, samples.length) < 0.001;
  const spectral = !silent && (tasks.includes('chords') || tasks.includes('structure')) ? spectra(samples) : [];
  for (const task of tasks) {
    result[task] = silent ? insufficient(task, 'silence') : task === 'rhythm' ? rhythm(samples) : task === 'melody' ? melody(samples)
      : task === 'chords' ? chords(spectral, samples.length / SAMPLE_RATE) : structure(samples, spectral);
  }
  parentPort?.postMessage({ ok: true, result });
} catch (error) {
  parentPort?.postMessage({ ok: false, code: error instanceof Error && error.message === 'invalid_audio' ? 'invalid_audio' : 'music_failed' });
} finally { parentPort?.close(); }
