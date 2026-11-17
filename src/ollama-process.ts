/*! Copyright (c) 2026 iinukami and contributors.
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7: see LICENSE-ADDITIONAL.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { lstat, mkdir, realpath, rename, unlink, writeFile } from 'node:fs/promises';
import { createServer, type Server, type Socket } from 'node:net';
import { isAbsolute, join, parse, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

interface Run {
  server: Server;
  sockets: Set<Socket>;
  socket?: Socket;
  helperSocket?: Socket;
  supervisorSocket?: Socket;
  supervisor?: ChildProcess;
  supervisorExited: boolean;
  console?: ChildProcess;
  ready: Promise<void>;
  accept: () => void;
  reject: (error: Error) => void;
  exited: Promise<void>;
  finish: () => void;
  stopping: boolean;
  started: boolean;
  done: boolean;
  authorized: boolean;
  consoleExited: boolean;
  brokerStopped: boolean;
}

/** Owns only the console/broker it creates. Existing Ollama services never enter this class. */
export class OllamaProcess {
  private root: string;
  private signal: AbortSignal;
  private active?: Run;
  private starting?: Promise<void>;
  private stopping?: Promise<void>;
  private closed = false;
  private generation = 0;
  private onAbort: () => void;

  constructor(root: string, signal: AbortSignal) {
    this.root = resolve(root);
    this.signal = signal;
    this.onAbort = () => { void this.close().catch(() => {}); };
    signal.addEventListener('abort', this.onAbort, { once: true });
  }

  running(): boolean { return !!this.active?.started && !this.active.done; }
  owned(): boolean { return !!this.active && !this.active.done; }

  start(executable: string, models: string): Promise<void> {
    if (this.closed || this.signal.aborted) return Promise.reject(Error('本地 Ollama 管理器已停止。'));
    if (this.stopping) return Promise.reject(Error('本地 Ollama 正在停止，请稍后重试。'));
    if (this.starting) return this.starting;
    if (this.running()) return Promise.resolve();
    if (this.active && !this.active.done) return Promise.reject(Error('本地 Ollama 旧控制台尚未确认退出。'));
    const work = this.startInternal(executable, models);
    this.starting = work;
    void work.finally(() => { if (this.starting === work) this.starting = undefined; }).catch(() => {});
    return work;
  }

