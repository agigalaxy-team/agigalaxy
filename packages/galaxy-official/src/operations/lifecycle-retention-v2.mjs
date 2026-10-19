import { transaction } from '../database.mjs';
import { redactTaskEventCopies, recordContentErasure } from './lifecycle-product-v2.mjs';
import { productV2Retention } from '../infrastructure/lifecycle-registry-v2.mjs';
import { cleanupTaskCommentsWithin } from './task-comment-retention-v2.mjs';
import {cleanupQualificationRequestsWithin} from './qualification-request-retention-v2.mjs';
import {cleanupHubsWithin} from './hub-retention-v2.mjs';
import {cleanupInformationWatchesWithin} from './information-watch-retention-v2.mjs';
import {cleanupTargetGovernanceWithin} from './target-governance-retention-v2.mjs';
import {cleanupIdentityGroupsWithin} from './identity-group-retention-v2.mjs';
import {cleanupWatchControlsWithin} from './watch-control-retention-v2.mjs';
import {cleanupOutcomeMaterialsWithin} from './outcome-material-retention-v2.mjs';
import {cleanupForumWithin} from './community-forum-retention-v1.mjs';
import {cleanupTaskMaterialsWithin} from './task-material-retention-v1.mjs';
import {cleanupPrivateConversationsWithin} from './private-conversation-retention.mjs';

const day = 86400;
// Bounded worker maintenance, never a backup or an inference loop. Original
// event hashes remain; erased bytes can no longer be cryptographically replayed.
export async function cleanupProductV2Retention(database, { now = () => Math.floor(Date.now() / 1000), outcomeStore = null,forumPolicy,endpoint } = {}) {
  const at = now(); if (!Number.isSafeInteger(at) || at < 0) throw new Error('Invalid lifecycle clock');
  const iso = seconds => new Date(seconds * 1000).toISOString();
  return transaction(database, async db => {
    const removed = {};
    Object.assign(removed,await cleanupPrivateConversationsWithin(db,at));
    Object.assign(removed,await cleanupTaskMaterialsWithin(db,at,{endpoint,forumPolicy}));
    Object.assign(removed,await cleanupForumWithin(db,at,{policy:forumPolicy,endpoint}));
    Object.assign(removed,await cleanupWatchControlsWithin(db,at));
    Object.assign(removed,await cleanupIdentityGroupsWithin(db,at));
    Object.assign(removed,await cleanupTargetGovernanceWithin(db,at));
    Object.assign(removed,await cleanupInformationWatchesWithin(db,at));
    Object.assign(removed,await cleanupHubsWithin(db,at));
    Object.assign(removed,await cleanupTaskCommentsWithin(db,at));
    Object.assign(removed,await cleanupQualificationRequestsWithin(db,at));
    Object.assign(removed,await cleanupOutcomeMaterialsWithin(db,at,{store:outcomeStore}));
    removed.trustPackagePermissionReceipts=(await db.query(`DELETE FROM trust_package_permissions WHERE id IN
      (SELECT id FROM trust_package_permissions WHERE expires_at<=$1 ORDER BY expires_at,id LIMIT 100)`,
      [iso(at-productV2Retention.trustPackagePermissions.receiptDaysAfterExpiry*day)])).rowCount;
    const expiredContext = (await db.query(`SELECT id,subject_id,payload_hash FROM context_grants_v2 WHERE expires_at<=$1 AND payload_text<>''
      ORDER BY expires_at,id LIMIT 100 FOR UPDATE`,[iso(at)])).rows;
    for (const row of expiredContext) await recordContentErasure(db,{table:'context_grants_v2',key:row.id,subjectId:row.subject_id,
      originalHash:row.payload_hash,at,retainedUntil:at+180*day,reason:'temporary-content-expired'});
    removed.expiredContextBodies=expiredContext.length?(await db.query("UPDATE context_grants_v2 SET payload_text='',erased_at=COALESCE(erased_at,$2) WHERE id=ANY($1::uuid[])",[expiredContext.map(row=>row.id),iso(at)])).rowCount:0;
    removed.identityOperations = (await db.query(`DELETE FROM identity_control_operations WHERE id IN
      (SELECT id FROM identity_control_operations WHERE expires_at<=$1 ORDER BY expires_at,id LIMIT 100)`, [iso(at-day)])).rowCount;
    removed.dailyUsage = (await db.query(`DELETE FROM community_daily_usage WHERE (account_id,day,category) IN
      (SELECT account_id,day,category FROM community_daily_usage WHERE day<$1::date ORDER BY day,account_id,category LIMIT 100)`, [iso(at-30*day)])).rowCount;
    removed.writeReceipts = (await db.query(`DELETE FROM community_write_receipts WHERE (account_id,category,operation_id) IN
      (SELECT account_id,category,operation_id FROM community_write_receipts WHERE created_at<=$1 ORDER BY created_at,account_id,operation_id LIMIT 100)`, [iso(at-180*day)])).rowCount;
    const events = (await db.query(`SELECT id,task_id,subject_id,payload_hash FROM task_events
      WHERE kind=ANY($1::text[]) AND created_at<=$2 AND payload_text<>'' ORDER BY task_id,id LIMIT 100`,
    [productV2Retention.taskEvents.temporaryKinds, iso(at-90*day)])).rows;
    let snapshotsRedacted = 0;
    if (events.length) {
      const result = await redactTaskEventCopies(db, events, { at, retainedUntil: at+180*day, reason: 'temporary-content-expired' });
      snapshotsRedacted = result.snapshotsRedacted;
      removed.temporaryTaskBodies = (await db.query("UPDATE task_events SET payload_text='' WHERE id=ANY($1::uuid[]) AND payload_text<>''", [events.map(e => e.id)])).rowCount;
    } else removed.temporaryTaskBodies = 0;
    const contactEvents=(await db.query(`SELECT operation_id,subject_id,payload_hash FROM contact_events_v2 WHERE payload_text<>'' AND created_at<=$1
      ORDER BY created_at,operation_id LIMIT 100`,[iso(at-productV2Retention.contacts.contentDays*day)])).rows;
    for(const event of contactEvents)await recordContentErasure(db,{table:'contact_events_v2',key:event.operation_id,subjectId:event.subject_id,
      originalHash:event.payload_hash,at,retainedUntil:at+180*day,reason:'temporary-content-expired'});
    removed.temporaryContactBodies=contactEvents.length?(await db.query("UPDATE contact_events_v2 SET payload_text='' WHERE operation_id=ANY($1::uuid[])",[contactEvents.map(e=>e.operation_id)])).rowCount:0;
    removed.erasureReceipts = (await db.query(`DELETE FROM lifecycle_erasure_records WHERE id IN
      (SELECT id FROM lifecycle_erasure_records WHERE retained_until<=$1 ORDER BY retained_until,id LIMIT 100)`, [iso(at)])).rowCount;
    return { removed, snapshotsRedacted, maximumRowsPerCategory: 100, backupStarted: false,
      cryptoMeaning: 'original-hash-retained; erased-original-bytes-not-reverifiable',
      relationshipAndResultFactsAutomaticallyExpired: false };
  });
}
