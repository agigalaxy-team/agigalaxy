// Actual owned Node process/stdio fixture. It replaces the macOS Swift/API
// boundary and cannot demonstrate a compiled bundle or Notification Center.
import { createInterface } from 'node:readline';
import { appendFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
const [scenario = 'authorized', recordPath = ''] = process.argv.slice(2);
const bundleId = 'org.galaxy.local-notifications';
const emit = value => process.stdout.write(JSON.stringify({ version: 1, bundleId, ...value }) + '\n');
const record = value => { if (recordPath) appendFileSync(recordPath, JSON.stringify(value) + '\n'); };
let first = true, id, timer;
function stop() {
 clearTimeout(timer);
 if (id) { record({ event: 'recall', notificationId: id }); emit({ event: 'withdrawn', notificationId: id,
   requested: true, observedAbsence: scenario !== 'recall-pending' }); }
 emit({ event: 'closed' });
 setTimeout(() => process.exit(0), scenario === 'delayed-exit' ? 250 : 5);
}
const input = createInterface({ input: process.stdin });
input.on('line', line => {
 const request = JSON.parse(line); record(request);
 if (!first) { if (scenario !== 'hang') stop(); return; }
 first = false;
 if (scenario === 'bad-json') { process.stdout.write('not-json\n'); return; }
 if (scenario === 'wrong-bundle') { process.stdout.write(JSON.stringify({ version: 1, bundleId: 'foreign.bundle', event: 'closed' }) + '\n'); return; }
 if (scenario === 'hang') return;
 const permission = scenario === 'denied' ? 'denied' : scenario === 'not-determined' ? 'not-determined' : 'authorized';
 const available = permission === 'authorized' && scenario !== 'alerts-disabled';
 if (request.mode === 'show') {
  if (!available) { emit({ event: 'unavailable', reason: 'macos_notification_permission_required' }); stop(); return; }
  id = request.promptId;
  emit({ event: 'accepted', notificationId: scenario === 'wrong-id' ? randomUUID() : id,
   evidence: 'UNUserNotificationCenter.add-completion' });
  timer = setTimeout(stop, 10000);
 } else {
  emit({ event: 'capabilities', channel: 'macos-user-notifications', available, permission,
   alertsEnabled: available, displayEvidence: 'none', recall: 'app-original-identifier' });
  stop();
 }
});
input.on('close', () => { if (scenario !== 'hang') stop(); });

