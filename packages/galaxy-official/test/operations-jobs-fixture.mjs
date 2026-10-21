import { PgBoss } from 'pg-boss';
import { createOperationsJobs, operationsDatabase } from '../src/operations-jobs.mjs';

export function queueFixture(db) {
  const boss = new PgBoss({ db: operationsDatabase(db), schema: 'galaxy_jobs', migrate: false,
    schedule: false, supervise: false, reindex: false, registerInstance: false,
    openTelemetry: { enabled: false } });
  return { boss, jobs: createOperationsJobs({ db, boss }) };
}
