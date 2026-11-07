import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { connect } from 'node:net';
import type { Duplex } from 'node:stream';
import { setImmediate as nextTurn } from 'node:timers/promises';
import type { ModelConnection } from 'whalelife';
import { transcribeCloud, understandCloud } from '../src/audio-cloud.ts';

function wave(seconds = 1) {
  const dataBytes = Math.round(seconds * 16000) * 2, wav = Buffer.alloc(44 + dataBytes);
  wav.write('RIFF'); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8);
  wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(16000, 24); wav.writeUInt32LE(32000, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34);
  wav.write('data', 36); wav.writeUInt32LE(dataBytes, 40);
  for (let i = 44; i < wav.length; i += 2) wav.writeInt16LE(Math.round(Math.sin((i - 44) * 0.01) * 1000), i);
  return wav;
}
async function mock(t: TestContext, handle: (req: IncomingMessage, res: ServerResponse, raw: Buffer) => void | Promise<void>) {
  const requests: { path: string; headers: IncomingMessage['headers']; raw: Buffer }[] = [];
  const server = createServer(async (req, res) => {
    const parts: Buffer[] = []; for await (const part of req) parts.push(part);
    const raw = Buffer.concat(parts); requests.push({ path: req.url!, headers: req.headers, raw });
    await handle(req, res, raw);
  });
  t.after(() => new Promise<void>(done => { server.closeAllConnections(); server.close(() => done()); }));
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  const port = (server.address() as { port: number }).port;
  const connection: ModelConnection = {
    id: 'synthetic-audio', name: 'Synthetic audio', model: 'explicit-model', type: 'stt',
    provider_id: 'fixture', provider_name: 'Fixture', protocol: 'openai-compatible',
    base_url: `http://127.0.0.1:${port}/v1/`, api_key: 'synthetic-audio-key', proxy_url: '',
    timeout_seconds: 2, parameters: {}, dimensions: null, context_window: null,
  };
  return { connection, requests, port };
}
function json(res: ServerResponse, data: unknown) {
  res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(data));
}
const signal = () => new AbortController().signal;
const code = (wanted: string, forbidden = 'SUPPLIER_PRIVATE_MARKER') => (error: any) => {
  assert.equal(error.code, wanted); assert.ok(!String(error).includes(forbidden)); return true;
};
const event = (data: unknown) => `data: ${JSON.stringify(data)}\r\n\r\n`;

test('STT uploads only the chosen WAV and allowlisted form parameters; JSON has clip timing without invented segments', async t => {
  const f = await mock(t, (_req, res) => json(res, { text: ' 合成语音内容 ', usage: { type: 'duration', seconds: 1, private_field: 'never_return' } }));
  const result = await transcribeCloud(wave(), { ...f.connection, parameters: {
    language: 'zh', prompt: '合成词汇提示', temperature: 0,
    model: 'injected-model', file: 'http://invalid.example/private', messages: [{ content: 'injected-history' }], stream: true,
  } }, signal());
  assert.equal(result.text, '合成语音内容'); assert.equal(result.timing, 'clip');
  assert.equal(result.segments, undefined); assert.deepEqual(result.usage, { seconds: 1 });
  assert.ok(result.warnings.length > 0); assert.equal(f.requests.length, 1);
  const request = f.requests[0], body = request.raw.toString();
  assert.equal(request.path, '/v1/audio/transcriptions'); assert.equal(request.headers.authorization, 'Bearer synthetic-audio-key');
  assert.equal(request.headers.cookie, undefined); assert.match(body, /name="model"\r\n\r\nexplicit-model/);
  assert.match(body, /filename="clip.wav"/); assert.match(body, /name="response_format"\r\n\r\njson/);
  assert.match(body, /name="language"\r\n\r\nzh/); assert.doesNotMatch(body, /injected-model|injected-history|invalid\.example/);
});

