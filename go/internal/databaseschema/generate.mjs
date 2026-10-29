// The SQL files are the authoritative business history. This generates only
// the ordered Go catalog; it never rewrites SQL or connects to a database.
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

const root = new URL('./', import.meta.url);
export const roles = Object.freeze(['api', 'worker', 'deletion-review', 'content-publisher']);

export async function readMigrations() {
  const names = await readdir(new URL('sql/', root));
  const versions = names.filter(name => /^[1-9][0-9]*\.sql$/.test(name))
    .map(name => Number(name.slice(0, -4))).sort((a, b) => a - b);
  if (!versions.length || versions.some(version => !Number.isSafeInteger(version)))
    throw new Error('An ordered SQL migration history is required.');
  const expected = new Set([...versions.map(version => `${version}.sql`), ...roles.map(role => `${role}-role.sql`)]);
  if (names.some(name => !expected.has(name))) throw new Error('Unexpected file in the authoritative SQL directory.');
  for (const role of roles) await readFile(new URL(`sql/${role}-role.sql`, root));
  return Promise.all(versions.map(async version => ({ version, sql: await readFile(new URL(`sql/${version}.sql`, root), 'utf8') })));
}

export async function generateCatalog({ check = false } = {}) {
  const migrations = await readMigrations();
  const source = '// Code generated from the authoritative sql/*.sql history; DO NOT EDIT.\npackage databaseschema\n\n'
    + 'var migrationVersions = [...]int{' + migrations.map(item => item.version).join(', ') + '}\n';
  const target = new URL('catalog.gen.go', root);
  if (check) {
    if (await readFile(target, 'utf8') !== source) throw new Error('Stale SQL migration catalog; run go generate ./internal/databaseschema.');
  } else await writeFile(target, source, 'utf8');
  return { migrations: migrations.length, roles: roles.length, schema: migrations.at(-1).version, check };
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url)
  console.log(JSON.stringify(await generateCatalog({ check: process.argv.includes('--check') })));
