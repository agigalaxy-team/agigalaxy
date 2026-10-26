import { runtimeConfigSnapshot,recordRuntimeConfig } from '../../src/operations/runtime-config-audit.mjs';
import { approveFixtureDeletion } from '../deletion-execute-workflow.mjs';
import { executeDeletion } from '../../src/operations/deletion-execute.mjs';
import { reviewDeletionRequest } from '../../src/operations/deletion-review.mjs';
import { captureDeletionLedger,replayDeletionLedger } from '../../src/operations/deletion-ledger.mjs';
import { minimizeDeletionReceipt } from '../../src/operations/deletion-minimize.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import pg from 'pg';
import { serviceFixture } from '../service-fixture.mjs';
import { migrations } from '../../src/infrastructure/migrations.mjs';
import { IdentityLinkService } from '../../src/identity-links.mjs';
import { syntheticIdentityProvider,syntheticIdentityCallback } from '../identity-test-provider.mjs';
import { ownerExportDatasets } from '../../src/shared/data-export-schema.mjs';
import { SearchIndex } from '../../src/search-index.mjs';
import { EvidenceService } from '../../src/evidence.mjs';
import { ConsentReader } from '../../src/consent-reader.mjs';
import { inspectGithubRun } from '../../src/github-evidence.mjs';
import { assertRecoveryReady } from '../../src/infrastructure/recovery-state.mjs';
import { createBackup, restoreBackup, initializeBackupRepository, copyBackupSnapshot,
  backupRepositoryCheck, retentionPreview, runBackupCommand } from '../../src/operations/backup.mjs';