test('STT preserves provider relative segment timestamps when explicitly using verbose_json', async t => {
  const f = await mock(t, (_req, res) => json(res, { text: '测试内容', segments: [
    { start: 0.1, end: 0.4, text: '测试', id: 'provider-private-id' }, { start: 0.5, end: 0.9, text: '内容' },
  ], usage: { input_tokens: 12, output_tokens: 4, total_tokens: 16 } }));
  const result = await transcribeCloud(wave(), { ...f.connection, parameters: { response_format: 'verbose_json', timestamp_granularities: ['segment'] } }, signal());
  assert.equal(result.timing, 'segment');
  assert.deepEqual(result.segments, [{ startSeconds: 0.1, endSeconds: 0.4, text: '测试' }, { startSeconds: 0.5, endSeconds: 0.9, text: '内容' }]);
  assert.equal(result.details?.timestampSource, 'provider');
  assert.doesNotMatch(JSON.stringify(result), /provider-private-id/);
  assert.match(f.requests[0].raw.toString(), /name="timestamp_granularities\[\]"\r\n\r\nsegment/);
});

test('STT returns validated word timings and discards unusable out-of-clip timestamps without fabricating replacements', async t => {
  let invalid = false;
  const f = await mock(t, (_req, res) => json(res, { text: 'test', words: [{ start: 0.1, end: invalid ? 99 : 0.8, word: 'test' }] }));
  const first = await transcribeCloud(wave(), f.connection, signal());
  assert.deepEqual(first.segments, [{ startSeconds: 0.1, endSeconds: 0.8, text: 'test' }]);
  invalid = true;
  const second = await transcribeCloud(wave(), f.connection, signal());
  assert.equal(second.text, 'test'); assert.equal(second.timing, 'clip'); assert.equal(second.segments, undefined);
  assert.match(second.warnings.join(''), /范围校验/); assert.equal(f.requests.length, 2);
});

test('invalid clip, unsupported protocol, wrong model type and unsafe configuration fail before an upload', async t => {
  const f = await mock(t, (_req, res) => json(res, { text: 'not expected' }));
  await assert.rejects(transcribeCloud(Buffer.from('SUPPLIER_PRIVATE_MARKER'), f.connection, signal()), code('audio_input'));
  await assert.rejects(transcribeCloud(wave(61), f.connection, signal()), code('audio_input'));
  await assert.rejects(transcribeCloud(wave(), { ...f.connection, protocol: 'dashscope' }, signal()), code('audio_protocol'));
  await assert.rejects(transcribeCloud(wave(), { ...f.connection, type: 'chat' }, signal()), code('audio_model_type'));
  await assert.rejects(transcribeCloud(wave(), { ...f.connection, base_url: 'https://user:SUPPLIER_PRIVATE_MARKER@example.invalid' }, signal()), code('audio_config'));
  await assert.rejects(transcribeCloud(wave(), { ...f.connection, parameters: { response_format: 'srt' } }, signal()), code('audio_config'));
  await assert.rejects(transcribeCloud(wave(), { ...f.connection, parameters: { timestamp_granularities: ['word'] } }, signal()), code('audio_config'));
  assert.equal(f.requests.length, 0);
});

test('small provider end-time overrun is bounded to the clip while out-of-clip starts invalidate timestamps', async t => {
  let start = 0.1;
  const f = await mock(t, (_req, res) => json(res, { text: 'test', segments: [{ start, end: 1.2, text: 'test' }] }));
  const valid = await transcribeCloud(wave(), f.connection, signal());
  assert.equal(valid.timing, 'segment');
  assert.deepEqual(valid.segments, [{ startSeconds: 0.1, endSeconds: 1, text: 'test' }]);
  start = 1.1;
  const invalid = await transcribeCloud(wave(), f.connection, signal());
  assert.equal(invalid.timing, 'clip'); assert.equal(invalid.segments, undefined);
  assert.equal(invalid.text, 'test'); assert.match(invalid.warnings.join(''), /范围校验/);
});

