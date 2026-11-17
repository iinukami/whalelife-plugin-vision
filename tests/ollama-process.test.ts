/*! Copyright (c) 2026 iinukami and contributors.
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7: see LICENSE-ADDITIONAL.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { createServer, Server } from 'node:net';
import { join } from 'node:path';
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';
import { OllamaProcess } from '../src/ollama-process.ts';
import { temporaryDirectory } from './temporary-directory.ts';

test('closed Ollama process manager rejects start without launching anything', async () => {
  const controller = new AbortController();
  const manager = new OllamaProcess('.', controller.signal);
  await manager.close();
  assert.equal(manager.running(), false);
  await assert.rejects(manager.start(process.execPath, process.cwd()), /已停止/);
  await manager.stop();
});

test('occupied managed port is left untouched', { skip: process.platform !== 'win32' }, async t => {
  const fixture = await temporaryDirectory(t);
  const root = fixture.dir;
  const server = createServer();
  fixture.cleanup.push(() => new Promise<void>(resolve => server.close(() => resolve())));
  try { await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(11435, '127.0.0.1', resolve); }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'EADDRINUSE') { t.skip('11435 already belongs to an external service'); return; } throw error; }
  const manager = new OllamaProcess(root, new AbortController().signal);
  fixture.cleanup.push(() => manager.close());
  await assert.rejects(manager.start(process.execPath, join(root, 'models')), /11435.*占用/);
  assert.equal(manager.running(), false);
  assert.equal(server.listening, true);
});

test('stop cancels a start before its asynchronous preflight completes', { skip: process.platform !== 'win32' }, async t => {
  const fixture = await temporaryDirectory(t), root = fixture.dir;
  const manager = new OllamaProcess(root, new AbortController().signal);
  fixture.cleanup.push(() => manager.close());
  const pending = manager.start(process.execPath, join(root, 'models'));
  const rejected = assert.rejects(pending, /取消|11435.*占用/);
  await manager.stop();
  await rejected;
  assert.equal(manager.running(), false);
  await manager.close();
});

for (const action of ['stop', 'abort'] as const) test(`${action} between pipe listen and listening settles without launching a console`,
  { skip: process.platform !== 'win32', timeout: 5_000 }, async t => {
    const fixture = await temporaryDirectory(t), controller = new AbortController();
    const manager = new OllamaProcess(fixture.dir, controller.signal);
    fixture.cleanup.push(() => manager.close());
    const original = Server.prototype.listen;
    let interrupted = false, stopping: Promise<void> | undefined;
    let pipe: Server | undefined;
    // Real Node listen allocates its handle synchronously but emits listening on
    // nextTick. Close that actual handle before nextTick, not a fake timed delay.
    t.mock.method(Server.prototype, 'listen', function(this: Server, ...args: Parameters<Server['listen']>) {
      const result = Reflect.apply(original, this, args) as Server;
      if (typeof args[0] === 'string' && args[0].startsWith('\\\\.\\pipe\\whalelife-vision-ollama-')) {
        interrupted = true;
        pipe = this;
        if (action === 'abort') controller.abort();
        stopping = manager.stop();
      }
      return result;
    });
    await assert.rejects(manager.start(process.execPath, join(fixture.dir, 'models')), /关闭|取消/);
    assert.equal(interrupted, true);
    await stopping;
    assert.equal(manager.running(), false);
    assert.equal(pipe?.listening, false);
    assert.equal(pipe?.listenerCount('listening'), 0);
    assert.equal(pipe?.listenerCount('error'), 0);
    const record = await until(async () => { try { return JSON.parse(await readFile(join(fixture.dir, 'console-run.json'), 'utf8')); } catch { return undefined; } });
    assert.equal(record.state, 'stopped');
    assert.equal(record.launcherPid, undefined);
  });

test('managed paths reject junctions and models outside the owned root before any launch', { skip: process.platform !== 'win32' }, async t => {
  const fixture = await temporaryDirectory(t), base = fixture.dir;
  const outside = join(base, 'outside'); await mkdir(outside);
  await writeFile(join(outside, 'sentinel'), 'untouched');
  for (const kind of ['root', 'models', 'record', 'outside'] as const) {
    const root = join(base, `case-${kind}`);
    if (kind === 'root') await symlink(outside, root, 'junction');
    else await mkdir(root);
    if (kind === 'models') await symlink(outside, join(root, 'models'), 'junction');
    if (kind === 'record') await symlink(outside, join(root, 'console-run.json'), 'junction');
    const manager = new OllamaProcess(root, new AbortController().signal);
    fixture.cleanup.push(() => manager.close());
    await assert.rejects(manager.start(process.execPath, kind === 'outside' ? outside : join(root, 'models')), /链接|重定向|自有目录/);
    assert.equal(manager.running(), false);
    await manager.close();
  }
  assert.equal(await readFile(join(outside, 'sentinel'), 'utf8'), 'untouched');
});

const visible = process.platform === 'win32' && process.env.VISION_TEST_VISIBLE_OLLAMA === '1';
test('visible owned CMD stops synthetic server and descendants on stop and parent abort', { skip: !visible, timeout: 70_000 }, async t => {
  const fixture = await temporaryDirectory(t), root = fixture.dir;
  const controller = new AbortController();
  const manager = new OllamaProcess(root, controller.signal);
  let owner: ChildProcess | undefined;
  fixture.cleanup.push(async () => {
    if (owner && owner.exitCode === null && owner.signalCode === null) owner.kill();
    await manager.close();
    let last: { pid?: number; descendant?: number } = {};
    try { last = JSON.parse(await readFile(join(root, 'models/synthetic.json'), 'utf8')); } catch {}
    await until(async () => (!last.pid || !alive(last.pid)) && (!last.descendant || !alive(last.descendant)) ? true : undefined);
  });
  const models = join(root, 'models');
  await mkdir(models);
  await writeFile(join(root, 'serve'), `
    import fs from 'node:fs'; import path from 'node:path'; import {spawn} from 'node:child_process';
    const descendant=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});
    fs.writeFileSync(path.join(process.env.OLLAMA_MODELS,'synthetic.json'),JSON.stringify({pid:process.pid,descendant:descendant.pid,host:process.env.OLLAMA_HOST,cloud:process.env.OLLAMA_NO_CLOUD}));
    console.log('Synthetic local Ollama lifecycle test; no model or media is used.');
    setInterval(()=>{},1000);
  `);
  t.diagnostic('visible lifecycle phase: broker exit during startup');
  const earlyStart = manager.start(process.execPath, models);
  const earlyRejected = assert.rejects(earlyStart, /控制台|连接|取消/);
  const earlyRecord = await until(async () => { try { const value = JSON.parse(await readFile(join(root, 'console-run.json'), 'utf8')); return value.brokerPid ? value : undefined; } catch { return undefined; } });
  process.kill(earlyRecord.brokerPid);
  await earlyRejected;
  await manager.stop();
  assert.equal(manager.running(), false);
  assert.equal(manager.owned(), false);
  for (const action of ['stop', 'launcher', 'broker', 'window', 'abort'] as const) {
    t.diagnostic(`visible lifecycle phase: ${action}`);
    const windowBaseline = action === 'window' ? await visibleWindowHandles() : [];
    await manager.start(process.execPath, models);
    assert.equal(manager.running(), true);
    const data = await until(async () => { try { return JSON.parse(await readFile(join(models, 'synthetic.json'), 'utf8')); } catch { return undefined; } });
    assert.equal(data.host, '127.0.0.1:11435');
    assert.equal(data.cloud, '1');
    assert.equal(alive(data.pid), true);
    assert.equal(alive(data.descendant), true);
    const { stdout } = await promisify(execFile)(join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
      ['-NoProfile', '-NonInteractive', '-Command', "@(Get-Process | Where-Object {$_.MainWindowTitle -like '*WhaleLife - Local Ollama*' -and $_.MainWindowHandle -ne 0}).Count"],
      { windowsHide: true, timeout: 5_000 });
    assert.ok(Number(stdout.trim()) > 0, 'the synthetic CMD must have an actual visible window');
    // Leave enough time for the isolated acceptance to inspect this visible window.
    if (process.env.VISION_TEST_VISIBLE_HOLD === '1') await new Promise(resolve => setTimeout(resolve, 4_000));
    const record = await until(async () => { try { const value = JSON.parse(await readFile(join(root, 'console-run.json'), 'utf8')); return value.serverPid === data.pid ? value : undefined; } catch { return undefined; } });
    if (action === 'launcher') {
      // Kill only this fixture's outer launcher. stop must await broker/job
      // acknowledgement, not incorrectly treat the launcher's exit as cleanup.
      process.kill(record.launcherPid);
    }
    if (action === 'broker') process.kill(record.brokerPid);
    if (action === 'window') t.diagnostic(await closeSyntheticConsole(record.brokerPid, windowBaseline));
    if (action === 'broker' || action === 'window') await until(async () => !manager.running() ? true : undefined);
    if (action === 'abort') { controller.abort(); await manager.close(); }
    else await manager.stop();
    assert.equal(manager.running(), false);
    assert.equal(manager.owned(), false);
    assert.equal(alive(data.pid), false, `server must already be gone when ${action} resolves`);
    assert.equal(alive(data.descendant), false, `descendant must already be gone when ${action} resolves`);
    assert.equal(alive(record.helperPid), false, `helper must already be gone when ${action} resolves`);
    assert.equal(alive(record.supervisorPid), false, `supervisor must already be gone when ${action} resolves`);
    await rm(join(models, 'synthetic.json'));
  }
  // A host's hard plugin cut-off cannot run JS cleanup. Closing its named pipe
  // must still release the broker's Job Object, including runner descendants.
  t.diagnostic('visible lifecycle phase: owner exit');
  owner = spawn(process.execPath, ['--input-type=module', '-e', `
    import {OllamaProcess} from ${JSON.stringify(new URL('../src/ollama-process.ts', import.meta.url).href)};
    const manager=new OllamaProcess(process.argv[1],new AbortController().signal);
    await manager.start(process.execPath,process.argv[2]);
    process.send({ready:true});
  `, root, models], { cwd: root, stdio: ['ignore', 'ignore', 'ignore', 'ipc'], windowsHide: true });
  const ownerProcess = owner;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(Error('Synthetic owner did not start')), 20_000);
    ownerProcess.once('message', () => { clearTimeout(timer); resolve(); });
    ownerProcess.once('error', error => { clearTimeout(timer); reject(error); });
    ownerProcess.once('exit', () => { clearTimeout(timer); reject(Error('Synthetic owner exited before start')); });
  });
  const data = await until(async () => { try { return JSON.parse(await readFile(join(models, 'synthetic.json'), 'utf8')); } catch { return undefined; } });
  assert.equal(alive(data.pid), true);
  assert.equal(alive(data.descendant), true);
  const record = await until(async () => { try { const value = JSON.parse(await readFile(join(root, 'console-run.json'), 'utf8')); return value.serverPid === data.pid ? value : undefined; } catch { return undefined; } });
  owner.kill();
  await until(async () => !alive(data.pid) && !alive(data.descendant) && !alive(record.launcherPid) ? true : undefined);
});

function alive(pid: number): boolean { try { process.kill(pid, 0); return true; } catch { return false; } }
const consoleWindowSource = String.raw`
using System; using System.Text; using System.Collections.Generic; using System.Runtime.InteropServices;
public static class SyntheticConsoleClose {
  public delegate bool WindowCallback(IntPtr hwnd,IntPtr state);
  [DllImport("kernel32.dll")] public static extern bool FreeConsole();
  [DllImport("kernel32.dll")] public static extern bool AttachConsole(uint pid);
  [DllImport("kernel32.dll")] public static extern IntPtr GetConsoleWindow();
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hwnd);
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr hwnd,uint message,IntPtr w,IntPtr l);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hwnd,out uint pid);
  [DllImport("user32.dll")] public static extern bool EnumWindows(WindowCallback callback,IntPtr state);
  [DllImport("user32.dll",CharSet=CharSet.Unicode)] static extern int GetClassName(IntPtr hwnd,StringBuilder name,int count);
  [DllImport("user32.dll",CharSet=CharSet.Unicode)] static extern int GetWindowText(IntPtr hwnd,StringBuilder text,int count);
  public static string Class(IntPtr hwnd){var value=new StringBuilder(256);GetClassName(hwnd,value,value.Capacity);return value.ToString();}
  public static string Title(IntPtr hwnd){var value=new StringBuilder(1024);GetWindowText(hwnd,value,value.Capacity);return value.ToString();}
  public static IntPtr[] Visible(){var result=new List<IntPtr>();EnumWindows((hwnd,state)=>{if(IsWindowVisible(hwnd))result.Add(hwnd);return true;},IntPtr.Zero);return result.ToArray();}
}
`;
async function visibleWindowHandles(): Promise<string[]> {
  const script = `$ErrorActionPreference='Stop'\nAdd-Type -TypeDefinition @'\n${consoleWindowSource}\n'@\nConvertTo-Json -Compress -InputObject @([SyntheticConsoleClose]::Visible() | ForEach-Object {$_.ToInt64().ToString()})`;
  const result = await promisify(execFile)(join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { windowsHide: true, timeout: 5_000 });
  const values: unknown = JSON.parse(result.stdout);
  assert.ok(Array.isArray(values) && values.every(value => typeof value === 'string' && /^\d+$/.test(value)));
  return values;
}
async function closeSyntheticConsole(brokerPid: number, baseline: string[]): Promise<string> {
  assert.ok(Number.isSafeInteger(brokerPid) && brokerPid > 0);
  assert.ok(baseline.every(value => /^\d+$/.test(value)));
  const script = `$ErrorActionPreference='Stop'
Add-Type -TypeDefinition @'
${consoleWindowSource}
'@
$outputWriter=[Console]::Out
$broker=[Diagnostics.Process]::GetProcessById(${brokerPid})
$brokerHandle=$broker.Handle
$baseline=@(${baseline.map(value => `'${value}'`).join(',')})
[SyntheticConsoleClose]::FreeConsole()|Out-Null
if(-not [SyntheticConsoleClose]::AttachConsole(${brokerPid})){throw 'Cannot attach synthetic console'}
$consoleHandle=[SyntheticConsoleClose]::GetConsoleWindow()
[SyntheticConsoleClose]::FreeConsole()|Out-Null
$consoleClass=[SyntheticConsoleClose]::Class($consoleHandle)
if($consoleClass -eq 'ConsoleWindowClass'){
  $handle=$consoleHandle
  if($baseline -contains $handle.ToInt64().ToString()){throw 'Synthetic console was present before this launch'}
}elseif($consoleClass -eq 'PseudoConsoleWindow'){
  # GetConsoleWindow is only a message window under Windows Terminal. Target
  # exactly one NEW real window, never an existing host window or all titles.
  $candidates=@([SyntheticConsoleClose]::Visible() | Where-Object {
    ($baseline -notcontains $_.ToInt64().ToString()) -and
    ([SyntheticConsoleClose]::Class($_) -eq 'CASCADIA_HOSTING_WINDOW_CLASS') -and
    ([SyntheticConsoleClose]::Title($_) -like '*WhaleLife - Local Ollama*')
  })
  if($candidates.Count -ne 1){throw 'Cannot uniquely identify the newly created synthetic Terminal window'}
  $handle=$candidates[0]
}else{throw 'Unknown synthetic console window class'}
$broker.Refresh()
if($broker.HasExited -or -not [SyntheticConsoleClose]::IsWindowVisible($handle)){throw 'Synthetic console disappeared before close'}
[uint32]$windowPid=0
[SyntheticConsoleClose]::GetWindowThreadProcessId($handle,[ref]$windowPid)|Out-Null
$windowProcess=Get-Process -Id $windowPid
$windowProcessName=$windowProcess.ProcessName
$windowProcessStarted=$windowProcess.StartTime.ToUniversalTime().ToString('o')
$windowClass=[SyntheticConsoleClose]::Class($handle)
if(-not [SyntheticConsoleClose]::PostMessage($handle,0x10,[IntPtr]::Zero,[IntPtr]::Zero)){throw 'Cannot close synthetic console'}
Start-Sleep -Milliseconds 400
$outputWriter.WriteLine(([pscustomobject]@{consoleClass=$consoleClass;closedWindowClass=$windowClass;closedWindowProcess=$windowProcessName;windowProcessStarted=$windowProcessStarted;stillVisible=[SyntheticConsoleClose]::IsWindowVisible($handle);brokerAlive=[bool](Get-Process -Id ${brokerPid} -ErrorAction SilentlyContinue)}|ConvertTo-Json -Compress))
`;
  const result = await promisify(execFile)(join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { windowsHide: true, timeout: 5_000 });
  return result.stdout.trim();
}
async function until<T>(read: () => Promise<T | undefined>): Promise<T> {
  const end = Date.now() + 12_000;
  while (Date.now() < end) { const value = await read(); if (value !== undefined) return value; await new Promise(resolve => setTimeout(resolve, 100)); }
  throw Error('Synthetic process state did not settle');
}
