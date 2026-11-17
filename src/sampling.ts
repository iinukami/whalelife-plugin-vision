/*! Copyright (c) 2026 iinukami and contributors.
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7: see LICENSE-ADDITIONAL.
 */
/** Independent sampler: scene change + accumulated motion + temporal floor. */
export type Sample = { atSeconds: number; reason: 'first' | 'cut' | 'motion' | 'floor' | 'last'; score: number };
export function difference(a: Uint8Array, b: Uint8Array): number {
  if (a.length !== b.length || !a.length) throw new Error('Invalid sampling grid');
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += Math.abs(a[i] - b[i]);
  return sum / a.length / 255;
}
/** The cap thins candidates across the whole interval; never silently keeps only the tail. */
export function selectSamples(grids: Uint8Array[], times: number[], maxFrames: number) {
  if (grids.length !== times.length || !Number.isInteger(maxFrames) || maxFrames < 2
    || times.some((time, i) => !Number.isFinite(time) || (i > 0 && time <= times[i - 1]))) throw new Error('Invalid sampling input');
  const candidates: Sample[] = [];
  let motion = 0, lastTime = -Infinity;
  for (let i = 0; i < grids.length; i++) {
    const score = i ? difference(grids[i - 1], grids[i]) : 1;
    const dt = i ? Math.max(0, times[i] - times[i - 1]) : 0;
    motion += score * dt;
    let reason: Sample['reason'] | undefined;
    if (!i) reason = 'first';
    else if (score >= 0.18) reason = 'cut';
    else if (motion >= 0.24 && times[i] - lastTime >= 1) reason = 'motion';
    else if (times[i] - lastTime >= 8) reason = 'floor';
    if (reason) { candidates.push({ atSeconds: times[i], reason, score }); lastTime = times[i]; motion = 0; }
  }
  if (times.length > 1 && lastTime !== times.at(-1)) candidates.push({ atSeconds: times.at(-1)!, reason: 'last', score: 0 });
  if (candidates.length <= maxFrames) return { samples: candidates, omittedCandidates: 0 };
  const selected = [candidates[0]];
  // One strongest candidate in each temporal bucket, preserving both endpoints.
  const first = times[0], last = times.at(-1)!;
  for (let bucket = 0; bucket < maxFrames - 2; bucket++) {
    const lo = first + (last - first) * bucket / (maxFrames - 2);
    const hi = first + (last - first) * (bucket + 1) / (maxFrames - 2);
    const part = candidates.slice(1, -1).filter(c => c.atSeconds >= lo && c.atSeconds < hi);
    part.sort((a, b) => (b.reason === 'cut' ? 1 : 0) - (a.reason === 'cut' ? 1 : 0) || b.score - a.score || a.atSeconds - b.atSeconds);
    if (part[0]) selected.push(part[0]);
  }
  selected.push(candidates.at(-1)!);
  selected.sort((a, b) => a.atSeconds - b.atSeconds);
  return { samples: selected, omittedCandidates: candidates.length - selected.length };
}
