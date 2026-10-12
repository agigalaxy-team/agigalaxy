import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp, writeFile, rm} from 'node:fs/promises';
import {join, resolve, sep} from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID} from 'node:crypto';
import {createWindowsNotificationChannel} from '../src/native-v2/notifications/windows-notify-icon.mjs';

async function subprocessFixture(body, run) {
  const directory = await mkdtemp(join(tmpdir(), 'galaxy-notification-')), file = join(directory, 'fixture.mjs'), children = [], spawns = [];
  await writeFile(file, "import readline from 'node:readline';let first=true;const lines=readline.createInterface({input:process.stdin});lines.on('line',line=>{if(!first){process.exit(0);return;}first=false;const input=JSON.parse(line);" + body + '});');
  // Include OS process startup and CI scheduling; the protocol assertions below
  // still require a real shown event and reject an accepted-only response.
  const channel = createWindowsNotificationChannel({command: process.execPath, platform: 'win32', timeoutMs: 5000,
    spawnProcess: (command, args, options) => { spawns.push({command, args, options}); const child = spawn(command, [file], options); children.push(child); return child; }});
  try { await run(channel, spawns); } finally {
    await channel.close(); assert.ok(children.every(child => child.exitCode !== null || child.signalCode !== null), 'Every owned real Node child exited');
    assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + sep)); await rm(directory, {recursive: true, force: true});
  }
}

test('real owned subprocess uses only fixed trusted arguments and reports shown independently from click/read', async () => {
  await subprocessFixture("if(input.mode==='probe'){process.stdout.write(JSON.stringify({event:'capabilities',available:true,channel:'windows-notify-icon',displayEvidence:'BalloonTipShown',permission:'system-managed'})+'\\n');process.exit(0);return;}if(Object.keys(input).sort().join(',')!=='eventCount,mode,testOnly')process.exit(4);const frame=JSON.stringify({event:'shown',evidence:'BalloonTipShown'})+'\\n';process.stdout.write(frame.slice(0,8));setTimeout(()=>process.stdout.write(frame.slice(8)),5);", async (channel, spawns) => {
    const capability = await channel.capabilities(); assert.equal(capability.available, true);
    const promptId = randomUUID(), result = await channel.show({promptId, eventCount: 2, sourceText: 'never enter process', command: 'untrusted command'});
    assert.equal(result.state, 'shown'); assert.equal(result.humanReadChanged, false); assert.equal(result.promptId, promptId);
    await channel.withdraw(promptId);
    for (const invocation of spawns) {
      assert.equal(invocation.options.shell, false); assert.equal(invocation.options.windowsHide, true);
      assert.equal(invocation.command, process.execPath); assert.equal(invocation.args.at(-2), '-File'); assert.match(invocation.args.at(-1), /windows-notify-icon\.ps1$/);
      assert.equal(invocation.args.some(argument => /ExecutionPolicy|untrusted|never enter/.test(argument)), false);
    }
  });
});

test('accepted without a shown event is unknown and owned process closes; it never fabricates a display receipt', async () => {
  await subprocessFixture("process.stdout.write('{\"event\":\"accepted\"}\\n');", async channel => {
    const result = await channel.show({promptId: randomUUID(), eventCount: 1});
    assert.equal(result.state, 'unknown'); assert.equal(result.displayed, false);
    const closing = channel.close(); assert.equal(channel.close(), closing); await closing;
  });
});

for (const body of ["process.stdout.write('null\\n');", "process.stdout.write('x'.repeat(9000));"]) test('invalid real process protocol is unknown and cannot leave a helper alive: ' + body.slice(0, 24), async () => {
  await subprocessFixture(body, async channel => {
    const result = await channel.show({promptId: randomUUID(), eventCount: 1}); assert.equal(result.state, 'unknown'); assert.equal(result.displayed, false);
  });
});

test('unsupported platform and an already cancelled intent do not spawn or install anything', async () => {
  let calls = 0;
  const unsupported = createWindowsNotificationChannel({platform: 'linux', command: process.execPath, spawnProcess: () => { calls++; }});
  assert.equal((await unsupported.capabilities()).available, false); await unsupported.close();
  const supported = createWindowsNotificationChannel({platform: 'win32', command: process.execPath, spawnProcess: () => { calls++; }});
  const abort = new AbortController(); abort.abort();
  assert.equal((await supported.show({promptId: randomUUID(), eventCount: 1}, {signal: abort.signal})).state, 'unknown');
  await supported.close(); assert.equal(calls, 0);
});
