import { readFile } from 'node:fs/promises';

const root = new URL('../../', import.meta.url);
const readJson = async path => JSON.parse(await readFile(new URL(path, root), 'utf8'));

export async function storageReference(migrations) {
  const tables = new Map([['schema_migrations', {
    table: 'schema_migrations', source: 'go/internal/databaseschema/migrate.go',
  }]]);
  for (const migration of migrations) {
    const sql = migration.sql.replace(/--[^\n]*/g, '');
    const declarations = /\b(CREATE\s+TABLE|DROP\s+TABLE)\s+(?:IF\s+(?:NOT\s+)?EXISTS\s+)?([a-z_][a-z0-9_.]*)(?=\s|\()/gi;
    for (const match of sql.matchAll(declarations)) {
      const name = match[2].replace(/^public\./i, '');
      if (name.includes('.')) continue;
      if (/^DROP/i.test(match[1])) tables.delete(name);
      else if (!tables.has(name)) tables.set(name, {
        table: name, introducedByMigration: migration.version,
        source: `go/internal/databaseschema/sql/${migration.version}.sql`,
      });
    }
  }
  const maintenance = await readJson('go/internal/subjectlifecycle/maintenance_catalog.json');
  const exports = await readJson('go/internal/subjectlifecycle/catalog.json');
  const known = new Set([...Object.keys(maintenance.targets), ...maintenance.excluded,
    ...maintenance.chatDelegatedTables]);
  const names = [...tables.keys()].sort();
  return {
    version: 3, status: 'current-source-declarations', schema: migrations.at(-1).version,
    migrationVersions: migrations.map(item => item.version),
    table_count: names.length, tables: names.map(name => tables.get(name)),
    coverage: {
      source: 'Named public-table CREATE/DROP declarations and the migration ledger bootstrap. Dynamic SQL and separate engine schemas are excluded.',
      live_table_equality_verified: false, all_table_lifecycle_review_complete: false,
      excluded_separate_stores: ['CMS', 'Keycloak', 'Agno', 'OpenPanel', 'Gorse',
        'Meilisearch', 'Prosody', 'object storage', 'Native JSON/PEM and SQLite', 'queue engine schemas'],
    },
    deletion: {
      source: 'go/internal/subjectlifecycle/maintenance_catalog.json',
      registeredMigrationVersions: maintenance.versions,
      matchesCurrentMigrationHistory: JSON.stringify(maintenance.versions) === JSON.stringify(migrations.map(item => item.version)),
      unclassifiedDeclaredTables: names.filter(name => !known.has(name)),
      runtimeCoverage: 'Static classification only. Explicit maintenance validates the actual migration ledger and tables before mutation.',
    },
    export: {
      source: 'go/internal/subjectlifecycle/catalog.json',
      datasets: exports.datasets.length, dataset_names: exports.datasets,
      all_dataset_runtime_acceptance: false,
    },
    current_guides: ['docs/product/data-and-files.md', 'docs/operations/recovery-adapters.md', 'WORK_STATUS.md'],
  };
}