test('HTTP failures and redirects do not leak provider text, forward credentials, or retry', async t => {
  const destination = await mock(t, (_req, res) => json(res, { text: 'must not be reached' }));
  let redirect = false;
  const f = await mock(t, (_req, res) => {
    res.statusCode = redirect ? 307 : 503;
    if (redirect) res.setHeader('Location', destination.connection.base_url + 'audio/transcriptions');
    res.end('SUPPLIER_PRIVATE_MARKER synthetic-audio-key file://private.wav');
  });
  await assert.rejects(transcribeCloud(wave(), f.connection, signal()), code('audio_http_error'));
  redirect = true;
  await assert.rejects(transcribeCloud(wave(), f.connection, signal()), code('audio_http_error'));
  assert.equal(f.requests.length, 2); assert.equal(destination.requests.length, 0);
});

test('caller cancellation and connection timeout stop the active upload with safe errors and no retry', async t => {
  let accepted!: () => void;
  const received = new Promise<void>(done => { accepted = done; });
  const f = await mock(t, () => { accepted(); });
  const controller = new AbortController();
  const pending = transcribeCloud(wave(), f.connection, controller.signal);
  await received; controller.abort('SUPPLIER_PRIVATE_MARKER');
  await assert.rejects(pending, code('cancelled'));
  await assert.rejects(transcribeCloud(wave(), { ...f.connection, timeout_seconds: 0.08 }, signal()), code('audio_timeout'));
  assert.equal(f.requests.length, 2);
  const already = new AbortController(); already.abort('SUPPLIER_PRIVATE_MARKER');
  await assert.rejects(transcribeCloud(wave(), f.connection, already.signal), code('cancelled'));
  assert.equal(f.requests.length, 2);
});

test('Qwen-compatible SSE handles fragmented UTF-8, discards reasoning, and keeps reported usage', async t => {
  const f = await mock(t, async (_req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    const bytes = Buffer.from(
      event({ choices: [{ index: 0, delta: { reasoning_content: 'PRIVATE_REASONING_MARKER' } }] })
      + event({ choices: [{ index: 0, delta: { content: '合成掌声' } }] })
      + event({ choices: [{ index: 0, delta: { content: '与音乐。' }, finish_reason: 'stop' }] })
      + event({ choices: [], usage: { prompt_tokens: 21, completion_tokens: 8, total_tokens: 29, prompt_tokens_details: { audio_tokens: 14 }, completion_tokens_details: { reasoning_tokens: 3 }, private: 'not included' } })
      + 'data: [DONE]\r\n\r\n');
    for (let at = 0; at < bytes.length; at += 5) { res.write(bytes.subarray(at, at + 5)); await nextTurn(); }
    res.end();
  });
  const result = await understandCloud(wave(), { ...f.connection, type: 'custom', parameters: {
    max_tokens: 1024, temperature: 0.2, top_p: 0.8, enable_thinking: true,
    model: 'injected-model', messages: [{ role: 'system', content: 'PRIVATE_PERSONA' }], tools: [{ name: 'unsafe' }], modalities: ['audio'],
  } }, 'sound', signal());
  assert.equal(result.text, '合成掌声与音乐。'); assert.equal(result.timing, 'clip'); assert.equal(result.segments, undefined);
  assert.deepEqual(result.usage, { prompt_tokens: 21, completion_tokens: 8, total_tokens: 29, input_audio_tokens: 14, output_reasoning_tokens: 3 });
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_REASONING_MARKER/);
  const body = JSON.parse(f.requests[0].raw.toString());
  assert.equal(f.requests[0].path, '/v1/chat/completions'); assert.equal(body.model, 'explicit-model'); assert.equal(body.stream, true);
  assert.deepEqual(body.modalities, ['text']); assert.deepEqual(body.stream_options, { include_usage: true });
  assert.equal(body.max_tokens, 1024); assert.equal(body.messages.length, 1); assert.equal(body.messages[0].role, 'user');
  assert.equal(body.tools, undefined); assert.doesNotMatch(JSON.stringify(body), /PRIVATE_PERSONA|injected-model/);
  const audio = body.messages[0].content.find((part: any) => part.type === 'input_audio');
  assert.equal(audio.input_audio.format, 'wav'); assert.equal(audio.input_audio.data, 'data:;base64,' + wave().toString('base64'));
});

