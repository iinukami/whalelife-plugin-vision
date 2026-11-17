import { test } from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { spawn } from 'node:child_process';
import { ScreenCapture, screenDefaults, screenSettingsOf, screenProcessSource, type ScreenFrame, type ScreenSource } from '../src/screen.ts';

async function jpeg(color: string, width = 120, height = 80) {
  return sharp({ create: { width, height, channels: 3, background: color } }).jpeg().toBuffer();
}
function fakeFrame(bytes: Buffer, atSeconds: number, extra: Partial<ScreenFrame> = {}): ScreenFrame {
  return { jpeg: bytes, atSeconds, width: 120, height: 80, targetId: 'synthetic-window',
    capturedAt: new Date(Date.UTC(2026, 0, 1) + atSeconds * 1000).toISOString(), ...extra };
}
function setup(source: ScreenSource, settings = { ...screenDefaults, enabled: true }) {
  const parent = new AbortController();
  const capture = new ScreenCapture(settings, parent.signal, { source, platform: 'win32' });
  return { capture, parent };
}
const active = () => new AbortController().signal;

test('screen settings default to disabled and strictly validate target, switch and duration', () => {
  assert.deepEqual(screenSettingsOf(undefined), screenDefaults);
  assert.deepEqual(screenSettingsOf({ enabled: true, target: 'screen', seconds: 20 }), { enabled: true, target: 'screen', seconds: 20 });
  for (const value of [{ enabled: 'true' }, { target: 'arbitrary-handle' }, { seconds: 1 }, { seconds: 61 }, { seconds: 2.5 }, { seconds: NaN }, null]) {
    assert.throws(() => screenSettingsOf(value));
  }
});

test('disabled, unsupported and cancelled capture do not invoke a source', async () => {
  let called = 0;
  const source: ScreenSource = async function* () { called++; };
  const disabled = setup(source, { ...screenDefaults });
  await assert.rejects(disabled.capture.capture({}, active()), { code: 'screen_disabled' });
  const unsupported = new ScreenCapture({ ...screenDefaults, enabled: true }, active(), { source, platform: 'linux' });
  await assert.rejects(unsupported.capture({}, active()), { code: 'unsupported_platform' });
  const cancelled = new AbortController(); cancelled.abort('private-reason');
  const enabled = setup(source);
  await assert.rejects(enabled.capture.capture({}, cancelled.signal), e => {
    assert.equal((e as { code: string }).code, 'cancelled'); assert.ok(!String(e).includes('private-reason')); return true;
  });
  assert.equal(called, 0);
  await Promise.all([disabled.capture.stop(), unsupported.stop(), enabled.capture.stop()]);
});

test('snapshot is fresh each call, retains aspect ratio and does not reuse earlier screen content', async () => {
  const red = await jpeg('#ff0000', 240, 80), blue = await jpeg('#0000ff', 240, 80);
  let calls = 0;
  const f = setup(async function* () { yield fakeFrame(++calls === 1 ? red : blue, 0, { width: 240 }); });
  try {
    const first = await f.capture.capture({}, active());
    const second = await f.capture.capture({}, active());
    assert.equal(first.detail, 'detail'); assert.equal(first.images.length, 1);
    assert.equal(first.images[0].width / first.images[0].height, 3);
    assert.notEqual(first.images[0].base64, second.images[0].base64);
    assert.equal(second.coverage.capturedFrames, 1);
    assert.equal(second.coverage.requestedSeconds, 0);
    assert.equal(second.coverage.audioIncluded, false);
    assert.equal(calls, 2);
  } finally { await f.capture.stop(); }
});

