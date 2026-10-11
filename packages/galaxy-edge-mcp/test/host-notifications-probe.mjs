import {writeFile, mkdir} from 'node:fs/promises';
import {dirname} from 'node:path';
import {randomUUID} from 'node:crypto';
import {createWindowsNotificationChannel} from '../src/native-v2/notifications/windows-notify-icon.mjs';

// Default is readonly capability discovery. --show-once is a deliberate single
// generic local test, not a Galaxy business event or proof the user read it.
const [outputPath, mode] = process.argv.slice(2);
if (!outputPath || mode !== undefined && mode !== '--show-once') throw Error('notification_probe_arguments_invalid');
const channel = createWindowsNotificationChannel();
try {
  const capability = await channel.capabilities();
  const delivery = mode === '--show-once' && capability.available
    ? await channel.show({promptId: randomUUID(), eventCount: 1, testOnly: true}) : null;
  const report = {timestamp: new Date().toISOString(), action: 'windows-notification-capability',
    outcome: capability.available ? 'capability-confirmed' : 'capability-unavailable', capability,
    genericSystemTestAttempted: delivery !== null, delivery,
    businessNotificationClaims: 0, agentCursorChanged: false, humanReadChanged: false,
    userReceivedConfirmed: false, globalConfigurationChanged: false, backgroundServiceInstalled: false};
  await mkdir(dirname(outputPath), {recursive: true});
  await writeFile(outputPath, JSON.stringify(report, null, 2) + '\n');
  process.stdout.write(JSON.stringify(report) + '\n');
} finally { await channel.close(); }
