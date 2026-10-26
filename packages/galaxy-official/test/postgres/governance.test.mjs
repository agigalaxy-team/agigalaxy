import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import pg from 'pg';
import { migrate } from "../../src/infrastructure/database.mjs";
import { apiReads } from '../../src/infrastructure/api-reads.mjs';
import { verifyGovernanceWorkflow } from '../governance-workflow.mjs';
import { verifyCaseModerationWorkflow } from '../case-moderation-workflow.mjs';
import { verifyVerifierParticipation } from '../verifier-participation-workflow.mjs';
import { verifyQualificationPolicyRegistry } from '../qualification-policy-registry-workflow.mjs';

test('isolated PostgreSQL restricted API role appends moderation supplements and corrections with private export visibility', async () => {
  assert.equal(process.env.GALAXY_TEST_PG_ISOLATED, '1');
  const admin = new pg.Pool(), api = new pg.Pool({ max: 8, options: '-c role=galaxy_api', statement_timeout: 10000 });
  try {
    await migrate(admin);
    await admin.query(await readFile(new URL('../../src/infrastructure/api-role.sql', import.meta.url), 'utf8'));
    await verifyGovernanceWorkflow(api, { migrateDatabase: false, repositories: apiReads });
    await verifyCaseModerationWorkflow(api, { migrateDatabase: false, repositories: apiReads });
    console.log(JSON.stringify({event:'verifier_participation_postgres_verified',...await verifyVerifierParticipation(api,{migrateDatabase:false,repositories:apiReads})}));
    console.log(JSON.stringify({event:'qualification_policy_registry_postgres_verified',...await verifyQualificationPolicyRegistry(api,{migrateDatabase:false,repositories:apiReads})}));
    await assert.rejects(api.query("UPDATE moderation_events SET payload_text=''"), /permission denied/);
    await assert.rejects(api.query('DELETE FROM moderation_reports'), /permission denied/);
  } finally { await api.end(); await admin.end(); }
});
