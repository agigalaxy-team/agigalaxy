import { spawn } from 'node:child_process';
import { isAbsolute } from 'node:path';
import { access } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';

// Fixed trusted helper; neither source text nor shell code is accepted from a
// tool. It keeps one GIO connection for Notify and the original-ID Close. A
// closed bus never reconnects, and a replaced daemon has a different unique
// owner on this connection. CLI-per-call gdbus cannot provide that lifetime.
const helper = String.raw`
import sys, os, json, re, stat, select, time
def emit(value):
    print(json.dumps(dict(version=1, **value), separators=(',', ':')), flush=True)
connection = None
try:
    initial = sys.stdin.readline(257)
    if len(initial) > 256:
        raise ValueError('invalid input')
    request = json.loads(initial)
    if request == {'mode': 'probe'}:
        probing = True
    elif set(request) == {'mode', 'eventCount'} and request['mode'] == 'show' and type(request['eventCount']) is int and 1 <= request['eventCount'] <= 20:
        probing = False
    else:
        raise ValueError('invalid input')
    import gi
    gi.require_version('Gio', '2.0')
    from gi.repository import Gio, GLib
    address = os.environ.get('DBUS_SESSION_BUS_ADDRESS')
    if not address:
        address = 'unix:path=' + os.environ.get('XDG_RUNTIME_DIR', '/run/user/' + str(os.getuid())) + '/bus'
    if not re.fullmatch(r'unix:(path=/[-A-Za-z0-9_/.]+|abstract=[-A-Za-z0-9_/.]+)(,guid=[a-fA-F0-9]{32})?', address):
        raise ValueError('only one local Unix session bus is supported')
    if address.startswith('unix:path='):
        socket_path = address[len('unix:path='):].split(',')[0]
        socket_info = os.stat(socket_path)
        if not stat.S_ISSOCK(socket_info.st_mode) or socket_info.st_uid != os.getuid():
            raise ValueError('session bus ownership unavailable')
    observer = Gio.DBusAuthObserver()
    observer.connect('authorize-authenticated-peer', lambda observer, stream, credentials: credentials is not None and credentials.get_unix_user() == os.getuid())
    connection = Gio.DBusConnection.new_for_address_sync(address,
        Gio.DBusConnectionFlags.AUTHENTICATION_CLIENT | Gio.DBusConnectionFlags.MESSAGE_BUS_CONNECTION, observer, None)
    connection.set_exit_on_close(False)
    def call(destination, path, interface, method, parameters, reply):
        return connection.call_sync(destination, path, interface, method, parameters,
            GLib.VariantType.new(reply), Gio.DBusCallFlags.NO_AUTO_START, 2000, None).unpack()
    owner = call('org.freedesktop.DBus', '/org/freedesktop/DBus', 'org.freedesktop.DBus', 'GetNameOwner',
        GLib.Variant('(s)', ('org.freedesktop.Notifications',)), '(s)')[0]
    if not re.fullmatch(r':[0-9]+\.[0-9]+', owner):
        raise ValueError('invalid notification owner')
    call(owner, '/org/freedesktop/Notifications', 'org.freedesktop.Notifications', 'GetCapabilities', None, '(as)')
    if probing:
        emit(dict(event='capabilities', available=True, channel='linux-freedesktop', displayEvidence='none', permission='system-managed', recall='same-connection-original-id'))
    else:
        # No object IDs, URLs, private titles, recipients or source bodies.
        notification_id = call(owner, '/org/freedesktop/Notifications', 'org.freedesktop.Notifications', 'Notify',
            GLib.Variant('(susssasa{sv}i)', ('Galaxy', 0, '', 'Galaxy',
                'There are new items to review. Return to the Galaxy notification inbox.', [],
                {'suppress-sound': GLib.Variant('b', True)}, 15000)), '(u)')[0]
        if type(notification_id) is not int or not 0 < notification_id <= 4294967295:
            raise ValueError('invalid notification ID')
        emit(dict(event='accepted', notificationId=notification_id, owner=owner, sameConnection=True, evidence='org.freedesktop.Notifications.Notify reply'))
        deadline = time.monotonic() + 15
        while not connection.is_closed() and time.monotonic() < deadline:
            ready, _, _ = select.select([sys.stdin], [], [], max(0, min(0.25, deadline - time.monotonic())))
            if ready:
                line = sys.stdin.readline(257)
                if not line or len(line) > 256 or json.loads(line) == {'mode': 'close'}:
                    break
                raise ValueError('invalid close input')
        requested = False
        if not connection.is_closed():
            try:
                call(owner, '/org/freedesktop/Notifications', 'org.freedesktop.Notifications', 'CloseNotification',
                    GLib.Variant('(u)', (notification_id,)), '()')
                requested = True
            except Exception:
                pass
        emit(dict(event='withdrawn', notificationId=notification_id, sameConnection=True, requested=requested))
except Exception:
    # Do not disclose environment, private context or raw exception text.
    emit(dict(event='unavailable', reason='linux_notification_service_unavailable'))
finally:
    if connection is not None and not connection.is_closed():
        try:
            connection.close_sync(None)
        except Exception:
            pass
    emit(dict(event='closed'))
`;

