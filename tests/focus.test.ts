/*! Copyright (c) 2026 iinukami and contributors.
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7: see LICENSE-ADDITIONAL.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { suggestFocus } from '../src/focus.ts';

const geometry = { width: 1600, height: 900, gridWidth: 64, gridHeight: 36 };
type Rect = { x: number; y: number; width: number; height: number };
function grids(rects: Rect[], count = 5) {
  return Array.from({ length: count }, (_, frame) => {
    const pixels = new Uint8Array(64 * 36 * 3).fill(30);
    for (const rect of rects) for (let y = rect.y; y < rect.y + rect.height; y++) for (let x = rect.x; x < rect.x + rect.width; x++)
      pixels.fill(frame % 2 ? 220 : 70, (y * 64 + x) * 3, (y * 64 + x + 1) * 3);
    return pixels;
  });
}
const times = (count: number, fps = 2) => Array.from({ length: count }, (_, i) => i / fps);

test('a persistent local region yields a bounded suggestion tied to an actual sample time', () => {
  const input = grids([{ x: 16, y: 10, width: 14, height: 9 }]);
  const result = suggestFocus(input, times(input.length), geometry);
  assert.ok(result.suggestion);
  const { crop, atSeconds } = result.suggestion;
  assert.ok(crop.x <= 16 / 64 && crop.x + crop.width >= 30 / 64);
  assert.ok(crop.y <= 10 / 36 && crop.y + crop.height >= 19 / 36);
  assert.ok(crop.width * crop.height < .2);
  assert.ok(times(input.length).includes(atSeconds));
});

test('static content and whole-screen cuts do not manufacture a focus region', () => {
  const stable = Array.from({ length: 5 }, () => new Uint8Array(64 * 36 * 3).fill(70));
  assert.equal(suggestFocus(stable, times(5), geometry).suggestion, undefined);
  const cuts = stable.map((frame, i) => frame.slice().fill(i % 2 ? 255 : 0));
  assert.equal(suggestFocus(cuts, times(5), geometry).suggestion, undefined);
});

test('isolated blinking pixels are rejected rather than enlarged', () => {
  const input = grids([{ x: 14, y: 8, width: 1, height: 1 }, { x: 40, y: 20, width: 1, height: 1 }]);
  assert.equal(suggestFocus(input, times(input.length), geometry).suggestion, undefined);
});

test('two similarly strong separated regions are not joined into a misleading rectangle', () => {
  const input = grids([{ x: 5, y: 8, width: 10, height: 8 }, { x: 48, y: 20, width: 10, height: 8 }]);
  const result = suggestFocus(input, times(input.length), geometry);
  assert.equal(result.suggestion, undefined);
  assert.match(result.reason, /分散/);
});

test('portrait letterboxing is removed before mapping focus coordinates to the source', () => {
  // 900x1600 inside a 64x36 grid occupies x=22..41, width=20.
  const input = grids([{ x: 27, y: 8, width: 9, height: 10 }]);
  const result = suggestFocus(input, times(input.length), { ...geometry, width: 900, height: 1600 });
  assert.ok(result.suggestion);
  const crop = result.suggestion.crop;
  assert.ok(crop.x >= .15 && crop.x <= .25, 'source x must not contain the grid padding offset');
  assert.ok(crop.width >= .5 && crop.width <= .6, 'source width must be relative to the 20 content columns');
  assert.ok(crop.x + crop.width <= 1 && crop.y + crop.height <= 1);
});

test('focus geometry is stable when the same activity is observed at a higher sampling rate', () => {
  const rect = { x: 18, y: 8, width: 12, height: 10 };
  const slow = grids([rect], 5), dense = grids([rect], 13);
  const a = suggestFocus(slow, times(slow.length, 2), geometry);
  const b = suggestFocus(dense, times(dense.length, 6), geometry);
  assert.ok(a.suggestion && b.suggestion);
  assert.deepEqual(a.suggestion.crop, b.suggestion.crop);
});

test('focus requires temporal evidence and rejects malformed sample geometry', () => {
  const input = grids([{ x: 10, y: 10, width: 10, height: 10 }], 2);
  assert.equal(suggestFocus(input, times(2), geometry).suggestion, undefined);
  assert.throws(() => suggestFocus(input, [0, 0], geometry));
  assert.throws(() => suggestFocus(input, times(2), { ...geometry, gridWidth: 0 }));
  assert.throws(() => suggestFocus([new Uint8Array(3)], [0], geometry));
});
