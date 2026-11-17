/*! Copyright (c) 2026 iinukami and contributors.
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7: see LICENSE-ADDITIONAL.
 */
// This standalone child is deliberately outside the host/plugin runtime.
import { connect } from 'node:net';
import { spawn } from 'node:child_process';
import { join, isAbsolute } from 'node:path';

const pipe = process.env.WL_OLLAMA_PIPE, token = process.env.WL_OLLAMA_TOKEN;
const supervisor = process.env.WL_OLLAMA_MODE === 'supervisor';
if (!pipe?.startsWith('\\\\.\\pipe\\whalelife-vision-ollama-') || !/^[0-9a-f]{64}$/.test(token ?? '')) throw Error('Missing local control channel');
const socket = connect(pipe);
if (!supervisor) process.title = 'WhaleLife - Local Ollama';
let helper, closing = false, finished = false, buffer = '', lastPong = Date.now(), configured = false;
const send = value => { if (!socket.destroyed && socket.writable) socket.write(JSON.stringify(value) + '\n'); };
const watchdog = setInterval(() => {
  if (!supervisor) process.title = 'WhaleLife - Local Ollama';
  if (Date.now() - lastPong > 6_000) { stop(); return; }
  send({ type: 'ping' });
  if (helper?.stdin.writable) helper.stdin.write('alive\n');
}, 1_000);
const finish = (confirmed = true) => {
  if (finished) return;
  finished = true;
  clearInterval(watchdog);
  send(confirmed ? { type: 'stopped', noHelper: !helper?.pid } : { type: 'error' });
  socket.end();
  setTimeout(() => socket.destroy(), 200).unref();
};
function stop() {
  if (closing) return;
  closing = true;
  if (helper?.stdin.writable) helper.stdin.end('stop\n');
  else if (!helper) finish();
}
socket.on('connect', () => send({ type: 'hello', role: supervisor ? 'supervisor' : 'broker', token, pid: process.pid }));
socket.on('error', stop);
socket.on('close', stop);
socket.on('data', chunk => {
  buffer += chunk.toString('utf8');
  let end;
  while ((end = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
    if (line.length > 16_384) { stop(); return; }
    let value;
    try { value = JSON.parse(line); } catch { stop(); return; }
    if (!value || typeof value !== 'object' || Array.isArray(value)) { stop(); return; }
    lastPong = Date.now();
    if (value.type === 'stop') { stop(); return; }
    if (!supervisor && value.type === 'output' && typeof value.text === 'string' && value.text.length <= 1_000) process.stdout.write(value.text);
    if (value.type === 'start' && !configured && !closing) {
      configured = true;
      if (!supervisor) continue;
      if (![value.executable, value.models, value.root].every(p => typeof p === 'string' && isAbsolute(p) && !/[\0\r\n"]/u.test(p))) { stop(); return; }
      launch(value);
    }
  }
  if (buffer.length > 16_384) stop();
});
process.on('SIGINT', stop);
process.on('SIGTERM', stop);

function launch(config) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (/^(OLLAMA_|WL_OLLAMA_|NODE_OPTIONS$)/i.test(key)) delete env[key];
  Object.assign(env, { OLLAMA_HOST: '127.0.0.1:11435', OLLAMA_MODELS: config.models,
    OLLAMA_NO_CLOUD: '1', OLLAMA_NUM_PARALLEL: '1', OLLAMA_MAX_LOADED_MODELS: '1', OLLAMA_CONTEXT_LENGTH: '8192',
    WL_OLLAMA_EXE: config.executable, WL_OLLAMA_ROOT: config.root,
    WL_OLLAMA_CONTROL_PIPE: pipe, WL_OLLAMA_CONTROL_TOKEN: token });
  // A Windows Job Object owns server AND runner descendants. The helper holds its
  // non-inheritable handle; stdin EOF, a missed heartbeat, or helper death closes it.
  const script = `$ErrorActionPreference='Stop'\nAdd-Type -TypeDefinition @'\n${jobSource}\n'@\n[WhaleLifeOwnedOllama]::Run($env:WL_OLLAMA_EXE,$env:WL_OLLAMA_ROOT,$env:WL_OLLAMA_CONTROL_PIPE,$env:WL_OLLAMA_CONTROL_TOKEN)\n`;
  helper = spawn(join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
    { shell: false, windowsHide: true, env, cwd: config.root, stdio: ['pipe', 'pipe', 'pipe'] });
  helper.stdin.on('error', () => {});
  let output = '', announced = false, jobStopped = false;
  const log = chunk => { const text = chunk.toString('utf8'); for (let i = 0; i < text.length; i += 1_000) send({ type: 'output', text: text.slice(i, i + 1_000) }); };
  helper.stderr.on('data', log);
  helper.stdout.on('data', chunk => {
    log(chunk);
    output += chunk.toString('utf8');
    if (!announced && output.length > 16_384) { stop(); return; }
    const match = /(?:^|\r?\n)WHALELIFE_OWNED_PID=(\d+)\r?\n/.exec(output);
    if (!announced && match) { announced = true; send({ type: 'started', pid: Number(match[1]) }); }
    if (/(?:^|\r?\n)WHALELIFE_OWNED_STOPPED\r?\n/.test(output)) jobStopped = true;
    if (announced) output = output.slice(-1_024);
  });
  helper.once('error', () => { send({ type: 'error' }); finish(); });
  helper.once('close', code => { if (!closing && code !== 0) send({ type: 'error' }); finish(jobStopped); });
  if (closing) helper.stdin.end('stop\n');
}

const jobSource = String.raw`
using System;
using System.Text;
using System.IO;
using System.IO.Pipes;
using System.Threading.Tasks;
using System.Diagnostics;
using System.Runtime.InteropServices;
public static class WhaleLifeOwnedOllama {
  [StructLayout(LayoutKind.Sequential)] struct IO_COUNTERS { public ulong A,B,C,D,E,F; }
  [StructLayout(LayoutKind.Sequential)] struct BASIC_LIMIT { public long A,B; public uint Flags; public UIntPtr Min,Max; public uint Active; public UIntPtr Affinity; public uint Priority,Scheduling; }
  [StructLayout(LayoutKind.Sequential)] struct EXTENDED_LIMIT { public BASIC_LIMIT Basic; public IO_COUNTERS Io; public UIntPtr ProcessMemory,JobMemory,PeakProcess,PeakJob; }
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] struct STARTUPINFO { public uint cb; public string reserved,desktop,title; public uint x,y,xsize,ysize,xchars,ychars,fill,flags; public ushort show,reserved2; public IntPtr data,input,output,error; }
  [StructLayout(LayoutKind.Sequential)] struct PROCESS_INFORMATION { public IntPtr process,thread; public uint pid,tid; }
  [StructLayout(LayoutKind.Sequential)] struct BASIC_ACCOUNTING { public long User,Kernel,PeriodUser,PeriodKernel; public uint Faults,Total,Active,Terminated; }
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern IntPtr CreateJobObject(IntPtr attributes,string name);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool SetInformationJobObject(IntPtr job,int kind,ref EXTENDED_LIMIT info,uint size);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool AssignProcessToJobObject(IntPtr job,IntPtr process);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool TerminateJobObject(IntPtr job,uint code);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool QueryInformationJobObject(IntPtr job,int kind,out BASIC_ACCOUNTING info,uint size,IntPtr returned);
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool CreateProcess(string application,StringBuilder command,IntPtr pa,IntPtr ta,bool inherit,uint flags,IntPtr environment,string cwd,ref STARTUPINFO si,out PROCESS_INFORMATION pi);
  [DllImport("kernel32.dll",SetLastError=true)] static extern uint ResumeThread(IntPtr thread);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool TerminateProcess(IntPtr process,uint code);
  [DllImport("kernel32.dll")] static extern uint WaitForSingleObject(IntPtr handle,uint timeout);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
  public static void Run(string executable,string root,string pipe,string token) {
    IntPtr job=IntPtr.Zero; PROCESS_INFORMATION pi=new PROCESS_INFORMATION();
    NamedPipeClientStream control=null; StreamReader reader=null; StreamWriter writer=null;
    try {
      control=new NamedPipeClientStream(".",pipe.Substring(9),PipeDirection.InOut,PipeOptions.Asynchronous);
      control.Connect(3000);
      reader=new StreamReader(control,new UTF8Encoding(false));
      writer=new StreamWriter(control,new UTF8Encoding(false)); writer.AutoFlush=true;
      writer.WriteLine("{\"type\":\"hello\",\"role\":\"helper\",\"token\":\""+token+"\",\"pid\":"+Process.GetCurrentProcess().Id+"}");
      var acknowledgement=reader.ReadLineAsync();
      if(!acknowledgement.Wait(3000)) throw new Exception("Local control handshake timed out");
      if(acknowledgement.Result!="{\"type\":\"helper-ack\"}") return;
      job=CreateJobObject(IntPtr.Zero,null);
      if(job==IntPtr.Zero) throw new Exception("Cannot create owned process job");
      EXTENDED_LIMIT limit=new EXTENDED_LIMIT(); limit.Basic.Flags=0x2000;
      if(!SetInformationJobObject(job,9,ref limit,(uint)Marshal.SizeOf(limit))) throw new Exception("Cannot secure owned process job");
      STARTUPINFO si=new STARTUPINFO(); si.cb=(uint)Marshal.SizeOf(si);
      if(!CreateProcess(executable,new StringBuilder("\""+executable+"\" serve"),IntPtr.Zero,IntPtr.Zero,true,4,IntPtr.Zero,root,ref si,out pi)) throw new Exception("Cannot start local Ollama");
      if(!AssignProcessToJobObject(job,pi.process)) { TerminateProcess(pi.process,1); throw new Exception("Cannot own local Ollama process"); }
      Console.WriteLine("WHALELIFE_OWNED_PID="+pi.pid); Console.Out.Flush();
      if(ResumeThread(pi.thread)==0xffffffff) throw new Exception("Cannot resume local Ollama");
      writer.WriteLine("{\"type\":\"helper-started\",\"pid\":"+pi.pid+"}");
      var input=Console.In.ReadLineAsync();
      var message=reader.ReadLineAsync();
      while(WaitForSingleObject(pi.process,0)!=0) {
        var index=Task.WaitAny(new Task[]{input,message},6000);
        if(index<0) break;
        if(index==0) {
          if(input.Result!="alive") break;
          input=Console.In.ReadLineAsync();
          writer.WriteLine("{\"type\":\"ping\"}");
        } else {
          if(message.Result!="{\"type\":\"pong\"}") break;
          message=reader.ReadLineAsync();
        }
      }
    } finally {
      try {
        if(job!=IntPtr.Zero) {
          if(!TerminateJobObject(job,0)) throw new Exception("Cannot stop owned process job");
          var limit=DateTime.UtcNow.AddSeconds(4);
          BASIC_ACCOUNTING accounting;
          while(true) {
            if(!QueryInformationJobObject(job,1,out accounting,(uint)Marshal.SizeOf(typeof(BASIC_ACCOUNTING)),IntPtr.Zero)) throw new Exception("Cannot confirm owned process job cleanup");
            if(accounting.Active==0) break;
            if(DateTime.UtcNow>=limit) throw new Exception("Owned process job cleanup timed out");
            System.Threading.Thread.Sleep(20);
          }
          // Assignment can fail while the new server is still suspended and
          // outside the job; its TerminateProcess must also be confirmed.
          if(pi.process!=IntPtr.Zero && WaitForSingleObject(pi.process,4000)!=0) throw new Exception("Cannot confirm owned server cleanup");
        }
        if(writer!=null) writer.WriteLine("{\"type\":\"helper-stopped\"}");
        try { Console.WriteLine("WHALELIFE_OWNED_STOPPED"); Console.Out.Flush(); } catch(IOException) {}
      } finally {
        if(job!=IntPtr.Zero) CloseHandle(job);
        if(pi.process!=IntPtr.Zero) CloseHandle(pi.process);
        if(pi.thread!=IntPtr.Zero) CloseHandle(pi.thread);
        if(control!=null) control.Dispose();
      }
    }
  }
}
`;