test('real restic encrypted copies restore PostgreSQL facts/files and invalidate pre-revocation authority', { timeout: 120000 }, async () => {
  assert.equal(process.env.GALAXY_TEST_PG_ISOLATED, '1');
  assert.ok(process.env.GALAXY_TEST_RESTIC_BIN, 'explicit restic executable required');
  const temporary = await mkdtemp(join(tmpdir(), 'galaxy-backup-test-'));
  const admin = new pg.Pool(); let db, restored;
  try {
    await admin.query('CREATE DATABASE galaxy_backup_source');
    db = new pg.Pool({ database: 'galaxy_backup_source' });
    const f = await serviceFixture(['binding', 'consent', 'case-teaser', 'evidence', 'proof', 'history', 'data-delete', 'data-export', 'notifications'], db);
    const configEvent=await recordRuntimeConfig(db,{endpoint:f.access.endpoint,component:'api',snapshot:runtimeConfigSnapshot({governance:{}})});
    const parent = { id: randomUUID(), kind: 'case', localRef: 'restore-fixture', title: 'Synthetic recovery', summary: 'Fixture only',
      source: { kind: 'local', reference: 'restore-fixture' }, participants: [{ subjectId: f.actor.subjectId, role: 'requester' }] };
    const parentGrant = await f.authorize(parent); await f.cases.submit(f.actor, parentGrant);
    const attempt = { id: randomUUID(), kind: 'attempt', caseId: parent.id, expectedVersion: 1, sequence: 1, approach: 'Fixture',
      configuration: { environment: 'integration', version: '1', tools: [] } };
    await f.cases.submit(f.actor, await f.authorize(attempt));
    const result = { id: randomUUID(), kind: 'result', caseId: parent.id, expectedVersion: 2, attemptId: attempt.id,
      outcome: 'succeeded', summary: 'Synthetic reported outcome', failureReason: '', limitations: ['Synthetic'] };
    await f.cases.submit(f.actor, await f.authorize(result));
    const evidence = { id: randomUUID(), caseId: parent.id, resultId: result.id, source: {
      provider: 'github-actions', owner: 'fixture', repository: 'example', runId: 1, attempt: 1, commit: 'a'.repeat(40) } };
    await f.evidence.submit(f.actor, await f.authorize(evidence, 'evidence.submit'));
    const worker = new EvidenceService(null, new ConsentReader({ now: () => f.now }), { db, endpoint: f.access.endpoint, now: () => f.now });
    await worker.processNext((source, now) => inspectGithubRun(source, { id: 1, run_attempt: 1, head_sha: source.commit,
      repository: { full_name: 'fixture/example', private: false, id: 123 }, updated_at: new Date(now * 1000).toISOString(),
      status: 'completed', conclusion: 'success' }, now));
    const preview = await f.proofs.preview(f.actor, { id: randomUUID(), evidenceId: evidence.id });
    const proof = await f.proofs.publish(f.actor, await f.authorize(JSON.parse(preview.payloadJson), 'proof.publish', { visibility: 'Public', purpose: 'public-profile' }));
    assert.equal((await f.proofs.get(null, proof.proofId)).status, 'active');
    const profile = { id: randomUUID(), expectedRevision: 0, selfDeclared: { displayName: 'Synthetic recovery profile' } };
    await f.profiles.publish(f.actor, await f.authorize(profile, 'profile.publish', { visibility: 'Public', purpose: 'public-profile' }));
    await f.notifications.archive(f.actor, { expectedRevision: 0, before: f.now - 1 });
    const exportId = randomUUID();
    await f.dataExport.create(f.actor, { id: exportId, datasets: ['profile-statements', 'notification-preferences'] });
    const index = new SearchIndex({ db, endpoint: f.access.endpoint, now: () => f.now });
    await index.configure({ enabled: true, rebuild: true });
    for (let i = 0; i < 100; i++) if ((await index.seedBatch()).complete) break;
    for (let i = 0; i < 100; i++) if (!(await index.processNext()).processed) break;
    assert.ok((await index.candidates('proof')).items.some(item => item.id === proof.proofId));
    const originalProfile = (await db.query('SELECT * FROM profile_statements')).rows;
    const originalPreferences = (await db.query('SELECT * FROM notification_preferences')).rows;
    const originalSubject = (await db.query('SELECT * FROM subjects')).rows;
    const identity=new IdentityLinkService(f.access,[syntheticIdentityProvider(f.access.endpoint,f.now)]);
    const identityLogin=await identity.begin(f.actor,{providerId:'fixture'});
    await identity.callback('fixture',syntheticIdentityCallback(identityLogin));
    const identityIntent=await identity.status(f.actor,{id:identityLogin.loginId});
    const identitySignature=await f.signForTest(identityIntent.payloadJson,'galaxy-identity-link+jws');
    await identity.confirm(f.actor,{id:identityLogin.loginId,signed:identitySignature});
    const deletionIntent = { version: 1, id: randomUUID(), endpoint: f.access.endpoint, subjectId: f.actor.subjectId,
      bindingId: f.actor.bindingId, issuedAt: f.now, expiresAt: f.now + 300, action: 'request',
      scope: 'all-owned-service-data', reason: 'privacy', takeout: 'not-needed' };
    await f.deletion.submit(f.actor, await f.signForTest(JSON.stringify(deletionIntent),'galaxy-deletion-intent+jws'));
    const deleted = await serviceFixture(['binding','data-delete'], db, {migrateDatabase:false});
    const deletionCommand=await approveFixtureDeletion(deleted,db);
    await executeDeletion(db,deletionCommand,{now:()=>deleted.now});
    const originalExecutions=(await db.query('SELECT * FROM deletion_executions')).rows;
    const originalDeletion = (await db.query('SELECT * FROM deletion_requests')).rows;
    const originalDeletionEvents = (await db.query('SELECT * FROM deletion_events')).rows;
    const configuration = join(temporary, 'config.json'), object = join(temporary, 'object.txt'), spool = join(temporary, 'spool.sqlite');
    await writeFile(configuration, JSON.stringify({ version: 'fixture-1', endpoint: f.access.endpoint }));
    await writeFile(object, 'Synthetic selected object');
    const sqlite = new DatabaseSync(spool);
    sqlite.exec("PRAGMA journal_mode=WAL; CREATE TABLE pending(id TEXT); INSERT INTO pending VALUES('synthetic-pending')");
    const primary = { binary: process.env.GALAXY_TEST_RESTIC_BIN, repository: join(temporary, 'primary'), environment: { RESTIC_PASSWORD: randomBytes(32).toString('hex') } };
    const secondary = { ...primary, repository: join(temporary, 'secondary'), environment: { RESTIC_PASSWORD: randomBytes(32).toString('hex') } };
    const cliConfig = join(temporary, 'operator.json');
    await writeFile(cliConfig, JSON.stringify({ version: 1, resticBinary: primary.binary,
      primary: { repository: primary.repository, environmentReferences: { RESTIC_PASSWORD: 'SYNTHETIC_BACKUP_PASSWORD' } } }));
    const cli = await runBackupCommand(process.execPath, [fileURLToPath(new URL('../../scripts/backup.mjs', import.meta.url)),
      'init', cliConfig, join(temporary, 'init-receipt.json')], { env: { SYNTHETIC_BACKUP_PASSWORD: primary.environment.RESTIC_PASSWORD } });
    assert.equal(JSON.parse(cli).result, 'completed');
    await initializeBackupRepository(secondary);
    const capture = { pool: db, database: 'galaxy_backup_source', pgBin: process.env.GALAXY_TEST_PG_BIN, repository: primary,
      stagingParent: temporary, endpoint: f.access.endpoint, configurationVersion: 'fixture-1', rpoTargetSeconds: 900, rtoTargetSeconds: 900,
      files: [{ name: 'configuration/service.json', kind: 'file', path: configuration }, { name: 'objects/example.txt', kind: 'file', path: object },
        { name: 'audit/spool.sqlite', kind: 'sqlite', path: spool }] };
    let receipt;
    try { receipt = await createBackup(capture); } finally { sqlite.close(); }
    assert.equal(receipt.manifest.version, 2);
    assert.equal(receipt.manifest.database.inventoryOrdering, 'jsonb-text-c-v1');
    assert.equal(receipt.manifest.schema, migrations.at(-1).version); assert.equal(receipt.restoreVerified, false);
    const inventory = JSON.parse(await readFile(new URL('../../../../docs/technical/reference/data-inventory-v0.1.json', import.meta.url), 'utf8'));
    assert.equal(inventory.schema, receipt.manifest.schema, 'data inventory must describe the actual backed-up schema');
    assert.deepEqual(inventory.tables.map(row => row.table).sort(), Object.keys(receipt.manifest.database.tables).sort());
    assert.equal(inventory.export.datasets, ownerExportDatasets.length);
    assert.equal((await readdir(temporary)).some(name => name.startsWith('galaxy-backup-stage-')), false);
    await assert.rejects(createBackup({ ...capture, database: 'postgres' }), /target mismatch/);
    await backupRepositoryCheck(primary);
    await f.consents.revoke(f.actor, parentGrant.consentId);
    await f.proofs.revoke(f.actor, proof.proofId);
    const copied = await copyBackupSnapshot(primary, secondary, receipt.snapshotId);
    await backupRepositoryCheck(secondary);
    const retention = await retentionPreview(secondary);
    assert.ok(Array.isArray(retention)); assert.ok(retention.some(group => group.keep?.length > 0));
    await assert.rejects(backupRepositoryCheck({ ...secondary, environment: { RESTIC_PASSWORD: 'synthetic-wrong-password' } }), /Backup command failed/);
    const restoreOptions = { admin, pgBin: process.env.GALAXY_TEST_PG_BIN, repository: secondary, snapshotId: copied.snapshotId,
      targetDirectory: join(temporary, 'restored'), targetDatabase: 'galaxy_restore_backup', expectedManifestSha256: receipt.manifestSha256 };
    await assert.rejects(restoreBackup({ ...restoreOptions, expectedManifestSha256: '0'.repeat(64),
      targetDirectory: join(temporary, 'bad-manifest'), targetDatabase: 'galaxy_restore_rejected' }), /manifest mismatch/);
    assert.equal((await admin.query("SELECT 1 FROM pg_database WHERE datname='galaxy_restore_rejected'")).rowCount, 0);
    // Exercise the connectionString override regression, using only the synthetic cluster URL.
    const url = new URL(`postgresql://${process.env.PGHOST}:${process.env.PGPORT}/postgres`);
    url.username = process.env.PGUSER; url.password = process.env.PGPASSWORD;
    const urlAdmin = new pg.Pool({ connectionString: url.href });
    let recovery;
    try { recovery = await restoreBackup({ ...restoreOptions, admin: urlAdmin }); } finally { await urlAdmin.end(); }
    assert.equal(recovery.databaseAndFilesMatched, true); assert.equal(recovery.withinDevelopmentTargets, true);
    restored = new pg.Pool({ database: restoreOptions.targetDatabase });
    await assert.rejects(assertRecoveryReady(restored), /quarantined/);
    assert.deepEqual((await restored.query('SELECT * FROM subjects')).rows, originalSubject);
    const restoredIdentity=(await restored.query('SELECT * FROM external_identity_links WHERE id=$1',[identityLogin.loginId])).rows[0];
    assert.equal(restoredIdentity.signature,identitySignature);assert.equal(restoredIdentity.payload_text,identityIntent.payloadJson);
    assert.ok(restoredIdentity.revoked_at,'old external associations are invalidated in quarantined recovery');
    assert.deepEqual((await restored.query('SELECT * FROM deletion_requests')).rows, originalDeletion);
    assert.deepEqual((await restored.query('SELECT * FROM deletion_events')).rows, originalDeletionEvents);
    assert.deepEqual((await restored.query('SELECT * FROM deletion_executions')).rows, originalExecutions);
    assert.deepEqual((await restored.query('SELECT * FROM profile_statements')).rows, originalProfile);
    assert.deepEqual((await restored.query('SELECT * FROM notification_preferences')).rows, originalPreferences);
    assert.ok((await restored.query('SELECT revoked_at FROM data_exports WHERE id=$1', [exportId])).rows[0].revoked_at);
    assert.equal((await restored.query('SELECT * FROM search_documents')).rowCount, 0, 'restored revocations invalidate derived candidates');
    assert.equal((await restored.query('SELECT id FROM subjects WHERE id=$1',[deleted.actor.subjectId])).rows.length,0);
    assert.equal((await restored.query('SELECT count(*) FROM case_events')).rows[0].count, '3');
    assert.equal((await restored.query('SELECT signed FROM proofs WHERE id=$1', [proof.proofId])).rows[0].signed, proof.signed);
    assert.equal((await restored.query('SELECT count(*) FROM consents WHERE revoked_at IS NULL')).rows[0].count, '0');
    assert.equal((await restored.query('SELECT count(*) FROM proofs WHERE revoked_at IS NULL')).rows[0].count, '0');
    assert.equal((await db.query('SELECT count(*) FROM bindings WHERE revoked_at IS NULL')).rows[0].count, '1', 'source database must remain unchanged');
    f.access.db = restored;
    await assert.rejects(f.access.authenticate(f.credential), /access_denied/);
    await assert.rejects(f.proofs.get(null, proof.proofId), /not_found/);
    assert.deepEqual((await f.history.query(null, { subjectId: f.actor.subjectId })).items, []);
    assert.deepEqual((await f.profiles.readWithin(restored, null, f.actor.subjectId)).selfDeclared, {});
    const recoveredIndex = new SearchIndex({ db: restored, endpoint: f.access.endpoint, now: () => f.now });
    for (let i = 0; i < 100; i++) if (!(await recoveredIndex.processNext()).processed) break;
    assert.equal((await recoveredIndex.candidates('proof')).items.length, 0, 'queued pre-restore jobs cannot republish revoked sources');
    assert.equal(await readFile(join(restoreOptions.targetDirectory, 'objects/example.txt'), 'utf8'), 'Synthetic selected object');
    const restoredSqlite = new DatabaseSync(join(restoreOptions.targetDirectory, 'audit/spool.sqlite'), { readOnly: true });
    try { assert.equal(restoredSqlite.prepare('SELECT id FROM pending').get().id, 'synthetic-pending'); } finally { restoredSqlite.close(); }
    // This execution occurs strictly after the ordinary backup. Its complete
    // independent ledger must remove facts that the old snapshot still contains.
    const approval={version:1,id:randomUUID(),requestId:deletionIntent.id,endpoint:f.access.endpoint,expectedRevision:1,reviewerRef:'synthetic-recovery-review',decision:'approve',explanation:'Post-snapshot synthetic deletion',
      plan:{policyId:'synthetic',policyVersion:'1',primary:{action:'delete-owned-data',notBefore:f.now,basis:'Synthetic'},audit:{action:'retain-minimum',until:f.now,basis:'Synthetic'},
        backups:{action:'expire-snapshots-and-replay-deletions',until:f.now+3600,basis:'Synthetic'},externalCopies:'outside-service-control'}};
    await reviewDeletionRequest(db,approval);
    await executeDeletion(db,{version:1,id:randomUUID(),requestId:deletionIntent.id,approvalId:approval.id,endpoint:f.access.endpoint,expectedRevision:2,executorRef:'synthetic-source'},{now:()=>f.now});
    await minimizeDeletionReceipt(db,{version:1,id:randomUUID(),requestId:deletionIntent.id,endpoint:f.access.endpoint,expectedRevision:3,operatorRef:'synthetic-retention',
      policy:{id:'synthetic',version:'1',notBefore:f.now+3600,basis:'Synthetic minimization'}},{now:()=>f.now+3600});
    const ledger=await captureDeletionLedger(db,{endpoint:f.access.endpoint,now:()=>f.now+3601});
    await writeFile(join(temporary,'independent-deletion-ledger.json'),ledger.payloadJson,{flag:'wx',mode:0o600});
    const replayCommand={version:1,id:randomUUID(),recoveryId:recovery.recoveryId,endpoint:f.access.endpoint,ledgerSha256:ledger.sha256,capturedNotBefore:f.now+3601,executorRef:'synthetic-restore'};
    const replay=await replayDeletionLedger(restored,ledger.payloadJson,replayCommand,{now:()=>f.now+3610});
    assert.equal(replay.requestsReplayed,2);
    assert.equal((await restored.query('SELECT id FROM subjects WHERE id=$1',[f.actor.subjectId])).rows.length,0);
    assert.equal((await restored.query('SELECT id FROM proofs WHERE id=$1',[proof.proofId])).rows.length,0);
    assert.equal((await restored.query('SELECT id FROM cases WHERE id=$1',[parent.id])).rows.length,0);
    for (const table of ['profile_statements', 'notification_preferences', 'data_exports', 'search_documents', 'external_identity_links'])
      assert.equal((await restored.query(`SELECT count(*) FROM ${table} WHERE subject_id=$1`, [f.actor.subjectId])).rows[0].count, '0');
    assert.equal((await restored.query('SELECT payload_text FROM deletion_events WHERE id=$1',[approval.id])).rows[0].payload_text,'');
    assert.deepEqual(await replayDeletionLedger(restored,ledger.payloadJson,replayCommand,{now:()=>f.now+3620}),replay);
    await assert.rejects(assertRecoveryReady(restored),/quarantined/);
    assert.equal((await restored.query('SELECT event_hash FROM runtime_config_events WHERE id=$1',[configEvent.id])).rows[0].event_hash,configEvent.event_hash);
    const measured = { runtimeConfigurationPreserved:true, event: 'backup_restore_verified', schema: receipt.manifest.schema, deletionLedgerPreserved: true, executionLedgerPreserved: true,
      inventoryMatched:true,ownerExportDatasets:ownerExportDatasets.length,profileAndNotificationArchivePreserved:true,externalIdentityPreservedAndInvalidated:true,
      exportTicketsInvalidated:true,restoredSearchInvalidated:true,queuedIndexCannotRepublish:true,currentSubjectRowsDeletedOnReplay:true,
      postSnapshotDeletionReplayed:true,minimizedLedgerReplayed:true,sourceLedgerSha256:ledger.sha256,replayRequests:replay.requestsReplayed,replayIdempotent:true,tables: Object.keys(receipt.manifest.database.tables),
      files: Object.keys(receipt.manifest.files), encryptedCopies: 2, actualOffsite: false, snapshotFactsMatchedBeforeReplay: true,
      rtoSeconds: recovery.rtoSeconds, recoveryPointAgeSeconds: recovery.recoveryPointAgeSeconds, targets: recovery.targets,
      invalidated: recovery.invalidated, quarantine: true, publicActivation: false };
    console.log(JSON.stringify(measured));
    if (process.env.GALAXY_TEST_BACKUP_EVIDENCE) await writeFile(process.env.GALAXY_TEST_BACKUP_EVIDENCE, JSON.stringify(measured, null, 2) + '\n', { flag: 'wx' });
  } finally {
    if (restored) await restored.end(); if (db) await db.end(); await admin.end();
    // The directory is the exact mkdtemp result owned by this isolated fixture.
    await rm(temporary, { recursive: true, force: true });
  }
});
