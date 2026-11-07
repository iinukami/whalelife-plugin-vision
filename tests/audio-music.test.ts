import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyzeMusic, type MusicTask } from '../src/audio-music.ts';

const tasks: MusicTask[] = ['rhythm', 'melody', 'chords', 'structure'];
const freshSignal = () => new AbortController().signal;
function wav(duration: number, sample: (seconds: number, index: number) => number) {
  const count = Math.round(duration * 16000), bytes = Buffer.alloc(44 + count * 2);
  bytes.write('RIFF', 0); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WAVEfmt ', 8);
  bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(16000, 24); bytes.writeUInt32LE(32000, 28);
  bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34); bytes.write('data', 36); bytes.writeUInt32LE(count * 2, 40);
  for (let i = 0; i < count; i++) bytes.writeInt16LE(Math.round(Math.max(-1, Math.min(1, sample(i / 16000, i))) * 32767), 44 + i * 2);
  return bytes;
}
const tone = (frequency: number, seconds: number, volume = 0.4) => volume * Math.sin(2 * Math.PI * frequency * seconds);

test('silence produces no invented tempo, notes, chords or structural labels', async () => {
  const result = await analyzeMusic(wav(4, () => 0), tasks, freshSignal());
  for (const task of tasks) assert.equal(result[task]?.details?.status, 'insufficient_evidence');
  assert.doesNotMatch(JSON.stringify(result), /"bpm":|"notes":|"label":"[A-G]|副歌候选/);
});

test('regular 120 BPM synthetic percussive onsets retain the slower-tempo ambiguity', async () => {
  const audio = wav(8, seconds => {
    const phase = seconds % 0.5;
    return phase < 0.07 ? tone(150, seconds, 0.8) * Math.exp(-phase * 55) : 0;
  });
  const result = (await analyzeMusic(audio, ['rhythm'], freshSignal())).rhythm!;
  assert.ok(Math.abs(Number(result.details?.bpm) - 120) <= 3, JSON.stringify(result));
  const candidates = result.details?.candidates as { bpm: number; periodicity: number }[];
  assert.ok(candidates.some(candidate => Math.abs(candidate.bpm - 60) < 2));
  assert.equal(result.details?.ambiguous, true);
  assert.equal(result.details?.meter, 'unknown');
  assert.ok(result.warnings.some(warning => warning.includes('不是节拍正确概率')));
});

test('a sustained tone is not called a beat pattern or a complete chord', async () => {
  const result = await analyzeMusic(wav(5, seconds => tone(440, seconds)), ['rhythm', 'chords'], freshSignal());
  assert.equal(result.rhythm?.details?.status, 'insufficient_evidence');
  assert.equal(result.chords?.details?.status, 'insufficient_evidence');
  assert.ok((result.chords?.details?.windows as { label: string | null }[]).every(window => window.label === null));
});

test('known A4 to C5 change is represented as approximate dominant pitch segments', async () => {
  const audio = wav(4, seconds => tone(seconds < 2 ? 440 : 523.251, seconds));
  const result = (await analyzeMusic(audio, ['melody'], freshSignal())).melody!;
  const notes = result.details?.notes as { note: string; startSeconds: number; endSeconds: number; frequencyHz: number }[];
  assert.ok(notes.some(note => note.note === 'A4' && Math.abs(note.frequencyHz - 440) < 5), JSON.stringify(result));
  assert.ok(notes.some(note => note.note === 'C5' && Math.abs(note.frequencyHz - 523.251) < 6), JSON.stringify(result));
  assert.ok(notes.every(note => note.startSeconds >= 0 && note.endSeconds <= 4 && note.endSeconds > note.startSeconds));
  assert.ok(result.segments?.some(segment => segment.startSeconds > 1.7 && segment.startSeconds < 2.3));
  assert.ok(result.warnings.some(warning => warning.includes('未进行人声分离')));
});

test('clean C major and A minor triads provide candidates with template scores, never probabilities', async () => {
  const cases = [
    { notes: [261.626, 329.628, 391.995], expected: 'C:maj' },
    { notes: [220, 261.626, 329.628], expected: 'A:min' },
  ];
  for (const item of cases) {
    const result = (await analyzeMusic(wav(3, seconds => item.notes.reduce((sum, frequency) => sum + tone(frequency, seconds, 0.2), 0)), ['chords'], freshSignal())).chords!;
    const windows = result.details?.windows as { label: string | null; templateMargin: number; candidates: { templateScore: number }[] }[];
    assert.ok(windows.some(window => window.label === item.expected), JSON.stringify(result));
    assert.ok(windows.every(window => Number.isFinite(window.templateMargin)));
    assert.doesNotMatch(JSON.stringify(result.details), /confidence|probability/);
    assert.ok(result.warnings.some(warning => warning.includes('不是正确概率')));
  }
});

test('deterministic broadband noise does not acquire tempo, melody or chord certainty', async () => {
  let seed = 123456789;
  const audio = wav(4, () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return (seed / 0x100000000 - 0.5) * 0.6; });
  const result = await analyzeMusic(audio, ['rhythm', 'melody', 'chords'], freshSignal());
  assert.equal(result.rhythm?.details?.status, 'insufficient_evidence');
  assert.equal(result.melody?.details?.status, 'insufficient_evidence');
  assert.equal(result.chords?.details?.status, 'insufficient_evidence');
});

