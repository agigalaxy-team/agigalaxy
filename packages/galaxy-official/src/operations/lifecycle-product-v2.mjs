import { randomUUID } from 'node:crypto';
import { digest } from '../shared/digest.mjs';
import { lifecyclePolicyVersion } from '../infrastructure/lifecycle-registry-v2.mjs';
import {prepareForumDeletionWithin,minimizeForumDeletionWithin} from './community-forum-retention-v1.mjs';

const iso = seconds => new Date(seconds * 1000).toISOString();
export async function recordContentErasure(db, { table, key, subjectId, originalHash = null, requestId = null,
  at, retainedUntil, reason = 'subject-deletion' }) {
  await db.query(`INSERT INTO lifecycle_erasure_records(id,table_name,object_key,subject_id,reason,policy_version,original_payload_hash,request_id,erased_at,retained_until)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT(table_name,object_key) DO NOTHING`,
  [randomUUID(), table, key, subjectId, reason, lifecyclePolicyVersion, originalHash, requestId, iso(at), iso(retainedUntil)]);
}

// Remove only system-maintained copies of selected authors/events. Independent
// text written by another author is never rewritten merely because it responds.
export function redactTaskSnapshot(snapshot, removedIds, subjectId = null) {
  const next = structuredClone(snapshot), belongs = id => removedIds.has(id);
  if (next.suggestions && belongs(next.suggestions.eventId)) next.suggestions = { state: 'content-unavailable', items: [], eventId: next.suggestions.eventId };
  next.invitations = (next.invitations ?? []).map(invite => {
    const value = structuredClone(invite);
    if (belongs(invite.invitationId)) { value.note = ''; value.contentErased = true; }
    value.replies = (value.replies ?? []).map(reply => belongs(reply.eventId) ? { ...reply, message: '', contentErased: true } : reply);
    return value;
  });
  next.applications = (next.applications ?? []).map(application => belongs(application.applicationId)
    ? { applicationId: application.applicationId, subjectId: application.subjectId, state: application.state,
      at: application.at, contentErased: true } : application);
  next.events = (next.events ?? []).map(record => belongs(record.event?.eventId)
    ? { actorId: record.actorId, at: record.at, event: { eventId: record.event.eventId, kind: record.event.kind, contentErased: true } } : record);
  if (subjectId && next.requesterId === subjectId) {
    return { schemaVersion: 2, contentDeleted: true, taskId: next.request?.taskId,
      requesterId: subjectId, version: next.version, state: 'source-unavailable',
      independentEventIds: next.events.filter(e => e.actorId !== subjectId).map(e => e.event.eventId) };
  }
  return next;
}
export function redactParticipationSnapshot(snapshot, removedIds, subjectId = null) {
  const next = structuredClone(snapshot), belongs = id => removedIds.has(id);
  next.events = (next.events ?? []).map(record => belongs(record.event?.eventId)
    ? { actorId: record.actorId, at: record.at, event: { eventId: record.event.eventId, kind: record.event.kind, contentErased: true } } : record);
  if (belongs(next.scopeEventId)) { next.agreedScope = null; next.scopeAvailable = false; }
  if (next.pendingScope && belongs(next.pendingScope.eventId)) next.pendingScope = null;
  next.deliveries = (next.deliveries ?? []).map(delivery => {
    const copy = structuredClone(delivery);
    if (belongs(delivery.deliveryId)) { copy.summary = ''; copy.contentErased = true; }
    if (copy.acceptance && belongs(copy.acceptance.eventId)) copy.acceptance = null;
    return copy;
  });
  for (const field of ['dispute','disputeResolution']) if (next[field] && belongs(next[field].eventId)) next[field] = null;
  if (next.feedback && (belongs(next.feedback.eventId) || subjectId && next.subjectId === subjectId)) next.feedback = null;
  if (subjectId && next.subjectId === subjectId) { next.contentDeleted = true; next.state = 'source-unavailable'; }
  return next;
}

