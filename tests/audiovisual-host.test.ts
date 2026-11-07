import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, cp, writeFile, readFile, readdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createServer, type IncomingHttpHeaders } from 'node:http';
import { temporaryDirectory, root } from './temporary-directory.ts';
import { movie } from './helpers.ts';

const TRANSCRIPT = 'SYNTHETIC_AUDIO_TRANSCRIPT_NOT_FOR_ARCHIVE';
const REPLY = 'SYNTHETIC_ORDINARY_AUDIOVISUAL_REPLY';
const PERSONA = 'SYNTHETIC_MAIN_PERSONA';
const MAIN_KEY = 'synthetic-av-main-key', STT_KEY = 'synthetic-av-stt-key';

async function diskText(directory: string): Promise<string> {
  const result: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    result.push(entry.isDirectory() ? await diskText(path) : await readFile(path, 'utf8'));
  }
  return result.join('\n');
}

test('packaged audiovisual service and tool share the selected main model, isolate transient inputs, and retain ordinary replies', { timeout: 60_000 }, async t => {
  const f = await temporaryDirectory(t);
  const sttCalls: { headers: IncomingHttpHeaders; raw: Buffer }[] = [], mainCalls: any[] = [], events: any[] = [];
  let viewRef = '', replyNormally = false;
  const server = createServer(async (req, res) => {
    if (req.method === 'GET') { res.setHeader('Content-Type', 'application/json'); res.end('{"data":[]}'); return; }
    const parts: Buffer[] = []; for await (const part of req) parts.push(part);
    const raw = Buffer.concat(parts);
    if (req.url === '/audio/v1/audio/transcriptions') {
      sttCalls.push({ headers: req.headers, raw });
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ text: TRANSCRIPT, segments: [{ start: 0.1, end: 0.8, text: TRANSCRIPT }], usage: { type: 'duration', seconds: 1 } }));
      return;
    }
    if (req.url !== '/main/v1/chat/completions') { res.statusCode = 404; res.end(); return; }
    const request = JSON.parse(raw.toString()); mainCalls.push(request);
    const answered = replyNormally || request.messages.some((m: any) => m.role === 'tool');
    const delta = answered ? { content: replyNormally ? 'SYNTHETIC_NEXT_TEXT_REPLY' : REPLY }
      : { tool_calls: [{ index: 0, id: 'synthetic-av-call', type: 'function', function: { name: 'media_understand',
        arguments: JSON.stringify({ mediaRef: viewRef, fromSeconds: 0.5, toSeconds: 1.5, audio: ['speech'] }) } }] };
    res.setHeader('Content-Type', 'text/event-stream');
    res.end('data: ' + JSON.stringify({ choices: [{ index: 0, delta, finish_reason: answered ? 'stop' : 'tool_calls' }],
      usage: { prompt_tokens: 20, completion_tokens: 4, total_tokens: 24 } }) + '\n\ndata: [DONE]\n\n');
  });
  f.cleanup.push(() => new Promise<void>(done => { server.closeAllConnections(); server.close(() => done()); }));
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  const port = (server.address() as { port: number }).port, run = join(f.dir, 'runtime');
  await mkdir(join(run, 'config'), { recursive: true });
  await mkdir(join(run, 'plugins'), { recursive: true });
  await cp(join(root, 'dist/vision'), join(run, 'plugins/vision'), { recursive: true });
  await mkdir(join(run, 'plugins/vision/data'), { recursive: true });
  await writeFile(join(run, 'plugins/vision/data/config.json'), JSON.stringify({
    ttlSeconds: 1800, maxMediaMiB: 64, maxTotalMiB: 256,
    audio: { speechBackend: 'cloud', speechModelId: 'selected-stt', understandingModelId: '', musicBackend: 'local' },
  }));
  const consumer = join(run, 'plugins/mock-av-source'); await mkdir(consumer);
  await writeFile(join(consumer, 'plugin.yaml'), 'id: mock-av-source\nname: Synthetic audiovisual source\nversion: 1.0.0\ndescription: Isolated test fixture\noptionalDepends: [vision]\n');
  await writeFile(join(consumer, 'index.ts'), `export function apply(ctx) {
    let binding;
    ctx.optional('vision', next => { binding = next; });
    ctx.provide('mock-av-source', {
      newSession: () => ctx.sessions.create('Synthetic audiovisual session'),
      offer: input => binding.service.offerMedia(input, { signal: binding.signal }),
      understand: input => binding.service.understand(input, { signal: binding.signal }),
      run: (sessionId, text) => ctx.sessions.run({ sessionId, text, persona: 'a', permission: 'full' }),
    });
  }`);
  await writeFile(join(run, 'a.md'), PERSONA);
  await writeFile(join(run, 'config/config.json'), JSON.stringify({
    log: { level: 'info' }, web: { port: 0 },
    providers: [
      { id: 'main', name: 'Synthetic main', protocol: 'openai-compatible', base_url: `http://127.0.0.1:${port}/main/v1`, api_key: MAIN_KEY },
      { id: 'audio', name: 'Synthetic STT', protocol: 'openai-compatible', base_url: `http://127.0.0.1:${port}/audio/v1`, api_key: STT_KEY },
    ],
    models: [
      { id: 'selected-main', provider: 'main', name: 'Selected main', model: 'synthetic-main-model', type: 'chat', enabled: true },
      { id: 'selected-stt', provider: 'audio', name: 'Selected STT', model: 'synthetic-stt-model', type: 'stt', enabled: true,
        parameters: { response_format: 'verbose_json', timestamp_granularities: ['segment'] } },
    ],
    model_bindings: { chat: 'selected-main' }, personas: { a: { name: 'Synthetic', file: 'a.md', model: 'selected-main', permission: 'full' } },
    channels: { web: { persona: 'a', permission: 'full' } }, memory: { root: 'memory' },
  }));
  const { boot } = await import(pathToFileURL(resolve(root, '../whalelife/core/index.ts')).href);
  let app: any; f.cleanup.push(async () => { await app?.close(); });
  app = await boot(run);
  app.runtime.events.on('tool/called', (event: any) => events.push(event));
  const record = app.runtime.records.get('vision');
  assert.equal(record.status, 'active', record.error); assert.notEqual(record.execution.pid, process.pid);
  const web = `http://127.0.0.1:${app.web.server.address().port}/plugins/vision`;
  assert.equal((await fetch(web + '/audio/prepare', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status, 401);
  const login = await fetch(`http://127.0.0.1:${app.web.server.address().port}/api/login`, { method: 'POST', body: '{}' });
  const cookie = login.headers.get('set-cookie')!.split(';')[0];
  const state = await (await fetch(web + '/state', { headers: { Cookie: cookie } })).json() as any;
  assert.deepEqual(state.models.map((model: any) => Object.keys(model).sort()), [['id', 'name', 'type'], ['id', 'name', 'type']]);
  assert.doesNotMatch(JSON.stringify(state), new RegExp(MAIN_KEY + '|' + STT_KEY));
  assert.equal(state.status.audio.local.ready, false); assert.equal(state.status.audio.local.phase, 'missing');
  const saved = await fetch(web + '/config', { method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ revision: state.revision, config: { ttlSeconds: 1800, maxMediaMiB: 64, maxTotalMiB: 256 } }) });
  assert.equal(saved.status, 200, 'an old settings client can still save media limits');
  const savedState = await (await fetch(web + '/state', { headers: { Cookie: cookie } })).json() as any;
  assert.deepEqual(savedState.config.audio, state.config.audio, 'an old client cannot erase selected audio backends');
  assert.equal(typeof app.tools.registerMultimodal, 'function');
  assert.ok(app.tools.list().some((tool: any) => tool.function.name === 'media_understand'), JSON.stringify(await app.runtime.services.get('vision').value.status()));
  const source = app.runtime.services.get('mock-av-source').value;
  const sessionId = await source.newSession(), otherSession = await source.newSession();
  const bytes = await movie(f.dir, 2);
  const offered = await source.offer({ sessionId, mime: 'video/mp4', base64: bytes.toString('base64') });
  assert.equal(offered.info.hasAudio, true);
  const range = { sessionId, mediaRef: offered.mediaRef, fromSeconds: 0.5, toSeconds: 1.5, audio: ['speech'] };
  const prepared = await source.understand(range);
  assert.equal(prepared.status, 'completed'); assert.ok(prepared.visual.images.length > 0);
  assert.equal(prepared.audio.status, 'completed');
  assert.equal(prepared.audio.tasks[0].backend, 'cloud');
  assert.equal(prepared.audio.tasks[0].evidence.text, TRANSCRIPT);
  assert.equal(prepared.audio.tasks[0].evidence.segments[0].startSeconds, 0.6, 'provider-relative timestamps gain exactly one media offset');
  assert.deepEqual(prepared.audio.tasks[0].evidence.usage, { seconds: 1 });
  assert.equal(prepared.visual.coverage.fromSeconds, prepared.audio.coverage.fromSeconds);
  assert.equal(prepared.visual.coverage.toSeconds, prepared.audio.coverage.toSeconds);
  assert.equal(mainCalls.length, 0, 'public service preparation invokes only the configured audio backend');
  assert.equal(sttCalls.length, 1);
  assert.equal(sttCalls[0].headers.authorization, 'Bearer ' + STT_KEY);
  assert.equal(sttCalls[0].headers.cookie, undefined);
  assert.match(sttCalls[0].raw.toString(), /name="model"\r\n\r\nsynthetic-stt-model/);
  assert.match(sttCalls[0].raw.toString(), /RIFF[\s\S]*WAVE/);
  assert.doesNotMatch(sttCalls[0].raw.toString(), new RegExp(PERSONA + '|' + MAIN_KEY + '|synthetic-main-model'));

  await assert.rejects(source.understand({ ...range, sessionId: otherSession }));
  const refused = await app.tools.call('media_understand', { ...range }, { id: otherSession, permission: 'full' });
  assert.ok(!refused.result.some((part: any) => part.type === 'image'));
  assert.doesNotMatch(JSON.stringify(refused), new RegExp(TRANSCRIPT));
  assert.equal(sttCalls.length, 1, 'cross-session service/tool requests cannot trigger an audio upload');

  viewRef = offered.mediaRef;
  assert.equal(await source.run(sessionId, 'SYNTHETIC_AUDIOVISUAL_REQUEST'), REPLY);
  assert.equal(mainCalls.length, 2); assert.equal(sttCalls.length, 2);
  assert.ok(mainCalls.every(call => call.model === 'synthetic-main-model'));
  assert.ok(mainCalls.every(call => JSON.stringify(call.messages).includes(PERSONA)));
  const continuation = mainCalls[1], wire = JSON.stringify(continuation);
  const parts = continuation.messages.filter((message: any) => Array.isArray(message.content)).flatMap((message: any) => message.content);
  const images = parts.filter((part: any) => part.type === 'image_url');
  assert.ok(images.length > 0 && images.every((image: any) => image.image_url.url.startsWith('data:image/jpeg;base64,')));
  assert.ok(wire.includes(TRANSCRIPT), 'one main-model request contains both real native images and the clip transcript');
  assert.ok(!wire.includes('input_audio') && !wire.includes(STT_KEY), 'the main model receives evidence, never audio credentials or an audio API request');
  assert.ok(!continuation.messages.filter((message: any) => message.role === 'tool').some((message: any) => message.content.includes('base64')));
  await app.runtime.events.drain();
  const toolEvents = events.filter(event => event.name === 'media_understand');
  assert.equal(toolEvents.length, 2);
  assert.ok(toolEvents.every(event => event.transient === true));
  const receipt = toolEvents.find(event => event.result.outcome === 'completed').result;
  assert.equal(receipt.action, 'prepare_audiovisual_input'); assert.equal(receipt.audioStatus, 'completed');
  assert.ok(receipt.images > 0); assert.deepEqual(receipt.tasks, [{ task: 'speech', backend: 'cloud', status: 'completed' }]);
  assert.doesNotMatch(JSON.stringify(toolEvents), new RegExp(TRANSCRIPT + '|' + STT_KEY + '|' + MAIN_KEY + '|base64'));
  const rows = await app.memory.readSession(sessionId), last = rows.at(-1);
  assert.equal(last.text, REPLY); assert.equal(last.transient, undefined, 'normal final assistant prose remains ordinary dialogue');
  assert.ok(rows.filter((row: any) => row.type === 'tool').every((row: any) => row.args === undefined));
  const persisted = await diskText(join(run, 'memory')) + await diskText(join(run, 'logs'));
  assert.ok(persisted.includes(REPLY)); assert.ok(persisted.includes('prepare_audiovisual_input'));
  assert.doesNotMatch(persisted, new RegExp(TRANSCRIPT + '|' + STT_KEY + '|' + MAIN_KEY));
  assert.ok(!persisted.includes(bytes.toString('base64')));
  assert.ok(images.every((image: any) => !persisted.includes(image.image_url.url)));

  replyNormally = true;
  await source.run(sessionId, 'SYNTHETIC_FOLLOWUP_REQUEST');
  assert.ok(JSON.stringify(mainCalls.at(-1)).includes(REPLY));
  assert.doesNotMatch(JSON.stringify(mainCalls.at(-1)), new RegExp(TRANSCRIPT + '|data:image/'));
  await source.run(otherSession, 'SYNTHETIC_OTHER_SESSION_REQUEST');
  assert.doesNotMatch(JSON.stringify(mainCalls.at(-1)), new RegExp(TRANSCRIPT + '|' + REPLY + '|data:image/'));
  assert.equal(sttCalls.length, 2, 'later text-only rounds do not replay audio work');
  await app.runtime.action('vision', 'stop');
  assert.deepEqual(await readdir(join(run, 'plugins/vision/data/media')), []);
  assert.ok(!app.tools.list().some((tool: any) => tool.function.name === 'media_understand'));
});
