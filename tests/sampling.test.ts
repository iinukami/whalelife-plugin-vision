import { test } from 'node:test';
import assert from 'node:assert/strict';
import { selectSamples, difference } from '../src/sampling.ts';
import { configOf, defaults } from '../src/types.ts';
test('static sequence has bounded temporal checks and both interval endpoints', () => {
  const times = Array.from({ length: 61 }, (_, i) => i / 2);
  const result = selectSamples(times.map(() => new Uint8Array(30).fill(50)), times, 8);
  assert.deepEqual(result.samples.map(s => s.atSeconds), [0, 8, 16, 24, 30]);
  assert.equal(result.omittedCandidates, 0);
});
test('hard cut and continuous motion are both represented', () => {
  const result = selectSamples([0, 20, 40, 60, 80, 100, 240].map(v => new Uint8Array(30).fill(v)), [0,1,2,3,4,5,6], 8);
  assert.ok(result.samples.some(s => s.reason === 'motion'));
  assert.ok(result.samples.some(s => s.reason === 'cut'));
  assert.equal(difference(new Uint8Array([0,0]), new Uint8Array([255,255])), 1);
});
test('busy scene cap preserves interval start/end and reports omitted candidates', () => {
  const times = Array.from({ length: 100 }, (_, i) => i / 2);
  const result = selectSamples(times.map((_, i) => new Uint8Array(30).fill(i % 2 ? 255 : 0)), times, 8);
  assert.equal(result.samples.length, 8);
  assert.equal(result.samples[0].atSeconds, 0);
  assert.equal(result.samples.at(-1)!.atSeconds, 49.5);
  assert.equal(result.omittedCandidates, 92);
});
test('configuration keeps media limits and ignores obsolete decoder paths', () => {
  assert.deepEqual(configOf({}), defaults);
  assert.throws(() => configOf({ ttlSeconds: NaN }));
  assert.throws(() => configOf({ maxTotalMiB: 1 }));
  assert.deepEqual(configOf({ ffmpegPath: 'ffmpeg\n--extra', ffprobePath: null }), defaults);
  assert.deepEqual(configOf({ ttlSeconds: 60, ffmpegPath: 'C:/old/ffmpeg.exe' }), { ...defaults, ttlSeconds: 60 });
});

test('a small configurable budget still spans the entire dense sampling interval', () => {
  const times = Array.from({ length: 360 }, (_, i) => i / 6);
  const grids = times.map((_, i) => new Uint8Array(30).fill(i % 2 ? 255 : 0));
  for (const cap of [2, 3, 5, 8]) {
    const result = selectSamples(grids, times, cap);
    assert.ok(result.samples.length <= cap);
    assert.equal(result.samples[0].atSeconds, 0);
    assert.equal(result.samples.at(-1)!.atSeconds, 359 / 6);
    assert.ok(result.omittedCandidates > 0);
  }
});

test('sampling rejects fractional budgets and nonmonotonic or invalid times', () => {
  const grids = [new Uint8Array([0]), new Uint8Array([255])];
  assert.throws(() => selectSamples(grids, [0, 1], 2.5));
  assert.throws(() => selectSamples(grids, [1, 0], 2));
  assert.throws(() => selectSamples(grids, [0, Number.NaN], 2));
});
