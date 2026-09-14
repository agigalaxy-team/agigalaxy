import test from 'node:test';
import assert from 'node:assert/strict';
import { transaction } from '../src/database.mjs';

test('failed rollback discards the uncertain connection and preserves the operation failure', async () => {
  const original = new Error('business write failed');
  const broken = new Error('connection lost during rollback');
  const commands = [];
  const releases = [];
  const client = {
    async query(sql) { commands.push(sql); if (sql === 'ROLLBACK') throw broken; },
    release(error) { releases.push(error); },
  };
  await assert.rejects(transaction({ connect: async () => client }, async tx => {
    assert.equal(tx, client);
    throw original;
  }), error => error === original);
  assert.deepEqual(commands, ['BEGIN', 'ROLLBACK']);
  assert.deepEqual(releases, [broken]);
});

test('commit failure is rolled back before releasing the connection', async () => {
  const failure = new Error('commit failed');
  const commands = [];
  const client = {
    async query(sql) { commands.push(sql); if (sql === 'COMMIT') throw failure; },
    release(error) { assert.equal(error, undefined); commands.push('release'); },
  };
  await assert.rejects(transaction({ connect: async () => client }, async tx => {
    await tx.query('business write');
    return 'must not return';
  }), error => error === failure);
  assert.deepEqual(commands, ['BEGIN', 'business write', 'COMMIT', 'ROLLBACK', 'release']);
});
