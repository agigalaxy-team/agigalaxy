import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { databaseInventory } from '../../src/operations/backup.mjs';

test('backup inventory remains identical across byte and punctuation-ignoring language collations', async () => {
  assert.equal(process.env.GALAXY_TEST_PG_ISOLATED, '1');
  const admin = new pg.Pool();
  const created = [], pools = [];
  try {
    for (const [name, options] of [
      ['galaxy_backup_order_byte', "LOCALE_PROVIDER builtin BUILTIN_LOCALE 'C.UTF-8'"],
      ['galaxy_backup_order_language', "LOCALE_PROVIDER icu ICU_LOCALE 'en-US-u-ka-shifted'"],
    ]) {
      await admin.query(`CREATE DATABASE ${name} TEMPLATE template0 ${options}`);
      created.push(name);
      const pool = new pg.Pool({ database: name }); pools.push(pool);
      await pool.query('CREATE TABLE samples (id integer PRIMARY KEY, payload text NOT NULL)');
      for (const [id, payload] of [[1, 'a-b'], [10, 'ab'], [2, 'a b'], [100, 'Áb']])
        await pool.query('INSERT INTO samples VALUES ($1, $2)', [id, payload]);
    }
    async function inventory(pool, ordering) {
      const client = await pool.connect();
      try { await client.query('BEGIN READ ONLY'); return await databaseInventory(client, { ordering }); }
      finally { await client.query('ROLLBACK'); client.release(); }
    }
    const legacy = await Promise.all(pools.map(pool => inventory(pool, 'legacy-database-default')));
    assert.notDeepEqual(legacy[0], legacy[1], 'fixture must reproduce the original cross-locale mismatch');
    const portable = await Promise.all(pools.map(pool => inventory(pool, 'jsonb-text-c-v1')));
    assert.deepEqual(portable[0], portable[1]);
    assert.equal(portable[0].samples.rows, 4);
    await assert.rejects(inventory(pools[0], 'unrecognized'), /Unsupported backup inventory ordering/);
  } finally {
    await Promise.all(pools.map(pool => pool.end()));
    for (const name of created) await admin.query(`DROP DATABASE ${name}`);
    await admin.end();
  }
});