test('cloud music JSON responses are explicitly labelled as descriptive estimates and preserve unknown usage', async t => {
  const f = await mock(t, (_req, res) => json(res, { choices: [{ message: { content: '合成节奏候选。' }, finish_reason: 'stop' }] }));
  const result = await understandCloud(wave(), { ...f.connection, type: 'chat' }, 'rhythm', signal());
  assert.equal(result.text, '合成节奏候选。'); assert.equal(result.usage, undefined);
  assert.equal(result.details?.evidenceKind, 'audio_model_description'); assert.match(result.warnings.join(''), /未经精确量测/);
});

test('truncated, unfinished and error SSE responses are rejected instead of being presented as complete analysis', async t => {
  let mode = 'length';
  const f = await mock(t, (_req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    if (mode === 'error') { res.end(event({ error: { message: 'SUPPLIER_PRIVATE_MARKER synthetic-audio-key' } })); return; }
    if (mode === 'invalid') { res.end('data: SUPPLIER_PRIVATE_MARKER\n\n'); return; }
    res.end(event({ choices: [{ index: 0, delta: { content: 'partial' }, ...(mode === 'length' ? { finish_reason: 'length' } : {}) }] }) + 'data: [DONE]\n\n');
  });
  const config = { ...f.connection, type: 'custom' as const };
  await assert.rejects(understandCloud(wave(), config, 'sound', signal()), code('audio_output_truncated'));
  mode = 'unfinished'; await assert.rejects(understandCloud(wave(), config, 'sound', signal()), code('audio_incomplete'));
  mode = 'error'; await assert.rejects(understandCloud(wave(), config, 'sound', signal()), code('audio_service_error'));
  mode = 'invalid'; await assert.rejects(understandCloud(wave(), config, 'sound', signal()), code('audio_response'));
  assert.equal(f.requests.length, 4);
});

test('cloud adapter bounds complete JSON, visible text, and ignored stream reasoning', async t => {
  let mode = 'text';
  const f = await mock(t, (_req, res) => {
    if (mode === 'text') { json(res, { text: 'x'.repeat(17 * 1024) }); return; }
    if (mode === 'json') { json(res, { text: 'short', unused: 'x'.repeat(1024 * 1024) }); return; }
    res.setHeader('Content-Type', 'text/event-stream');
    res.end(event({ choices: [{ index: 0, delta: { reasoning_content: 'x'.repeat(1024 * 1024) } }] }));
  });
  await assert.rejects(transcribeCloud(wave(), f.connection, signal()), code('audio_output_limit'));
  mode = 'json'; await assert.rejects(transcribeCloud(wave(), f.connection, signal()), code('audio_output_limit'));
  mode = 'sse'; await assert.rejects(understandCloud(wave(), { ...f.connection, type: 'custom' }, 'sound', signal()), code('audio_output_limit'));
  assert.equal(f.requests.length, 3);
});