const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value);
const unknown = reason => ({ state: 'unknown', reason, displayed: false, humanReadChanged: false, agentCursorChanged: false });

/** Trusted local installation configuration only. Constructing this channel
 * starts nothing. Existing runtime/Choice owns explicit opt-in and durable
 * event/claim dedup; this adapter never signs a display or human-read receipt.
 */
export function createLinuxNotificationChannel({ command = '/usr/bin/python3', platform = process.platform,
  spawnProcess = spawn, checkExecutable = access, timeoutMs = 28000, shutdownGraceMs = 1500 } = {}) {
  if (typeof command !== 'string' || !isAbsolute(command)) throw Error('notification_command_must_be_absolute');
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30000
    || !Number.isInteger(shutdownGraceMs) || shutdownGraceMs < 1 || shutdownGraceMs > 3000) throw Error('notification_timeout_invalid');
  const entries = new Map(); let disposed = false, closing;
  function open(mode, { promptId = randomUUID(), eventCount = 1, signal, isCurrent = () => true, onClosed } = {}) {
    if (disposed) return Promise.resolve({ state: 'unavailable', reason: 'notification_channel_closed', displayed: false });
    if (mode === 'show' && (!uuid(promptId) || !Number.isInteger(eventCount) || eventCount < 1 || eventCount > 20)) throw Error('notification_prompt_invalid');
    if (typeof isCurrent !== 'function') throw Error('notification_current_guard_invalid');
    if (mode === 'show' && entries.has(promptId)) return entries.get(promptId).result;
    if (entries.size >= 64) return Promise.resolve(unknown('notification_process_capacity'));
    let resolveResult, resolveExit;
    const result = new Promise(resolve => { resolveResult = resolve; }), exit = new Promise(resolve => { resolveExit = resolve; });
    const entry = { promptId, result, exit, child: null, done: false, cleaned: false, stopping: null, accepted: false,
      notificationId: null, recallRequested: false, buffer: '', bytes: 0, timer: null };
    entries.set(promptId, entry);
    const current = () => {
      try { return !disposed && !entry.cleaned && !signal?.aborted && isCurrent() === true; } catch { return false; }
    };
    const finish = value => { if (!entry.done) { entry.done = true; resolveResult(value); } };
    const cleanup = () => {
      if (entry.cleaned) return; entry.cleaned = true; entries.delete(promptId);
      clearTimeout(entry.timer); signal?.removeEventListener('abort', abort); resolveExit();
      finish(unknown(entry.accepted ? 'notification_display_unconfirmed' : 'notification_process_closed'));
      if (typeof onClosed === 'function') Promise.resolve().then(() => onClosed({ promptId, ownedProcessClosed: true })).catch(() => {});
    };
    const abort = () => { finish(unknown('notification_cancelled')); void stop(entry).catch(() => {}); };
    entry.cleanup = cleanup;
    entry.abort = abort;
    entry.timer = setTimeout(() => { finish(unknown('notification_process_timeout')); void stop(entry).catch(() => {}); }, timeoutMs);
    signal?.addEventListener('abort', abort, { once: true });
    void Promise.resolve().then(async () => {
      if (platform !== 'linux') { finish({ state: 'unavailable', reason: 'linux_channel_not_available', displayed: false }); cleanup(); return; }
      await checkExecutable(command);
      if (!current()) { abort(); return; }
      entry.child = spawnProcess(command, ['-I', '-c', helper], { shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
      entry.child.stdin.on('error', () => {}); entry.child.stderr.resume(); entry.child.stdout.setEncoding('utf8');
      const invalid = () => { finish(unknown('notification_protocol_invalid')); void stop(entry).catch(() => {}); };
      entry.child.stdout.on('data', chunk => {
        entry.bytes += Buffer.byteLength(chunk);
        if (entry.bytes > 8192) { invalid(); return; }
        entry.buffer += chunk;
        while (entry.buffer.includes('\n')) {
          const index = entry.buffer.indexOf('\n'), line = entry.buffer.slice(0, index).trim(); entry.buffer = entry.buffer.slice(index + 1);
          let event;
          try { event = JSON.parse(line); } catch { invalid(); return; }
          if (event?.version !== 1) { invalid(); return; }
          if (mode === 'probe' && event.event === 'capabilities' && event.available === true && event.channel === 'linux-freedesktop'
            && event.displayEvidence === 'none' && event.permission === 'system-managed' && event.recall === 'same-connection-original-id') {
            finish({ available: true, channel: 'linux-freedesktop', displayEvidence: 'none', permission: 'system-managed', recall: 'same-connection-original-id', processStarted: true });
          } else if (mode === 'show' && event.event === 'accepted' && !entry.accepted && Number.isInteger(event.notificationId)
            && event.notificationId > 0 && event.notificationId <= 4294967295 && /^:[0-9]+\.[0-9]+$/.test(event.owner ?? '')
            && event.sameConnection === true && event.evidence === 'org.freedesktop.Notifications.Notify reply') {
            entry.accepted = true; entry.notificationId = event.notificationId;
            if (!current()) { abort(); continue; }
            finish({ ...unknown('notification_display_unconfirmed'), promptId, systemAccepted: true,
              acceptanceEvidence: 'org.freedesktop.Notifications.Notify reply', foregroundFallbackRequired: true });
          } else if (mode === 'show' && event.event === 'withdrawn' && event.sameConnection === true
            && typeof event.requested === 'boolean' && (event.notificationId === entry.notificationId || !entry.accepted && event.notificationId === null)) {
            entry.recallRequested = event.requested;
          } else if (event.event === 'unavailable' && event.reason === 'linux_notification_service_unavailable') {
            finish({ state: 'unavailable', reason: event.reason, displayed: false });
          } else if (event.event === 'closed') {
            // A protocol close is not process exit, display, a click or a read.
          } else { invalid(); return; }
        }
      });
      entry.child.once('error', () => {
        finish({ state: 'unavailable', reason: 'notification_process_unavailable', displayed: false });
        // Spawn failure has no owned process. A later kill/error event is not
        // exit evidence; retain the process until real exit or failed drain.
        if (!entry.child.pid) cleanup(); else void stop(entry).catch(() => {});
      });
      entry.child.once('exit', cleanup);
      if (!current()) { abort(); return; }
      entry.child.stdin.write(JSON.stringify({ mode, ...(mode === 'show' ? { eventCount } : {}) }) + '\n');
    }).catch(() => { finish({ state: 'unavailable', reason: 'notification_process_unavailable', displayed: false }); if (entry.child) void stop(entry).catch(() => {}); else cleanup(); });
    return result;
  }
  function stop(entry) {
    return entry.stopping ??= Promise.resolve().then(async () => {
      if (entry.cleaned) return;
      if (!entry.child) { entry.cleanup(); return; }
      try { entry.child.stdin.write('{"mode":"close"}\n'); } catch { }
      let timer;
      await Promise.race([entry.exit, new Promise(resolve => { timer = setTimeout(resolve, shutdownGraceMs); })]); clearTimeout(timer);
      if (!entry.cleaned) {
        entry.child.kill();
        await Promise.race([entry.exit, new Promise(resolve => { timer = setTimeout(resolve, shutdownGraceMs); })]); clearTimeout(timer);
      }
      if (!entry.cleaned) throw Error('notification_process_shutdown_unconfirmed');
    });
  }
  return Object.freeze({
    kind: 'linux-freedesktop',
    async capabilities() {
      const value = await open('probe');
      return value.available === true ? value : { available: false, channel: 'linux-freedesktop', permission: 'unknown', reason: value.reason ?? 'notification_capability_unconfirmed' };
    },
    show({ promptId, eventCount }, options) { return open('show', { ...options, promptId, eventCount }); },
    async withdraw(promptId) {
      const entry = entries.get(promptId);
      if (entry) { entry.abort(); await stop(entry); }
      return { promptId, ownedProcessClosed: !entries.has(promptId), systemRecall: entry?.recallRequested ? 'requested-original-id' : 'unconfirmed',
        displayed: false, humanReadChanged: false, agentCursorChanged: false };
    },
    close() {
      disposed = true;
      return closing ??= Promise.resolve().then(async () => { const pending = [...entries.values()]; for (const entry of pending) entry.abort(); await Promise.all(pending.map(stop)); });
    },
  });
}