test('full observation continues after frame cap and retains the real first and last sample', async () => {
  const red = await jpeg('#ff0000'), blue = await jpeg('#0000ff');
  let yielded = 0;
  const f = setup(async function* () {
    for (let i = 0; i <= 20; i++) { yielded++; yield fakeFrame(i % 2 ? red : blue, i / 2); }
  });
  try {
    const result = await f.capture.capture({ mode: 'observe', seconds: 10 }, active(), { maxFrames: 3, sampleFps: 2 });
    assert.equal(yielded, 21); assert.equal(result.coverage.capturedFrames, 21);
    assert.equal(result.images.length, 3);
    assert.equal(result.coverage.fromSeconds, 0); assert.equal(result.coverage.toSeconds, 10);
    assert.equal(result.coverage.selectedTimes[0], 0); assert.equal(result.coverage.selectedTimes.at(-1), 10);
    assert.equal(result.coverage.observedSeconds, 10);
    assert.equal(result.detail, 'overview');
    assert.equal(result.coverage.timelineComplete, false);
  } finally { await f.capture.stop(); }
});

test('static observation still returns current endpoints and samples distributed across the interval', async () => {
  const bytes = await jpeg('#333333');
  const f = setup(async function* () { for (let i = 0; i <= 20; i++) yield fakeFrame(bytes, i / 2); });
  try {
    const result = await f.capture.capture({ mode: 'observe', seconds: 10 }, active(), { maxFrames: 8, sampleFps: 2 });
    assert.equal(result.images.length, 8);
    assert.equal(result.coverage.selectedTimes[0], 0);
    assert.equal(result.coverage.selectedTimes.at(-1), 10);
    assert.ok(result.coverage.selectedTimes.some(at => at > 5 && at < 9));
    assert.ok(result.images.every(image => image.base64 === result.images[0].base64));
  } finally { await f.capture.stop(); }
});

test('premature observation does not claim the requested duration was covered', async () => {
  const bytes = await jpeg('#fff');
  const f = setup(async function* () { yield fakeFrame(bytes, 0); yield fakeFrame(bytes, 1); });
  try { await assert.rejects(f.capture.capture({ mode: 'observe', seconds: 10 }, active()), { code: 'screen_incomplete' }); }
  finally { await f.capture.stop(); }
});

test('irregular capture timestamps are reported as actual coverage, not a promised fixed interval', async () => {
  const bytes = await jpeg('#fff'), times = [0, 0.8, 1.7, 2.3];
  const f = setup(async function* () { for (const at of times) yield fakeFrame(bytes, at); });
  try {
    const result = await f.capture.capture({ mode: 'observe', seconds: 2 }, active(), { sampleFps: 2 });
    assert.deepEqual(result.coverage.selectedTimes, times);
    assert.equal(result.coverage.requestedSeconds, 2);
    assert.equal(result.coverage.observedSeconds, 2.3);
    assert.equal(result.coverage.requestedSampleIntervalSeconds, 0.5);
    assert.equal(Object.hasOwn(result.coverage, 'sampleIntervalSeconds'), false);
    assert.match(result.warnings.join(' '), /以 selectedTimes 为准/);
  } finally { await f.capture.stop(); }
});

test('target changes and backwards timestamps fail instead of mixing unrelated windows', async () => {
  const bytes = await jpeg('#fff');
  const changed = setup(async function* () {
    yield fakeFrame(bytes, 0); yield fakeFrame(bytes, 2, { targetId: 'different-window' });
  });
  const reversed = setup(async function* () {
    yield fakeFrame(bytes, 0); yield fakeFrame(bytes, 1); yield fakeFrame(bytes, 0.5);
  });
  try {
    await assert.rejects(changed.capture.capture({ mode: 'observe', seconds: 2 }, active()), { code: 'screen_target_changed' });
    await assert.rejects(reversed.capture.capture({ mode: 'observe', seconds: 2 }, active()), { code: 'screen_failed' });
  } finally { await changed.capture.stop(); await reversed.capture.stop(); }
});