export async function redactTaskEventCopies(db, events, { subjectId = null, requestId = null, at, retainedUntil, reason = 'subject-deletion' }) {
  const removedIds = new Set(events.map(event => event.id)), taskIds = [...new Set(events.map(event => event.task_id))];
  if (subjectId) for (const row of (await db.query('SELECT id FROM task_requests WHERE requester_id=$1', [subjectId])).rows) if (!taskIds.includes(row.id)) taskIds.push(row.id);
  let snapshots = 0;
  for (const taskId of taskIds.sort((left,right)=>left<right?-1:left>right?1:0)) {
    const tasks = (await db.query('SELECT id,requester_id,snapshot FROM task_requests WHERE id=$1 FOR UPDATE', [taskId])).rows;
    for (const row of tasks) {
      const snapshot = redactTaskSnapshot(row.snapshot, removedIds, subjectId);
      if (JSON.stringify(snapshot) === JSON.stringify(row.snapshot)) continue;
      if (subjectId && row.requester_id === subjectId) await recordContentErasure(db, { table: 'task_requests', key: row.id, subjectId,
        originalHash: digest(JSON.stringify(row.snapshot)), requestId, at, retainedUntil, reason });
      await db.query('UPDATE task_requests SET snapshot=$2::jsonb WHERE id=$1', [row.id, JSON.stringify(snapshot)]); snapshots++;
    }
    for (const row of (await db.query('SELECT id,subject_id,snapshot FROM task_participations WHERE task_id=$1 FOR UPDATE', [taskId])).rows) {
      const snapshot = redactParticipationSnapshot(row.snapshot, removedIds, subjectId);
      if (JSON.stringify(snapshot) === JSON.stringify(row.snapshot)) continue;
      if (subjectId && row.subject_id === subjectId) await recordContentErasure(db, { table: 'task_participations', key: row.id, subjectId,
        originalHash: digest(JSON.stringify(row.snapshot)), requestId, at, retainedUntil, reason });
      await db.query('UPDATE task_participations SET snapshot=$2::jsonb WHERE id=$1', [row.id, JSON.stringify(snapshot)]); snapshots++;
    }
  }
  for (const event of events) await recordContentErasure(db, { table: 'task_events', key: event.id, subjectId: event.subject_id,
    originalHash: event.payload_hash, requestId, at, retainedUntil, reason });
  return { snapshotsRedacted: snapshots, eventReceipts: events.length };
}

