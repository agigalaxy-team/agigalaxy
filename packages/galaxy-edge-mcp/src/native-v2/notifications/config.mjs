import * as z from 'zod/v4';
import { isAbsolute } from 'node:path';
import { createWindowsNotificationChannel } from './windows-notify-icon.mjs';
import { createLinuxNotificationChannel } from './linux-freedesktop.mjs';
import { createMacOSNotificationChannel } from './macos-user-notifications.mjs';

// This belongs to the trusted local installation file, never MCP arguments.
// Selecting a channel constructs no child and enables no notification polling.
export const nativeNotificationConfigSchema = z.strictObject({
  kind: z.enum(['windows-notify-icon', 'linux-freedesktop', 'macos-user-notifications']),
  command: z.string().min(1).max(4096).refine(isAbsolute).optional(),
}).refine(value => value.kind !== 'macos-user-notifications' || !value.command
  || /[/\\]GalaxyNotifications\.app[/\\]Contents[/\\]MacOS[/\\]GalaxyNotifications$/.test(value.command));

export function createConfiguredNotificationChannel(configuration, {
  platform = process.platform,
  createWindows = createWindowsNotificationChannel,
  createLinux = createLinuxNotificationChannel,
  createMacOS = createMacOSNotificationChannel,
} = {}) {
  const selected = nativeNotificationConfigSchema.parse(configuration ?? {
    kind: platform === 'linux' ? 'linux-freedesktop' : platform === 'darwin' ? 'macos-user-notifications' : 'windows-notify-icon',
  });
  const create = selected.kind === 'linux-freedesktop' ? createLinux : selected.kind === 'macos-user-notifications' ? createMacOS : createWindows;
  const channel = create({ platform, ...(selected.command ? { command: selected.command } : {}) });
  return { ...channel, kind: selected.kind };
}
