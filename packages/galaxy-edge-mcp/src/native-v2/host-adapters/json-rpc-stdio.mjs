import { spawn } from 'node:child_process';
import { isAbsolute } from 'node:path';
import {nativeDiagnostics} from '../diagnostics.mjs';

// Only an explicitly selected executable is launched. No shell interpolation,
// credential persistence, daemon installation, or stderr/body logging.
export function createJsonRpcStdio({ command, args = [], cwd, spawnProcess = spawn,
  requestTimeoutMs = 30000, closeTimeoutMs = 2000, maxFrameBytes = 1024 * 1024 } = {}) {
  const diagnostics=nativeDiagnostics('host-client');
  if (typeof command !== 'string' || !isAbsolute(command) || !Array.isArray(args) || args.some(x => typeof x !== 'string'))
    throw new Error('host_executable_required');
  if (![requestTimeoutMs, closeTimeoutMs, maxFrameBytes].every(value => Number.isSafeInteger(value) && value > 0))
    throw new Error('host_timeout_invalid');
  let child, exitDone, processExited = false, buffer = '', sequence = 0, closed = false, closing,startedAt;
  const pending = new Map(), listeners = new Set(), disconnects = new Set();
  function fail(error) {
    if (closed) return;
    const normal=!!closing||error?.message==='host_closed';
    diagnostics.emit({event:'host_process',stage:'host-process',outcome:normal?'stopped':'failed',...(normal?{}:{error})});
    closed = true;
    for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(error); }
    pending.clear();
    for (const listener of disconnects) listener(error);
  }
  function send(message) {
    if (closed || closing || !child?.stdin?.writable) throw new Error('host_disconnected');
    const frame=JSON.stringify(message)+'\n';if(Buffer.byteLength(frame)>maxFrameBytes)throw Error('host_frame_too_large');
    child.stdin.write(frame);
  }
  function start() {
    if (child) return;
    if (closed) throw new Error('host_disconnected');
    startedAt=performance.now();
    diagnostics.emit({event:'host_process',stage:'host-process',outcome:'started'});
    try{child = spawnProcess(command, args, { cwd, stdio: ['pipe', 'pipe', 'pipe'], shell: false, windowsHide: true });}
    catch(error){diagnostics.emit({event:'host_process',stage:'host-process',outcome:'failed',error,durationMs:performance.now()-startedAt});throw error;}
    child.stderr?.on('data', () => {});
    child.on('error', error => {diagnostics.emit({event:'host_process',stage:'host-process',outcome:'failed',error});fail(new Error('host_process_failed'));});
    exitDone = new Promise(resolveExit => child.once('close', () => { processExited = true; resolveExit(); }));
    child.on('close', code => {diagnostics.emit({event:'host_process',stage:'host-process',outcome:closing?'stopped':code===0?'succeeded':'failed',exitCode:code,durationMs:performance.now()-startedAt});fail(new Error('host_disconnected'));});
    child.stdin.on('error', () => fail(new Error('host_disconnected')));
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      buffer += chunk;
      while (buffer.includes('\n')) {
        const split = buffer.indexOf('\n'), line = buffer.slice(0, split); buffer = buffer.slice(split + 1);
        if (Buffer.byteLength(line) > maxFrameBytes) { fail(new Error('host_frame_too_large')); child.kill(); return; }
        if (!line.trim()) continue;
        let message;
        try { message = JSON.parse(line); } catch { fail(new Error('host_protocol_invalid')); child.kill(); return; }
        if (!message || typeof message !== 'object' || Array.isArray(message)) { fail(new Error('host_protocol_invalid')); child.kill(); return; }
        if (message.id !== undefined && !message.method) {
          const entry = pending.get(message.id); if (!entry) continue;
          pending.delete(message.id); clearTimeout(entry.timer);
          if (message.error) entry.reject(new Error('host_rpc_failed')); else entry.resolve(message.result);
        } else if (message.method && message.id !== undefined) {
          // An unattended room reader never approves tools, permissions or
          // downstream elicitation. No host request can expand Galaxy scope.
          // During shutdown stdin is already draining; a late request must
          // neither reopen it nor throw outside the protocol failure path.
          if (!closed && !closing) {
            try { send({ id: message.id, error: { code: -32601, message: 'Not available in this scoped reader' } }); }
            catch { fail(new Error('host_disconnected')); child.kill(); return; }
          }
        } else for (const listener of listeners) listener(message);
      }
      if (Buffer.byteLength(buffer) > maxFrameBytes) { fail(new Error('host_frame_too_large')); child.kill(); }
    });
  }
  function request(method, params = {}) {
    return diagnostics.scope(()=>{
    if (closed || closing) return Promise.reject(new Error('host_disconnected'));
    try{start();}catch(error){diagnostics.emit({event:'host_rpc',stage:'host-rpc',outcome:'failed',method,error});return Promise.reject(error);}
    const id = ++sequence;
    const response=new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(id); reject(new Error('host_rpc_unknown')); }, requestTimeoutMs);
      pending.set(id, { resolve, reject, timer });
      try { send({ id, method, params }); } catch (error) { pending.delete(id); clearTimeout(timer); reject(error); }
    });
    return diagnostics.run('host-rpc',()=>response,{event:'host_rpc',method});
    });
  }
  function close() {
    return closing ??= Promise.resolve().then(async () => {
      if (!child) { fail(new Error('host_closed')); return; }
      if (processExited) { fail(new Error('host_closed')); return; }
      child.stdin.end();
      let timer;
      await Promise.race([exitDone, new Promise(resolve => { timer = setTimeout(resolve, closeTimeoutMs); })]);
      clearTimeout(timer);
      if (!processExited) {
        child.kill();
        await Promise.race([exitDone, new Promise(resolve => { timer = setTimeout(resolve, closeTimeoutMs); })]);
        clearTimeout(timer);
      }
      fail(new Error('host_closed'));
      if (!processExited) throw new Error('host_process_shutdown_unconfirmed');
    });
  }
  return Object.freeze({ request, notify: (method, params = {}) => send({ method, params }),
    subscribe: listener => { listeners.add(listener); return () => listeners.delete(listener); },
    onDisconnect: listener => { disconnects.add(listener); return () => disconnects.delete(listener); }, close });
}
