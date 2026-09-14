import { migrations } from './infrastructure/migrations.mjs';
import pg from 'pg';
import { readFile } from 'node:fs/promises';

export function openDatabase(connectionString) {
  if (!connectionString) throw new Error('DATABASE_URL is required.');
  return new pg.Pool({ connectionString, max: 8, connectionTimeoutMillis: 5000,
    idleTimeoutMillis: 30000, statement_timeout: 10000, application_name: 'galaxy-official' });
}

export async function transaction(pool, operation, {isolation='read committed'}={}) {
  if(!['read committed','repeatable read'].includes(isolation))throw new Error('Unsupported transaction isolation');
  // PGlite uses a serialized transaction callback; production pg pins one connection.
  if (typeof pool.transaction === 'function') return pool.transaction(async db=>{
    if(isolation==='repeatable read')await db.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
    return operation(db);
  });
  const client = await pool.connect();
  let discard;
  try {
    await client.query(isolation==='repeatable read'?'BEGIN ISOLATION LEVEL REPEATABLE READ':'BEGIN');
    const result = await operation(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    try { await client.query('ROLLBACK'); }
    catch (rollbackError) { discard = rollbackError; }
    // Keep the operation failure while discarding a connection whose transaction
    // state could not be reset. It must never return to the usable pool.
    throw error;
  } finally { client.release(discard); }
}


// Role setup is opt-in administrative work. Runtime services never invoke it.
export const migrationRoles = Object.freeze(['api', 'worker', 'deletion-review']);
export function validateMigrationRoles(roles) {
  if (!Array.isArray(roles) || new Set(roles).size !== roles.length || roles.some(role => !migrationRoles.includes(role)))
    throw new Error('Explicit supported migration roles required.');
  return [...roles];
}
export async function migrate(pool, { roles = [] } = {}) {
  const scripts = await Promise.all(validateMigrationRoles(roles).map(async role =>
    readFile(new URL(`./infrastructure/${role}-role.sql`, import.meta.url), 'utf8')));
  return transaction(pool, async (db) => {
    await db.query('SELECT pg_advisory_xact_lock(734912306)');
    await db.query('CREATE TABLE IF NOT EXISTS schema_migrations (version integer PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
    const applied = (await db.query('SELECT version FROM schema_migrations ORDER BY version')).rows.map(r => r.version);
    if (applied.some(v => !migrations.some(m => m.version === v))) throw new Error('Database schema is newer than this application.');
    if (applied.some((version, index) => version !== migrations[index].version))
      throw new Error('Migration history must be a contiguous prefix; repair requires explicit review.');
    for (const migration of migrations) {
      if (applied.includes(migration.version)) continue;
      if (typeof db.exec === 'function') await db.exec(migration.sql);
      else await db.query(migration.sql);
      await db.query('INSERT INTO schema_migrations (version) VALUES ($1)', [migration.version]);
    }
    // Use the same connection, transaction and advisory lock as the schema.
    // A provisioning failure rolls back newly applied DDL, history and grants.
    for (const sql of scripts) {
      if (typeof db.exec === 'function') await db.exec(sql);
      else await db.query(sql);
    }
    return migrations.at(-1).version;
  });
}