export async function prepareProductV2Deletion(db, { subjectId, requestId, at, retainedUntil }) {
  // Called only after exact deletion approval is validated, never on request.
  // Keep the private object key until the worker has an actual Delete receipt.
  await db.query('UPDATE chat_attachments SET revoked_at=COALESCE(revoked_at,$2),purge_pending=true WHERE subject_id=$1 AND purged_at IS NULL',[subjectId,iso(at)]);
  // Outcome copies use the same delegated storage lifecycle. Keep their rows
  // as minimal receipts until the worker has an actual object-erasure result;
  // deletion execution must never remove a database pointer before erasing an
  // external Garage/S3 object.
  await db.query("UPDATE outcome_materials_v2 SET state=CASE WHEN state='erased' THEN state ELSE 'revoked' END,purge_pending=true WHERE purged_at IS NULL AND (subject_id=$1 OR author_id=$1)",[subjectId]);
  const info = { subjectId, requestId, at, retainedUntil };
  await prepareForumDeletionWithin(db,info);
  await db.query("UPDATE hub_heads_v2 SET state='suspended' WHERE owner_id=$1",[subjectId]);
  await db.query("UPDATE hub_intake_v2 SET state='closed' WHERE subject_id=$1",[subjectId]);
  await db.query("UPDATE hub_memberships_v2 SET state='exited' WHERE subject_id=$1 AND state IN ('active','invited')",[subjectId]);
  await db.query("UPDATE hub_peering_agreements_v2 SET state='exited' WHERE subject_id=$1",[subjectId]);
  await db.query('UPDATE hub_peering_grants_v2 SET revoked_at=COALESCE(revoked_at,$2) WHERE subject_id=$1',[subjectId,at]);
  // Independent replies may retain the comment ID, not its account identity or
  // source text. The quota ledger has its own bounded audit lifecycle.
  await db.query("UPDATE task_comments_v2 SET state='retracted',account_id=NULL,review_event_id=NULL WHERE subject_id=$1",[subjectId]);
  const events = (await db.query('SELECT id,task_id,subject_id,payload_hash FROM task_events WHERE subject_id=$1', [subjectId])).rows;
  const redacted = await redactTaskEventCopies(db, events, info);
  for (const table of ['case_events', 'verification_events']) {
    const rows = table === 'case_events' ? (await db.query('SELECT id,payload_hash FROM case_events WHERE subject_id=$1', [subjectId])).rows
      : (await db.query('SELECT e.operation_id AS id,e.payload_hash FROM verification_events e JOIN verification_objects o ON o.id=e.object_id WHERE o.subject_id=$1', [subjectId])).rows;
    for (const row of rows) await recordContentErasure(db, { table, key: row.id, originalHash: row.payload_hash, ...info });
  }
  // Case container metadata can outlive its author because another author has
  // independent facts. Workspace/source references are not needed to keep IDs.
  for (const row of (await db.query('SELECT id,local_ref,source_ref FROM cases WHERE subject_id=$1', [subjectId])).rows) {
    const erased = 'erased:' + row.id;
    if (row.local_ref !== erased || row.source_ref !== erased) {
      await recordContentErasure(db, { table: 'cases', key: row.id, originalHash: digest(JSON.stringify({ localRef: row.local_ref, sourceRef: row.source_ref })), ...info });
      await db.query('UPDATE cases SET local_ref=$2,source_ref=$2 WHERE id=$1', [row.id, erased]);
    }
  }
  // Recovery material is a public key, never the user's recovery secret. Disable
  // further control use, preserving the historical signed chain until safe erase.
  await db.query("UPDATE device_authorizations SET status='revoked',revoked_at=COALESCE(revoked_at,$2) WHERE subject_id=$1", [subjectId, iso(at)]);
  await db.query("UPDATE recovery_authorizations SET status='replaced' WHERE subject_id=$1 AND status='active'", [subjectId]);
  await db.query("UPDATE identity_control_operations SET state='canceled' WHERE subject_id=$1 AND state='requested'", [subjectId]);
  await db.query("UPDATE verification_objects SET state='revoked' WHERE subject_id=$1", [subjectId]);
  await db.query("UPDATE experience_objects SET state='revoked' WHERE subject_id=$1", [subjectId]);
  await db.query("UPDATE projects_v2 SET state='archived',updated_at=$2 WHERE owner_id=$1", [subjectId,iso(at)]);
  await db.query("UPDATE recruitment_opportunities SET state=CASE WHEN project_id IN (SELECT id FROM projects_v2 WHERE owner_id=$1) THEN 'closed' ELSE 'paused' END,updated_at=$2 WHERE project_id IN (SELECT id FROM projects_v2 WHERE owner_id=$1) OR publisher_id=$1 OR contact_subject_id=$1",[subjectId,iso(at)]);
  await db.query("UPDATE project_roles_v2 SET state='revoked',updated_at=$2 WHERE subject_id=$1", [subjectId,iso(at)]);
  await db.query("UPDATE project_transfers_v2 SET state='cancelled',updated_at=$2 WHERE state='offered' AND (from_subject_id=$1 OR to_subject_id=$1)", [subjectId,iso(at)]);
  // A pending Contact never becomes accepted by erasure. Existing shared rooms
  // keep the other member's independent relationship and use the chat adapter.
  await db.query("UPDATE contacts_v2 SET state=CASE WHEN initiator_id=$1 THEN 'withdrawn' ELSE 'declined' END,updated_at=$2 WHERE state='sent' AND (initiator_id=$1 OR recipient_id=$1)", [subjectId,iso(at)]);
  await db.query("UPDATE personal_summary_preferences SET enabled=false,updated_at=$2 WHERE subject_id=$1", [subjectId,iso(at)]);
  await db.query("UPDATE personal_summary_versions SET content='{}'::jsonb,state='deleted' WHERE subject_id=$1", [subjectId]);
  await db.query("UPDATE choice_snapshot_preferences SET enabled=false,snapshot_ids='[]',revision=revision+1,updated_at=$2 WHERE subject_id=$1",[subjectId,iso(at)]);
  await db.query("UPDATE choice_snapshot_versions SET content='{}',dependencies='[]',state='deleted' WHERE subject_id=$1",[subjectId]);
  await db.query("UPDATE room_shared_summaries SET content='{}'::jsonb,source_facts='[]'::jsonb,state='retracted',retracted_at=COALESCE(retracted_at,$2) WHERE subject_id=$1", [subjectId,iso(at)]);
  await db.query(`UPDATE community_interactions SET invalidated_at=COALESCE(invalidated_at,$2)
    WHERE counterparty_id=$1 OR source_id IN (SELECT id FROM task_events WHERE subject_id=$1)`, [subjectId, iso(at)]);
  return redacted;
}

