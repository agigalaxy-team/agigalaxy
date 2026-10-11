import { spawn } from 'node:child_process';
import { access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { isAbsolute } from 'node:path';
import { randomUUID } from 'node:crypto';

const kind = 'macos-user-notifications', bundleId = 'org.galaxy.local-notifications';
const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value);
const unknown = reason => ({ state: 'unknown', reason, displayed: false, humanReadChanged: false, agentCursorChanged: false });

/** Trusted bundled helper only. Construction and unsupported platforms start
 * nothing. AppleScript display notification has no original-ID recall contract.
 * The helper's app permissions and notification acceptance are never a read ACK.
 */
export function createMacOSNotificationChannel({ command = null, platform = process.platform,
  spawnProcess = spawn, checkExecutable = path => access(path, constants.X_OK),
  timeoutMs = 28000, shutdownGraceMs = 1500 } = {}) {
  if (command !== null && (typeof command !== 'string' || !isAbsolute(command)
    || !/[/\\]GalaxyNotifications\.app[/\\]Contents[/\\]MacOS[/\\]GalaxyNotifications$/.test(command)))
    throw Error('notification_bundled_command_invalid');
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30000
    || !Number.isInteger(shutdownGraceMs) || shutdownGraceMs < 1 || shutdownGraceMs > 3000)
    throw Error('notification_timeout_invalid');
  const entries = new Map(); let disposed = false, closing;
  function open(mode, { promptId = randomUUID(), eventCount = 1, signal, isCurrent = () => true, onClosed } = {}) {
    if (disposed) return Promise.resolve({ state: 'unavailable', reason: 'notification_channel_closed', displayed: false });
    if (!['probe', 'show', 'permission'].includes(mode)) throw Error('notification_mode_invalid');
    if (mode === 'show' && (!uuid(promptId) || !Number.isInteger(eventCount) || eventCount < 1 || eventCount > 20))
      throw Error('notification_prompt_invalid');
    if (typeof isCurrent !== 'function') throw Error('notification_current_guard_invalid');
    if (entries.has(promptId)) return entries.get(promptId).result;
    if (entries.size >= 64) return Promise.resolve(unknown('notification_process_capacity'));
    let resolveResult, resolveExit;
    const result = new Promise(resolve => { resolveResult = resolve; }), exit = new Promise(resolve => { resolveExit = resolve; });
    const entry = { promptId, result, exit, child: null, done: false, cleaned: false, stopping: null,
      accepted: false, recallRequested: false, observedAbsence: false, buffer: '', bytes: 0, timer: null };
    // Reserve before executable inspection so concurrent waits cannot exceed 64.
    entries.set(promptId, entry);
    const current = () => { try { return !disposed && !entry.cleaned && !signal?.aborted && isCurrent() === true; } catch { return false; } };
    const finish = value => { if (!entry.done) { entry.done = true; resolveResult(value); } };
    const cleanup = () => {
      if (entry.cleaned) return; entry.cleaned = true; entries.delete(promptId);
      clearTimeout(entry.timer); signal?.removeEventListener('abort', abort); resolveExit();
      finish(unknown(entry.accepted ? 'notification_display_unconfirmed' : 'notification_process_closed'));
      if (typeof onClosed === 'function') Promise.resolve().then(() => onClosed({ promptId, ownedProcessClosed: true })).catch(() => {});
    };
    const abort = () => { finish(unknown('notification_cancelled')); void stop(entry).catch(() => {}); };
    entry.cleanup = cleanup; entry.abort = abort;
    entry.timer = setTimeout(() => { finish(unknown('notification_process_timeout')); void stop(entry).catch(() => {}); }, timeoutMs);
    signal?.addEventListener('abort', abort, { once: true });
    void Promise.resolve().then(async () => {
      if (platform !== 'darwin' || command === null) {
        finish({ state: 'unavailable', reason: platform !== 'darwin' ? 'macos_channel_not_available' : 'macos_bundled_helper_required', displayed: false });
        cleanup(); return;
      }
      await checkExecutable(command);
      if (!current()) { abort(); return; }
      entry.child = spawnProcess(command, ['--stdio-v1'], { shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
      entry.child.stdin.on('error', () => {}); entry.child.stderr.resume(); entry.child.stdout.setEncoding('utf8');
      const invalid = () => { finish(unknown('notification_protocol_invalid')); void stop(entry).catch(() => {}); };
      entry.child.stdout.on('data', chunk => {
        entry.bytes += Buffer.byteLength(chunk);
        if (entry.bytes > 8192) { invalid(); return; }
        entry.buffer += chunk;
        while (entry.buffer.includes('\n')) {
          const index = entry.buffer.indexOf('\n'), line = entry.buffer.slice(0, index).trim(); entry.buffer = entry.buffer.slice(index + 1);
          let event; try { event = JSON.parse(line); } catch { invalid(); return; }
          if (event?.version !== 1 || event.bundleId !== bundleId) { invalid(); return; }
          if (['probe', 'permission'].includes(mode) && event.event === 'capabilities'
            && typeof event.available === 'boolean' && ['authorized', 'denied', 'not-determined', 'unknown'].includes(event.permission)
            && event.channel === kind && event.displayEvidence === 'none' && event.recall === 'app-original-identifier'
            && (event.available === false || event.permission === 'authorized' && event.alertsEnabled === true)) {
            if (!current()) { abort(); continue; }
            finish({ available: event.available, channel: kind, permission: event.permission,
              alertsEnabled: event.alertsEnabled === true, displayEvidence: 'none', recall: event.recall,
              reason: event.available ? null : 'macos_notification_permission_required', processStarted: true });
          } else if (mode === 'show' && event.event === 'accepted' && !entry.accepted
            && event.notificationId === promptId && event.evidence === 'UNUserNotificationCenter.add-completion') {
            entry.accepted = true;
            if (!current()) { abort(); continue; }
            finish({ ...unknown('notification_display_unconfirmed'), promptId, systemAccepted: true,
              acceptanceEvidence: event.evidence, foregroundFallbackRequired: true });
          } else if (mode === 'show' && event.event === 'withdrawn' && event.notificationId === promptId
            && typeof event.requested === 'boolean' && typeof event.observedAbsence === 'boolean'
            && (!event.observedAbsence || event.requested)) {
            entry.recallRequested = event.requested; entry.observedAbsence = event.observedAbsence;
          } else if (event.event === 'unavailable' && ['macos_notification_permission_required', 'macos_notification_service_unavailable',
            'macos_notification_bundle_required', 'macos_notification_input_invalid'].includes(event.reason)) {
            finish({ state: 'unavailable', reason: event.reason, displayed: false });
          } else if (event.event === 'closed') {
            // A protocol message is not OS recall or process-exit evidence.
          } else { invalid(); return; }
        }
      });
      entry.child.once('error', () => {
        finish({ state: 'unavailable', reason: 'notification_process_unavailable', displayed: false });
        if (!entry.child.pid) cleanup(); else void stop(entry).catch(() => {});
      });
      entry.child.once('exit', cleanup);
      if (!current()) { abort(); return; }
      entry.child.stdin.write(JSON.stringify({ version: 1, mode, ...(mode === 'show' ? { promptId, eventCount } : {}) }) + '\n');
    }).catch(() => {
      finish({ state: 'unavailable', reason: 'notification_process_unavailable', displayed: false });
      if (entry.child) void stop(entry).catch(() => {}); else cleanup();
    });
    return result;
  }
  function stop(entry) {
    return entry.stopping ??= Promise.resolve().then(async () => {
      if (entry.cleaned) return;
      if (!entry.child) { entry.cleanup(); return; }
      try { entry.child.stdin.write('{"version":1,"mode":"close"}\n'); } catch {}
      let timer;
      await Promise.race([entry.exit, new Promise(resolve => { timer = setTimeout(resolve, shutdownGraceMs); })]); clearTimeout(timer);
      if (!entry.cleaned) {
        entry.child.kill();
        await Promise.race([entry.exit, new Promise(resolve => { timer = setTimeout(resolve, shutdownGraceMs); })]); clearTimeout(timer);
      }
      if (!entry.cleaned) throw Error('notification_process_shutdown_unconfirmed');
    });
  }
  const capability = value => value.available === true || typeof value.available === 'boolean'
    ? value : { available: false, channel: kind, permission: 'unknown', reason: value.reason ?? 'notification_capability_unconfirmed' };
  return Object.freeze({
    kind,
    async capabilities() { return capability(await open('probe')); },
    // Only an explicit trusted user-choice path may invoke this method. Normal
    // probe/show/check never request OS permission or provisional authorization.
    async requestPermission(options = {}) { return capability(await open('permission', options)); },
    show({ promptId, eventCount }, options) { return open('show', { ...options, promptId, eventCount }); },
    async withdraw(promptId) {
      const entry = entries.get(promptId);
      if (entry) { entry.abort(); await stop(entry); }
      return { promptId, ownedProcessClosed: !entries.has(promptId),
        systemRecall: entry?.recallRequested ? 'requested-original-id' : 'unconfirmed',
        observedAbsence: entry?.observedAbsence === true, displayed: false, humanReadChanged: false, agentCursorChanged: false };
    },
    close() {
      disposed = true;
      return closing ??= Promise.resolve().then(async () => {
        const pending = [...entries.values()]; for (const entry of pending) entry.abort(); await Promise.all(pending.map(stop));
      });
    },
  });
}

