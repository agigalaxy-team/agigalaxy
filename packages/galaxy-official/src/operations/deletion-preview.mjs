import { transaction } from '../database.mjs';
import { exportSources } from '../infrastructure/export-datasets.mjs';
import { productV2Retention } from '../infrastructure/lifecycle-registry-v2.mjs';

// Operational impact inventory, not a deletion authorization or executor.
export async function deletionPreview(database, subjectId) {
  if (!/^GUID[0-9A-Z]{28}$/.test(subjectId)) throw new Error('Invalid deletion subject');
  return transaction(database, async db => {
    await db.query('SET TRANSACTION READ ONLY');
    if (!(await db.query('SELECT 1 FROM subjects WHERE id=$1', [subjectId])).rows.length) throw new Error('Deletion subject not found');
    const ownedDatasets = {};
    for (const [name, source] of Object.entries(exportSources)) ownedDatasets[name] = Number((await db.query(
      `SELECT count(*) FROM ${source.from} WHERE ${source.owner}=$1`, [subjectId])).rows[0].count);
    const dependencies = {};
    for (const [name, sql] of Object.entries({
      otherAuthorsAssistanceEvents: 'SELECT count(*) FROM assistance_events e JOIN assistance_requests a ON e.assistance_id=a.id WHERE a.requester_id=$1 AND e.subject_id<>$1',
      receivedContext: 'SELECT count(*) FROM context_grants WHERE participant_id=$1 AND subject_id<>$1',
      otherAuthorsCapsuleUses: 'SELECT count(*) FROM capsule_uses u JOIN capsules c ON u.capsule_id=c.id WHERE c.subject_id=$1 AND u.subject_id<>$1',
      otherAuthorsBuilderEvents: 'SELECT count(*) FROM builder_events e JOIN builders b ON e.builder_id=b.id WHERE b.owner_id=$1 AND e.subject_id<>$1',
      otherAuthorsTaskEvents: 'SELECT count(*) FROM task_events e JOIN task_requests t ON t.id=e.task_id WHERE t.requester_id=$1 AND e.subject_id<>$1',
      otherAuthorsCaseEvents: 'SELECT count(*) FROM case_events e JOIN cases c ON c.id=e.case_id WHERE c.subject_id=$1 AND e.subject_id<>$1',
      otherSubjectsOnSameAccount: 'SELECT count(*) FROM community_account_links other WHERE other.subject_id<>$1 AND other.account_id IN (SELECT account_id FROM community_account_links WHERE subject_id=$1)',
      otherAuthorsProjectEvents: 'SELECT count(*) FROM project_events_v2 e JOIN projects_v2 p ON p.id=e.project_id WHERE p.owner_id=$1 AND e.subject_id<>$1',
      transferredProjectsCreatedBySubject: 'SELECT count(*) FROM projects_v2 WHERE creator_id=$1 AND owner_id<>$1',
      otherAuthorsContactEvents: 'SELECT count(*) FROM contact_events_v2 e JOIN contacts_v2 c ON c.id=e.contact_id WHERE (c.initiator_id=$1 OR c.recipient_id=$1) AND e.subject_id<>$1',
      independentExperienceReviews: 'SELECT count(*) FROM experience_objects r JOIN experience_objects e ON e.id=r.experience_id WHERE e.subject_id=$1 AND r.subject_id<>$1',
      otherVerificationDependencies: 'SELECT count(*) FROM verification_dependencies d JOIN verification_objects own ON own.id=d.target_id JOIN verification_objects other ON other.id=d.object_id WHERE own.subject_id=$1 AND other.subject_id<>$1',
    })) dependencies[name] = Number((await db.query(sql, [subjectId])).rows[0].count);
    return { version: 1, subjectId, checkedAt: new Date().toISOString(), ownedDatasets, dependencies,
      physicalDeletionPerformed: false, approvalRequired: true, ownershipVerified: false, productV2Retention,
      storage: { primary: 'inventory-only', backups: 'operator-inventory-required', indexes: 'no-external-index-configured-in-current-implementation',
        localExports: 'user-controlled; not remotely erasable', thirdPartyCopies: 'not remotely erasable' },
      next: ['verify signed subject request and exact requested scope', 'offer takeout before revoking the final binding',
        'record retention basis and approved exceptions', 'revoke selected grants and public projections',
        'execute a reviewed referentially complete deletion plan with minimal tombstones',
        'track backup expiry and deletion replay before restoring service', 'issue a per-storage result; never claim erased from a preview'] };
  });
}