test('window movement or resizing may change image dimensions without distorting the selected frames', async () => {
  const wide = await jpeg('#fff', 240, 80), tall = await jpeg('#eee', 80, 240);
  const f = setup(async function* () {
    yield fakeFrame(wide, 0, { width: 240 });
    yield fakeFrame(tall, 2, { width: 80, height: 240 });
  });
  try {
    const result = await f.capture.capture({ mode: 'observe', seconds: 2 }, active());
    assert.equal(result.images[0].width / result.images[0].height, 3);
    assert.equal(result.images.at(-1)!.height / result.images.at(-1)!.width, 3);
  } finally { await f.capture.stop(); }
});

test('cancellation waits for source cleanup; concurrent tasks are rejected and a later call can start fresh', async () => {
  let started!: () => void, cleaned = 0, calls = 0;
  const gate = new Promise<void>(resolve => { started = resolve; });
  const bytes = await jpeg('#fff');
  const f = setup(async function* (_request, signal) {
    calls++;
    try {
      if (calls > 1) { yield fakeFrame(bytes, 0); return; }
      started();
      await new Promise<void>((resolve, reject) => {
        if (signal.aborted) { reject(new Error('aborted')); return; }
        signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      });
      yield fakeFrame(bytes, 0);
    } finally { cleaned++; }
  });
  const cancel = new AbortController();
  const pending = f.capture.capture({ mode: 'observe', seconds: 10 }, cancel.signal);
  const rejected = assert.rejects(pending, { code: 'cancelled' });
  try {
    await gate;
    assert.equal(f.capture.status().busy, true);
    await assert.rejects(f.capture.capture({}, active()), { code: 'screen_busy' });
    cancel.abort('private-cancel-reason');
    await rejected;
    assert.equal(cleaned, 1); assert.equal(calls, 1); assert.equal(f.capture.status().busy, false);
    assert.equal((await f.capture.capture({}, active())).images.length, 1);
    assert.equal(calls, 2); assert.equal(cleaned, 2);
  } finally { cancel.abort(); await f.capture.stop(); }
});

test('plugin stop cancels in-flight source and rejects subsequent work', async () => {
  let ready!: () => void, finished = false;
  const gate = new Promise<void>(resolve => { ready = resolve; });
  const f = setup(async function* (_request, signal) {
    try {
      ready();
      await new Promise<void>((_resolve, reject) => signal.addEventListener('abort', () => reject(Error('stop')), { once: true }));
    } finally { finished = true; }
  });
  const rejected = assert.rejects(f.capture.capture({}, active()), { code: 'cancelled' });
  await gate; await f.capture.stop(); await rejected;
  assert.equal(finished, true); assert.equal(f.capture.status().ready, false);
  await assert.rejects(f.capture.capture({}, active()), { code: 'stopped' });
});

test('invalid images, dishonest dimensions, excessive samples and invalid parameters fail before returning content', async () => {
  const bytes = await jpeg('#fff');
  const cases: Array<[ScreenSource, string]> = [
    [async function* () { yield fakeFrame(bytes, 0, { width: 121 }); }, 'screen_failed'],
    [async function* () { yield fakeFrame(Buffer.alloc(4 * 1024 * 1024 + 1), 0); }, 'screen_output_limit'],
    [async function* () { yield fakeFrame(bytes, 0, { width: 50000, height: 50000 }); }, 'screen_output_limit'],
    [async function* () { for (let i = 0; i < 30; i++) yield fakeFrame(bytes, i / 20); }, 'screen_output_limit'],
  ];
  for (const [source, code] of cases) {
    const f = setup(source);
    try { await assert.rejects(f.capture.capture({ mode: 'observe', seconds: 2 }, active()), { code }); }
    finally { await f.capture.stop(); }
  }
  let called = 0;
  const f = setup(async function* () { called++; });
  try {
    await assert.rejects(f.capture.capture({ seconds: 10 }, active()), { code: 'invalid_input' });
    await assert.rejects(f.capture.capture({ mode: 'observe', seconds: NaN }, active()), { code: 'invalid_input' });
    await assert.rejects(f.capture.capture({}, active(), { maxFrames: 9 }), { code: 'invalid_input' });
    assert.equal(called, 0);
  } finally { await f.capture.stop(); }
});

