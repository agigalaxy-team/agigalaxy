import { createInterface } from 'node:readline';

// Test-only real Node child, not Python/GIO, a Linux daemon or an OS popup.
// The production spawn contract is inspected by the parent before replacing
// the trusted helper with this explicit protocol fixture.
const scenario = process.argv[2] ?? 'normal';
const lines = createInterface({ input: process.stdin });
let first = true, notificationId = null, closePending = false;
const emit = value => process.stdout.write(JSON.stringify({ version: 1, ...value }) + '\n');
const finish = () => { lines.close(); process.stdin.destroy(); };
const closeOriginal = () => {
  emit({ event: 'withdrawn', notificationId, sameConnection: true, requested: scenario !== 'owner-lost' });
  emit({ event: 'closed' }); finish();
};
lines.on('line', line => {
  if (line.length > 256) { process.exitCode = 2; finish(); return; }
  let value;
  try { value = JSON.parse(line); } catch { process.exitCode = 2; finish(); return; }
  if (first) {
    first = false;
    if (value.mode === 'probe' && Object.keys(value).length === 1) {
      emit({ event: 'capabilities', available: true, channel: 'linux-freedesktop', displayEvidence: 'none', permission: 'system-managed', recall: 'same-connection-original-id' });
      finish(); return;
    }
    if (value.mode !== 'show' || Object.keys(value).sort().join(',') !== 'eventCount,mode'
      || !Number.isInteger(value.eventCount) || value.eventCount < 1 || value.eventCount > 20) {
      process.exitCode = 2; finish(); return;
    }
    if (scenario === 'unavailable') { emit({ event: 'unavailable', reason: 'linux_notification_service_unavailable' }); finish(); return; }
    if (scenario === 'malformed') { emit({ event: 'shown', displayed: true, evidence: 'pretend-display' }); finish(); return; }
    if (scenario === 'oversize') { process.stdout.write('x'.repeat(9000)); return; }
    if (scenario === 'hang') return;
    const accepted = () => {
      notificationId = 17;
      emit({ event: 'accepted', notificationId, owner: ':1.47', sameConnection: true, evidence: 'org.freedesktop.Notifications.Notify reply' });
      if (closePending) closeOriginal();
    };
    if (scenario === 'late') setTimeout(accepted, 100); else accepted();
  } else if (value.mode === 'close' && Object.keys(value).length === 1) {
    if (scenario === 'hang') return;
    if (scenario === 'late' && notificationId === null) { closePending = true; return; }
    closeOriginal();
  } else { process.exitCode = 2; finish(); }
});