test('energy transition is a bounded change point, not a verse or chorus classification', async () => {
  const result = (await analyzeMusic(wav(6, seconds => tone(seconds < 3 ? 220 : 880, seconds, seconds < 3 ? 0.05 : 0.5)), ['structure'], freshSignal())).structure!;
  const cuts = result.details?.changePoints as { atSeconds: number; reason: string }[];
  assert.ok(cuts.some(cut => Math.abs(cut.atSeconds - 3) <= 0.5), JSON.stringify(result));
  assert.ok(cuts.length <= 12);
  const segments = result.details?.segments as { startSeconds: number; endSeconds: number; relativeEnergy: string }[];
  assert.equal(segments[0].startSeconds, 0); assert.equal(segments.at(-1)?.endSeconds, 6);
  assert.ok(segments.every(segment => segment.endSeconds > segment.startSeconds));
  assert.ok(result.warnings.some(warning => warning.includes('没有识别主歌')));
});

test('short clip and FFmpeg pipe WAV are handled without fabricated precision or ownership transfer', async () => {
  const bytes = wav(0.25, seconds => tone(440, seconds));
  bytes.writeUInt32LE(0xffffffff, 4); bytes.writeUInt32LE(0xffffffff, 40);
  const snapshot = Buffer.from(bytes);
  const result = await analyzeMusic(bytes, tasks, freshSignal());
  assert.deepEqual(bytes, snapshot, 'worker transfer must not detach/mutate the caller buffer');
  for (const task of tasks) assert.equal(result[task]?.details?.reason, 'short');
});

test('invalid formats, durations, task names and chunk lengths fail with safe errors', async () => {
  const base = wav(1, seconds => tone(440, seconds));
  const stereo = Buffer.from(base); stereo.writeUInt16LE(2, 22);
  const wrongRate = Buffer.from(base); wrongRate.writeUInt32LE(48000, 24);
  const truncated = base.subarray(0, base.length - 2);
  const long = wav(60.01, () => 0);
  for (const bytes of [stereo, wrongRate, truncated, long, Buffer.from('SECRET_MEDIA_NOT_WAV')]) {
    await assert.rejects(analyzeMusic(bytes, ['rhythm'], freshSignal()), (error: any) => {
      assert.equal(error.code, 'invalid_audio'); assert.doesNotMatch(error.message, /SECRET_MEDIA|D:\\/); return true;
    });
  }
  await assert.rejects(analyzeMusic(base, ['private/path'] as unknown as MusicTask[], freshSignal()), { code: 'invalid_audio' });
  await assert.rejects(analyzeMusic(base, [], freshSignal()), { code: 'invalid_audio' });
});

test('cancellation before and during worker execution rejects without leaking the reason', async () => {
  const bytes = wav(60, seconds => tone(220 + (Math.floor(seconds) % 12) * 11, seconds));
  const before = new AbortController(); before.abort('SECRET_CANCEL_REASON');
  await assert.rejects(analyzeMusic(bytes, tasks, before.signal), { code: 'cancelled' });
  const during = new AbortController();
  const pending = analyzeMusic(bytes, tasks, during.signal);
  const timer = setTimeout(() => during.abort('SECRET_CANCEL_REASON'), 30);
  try {
    await assert.rejects(pending, (error: any) => {
      assert.equal(error.code, 'cancelled'); assert.doesNotMatch(error.message, /SECRET_CANCEL_REASON/); return true;
    });
  } finally { clearTimeout(timer); }
});

test('full allowed duration keeps the parent responsive and output bounded', async () => {
  const bytes = wav(60, seconds => tone(220 * 2 ** ((Math.floor(seconds * 2) % 12) / 12), seconds));
  let ticked = false;
  const tick = setTimeout(() => { ticked = true; }, 0);
  try {
    const result = await analyzeMusic(bytes, tasks, freshSignal());
    assert.equal(ticked, true, 'DSP must run outside the plugin event loop');
    assert.ok(Buffer.byteLength(JSON.stringify(result)) < 48 * 1024);
    assert.ok((result.melody?.details?.notes as unknown[]).length <= 64);
    assert.ok((result.structure?.details?.changePoints as unknown[]).length <= 12);
    assert.ok((result.chords?.details?.windows as unknown[]).length <= 60);
  } finally { clearTimeout(tick); }
});