test('explicit proxy is used, proxy authorization stays at the proxy, and all tunnel sockets close', async t => {
  const f = await mock(t, (_req, res) => json(res, { text: 'proxied' }));
  const tunnels: IncomingMessage[] = [], sockets = new Set<Duplex>();
  const proxy = createServer((_req, res) => { res.statusCode = 500; res.end(); });
  const track = <T extends Duplex>(socket: T): T => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); return socket; };
  proxy.on('connect', (req, client, head) => {
    tunnels.push(req); track(client);
    const target = track(connect({ host: '127.0.0.1', port: f.port }));
    target.on('error', () => client.destroy()); client.on('error', () => target.destroy());
    client.once('close', () => target.destroy()); target.once('close', () => client.destroy());
    target.once('connect', () => { client.write('HTTP/1.1 200 Connection Established\r\n\r\n'); if (head.length) target.write(head); client.pipe(target); target.pipe(client); });
  });
  t.after(() => new Promise<void>(done => { for (const socket of sockets) socket.destroy(); proxy.closeAllConnections(); proxy.close(() => done()); }));
  await new Promise<void>(done => proxy.listen(0, '127.0.0.1', done));
  const proxyPort = (proxy.address() as { port: number }).port;
  const result = await transcribeCloud(wave(), { ...f.connection, proxy_url: `http://synthetic-proxy-user:synthetic-proxy-password@127.0.0.1:${proxyPort}` }, signal());
  assert.equal(result.text, 'proxied'); assert.equal(tunnels.length, 1); assert.equal(tunnels[0].url, `127.0.0.1:${f.port}`);
  assert.ok(tunnels[0].headers['proxy-authorization']); assert.equal(f.requests[0].headers['proxy-authorization'], undefined);
  assert.equal(f.requests.length, 1);
  await Promise.all([...sockets].map(socket => new Promise<void>(done => socket.once('close', () => done()))));
  assert.equal(sockets.size, 0);
});

test('empty recognized speech is not equated with silence and absent usage is not reported as zero', async t => {
  const f = await mock(t, (_req, res) => json(res, { text: '', usage: { input_tokens: -1, total_tokens: 'unknown' } }));
  const result = await transcribeCloud(wave(), f.connection, signal());
  assert.equal(result.text, ''); assert.equal(result.usage, undefined); assert.match(result.warnings.join(''), /不证明片段没有声音/);
});

test('STT keeps reported input audio token details without creating a usage estimate', async t => {
  const f = await mock(t, (_req, res) => json(res, { text: 'test', usage: {
    type: 'tokens', input_tokens: 14, input_token_details: { text_tokens: 0, audio_tokens: 14 }, output_tokens: 4, total_tokens: 18,
  } }));
  const result = await transcribeCloud(wave(), f.connection, signal());
  assert.deepEqual(result.usage, { input_tokens: 14, output_tokens: 4, total_tokens: 18, input_text_tokens: 0, input_audio_tokens: 14 });
});

test('SSE DONE terminates the reader even when the server keeps its response open', async t => {
  let closed!: () => void;
  const disconnected = new Promise<void>(done => { closed = done; });
  const f = await mock(t, (_req, res) => {
    res.once('close', closed); res.setHeader('Content-Type', 'text/event-stream');
    res.write(event({ choices: [{ index: 0, delta: { content: 'complete' }, finish_reason: 'stop' }] }) + 'data: [DONE]\n\n');
  });
  const result = await understandCloud(wave(), { ...f.connection, type: 'chat' }, 'sound', signal());
  assert.equal(result.text, 'complete'); await disconnected;
  assert.equal(f.requests.length, 1);
});

test('cancellation and timeout also terminate a partially received SSE body without delivering it', async t => {
  let received!: () => void;
  const ready = new Promise<void>(done => { received = done; });
  const f = await mock(t, (_req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.write(event({ choices: [{ index: 0, delta: { content: 'partial analysis' } }] })); received();
  });
  const controller = new AbortController();
  const pending = understandCloud(wave(), { ...f.connection, type: 'chat' }, 'sound', controller.signal);
  await ready; controller.abort('SUPPLIER_PRIVATE_MARKER');
  await assert.rejects(pending, code('cancelled'));
  await assert.rejects(understandCloud(wave(), { ...f.connection, type: 'chat', timeout_seconds: 0.08 }, 'sound', signal()), code('audio_timeout'));
  assert.equal(f.requests.length, 2);
});
