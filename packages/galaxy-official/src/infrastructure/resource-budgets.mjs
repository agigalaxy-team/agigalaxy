import { z } from 'zod';
import { lstat,readFile } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { ServiceError } from '../shared/service-error.mjs';
import {forumSubjectBytesSql} from '../community-forum-budget-v1.mjs';

export const resourceBudgetPolicySchema=z.object({version:z.literal(1),maxPayloadBytesPerSubject:z.number().int().min(0).max(1099511627776),
  maxQueuedJobsPerSubject:z.number().int().min(1).max(100000),maxActiveExportsPerSubject:z.number().int().min(1).max(1000),
  maxActiveJobsGlobal:z.number().int().min(1).max(1000),maxActiveJobsPerSubject:z.number().int().min(1).max(1000)}).strict();
export const defaultResourceBudgetPolicy=resourceBudgetPolicySchema.parse({version:1,maxPayloadBytesPerSubject:1048576,maxQueuedJobsPerSubject:32,maxActiveExportsPerSubject:3,maxActiveJobsGlobal:4,maxActiveJobsPerSubject:1});
export async function loadResourceBudgetPolicy(path){
  if(!path)return structuredClone(defaultResourceBudgetPolicy);
  if(!isAbsolute(path))throw new Error('Absolute resource budget policy path required');
  const info=await lstat(path);if(!info.isFile()||info.isSymbolicLink()||info.size>8192)throw new Error('Invalid resource budget policy');
  return resourceBudgetPolicySchema.parse(JSON.parse(await readFile(path,'utf8')));
}
export const budgetPayloadTables=['external_identity_links','case_events','evidence_submissions','proofs','assistance_events','context_grants','context_acceptances','moderation_reports','moderation_events','capsule_events','capsule_uses','builder_events'];
const bytesSql=budgetPayloadTables.map(table=>`SELECT coalesce(sum(octet_length(payload_text)${table==='proofs'?'+octet_length(signed)':table==='external_identity_links'?'+octet_length(signature)':''}),0)::bigint AS bytes FROM ${table} WHERE ${table==='moderation_reports'?'reporter_id':'subject_id'}=$1`).join(' UNION ALL ');
// Real variable payload bytes plus conservative fixed metadata reservations.
// Chat reserves bodies BEFORE Prosody I/O. Its acknowledgement only fills fixed
// fields; counting null-to-value JSON growth afterwards could cause a false
// rollback after a remote message had already been accepted.
const productBytesSql = [
  "SELECT coalesce(sum(octet_length(purpose)+1024),0)::bigint AS bytes FROM watch_controls_v2 WHERE subject_id=$1",
  "SELECT coalesce(sum(octet_length(result::text)+512),0)::bigint AS bytes FROM watch_control_operations_v2 WHERE subject_id=$1",
  "SELECT coalesce(sum(octet_length(member_ids::text)+1024),0)::bigint AS bytes FROM identity_groups_v2 WHERE subject_id=$1",
  "SELECT coalesce(sum(octet_length(payload_text)+octet_length(required_ids::text)+1024),0)::bigint AS bytes FROM identity_group_operations_v2 WHERE subject_id=$1",
  "SELECT coalesce(sum(octet_length(proof_text)+octet_length(signature)+1024),0)::bigint AS bytes FROM identity_group_approvals_v2 WHERE subject_id=$1",
  "SELECT coalesce(sum(octet_length(payload_text)+1024),0)::bigint AS bytes FROM target_governance_events_v2 WHERE subject_id=$1",
  "SELECT coalesce(sum(octet_length(party_ids::text)+2048),0)::bigint AS bytes FROM target_reports_v2 WHERE subject_id=$1",
  "SELECT coalesce(sum(octet_length(plan::text)+octet_length(baseline::text)+octet_length(scan::text)+1024),0)::bigint AS bytes FROM information_watches_v2 WHERE subject_id=$1",
  "SELECT coalesce(sum(octet_length(result::text)+512),0)::bigint AS bytes FROM information_watch_operations_v2 WHERE subject_id=$1",
  "SELECT coalesce(sum(octet_length(changes::text)+512),0)::bigint AS bytes FROM information_watch_changes_v2 WHERE subject_id=$1",
  "SELECT coalesce(sum(octet_length(payload_text)+1024),0)::bigint AS bytes FROM hub_events_v2 WHERE subject_id=$1",
  "SELECT coalesce(sum(octet_length(payload_text)+1024),0)::bigint AS bytes FROM hub_peering_events_v2 WHERE subject_id=$1",
  "SELECT count(*)*2048 AS bytes FROM hub_heads_v2 WHERE owner_id=$1",
  "SELECT count(*)*1024 AS bytes FROM hub_memberships_v2 WHERE subject_id=$1",
  "SELECT count(*)*1024 AS bytes FROM hub_intake_v2 WHERE subject_id=$1",
  "SELECT count(*)*2048 AS bytes FROM hub_peering_agreements_v2 WHERE subject_id=$1",
  "SELECT count(*)*2048 AS bytes FROM hub_peering_grants_v2 WHERE subject_id=$1",
  "SELECT count(*)*512 AS bytes FROM hub_peering_changes_v2 WHERE subject_id=$1",
  "SELECT count(*)*512 AS bytes FROM hub_peering_receipts_v2 WHERE subject_id=$1",
  "SELECT coalesce(sum(octet_length(payload_text)+octet_length(signed)+octet_length(identity::text)+coalesce(octet_length(revoke_payload_text),0)+coalesce(octet_length(revoke_signed),0)+2048),0)::bigint AS bytes FROM trust_package_permissions WHERE subject_id=$1",
  "SELECT coalesce(sum(octet_length(payload_text)+octet_length(link_fingerprints::text)+1024),0)::bigint AS bytes FROM task_comment_events_v2 WHERE subject_id=$1",
  "SELECT coalesce(sum(octet_length(payload_text)+1024),0)::bigint AS bytes FROM comment_governance_events_v2 WHERE subject_id=$1",
  "SELECT (count(*)*1024)::bigint AS bytes FROM task_comments_v2 WHERE subject_id=$1",
  "SELECT (count(*)*1024)::bigint AS bytes FROM comment_reports_v2 WHERE reporter_id=$1",
  "SELECT coalesce(sum(octet_length(payload_text)+81920),0)::bigint AS bytes FROM ci_requests_v2 WHERE subject_id=$1",
  "SELECT coalesce(sum(octet_length(payload_text)+octet_length(signed)+1024),0)::bigint AS bytes FROM ci_proofs_v2 WHERE subject_id=$1",
  "SELECT coalesce(sum(octet_length(payload_text)+1024),0)::bigint AS bytes FROM context_grants_v2 WHERE subject_id=$1",
  "SELECT coalesce(sum(octet_length(payload_text)+1024),0)::bigint AS bytes FROM context_events_v2 WHERE subject_id=$1",
  "SELECT coalesce(sum(octet_length(payload_text)+512),0)::bigint AS bytes FROM task_events WHERE subject_id=$1",
  "SELECT coalesce(sum(octet_length(snapshot::text)+512),0)::bigint AS bytes FROM task_requests WHERE requester_id=$1",
  "SELECT coalesce(sum(octet_length(body_text)+octet_length(descriptor::text)+1024),0)::bigint AS bytes FROM task_materials_v1 WHERE subject_id=$1",
  "SELECT coalesce(sum(coalesce(octet_length(c.signature_envelope),0)+coalesce(octet_length(c.signed_payload_text),0)+octet_length(c.intent::text)+512),0)::bigint AS bytes FROM consents c WHERE c.subject_id=$1 AND c.intent->>'action'='assistance.publish' AND c.intent->'fields' ? 'materials'",
  "SELECT coalesce(sum(octet_length(to_jsonb(a)::text)+512),0)::bigint AS bytes FROM audit_events a WHERE a.actor=$1 AND a.object_id IN(SELECT c.id::text FROM consents c WHERE c.subject_id=$1 AND c.intent->>'action'='assistance.publish' AND c.intent->'fields' ? 'materials' UNION SELECT c.intent->>'objectId' FROM consents c WHERE c.subject_id=$1 AND c.intent->>'action'='assistance.publish' AND c.intent->'fields' ? 'materials')",
  "SELECT coalesce(sum(octet_length(snapshot::text)+512),0)::bigint AS bytes FROM task_participations WHERE subject_id=$1",
  "SELECT coalesce(sum(octet_length(e.payload_text)+octet_length(e.payload::text)+octet_length(e.context::text)+512),0)::bigint AS bytes FROM verification_events e JOIN verification_objects o ON o.id=e.object_id WHERE o.subject_id=$1",
  "SELECT coalesce(sum(octet_length(payload_text)+coalesce(octet_length(revoke_payload_text),0)+1024),0)::bigint AS bytes FROM capsule_permissions WHERE subject_id=$1",
  "SELECT coalesce(sum(octet_length(payload_text)+1024),0)::bigint AS bytes FROM capsule_uses_v2 WHERE subject_id=$1",
  "SELECT coalesce(sum(2048+octet_length(title)+octet_length(task_refs::text)),0)::bigint AS bytes FROM chat_rooms WHERE creator_subject_id=$1",
  "SELECT (count(*)*512)::bigint AS bytes FROM chat_memberships WHERE subject_id=$1",
  "SELECT coalesce(sum(1024+octet_length(payload::text)+octet_length(required_parties::text)+octet_length(votes::text)),0)::bigint AS bytes FROM chat_decisions WHERE proposer_subject_id=$1",
  "SELECT coalesce(sum(content_bytes+1024),0)::bigint AS bytes FROM chat_message_refs WHERE subject_id=$1",
  "SELECT (count(*)*1024)::bigint AS bytes FROM chat_message_operations WHERE subject_id=$1",
  "SELECT (count(*)*512)::bigint AS bytes FROM chat_cursors WHERE subject_id=$1",
  "SELECT (count(*)*512)::bigint AS bytes FROM chat_message_preferences WHERE subject_id=$1",
  "SELECT (count(*)*1024)::bigint AS bytes FROM chat_agent_grants WHERE subject_id=$1",
  "SELECT coalesce(sum(1024+octet_length(name)+octet_length(media_type)),0)::bigint AS bytes FROM chat_attachments WHERE subject_id=$1",
  "SELECT coalesce(sum(byte_size+2048+octet_length(title)+octet_length(source::text)+octet_length(audience::text)),0)::bigint AS bytes FROM outcome_materials_v2 WHERE subject_id=$1",
  "SELECT coalesce(sum(octet_length(settings::text)+1024),0)::bigint AS bytes FROM notification_options_v2 WHERE subject_id=$1",
  "SELECT (count(*)*1024)::bigint AS bytes FROM notification_presentations WHERE subject_id=$1",
  "SELECT coalesce(sum(coalesce(octet_length(room_ids::text),0)+2048),0)::bigint AS bytes FROM personal_summary_preferences WHERE subject_id=$1",
  "SELECT (count(*)*1024)::bigint AS bytes FROM personal_summary_heads WHERE subject_id=$1",
  "SELECT coalesce(sum(octet_length(content::text)+1024),0)::bigint AS bytes FROM personal_summary_versions WHERE subject_id=$1",
  "SELECT coalesce(sum(octet_length(snapshot_ids::text)+1024),0)::bigint AS bytes FROM choice_snapshot_preferences WHERE subject_id=$1",
  "SELECT (count(*)*1024)::bigint AS bytes FROM choice_snapshot_heads WHERE subject_id=$1",
  "SELECT coalesce(sum(octet_length(content::text)+octet_length(dependencies::text)+1024),0)::bigint AS bytes FROM choice_snapshot_versions WHERE subject_id=$1",
  "SELECT coalesce(sum(octet_length(payload_text)+octet_length(affected_fields::text)+1024),0)::bigint AS bytes FROM project_events_v2 WHERE subject_id=$1",
  "SELECT (count(*)*1024)::bigint AS bytes FROM projects_v2 WHERE owner_id=$1",
  "SELECT (count(*)*512)::bigint AS bytes FROM project_field_sources_v2 f JOIN projects_v2 p ON p.id=f.project_id WHERE p.owner_id=$1",
  "SELECT (count(*)*512)::bigint AS bytes FROM project_roles_v2 WHERE subject_id=$1",
  "SELECT (count(*)*1024)::bigint AS bytes FROM project_transfers_v2 WHERE from_subject_id=$1",
  "SELECT coalesce(sum(octet_length(settings::text)+1024),0)::bigint AS bytes FROM project_preferences_v2 WHERE subject_id=$1",
  "SELECT coalesce(sum(octet_length(payload_text)+1024),0)::bigint AS bytes FROM contact_events_v2 WHERE subject_id=$1",
  "SELECT (count(*)*1024)::bigint AS bytes FROM contacts_v2 WHERE initiator_id=$1",
  "SELECT coalesce(sum(octet_length(e.payload_text)+octet_length(e.context::text)+1024),0)::bigint AS bytes FROM experience_events e JOIN experience_objects o ON o.id=e.object_id WHERE o.subject_id=$1",
  "SELECT coalesce(sum(coalesce(octet_length(source_key),0)+1024),0)::bigint AS bytes FROM experience_objects WHERE subject_id=$1",
  "SELECT coalesce(sum(octet_length(payload_text)+coalesce(octet_length(revoke_payload_text),0)+1024),0)::bigint AS bytes FROM qualification_calculation_grants WHERE subject_id=$1",
  "SELECT coalesce(sum(octet_length(payload_text)+1024),0)::bigint AS bytes FROM qualification_permission_request_events WHERE subject_id=$1",
  "SELECT count(*)*1024 AS bytes FROM qualification_permission_requests WHERE subject_id=$1",
  "SELECT coalesce(sum(octet_length(payload_text)+octet_length(source_refs::text)+coalesce(octet_length(revoke_payload_text),0)+1024),0)::bigint AS bytes FROM contribution_publications WHERE subject_id=$1",
  "SELECT coalesce(sum(octet_length(content::text)+octet_length(source_facts::text)+2048),0)::bigint AS bytes FROM room_shared_summaries WHERE subject_id=$1",
  "SELECT coalesce(sum(octet_length(payload_text)+1024),0)::bigint AS bytes FROM recruitment_events WHERE subject_id=$1",
  "SELECT (count(*)*1024)::bigint AS bytes FROM recruitment_opportunities WHERE publisher_id=$1",
  "SELECT (count(*)*1024)::bigint AS bytes FROM recruitment_task_links WHERE subject_id=$1",
  "SELECT (count(*)*1024)::bigint AS bytes FROM configuration_objects WHERE subject_id=$1",
  "SELECT (count(*)*1024)::bigint AS bytes FROM worker_pack_uses WHERE subject_id=$1",
  "SELECT coalesce(sum(octet_length(payload_text)+1024),0)::bigint AS bytes FROM worker_pack_use_events WHERE subject_id=$1",
  "SELECT coalesce(sum(octet_length(payload_text)+1024),0)::bigint AS bytes FROM configuration_events WHERE subject_id=$1",
].join(' UNION ALL ');
export async function lockSubjectResourceBudget(db,subjectId){await db.query('SELECT pg_advisory_xact_lock(734912309,hashtext($1))',[subjectId]);}
export async function subjectResourceUsage(db,subjectId,now){
  const bytes=(await db.query(`SELECT coalesce(sum(bytes),0)::text AS bytes FROM (${bytesSql} UNION ALL ${productBytesSql} UNION ALL ${forumSubjectBytesSql}) AS owned_payloads`,[subjectId])).rows[0].bytes;
  const jobs=(await db.query("SELECT count(*)::text AS count FROM jobs j LEFT JOIN evidence_submissions e ON j.payload->>'evidenceId'=e.id::text LEFT JOIN ci_requests_v2 ci ON j.payload->>'ciRequestId'=ci.id::text WHERE (e.subject_id=$1 OR ci.subject_id=$1 OR j.kind='builder-probe' AND j.payload->>'subjectId'=$1) AND j.state IN ('pending','running')",[subjectId])).rows[0].count;
  const exports=(await db.query('SELECT count(*)::text AS count FROM data_exports WHERE subject_id=$1 AND revoked_at IS NULL AND expires_at>$2',[subjectId,new Date(now*1000).toISOString()])).rows[0].count;
  return {payloadBytes:BigInt(bytes),queuedJobs:Number(jobs),activeExports:Number(exports)};
}
export function enforceResourceGrowth(before,after,policy){
  if(after.payloadBytes>BigInt(policy.maxPayloadBytesPerSubject)&&after.payloadBytes>before.payloadBytes)throw new ServiceError('storage_quota_exceeded',409);
  if(after.queuedJobs>policy.maxQueuedJobsPerSubject&&after.queuedJobs>before.queuedJobs)throw new ServiceError('job_queue_quota_exceeded',409);
  if(after.activeExports>policy.maxActiveExportsPerSubject&&after.activeExports>before.activeExports)throw new ServiceError('export_ticket_quota_exceeded',409);
}
