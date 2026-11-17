/*! Copyright (c) 2026 iinukami and contributors.
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7: see LICENSE-ADDITIONAL.
 */
import type { Crop } from './types.ts';

export type FocusSuggestion = { crop: Crop; atSeconds: number };
export type FocusDecision = { suggestion?: FocusSuggestion; reason: string };
type Geometry = { width: number; height: number; gridWidth: number; gridHeight: number };

/** A conservative change-region hint, not semantic recognition or a confidence score.
 * Grids contain letterboxed RGB pixels. No full-resolution images are retained here.
 */
export function suggestFocus(grids: Uint8Array[], times: number[], geometry: Geometry): FocusDecision {
  const { width, height, gridWidth: gw, gridHeight: gh } = geometry;
  if (![width, height, gw, gh].every(n => Number.isInteger(n) && n > 0) || gw * gh > 65_536
    || grids.length !== times.length || grids.some(g => g.length !== gw * gh * 3)
    || times.some((n, i) => !Number.isFinite(n) || (i > 0 && n <= times[i - 1]))) throw Error('Invalid focus grid');
  if (grids.length < 3) return { reason: '变化样本不足，保留全景。' };
  const scale = Math.min(gw / width, gh / height);
  const cw = Math.min(gw, Math.max(1, Math.round(width * scale)));
  const ch = Math.min(gh, Math.max(1, Math.round(height * scale)));
  const left = Math.floor((gw - cw) / 2), top = Math.floor((gh - ch) / 2);
  const heat = new Uint16Array(gw * gh), useful: number[] = [];
  const delta = (i: number, pixel: number) => {
    const at = pixel * 3, a = grids[i - 1], b = grids[i];
    return (Math.abs(a[at] - b[at]) + Math.abs(a[at + 1] - b[at + 1]) + Math.abs(a[at + 2] - b[at + 2])) / 3;
  };
  for (let i = 1; i < grids.length; i++) {
    let changed = 0;
    for (let y = top; y < top + ch; y++) for (let x = left; x < left + cw; x++) if (delta(i, y * gw + x) >= 18) changed++;
    // A cut, fade or broad camera movement is not evidence of a local region.
    if (!changed || changed / (cw * ch) >= .65) continue;
    useful.push(i);
    for (let y = top; y < top + ch; y++) for (let x = left; x < left + cw; x++) {
      const pixel = y * gw + x; if (delta(i, pixel) >= 18) heat[pixel]++;
    }
  }
  if (useful.length < 2) return { reason: '没有足够的持续局部变化，保留全景。' };
  const minimumHits = Math.max(2, Math.ceil(useful.length * .25));
  const visited = new Uint8Array(heat.length);
  const components: { weight: number; count: number; x0: number; y0: number; x1: number; y1: number }[] = [];
  for (let y = top; y < top + ch; y++) for (let x = left; x < left + cw; x++) {
    const start = y * gw + x;
    if (visited[start] || heat[start] < minimumHits) continue;
    const queue = [start]; visited[start] = 1;
    let count = 0, weight = 0, x0 = x, x1 = x + 1, y0 = y, y1 = y + 1;
    for (let head = 0; head < queue.length; head++) {
      const p = queue[head], px = p % gw, py = Math.floor(p / gw);
      count++; weight += heat[p]; x0 = Math.min(x0, px); x1 = Math.max(x1, px + 1); y0 = Math.min(y0, py); y1 = Math.max(y1, py + 1);
      for (const [nx, ny] of [[px - 1, py], [px + 1, py], [px, py - 1], [px, py + 1]]) {
        if (nx < left || nx >= left + cw || ny < top || ny >= top + ch) continue;
        const n = ny * gw + nx;
        if (!visited[n] && heat[n] >= minimumHits) { visited[n] = 1; queue.push(n); }
      }
    }
    if (count >= Math.max(6, Math.ceil(cw * ch * .005))) components.push({ weight, count, x0, y0, x1, y1 });
  }
  components.sort((a, b) => b.weight - a.weight || b.count - a.count);
  const main = components[0];
  if (!main) return { reason: '变化过于细小或零散，保留全景。' };
  const totalWeight = components.reduce((sum, part) => sum + part.weight, 0);
  if (main.weight / totalWeight < .65) return { reason: '存在多个分散变化区域，保留全景，未合并成大裁剪框。' };
  const rawArea = (main.x1 - main.x0) * (main.y1 - main.y0) / (cw * ch);
  if (rawArea < .01 || rawArea > .6 || main.count / ((main.x1 - main.x0) * (main.y1 - main.y0)) < .2)
    return { reason: '变化区域不适合局部放大，保留全景。' };
  // One grid cell of padding also tolerates one-pixel scaler rounding differences.
  const x0 = Math.max(left, main.x0 - 1), x1 = Math.min(left + cw, main.x1 + 1);
  const y0 = Math.max(top, main.y0 - 1), y1 = Math.min(top + ch, main.y1 + 1);
  const crop = { x: (x0 - left) / cw, y: (y0 - top) / ch, width: (x1 - x0) / cw, height: (y1 - y0) / ch };
  let selected = useful[0], strongest = -1;
  for (const i of useful) {
    let score = 0;
    for (let y = main.y0; y < main.y1; y++) for (let x = main.x0; x < main.x1; x++) score += delta(i, y * gw + x);
    if (score >= strongest) { strongest = score; selected = i; }
  }
  return { suggestion: { crop, atSeconds: times[selected] }, reason: '根据持续局部变化追加一张细节图；全景仍保留，变化不代表内容重要性。' };
}