// Other authors' references may hold a row after owner-only leaf deletion. A FK
// is not permission to retain the source body. Keep its ID/hash, erase all copies.
export async function minimizeRetainedProductContent(db, info) {
  const minimized = {};
  Object.assign(minimized,await minimizeForumDeletionWithin(db,info));
  // A co-signed display relationship cannot survive physical erasure of a
  // member's proof. This marker is not a forged member-signed revocation.
  await db.query('UPDATE identity_groups_v2 SET source_erased_at=COALESCE(source_erased_at,$2) WHERE member_ids ? $1',[info.subjectId,iso(info.at)]);
  const groupOps=(await db.query("SELECT id,payload_hash FROM identity_group_operations_v2 WHERE subject_id=$1 AND payload_text<>''",[info.subjectId])).rows;
  for(const row of groupOps)await recordContentErasure(db,{table:'identity_group_operations_v2',key:row.id,originalHash:row.payload_hash,...info});
  if(groupOps.length)await db.query("UPDATE identity_group_operations_v2 SET payload_text='',erased_at=COALESCE(erased_at,$2) WHERE subject_id=$1",[info.subjectId,iso(info.at)]);
  minimized.identity_group_operations_v2=groupOps.length;
  for (const table of ['target_governance_events_v2','hub_events_v2','hub_peering_events_v2','qualification_permission_request_events','case_events','task_events','capsule_events','capsule_uses','capsule_uses_v2','capsule_permissions','qualification_calculation_grants','context_grants_v2','context_events_v2','task_comment_events_v2','comment_governance_events_v2']) {
    const rows = (await db.query(`SELECT id,payload_hash FROM ${table} WHERE subject_id=$1 AND payload_text<>''`, [info.subjectId])).rows;
    for (const row of rows) await recordContentErasure(db, { table, key: row.id, originalHash: row.payload_hash, ...info });
    if (rows.length) await db.query(`UPDATE ${table} SET payload_text=''${['capsule_permissions','qualification_calculation_grants'].includes(table)?",revoke_payload_text=CASE WHEN revoke_payload_text IS NULL THEN NULL ELSE '' END":''} WHERE id=ANY($1::uuid[])`, [rows.map(row=>row.id)]);
    minimized[table] = rows.length;
    if (table === 'context_grants_v2' && rows.length) await db.query("UPDATE context_grants_v2 SET erased_at=COALESCE(erased_at,$2) WHERE id=ANY($1::uuid[])",[rows.map(row=>row.id),iso(info.at)]);
    if (['target_governance_events_v2','task_comment_events_v2','comment_governance_events_v2'].includes(table) && rows.length) await db.query(`UPDATE ${table} SET erased_at=COALESCE(erased_at,$2)${table==='task_comment_events_v2'?",text_fingerprint=NULL,link_fingerprints='[]'":''} WHERE id=ANY($1::uuid[])`,[rows.map(row=>row.id),iso(info.at)]);
  }
  const rows=(await db.query("SELECT e.operation_id,e.payload_hash FROM verification_events e JOIN verification_objects o ON o.id=e.object_id WHERE o.subject_id=$1 AND e.payload_text<>''",[info.subjectId])).rows;
  for(const row of rows)await recordContentErasure(db,{table:'verification_events',key:row.operation_id,originalHash:row.payload_hash,...info});
  if(rows.length)await db.query("UPDATE verification_events SET payload_text='',payload='{}'::jsonb,context='{}'::jsonb WHERE operation_id=ANY($1::uuid[])",[rows.map(row=>row.operation_id)]);
  minimized.verification_events=rows.length;
  for(const table of ['project_events_v2','contact_events_v2','experience_events','recruitment_events','configuration_events']) {
    const own=table==='experience_events'?'object_id IN (SELECT id FROM experience_objects WHERE subject_id=$1)':'subject_id=$1';
    const retained=(await db.query(`SELECT operation_id,payload_hash FROM ${table} WHERE ${own} AND payload_text<>''`,[info.subjectId])).rows;
    for(const row of retained)await recordContentErasure(db,{table,key:row.operation_id,originalHash:row.payload_hash,...info});
    // Project affected_fields and last-writer pointers stay: removing them could
    // incorrectly make an older author's value reappear as the current value.
    if(retained.length)await db.query(`UPDATE ${table} SET payload_text=''${table==='experience_events'?",context='{}'::jsonb":''} WHERE operation_id=ANY($1::uuid[])`,[retained.map(row=>row.operation_id)]);
    minimized[table]=retained.length;
  }
  return minimized;
}
