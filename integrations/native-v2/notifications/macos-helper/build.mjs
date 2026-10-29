import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { isAbsolute, join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const sourceDirectory = dirname(fileURLToPath(import.meta.url)), run = promisify(execFile);
const sha = bytes => createHash('sha256').update(bytes).digest('hex');

/** Explicit developer build only: requires an existing macOS SDK/toolchain.
 * The new directory is reserved exclusively. Failure leaves partial evidence;
 * no signing, notarization, install, system policy or background launch occurs.
 */
export async function buildMacOSNotificationHelper({ destination, platform = process.platform, executeFile = run } = {}) {
  if (platform !== 'darwin') throw Error('macos_build_host_required');
  if (typeof destination !== 'string' || !isAbsolute(destination)) throw Error('macos_build_new_absolute_directory_required');
  const target = resolve(destination), swiftPath = join(sourceDirectory, 'GalaxyNotifications.swift');
  const [swift, plist] = await Promise.all([readFile(swiftPath), readFile(join(sourceDirectory, 'Info.plist'))]);
  // Non-recursive exclusive mkdir rejects existing destinations. Child paths
  // are fixed, never provided by a tool or substituted as shell syntax.
  await mkdir(target);
  const app = join(target, 'GalaxyNotifications.app'), contents = join(app, 'Contents'), executable = join(contents, 'MacOS', 'GalaxyNotifications');
  await mkdir(join(contents, 'MacOS'), { recursive: true });
  await writeFile(join(contents, 'Info.plist'), plist, { flag: 'wx' });
  const args = ['--sdk', 'macosx', 'swiftc', '-swift-version', '5', '-O', '-framework', 'AppKit',
    '-framework', 'UserNotifications', swiftPath, '-o', executable];
  await executeFile('/usr/bin/xcrun', args, { shell: false, windowsHide: true, timeout: 60000, maxBuffer: 1024 * 1024 });
  const bytes = await readFile(executable);
  const report = { schemaVersion: 1, kind: 'galaxy-macos-notification-helper-development-build',
    command: executable, bundleId: 'org.galaxy.local-notifications',
    inputs: { 'GalaxyNotifications.swift': sha(swift), 'Info.plist': sha(plist) }, executableSha256: sha(bytes),
    compiled: true, signed: false, notarized: false, installed: false, launched: false,
    notificationPermissionChecked: false, notificationShown: false };
  await writeFile(join(target, 'build-report.json'), JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
  return report;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log(JSON.stringify(await buildMacOSNotificationHelper({ destination: process.argv[2] })));
}