test('source exceptions are sanitized and cannot expose desktop or local path text', async () => {
  const f = setup(async function* () { throw Error('private-window-title C:/Users/private'); });
  try {
    await assert.rejects(f.capture.capture({}, active()), e => {
      assert.equal((e as { code: string }).code, 'screen_failed');
      assert.ok(!String(e).includes('private')); return true;
    });
  } finally { await f.capture.stop(); }
});

test('native transport cancellation waits for the actual synthetic child close event', async t => {
  let started!: () => void, closed = false;
  const gate = new Promise<void>(resolve => { started = resolve; });
  let child: ReturnType<typeof spawn> | undefined;
  const source = screenProcessSource(() => {
    const next = spawn(process.execPath, ['-e', 'process.stdout.write("ready\\n"); setInterval(()=>{},1000)'],
      { windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    child = next;
    next.once('spawn', started);
    next.once('close', () => { closed = true; });
    return next;
  });
  t.after(() => { if (child && !closed) child.kill('SIGKILL'); });
  const f = setup(source), cancel = new AbortController();
  t.after(() => f.capture.stop());
  const rejected = assert.rejects(f.capture.capture({}, cancel.signal), { code: 'cancelled' });
  await gate; cancel.abort('private-reason'); await rejected;
  assert.equal(closed, true);
  assert.equal(f.capture.status().busy, false);
});

test('native transport accepts a complete synthetic frame and drains private stderr without returning it', async t => {
  const bytes = await jpeg('#abcdef'), frame = fakeFrame(bytes, 0);
  const message = JSON.stringify({ type: 'frame', ...frame, jpeg: bytes.toString('base64') });
  let closed = false;
  const f = setup(screenProcessSource(() => {
    const child = spawn(process.execPath, ['-e',
      'process.stderr.write("private-window-title\\n"); process.stdout.write(process.argv[1]+"\\n")', message],
    { windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    child.once('close', () => { closed = true; }); return child;
  }));
  t.after(() => f.capture.stop());
  const result = await f.capture.capture({}, active());
  assert.equal(result.images.length, 1); assert.equal(closed, true);
  assert.ok(!JSON.stringify(result).includes('private-window-title'));
});

test('native transport rejects partial success on nonzero exit and terminates malformed or oversized producers', async t => {
  const bytes = await jpeg('#abcdef');
  const message = JSON.stringify({ type: 'frame', ...fakeFrame(bytes, 0), jpeg: bytes.toString('base64') });
  const cases = [
    { code: 'screen_failed', script: 'process.stdout.write(process.argv[1]+"\\n",()=>process.exit(3))' },
    { code: 'screen_failed', script: 'process.stdout.write("{bad-json}\\n"); setInterval(()=>{},1000)' },
    { code: 'screen_failed', script: 'process.stdout.write(process.argv[1]);' },
    { code: 'screen_output_limit', script: 'process.stdout.write("x".repeat(6*1024*1024+1)); setInterval(()=>{},1000)' },
    { code: 'screen_target_unavailable', script: 'process.stdout.write(JSON.stringify({type:"error",code:"target_unavailable"})+"\\n"); setInterval(()=>{},1000)' },
  ];
  for (const item of cases) {
    await t.test(item.code + ': ' + item.script.slice(0, 45), async sub => {
      let closed = false;
      let child: ReturnType<typeof spawn> | undefined;
      const f = setup(screenProcessSource(() => {
        const next = spawn(process.execPath, ['-e', item.script, message],
          { windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
        child = next; next.once('close', () => { closed = true; }); return next;
      }));
      sub.after(async () => { if (child && !closed) child.kill('SIGKILL'); await f.capture.stop(); });
      await assert.rejects(f.capture.capture({}, active()), { code: item.code });
      assert.equal(closed, true); assert.equal(f.capture.status().busy, false);
    });
  }
});
