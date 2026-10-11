import {spawn} from 'node:child_process';
import {isAbsolute, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {access} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';

const helperPath = fileURLToPath(new URL('./windows-notify-icon.ps1', import.meta.url));
const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
const unconfirmed = reason => ({state: 'unknown', reason, displayed: false, humanReadChanged: false});

// command is trusted installation configuration, never a tool/model input.
// The bundled fixed helper only receives a mode and count through stdin.
export function createWindowsNotificationChannel({
  command = process.env.SystemRoot ? join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe') : null,
  platform = process.platform,
  spawnProcess = spawn,
  checkExecutable = access,
  timeoutMs = 18000,
} = {}) {
  if (command !== null && !isAbsolute(command)) throw Error('notification_command_must_be_absolute');
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30000) throw Error('notification_timeout_invalid');
  const entries = new Map();
  let disposed = false, closing;
  function open(mode, {promptId = randomUUID(), eventCount = 1, testOnly = false, signal, isCurrent = () => true, onClicked, onClosed} = {}) {
    if (disposed) return Promise.resolve({state: 'unavailable', reason: 'notification_channel_closed', displayed: false});
    if (mode === 'show' && (!uuid(promptId) || !Number.isInteger(eventCount) || eventCount < 1 || eventCount > 20)) throw Error('notification_prompt_invalid');
    if (mode === 'show' && entries.has(promptId)) return entries.get(promptId).result;
    let resolveResult, resolveExit;
    const result = new Promise(resolve => { resolveResult = resolve; });
    const exit = new Promise(resolve => { resolveExit = resolve; });
    const entry = {promptId, result, exit, child: null, timer: null, closing: null, done: false, cleaned: false, displayed: false, accepted: false, buffer: '', bytes: 0};
    entries.set(promptId, entry);
    const finish = value => { if (!entry.done) { entry.done = true; resolveResult(value); } };
    const current = () => !disposed && !signal?.aborted && isCurrent() === true;
    const abort = () => {
      finish(entry.displayed ? {state: 'shown', displayed: true, evidence: 'BalloonTipShown', promptId, humanReadChanged: false} : unconfirmed('notification_cancelled'));
      void stop(entry).catch(() => {});
    };
    const cleanup = () => {
      if (entry.cleaned) return; entry.cleaned = true;
      clearTimeout(entry.timer); signal?.removeEventListener('abort', abort); entries.delete(promptId); resolveExit();
      finish(unconfirmed(entry.accepted ? 'notification_display_unconfirmed' : 'notification_process_closed'));
      if (typeof onClosed === 'function') Promise.resolve().then(() => onClosed({promptId, ownedProcessClosed: true})).catch(() => {});
    };
    entry.abort = abort;
    void Promise.resolve().then(async () => {
      if (platform !== 'win32' || !command) { finish({state: 'unavailable', reason: 'windows_channel_not_available', displayed: false}); cleanup(); return; }
      await checkExecutable(command);
      if (!current()) { finish(unconfirmed('notification_cancelled')); cleanup(); return; }
      entry.child = spawnProcess(command, ['-NoLogo', '-NoProfile', '-NonInteractive', '-STA', '-WindowStyle', 'Hidden', '-File', helperPath],
        {shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe']});
      entry.child.stdin.on('error', () => {});
      // Do not retain stderr or child exception messages.
      entry.child.stderr.resume();
      entry.child.stdout.setEncoding('utf8');
      entry.child.stdout.on('data', chunk => {
        entry.bytes += Buffer.byteLength(chunk);
        if (entry.bytes > 8192) { finish(unconfirmed('notification_protocol_invalid')); void stop(entry).catch(() => {}); return; }
        entry.buffer += chunk;
        while (entry.buffer.includes('\n')) {
          const index = entry.buffer.indexOf('\n'), line = entry.buffer.slice(0, index).trim();
          entry.buffer = entry.buffer.slice(index + 1);
          if (!line) continue;
          let event;
          try { event = JSON.parse(line); } catch { finish(unconfirmed('notification_protocol_invalid')); void stop(entry).catch(() => {}); return; }
          if (!event || Array.isArray(event) || typeof event !== 'object') { finish(unconfirmed('notification_protocol_invalid')); void stop(entry).catch(() => {}); return; }
          if (mode === 'probe' && event.event === 'capabilities' && event.available === true && event.channel === 'windows-notify-icon'
            && event.displayEvidence === 'BalloonTipShown' && event.permission === 'system-managed') {
            finish({available: true, channel: 'windows-notify-icon', displayEvidence: 'BalloonTipShown', permission: 'system-managed', processStarted: true});
          } else if (event.event === 'unavailable') {
            finish({state: 'unavailable', reason: 'windows_notification_unavailable', displayed: false});
          } else if (mode === 'show' && event.event === 'accepted') {
            entry.accepted = true;
          } else if (mode === 'show' && event.event === 'shown' && event.evidence === 'BalloonTipShown') {
            entry.displayed = true;
            finish({state: 'shown', displayed: true, evidence: 'BalloonTipShown', promptId, humanReadChanged: false});
            if (!current()) void stop(entry).catch(() => {});
          } else if (mode === 'show' && event.event === 'clicked') {
            if (entry.displayed && current() && typeof onClicked === 'function') Promise.resolve().then(() => onClicked({promptId, humanReadChanged: false})).catch(() => {});
          } else if (mode === 'show' && ['dismissed', 'closed'].includes(event.event)) {
            // Closing is not reading, nor proof that a previously unknown prompt appeared.
          } else { finish(unconfirmed('notification_protocol_invalid')); void stop(entry).catch(() => {}); return; }
        }
      });
      entry.child.once('error', () => { finish({state: 'unavailable', reason: 'notification_process_unavailable', displayed: false}); cleanup(); });
      entry.child.once('exit', cleanup);
      signal?.addEventListener('abort', abort, {once: true});
      entry.timer = setTimeout(() => { finish(unconfirmed('notification_display_unconfirmed')); void stop(entry).catch(() => {}); }, timeoutMs);
      if (!current()) { abort(); return; }
      entry.child.stdin.write(JSON.stringify({mode, ...(mode === 'show' ? {eventCount, testOnly: testOnly === true} : {})}) + '\n');
    }).catch(() => { finish({state: 'unavailable', reason: 'notification_process_unavailable', displayed: false}); if (entry.child) void stop(entry).catch(() => {}); else cleanup(); });
    return result;
  }
  function stop(entry) {
    return entry.closing ??= Promise.resolve().then(async () => {
      if (!entry.child) { await entry.result; return; }
      try { entry.child.stdin.write('close\n'); } catch { }
      let timer;
      await Promise.race([entry.exit, new Promise(resolve => { timer = setTimeout(resolve, 1500); })]); clearTimeout(timer);
      if (entries.has(entry.promptId)) {
        entry.child.kill();
        await Promise.race([entry.exit, new Promise(resolve => { timer = setTimeout(resolve, 500); })]); clearTimeout(timer);
      }
      if (entries.has(entry.promptId)) throw Error('notification_process_shutdown_unconfirmed');
    });
  }
  return Object.freeze({
    async capabilities() {
      if (disposed) return {available: false, reason: 'notification_channel_closed'};
      const value = await open('probe');
      return value.available === true ? value : {available: false, reason: value.reason ?? 'notification_capability_unconfirmed', permission: 'unknown'};
    },
    show({promptId, eventCount, testOnly = false}, options) { return open('show', {...options, promptId, eventCount, testOnly}); },
    async withdraw(promptId) {
      const entry = entries.get(promptId); if (entry) { entry.abort(); await stop(entry); }
      return {promptId, ownedProcessClosed: !entries.has(promptId), systemRecall: 'best-effort', humanReadChanged: false};
    },
    close() { return closing ??= Promise.resolve().then(async () => { disposed = true; const active = [...entries.values()]; for (const entry of active) entry.abort(); await Promise.all(active.map(stop)); }); },
  });
}