  private async startInternal(executable: string, models: string): Promise<void> {
    const generation = this.generation;
    const cancelled = () => { if (this.closed || generation !== this.generation) throw Error('本地 Ollama 启动已取消。'); };
    if (process.platform !== 'win32') throw Error('一键启动目前仅支持 Windows。');
    if (![executable, models].every(value => isAbsolute(value) && !/[\0\r\n"]/u.test(value)))
      throw Error('本地 Ollama 路径无效。');
    if (normalized(models) !== normalized(join(this.root, 'models'))) throw Error('本地 Ollama 模型必须使用插件自有目录。');
    await safeDirectory(this.root, true);
    await safeDirectory(models, true);
    await safeFile(executable, false);
    await safeFile(join(this.root, 'console-run.json'), true);
    cancelled();
    await portAvailable();
    this.signal.throwIfAborted();
    cancelled();
    const token = randomBytes(32).toString('hex');
    const pipe = `\\\\.\\pipe\\whalelife-vision-ollama-${randomBytes(16).toString('hex')}`;
    let accept!: () => void, reject!: (error: Error) => void, finish!: () => void;
    const ready = new Promise<void>((yes, no) => { accept = yes; reject = no; });
    // A close/abort can arrive before startInternal awaits ready.
    void ready.catch(() => {});
    const exited = new Promise<void>(yes => { finish = yes; });
    const run: Run = { server: createServer(), sockets: new Set(), ready, accept, reject, exited, finish,
      stopping: false, started: false, done: false, authorized: false, consoleExited: false, brokerStopped: false, supervisorExited: false };
    this.active = run;
    let recordTail = Promise.resolve();
    let recordDetails: Record<string, unknown> = {};
    const record = (state: string, extra: Record<string, unknown> = {}) => {
      recordDetails = { ...recordDetails, ...extra };
      const value = JSON.stringify({ state, createdAt: new Date().toISOString(), launcherPid: run.console?.pid, ...recordDetails }) + '\n';
      const work = recordTail.then(() => safeRecord(this.root, value));
      recordTail = work.catch(() => {});
      return work;
    };
    const done = () => {
      if (run.done) return;
      run.done = true;
      run.stopping = true;
      run.reject(Error('本地 Ollama 控制台已退出。'));
      for (const socket of run.sockets) socket.destroy();
      run.server.close();
      if (this.active === run) this.active = undefined;
      run.finish();
      void record('stopped').catch(() => {});
    };
    const tryDone = () => {
      if (run.consoleExited && (!run.authorized || run.brokerStopped) && (!run.supervisor || run.supervisorExited)) done();
    };
    const requestStop = () => {
      run.stopping = true;
      run.started = false;
      for (const socket of [run.socket, run.supervisorSocket, run.helperSocket])
        if (socket && !socket.destroyed && socket.writable) socket.write(JSON.stringify({ type: 'stop' }) + '\n');
    };
    const launchSupervisor = () => {
      const env: NodeJS.ProcessEnv = { ...process.env, WL_OLLAMA_PIPE: pipe, WL_OLLAMA_TOKEN: token, WL_OLLAMA_MODE: 'supervisor' };
      delete env.NODE_OPTIONS;
      run.supervisor = spawn(process.execPath, [fileURLToPath(new URL('./ollama-console.mjs', import.meta.url))],
        { cwd: this.root, env, windowsHide: true, stdio: 'ignore' });
      run.supervisor.once('error', () => { run.reject(Error('本地 Ollama 管理进程无法启动。')); requestStop(); });
      run.supervisor.once('close', () => { run.supervisorExited = true; requestStop(); tryDone(); });
    };
    // Closing between listen() and its next-tick 'listening' event emits only
    // 'close' in Node. There is no console to wait for in that startup phase.
    run.server.on('close', () => { if (!run.console) done(); });
    run.server.on('connection', socket => {
      if (run.done || run.sockets.size >= 6) { socket.destroy(); return; }
      run.sockets.add(socket);
      let data = '', authenticated = false, role: 'broker' | 'helper' | 'supervisor' = 'broker';
      const authTimer = setTimeout(() => socket.destroy(), 3_000);
      socket.on('error', () => {});
      socket.on('close', () => {
        run.sockets.delete(socket);
        clearTimeout(authTimer);
        if (authenticated && !run.done) {
          run.reject(Error('本地 Ollama 控制台连接已断开。'));
          requestStop();
        }
      });
      socket.on('data', chunk => {
        data += chunk.toString('utf8');
        let end: number;
        while ((end = data.indexOf('\n')) >= 0) {
          const line = data.slice(0, end); data = data.slice(end + 1);
          if (line.length > 16_384) { socket.destroy(); return; }
          let value: Record<string, unknown>;
          try { value = JSON.parse(line); } catch { socket.destroy(); return; }
          if (!value || typeof value !== 'object' || Array.isArray(value)) { socket.destroy(); return; }
          if (!authenticated) {
            if (value.type !== 'hello' || value.token !== token || !Number.isSafeInteger(value.pid)) { socket.destroy(); return; }
            if (value.role === 'helper') role = 'helper';
            else if (value.role === 'supervisor') role = 'supervisor';
            else if (value.role !== undefined && value.role !== 'broker') { socket.destroy(); return; }
            if (role === 'helper' ? !!run.helperSocket : role === 'supervisor' ? !!run.supervisorSocket : !!run.socket) { socket.destroy(); return; }
            authenticated = true;
            clearTimeout(authTimer);
            if (role === 'helper') {
              run.helperSocket = socket;
              socket.write(JSON.stringify({ type: run.stopping || this.closed || this.signal.aborted ? 'stop' : 'helper-ack' }) + '\n');
              void record('starting', { helperPid: value.pid }).catch(() => {});
              continue;
            }
            if (role === 'supervisor') {
              run.supervisorSocket = socket;
              if (run.stopping || this.closed || this.signal.aborted) { socket.write(JSON.stringify({ type: 'stop' }) + '\n'); continue; }
              run.authorized = true;
              socket.write(JSON.stringify({ type: 'start', executable, models, root: this.root }) + '\n');
              void record('starting', { supervisorPid: value.pid }).catch(() => {});
              continue;
            }
            run.socket = socket;
            if (run.stopping || this.closed || this.signal.aborted) { socket.end(JSON.stringify({ type: 'stop' }) + '\n'); return; }
            socket.write(JSON.stringify({ type: 'start' }) + '\n');
            launchSupervisor();
            void record('starting', { brokerPid: value.pid }).catch(() => {});
          } else if (value.type === 'ping') {
            socket.write(JSON.stringify({ type: run.stopping ? 'stop' : 'pong' }) + '\n');
          } else if (role === 'helper' && value.type === 'helper-started' && Number.isSafeInteger(value.pid)) {
            if (run.stopping) { socket.write(JSON.stringify({ type: 'stop' }) + '\n'); continue; }
            run.started = true;
            void record('running', { serverPid: value.pid }).catch(() => {});
            run.accept();
          } else if (value.type === 'error') {
            run.reject(Error('本地 Ollama 可见控制台启动失败。'));
          } else if (role === 'supervisor' && value.type === 'output' && typeof value.text === 'string' && value.text.length <= 1_000) {
            if (run.socket && !run.socket.destroyed && run.socket.writableLength < 65_536)
              run.socket.write(JSON.stringify({ type: 'output', text: value.text }) + '\n');
          } else if ((role === 'helper' && value.type === 'helper-stopped') ||
            (role === 'supervisor' && value.type === 'stopped' && value.noHelper === true && !run.helperSocket)) {
            run.stopping = true;
            run.brokerStopped = true;
            tryDone();
          }
        }
        if (data.length > 16_384) socket.destroy();
      });
    });
    try {
      await new Promise<void>((yes, no) => {
        let settled = false;
        const settle = (error?: Error) => {
          if (settled) return;
          settled = true;
          run.server.off('error', onError);
          run.server.off('listening', onListening);
          run.server.off('close', onClose);
          this.signal.removeEventListener('abort', onAbort);
          if (error) no(error); else yes();
        };
        const onError = (error: Error) => settle(error);
        const onListening = () => settle();
        const onClose = () => settle(Error('本地 Ollama 启动控制通道已关闭。'));
        const onAbort = () => {
          run.stopping = true;
          run.server.close();
          settle(Error('本地 Ollama 启动已取消。'));
        };
        run.server.once('error', onError);
        run.server.once('listening', onListening);
        run.server.once('close', onClose);
        this.signal.addEventListener('abort', onAbort, { once: true });
        if (this.signal.aborted || this.closed || run.stopping) { onAbort(); return; }
        try { run.server.listen(pipe); } catch (error) { settle(error as Error); }
      });
      run.server.on('error', () => { run.reject(Error('本地 Ollama 控制通道失败。')); run.socket?.destroy(); });
      this.signal.throwIfAborted();
      if (this.closed || run.stopping) throw Error('本地 Ollama 启动已取消。');
      await safeDirectory(this.root, false);
      await safeDirectory(models, false);
      await safeFile(executable, false);
      await safeFile(join(this.root, 'console-run.json'), true);
      this.signal.throwIfAborted();
      if (this.closed || run.stopping) throw Error('本地 Ollama 启动已取消。');
      // Only fixed shell syntax is used. Paths are environment values, never shell fragments.
      // CON redirection is necessary when a plugin worker inherited piped/no console handles.
      const env: NodeJS.ProcessEnv = { ...process.env, WL_OLLAMA_NODE: process.execPath,
        WL_OLLAMA_BROKER: fileURLToPath(new URL('./ollama-console.mjs', import.meta.url)),
        WL_OLLAMA_PIPE: pipe, WL_OLLAMA_TOKEN: token, WL_OLLAMA_MODE: 'broker' };
      delete env.NODE_OPTIONS;
      const command = '$p=Start-Process -FilePath "$env:SystemRoot\\System32\\cmd.exe" -ArgumentList @("/d","/v:off","/s","/c",\'"title WhaleLife - Local Ollama & "%WL_OLLAMA_NODE%" "%WL_OLLAMA_BROKER%" < CON > CON 2>&1"\') -WindowStyle Normal -PassThru -Wait; exit $p.ExitCode';
      run.console = spawn(join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
        ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(command, 'utf16le').toString('base64')],
        { cwd: this.root, env, windowsHide: true, stdio: 'ignore' });
      run.console.once('error', () => { run.reject(Error('无法打开本地 Ollama 的 CMD 窗口。')); done(); });
      run.console.once('exit', () => {
        run.consoleExited = true;
        run.reject(Error('本地 Ollama 控制台已退出。'));
        requestStop();
        tryDone();
      });
      await record('launching');
      await deadline(ready, 20_000, '本地 Ollama 控制台启动超时。');
    } catch (error) {
      requestStop();
      if (!run.console) run.server.close();
      if (!run.console?.pid) done();
      await deadline(exited, 10_000, '本地 Ollama 控制台尚未退出。').catch(() => {});
      throw error;
    }
  }

  stop(): Promise<void> {
    this.generation++;
    if (this.stopping) return this.stopping;
    const run = this.active;
    if (!run) return this.starting?.then(() => {}, () => {}) ?? Promise.resolve();
    run.stopping = true;
    run.started = false;
    run.reject(Error('本地 Ollama 启动已取消。'));
    if (run.socket && !run.socket.destroyed) run.socket.write(JSON.stringify({ type: 'stop' }) + '\n');
    if (run.helperSocket && !run.helperSocket.destroyed) run.helperSocket.write(JSON.stringify({ type: 'stop' }) + '\n');
    if (run.supervisorSocket && !run.supervisorSocket.destroyed) run.supervisorSocket.write(JSON.stringify({ type: 'stop' }) + '\n');
    // An already spawned helper may still be authenticating; let it connect,
    // receive stop, and explicitly confirm that it never created a job.
    if (!run.console) for (const socket of run.sockets) socket.destroy();
    if (!run.console) run.server.close();
    const work = deadline(run.exited, 12_000, '本地 Ollama 控制台未确认退出，请检查其 CMD 窗口。');
    this.stopping = work;
    void work.finally(() => { if (this.stopping === work) this.stopping = undefined; }).catch(() => {});
    return work;
  }

  async close(): Promise<void> {
    this.closed = true;
    this.signal.removeEventListener('abort', this.onAbort);
    await this.stop();
  }
}

function normalized(path: string): string { return resolve(path).toLowerCase(); }

/** Walk every ancestor; a junction anywhere on the route is not an owned directory. */
async function safeDirectory(path: string, create: boolean): Promise<void> {
  const target = resolve(path), volume = parse(target).root;
  let current = volume;
  for (const part of ['', ...relative(volume, target).split(/[\\/]/u).filter(Boolean)]) {
    if (part) current = join(current, part);
    let info;
    try { info = await lstat(current); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || !create) throw Error('本地 Ollama 目录不存在或无法访问。');
      try { await mkdir(current); } catch (cause) { if ((cause as NodeJS.ErrnoException).code !== 'EEXIST') throw cause; }
      info = await lstat(current);
    }
    if (!info.isDirectory() || info.isSymbolicLink() || normalized(await realpath(current)) !== normalized(current))
      throw Error('本地 Ollama 目录包含链接或重定向，已拒绝启动。');
  }
}

async function safeFile(path: string, optional: boolean): Promise<void> {
  let info;
  try { info = await lstat(path); }
  catch (error) { if (optional && (error as NodeJS.ErrnoException).code === 'ENOENT') return; throw Error('本地 Ollama 文件不存在或无法访问。'); }
  if (!info.isFile() || info.isSymbolicLink() || normalized(await realpath(path)) !== normalized(path))
    throw Error('本地 Ollama 文件包含链接或重定向，已拒绝启动。');
}

async function safeRecord(root: string, value: string): Promise<void> {
  await safeDirectory(root, false);
  const path = join(root, 'console-run.json');
  await safeFile(path, true);
  const temporary = join(root, `.console-run-${randomBytes(12).toString('hex')}.tmp`);
  try {
    await writeFile(temporary, value, { flag: 'wx' });
    await safeDirectory(root, false);
    await safeFile(path, true);
    await rename(temporary, path);
  } finally { await unlink(temporary).catch(() => {}); }
}

function portAvailable(): Promise<void> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', () => reject(Error('本机端口 11435 已被占用；请检测已有服务。')));
    server.listen({ host: '127.0.0.1', port: 11435, exclusive: true }, () => server.close(error => error ? reject(error) : resolve()));
  });
}

async function deadline<T>(work: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([work, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(Error(message)), ms); })]); }
  finally { clearTimeout(timer); }
}
