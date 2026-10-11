import test from 'node:test';
import assert from 'node:assert/strict';
import { createConfiguredNotificationChannel, nativeNotificationConfigSchema } from '../src/native-v2/notifications/config.mjs';
import { nativeConfigSchema } from '../src/native-v2/stdio.mjs';

test('trusted host notification configuration accepts only exact channel and absolute executable, with no tool args or source text', () => {
  const valid = { kind: 'linux-freedesktop', command: process.execPath };
  assert.deepEqual(nativeNotificationConfigSchema.parse(valid), valid);
  for (const invalid of [
    { kind: 'any-shell' }, { kind: 'linux-freedesktop', command: 'python3' },
    { ...valid, args: ['arbitrary'] }, { ...valid, text: 'private text' }, { ...valid, enabled: true },
  ]) assert.equal(nativeNotificationConfigSchema.safeParse(invalid).success, false);
  const config = { version: 2, endpoint: 'https://official.example.org', website: 'https://galaxy.example.org',
    dataDirectory: process.cwd(), trustedKeys: {}, hostNotifications: valid };
  assert.deepEqual(nativeConfigSchema.parse(config).hostNotifications, valid);
  assert.equal(nativeConfigSchema.safeParse({ ...config, hostNotifications: { ...valid, enabled: true } }).success, false);
});

test('configuration selects one local channel without capability probing, showing or enabling a helper', async () => {
  const calls = [], operations = [];
  const factory = kind => options => { calls.push({ kind, options }); return {
    async capabilities() { operations.push('probe'); }, async show() { operations.push('show'); },
    async withdraw() { operations.push('withdraw'); }, async close() { operations.push('close'); },
  }; };
  const overrides = { createLinux: factory('linux-freedesktop'), createWindows: factory('windows-notify-icon') };
  assert.equal(createConfiguredNotificationChannel(undefined, { ...overrides, platform: 'linux' }).kind, 'linux-freedesktop');
  assert.equal(createConfiguredNotificationChannel(undefined, { ...overrides, platform: 'win32' }).kind, 'windows-notify-icon');
  assert.equal(createConfiguredNotificationChannel({ kind: 'linux-freedesktop', command: process.execPath }, { ...overrides, platform: 'linux' }).kind, 'linux-freedesktop');
  assert.deepEqual(calls, [
    { kind: 'linux-freedesktop', options: { platform: 'linux' } },
    { kind: 'windows-notify-icon', options: { platform: 'win32' } },
    { kind: 'linux-freedesktop', options: { platform: 'linux', command: process.execPath } },
  ]);
  assert.deepEqual(operations, []);
});
