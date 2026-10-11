import { productV2Retention } from './lifecycle-registry-v2.mjs';
import {ServiceError} from '../shared/service-error.mjs';
const row = (table, owner, fields, key = 't.id::text', cutoff = 't.created_at') => ({ from: `${table} t`, owner: `t.${owner}`, fields, key, cutoff });
async function taskMaterialExport(item,_now,{db,actor,viewServices}){
 let allowed=false;
 try{
  await viewServices.assistance.requireTaskWithin(db,actor,item.task_id);
  allowed=(await viewServices.assistance.taskMaterials.statusWithin(db,item)).available;
 }catch(error){if(!(error instanceof ServiceError)||![403,404].includes(error.status))throw error;}
 return {...item,body_text:allowed?item.body_text:'',contentAvailable:allowed,authority:'current-task-and-source-permission; original descriptor/hash are historical'};
}
async function forumEventExport(item,_now,{db,actor,viewServices}){
 const forum=viewServices.forum;let allowed=false;
 if(forum&&item.payload_text){
  if(item.kind==='create-post'||item.kind==='publish-version')allowed=(await forum.readVersionWithin(db,item.post_id,item.version_id)).availability==='available';
  else if(item.kind==='create-reply')allowed=(await forum.readReplyWithin(db,item.reply_id)).availability==='available';
  else allowed=(await forum.permissions.statusWithin(db,item.permission_id,{viewerId:actor.subjectId,payloadHash:item.payload_hash})).allowed;
 }
 return {...item,payload_text:allowed?item.payload_text:'',contentAvailable:allowed,authority:'current-forum-read-only; original hash is historical'};
}
async function forumGovernanceExport(item,_now,{db,actor,viewServices}){
 const allowed=!!item.payload_text&&!!viewServices.forum&&(await viewServices.forum.permissions.statusWithin(db,item.permission_id,{visibility:'Private',viewerId:actor.subjectId,payloadHash:item.payload_hash})).allowed;
 return {...item,payload_text:allowed?item.payload_text:'',contentAvailable:allowed,authority:'current-exact-private-forum-permission-only'};
}
// Owner submissions do not include the mixed-author Task/Participation snapshot.
// Those composites are exported only through a fresh authorized-view read.
export const productV2ExportSources = {
  'task-materials':{...row('task_materials_v1','subject_id','t.material_id,t.task_id,t.subject_id,t.root_event_id,t.consent_id,t.descriptor,t.body_text,t.text_hash,t.created_at,t.expires_at,t.erased_at','t.material_id::text'),transform:taskMaterialExport},
  'forum-post-heads':row('forum_posts_v1','subject_id','t.id,t.subject_id,t.head_version,t.current_version_id,t.state,t.created_at,t.updated_at,t.erased_at'),
  'forum-version-locators':row('forum_versions_v1','subject_id','t.id,t.post_id,t.version_number,t.publication_event_id,t.permission_id,t.payload_hash,t.published_until,t.state,t.created_at,t.erased_at'),
  'forum-reply-locators':row('forum_replies_v1','subject_id','t.id,t.post_id,t.post_version_id,t.reply_to_id,t.content_revision,t.revision,t.publication_event_id,t.permission_id,t.payload_hash,t.published_until,t.state,t.created_at,t.erased_at'),
  'forum-events':{...row('forum_events_v1','subject_id','t.id,t.subject_id,t.kind,t.post_id,t.version_id,t.reply_id,t.payload_text,t.payload_hash,t.result,t.created_at,t.erased_at,p.id permission_id'),from:'forum_events_v1 t LEFT JOIN forum_permissions_v1 p ON p.event_id=t.id',transform:forumEventExport},
  'forum-permissions':row('forum_permissions_v1','subject_id','t.id,t.event_id,t.consent_id,t.origin_binding_id,t.source_device_id,t.source_key_id,t.accepted_epoch,t.accepted_control_hash,t.signature_hash,t.payload_hash,t.action,t.object_id,t.visibility,t.fields,t.viewers,t.issued_at,t.published_until,t.accepted_at,t.authorization_audit_until,t.revoked_at,t.erased_at,t.policy_hash','t.id::text','t.accepted_at'),
  'forum-report-locators':row('forum_reports_v1','subject_id','t.id,t.target,t.version,t.state,t.appeal_count,t.decision_event_id,t.restriction_event_id,t.restriction_until,t.created_at,t.closed_at,t.audit_until'),
  'forum-governance-events':{...row('forum_governance_events_v1','subject_id','t.id,t.operation_id,t.report_id,t.subject_id,t.version,t.kind,t.permission_id,t.payload_text,t.payload_hash,t.created_at,t.erased_at,t.resolution,t.effect_until'),transform:forumGovernanceExport},
  'forum-write-receipts':row('forum_write_receipts_v1','subject_id','t.operation_id,t.category,t.payload_hash,t.locator,t.result,t.created_at,t.retained_until','t.operation_id::text'),
  'forum-daily-usage':{from:'forum_daily_usage_v1 t',owner:'(SELECT $1::text WHERE EXISTS(SELECT 1 FROM community_account_links l WHERE l.subject_id=$1 AND l.account_id=t.account_id))',fields:'t.account_id,t.day,t.category,t.used',key:"t.account_id::text||':'||t.day::text||':'||t.category",cutoff:'t.day::timestamp'},
  'outcome-materials-v2':row('outcome_materials_v2','subject_id','t.id,t.subject_id,t.author_id,t.case_id,t.task_id,t.source,t.source_kind,t.audience,t.uses,t.title,t.request_id,t.approval_id,t.revision,t.state,t.created_at,t.request_expires_at,t.approved_at,t.expires_at,t.body_text,t.name,t.media_type,t.byte_size,t.sha256,t.scan_result,t.purge_pending,t.purged_at'),
  'watch-controls':row('watch_controls_v2','subject_id','t.watch_id,t.subject_id,t.room_id,t.task_id,t.purpose,t.revision,t.state,t.current_grant_id,t.current_binding_id,t.expires_at,t.created_at,t.updated_at,t.stopped_at','t.watch_id::text'),
  'watch-control-operations':row('watch_control_operations_v2','subject_id','t.operation_id,t.watch_id,t.subject_id,t.binding_id,t.kind,t.request_hash,t.result,t.created_at','t.operation_id::text'),
  'identity-group-heads':row('identity_groups_v2','subject_id','t.id,t.subject_id,t.version,t.state,t.current_operation_id,t.created_at,t.updated_at,t.source_erased_at'),
  'identity-group-operations':row('identity_group_operations_v2','subject_id','t.id,t.group_id,t.subject_id,t.kind,t.expected_version,t.payload_text,t.payload_hash,t.state,t.result_version,t.created_at,t.expires_at,t.closed_at,t.erased_at'),
  'identity-group-approvals':row('identity_group_approvals_v2','subject_id','t.id,t.operation_id,t.subject_id,t.decision,t.proof_text,t.signature,t.key_id,t.epoch,t.public_key,t.chain_head,t.created_at'),
  'information-watches':row('information_watches_v2','subject_id','t.id,t.subject_id,t.revision,t.check_revision,t.state,t.plan,t.expires_at,t.last_checked_at,t.next_check_at,t.created_at,t.updated_at,t.ended_at'),
  'information-watch-operations':row('information_watch_operations_v2','subject_id','t.operation_id,t.subject_id,t.watch_id,t.request_hash,t.result,t.created_at','t.operation_id::text'),
  'information-change-receipts':row('information_watch_changes_v2','subject_id','t.id,t.subject_id,t.watch_id,t.batch_key,t.created_at,t.available_at,t.expires_at'),
  'worker-pack-uses':row('worker_pack_uses','subject_id','t.id,t.subject_id,t.builder_id,t.manifest_id,t.case_id,t.attempt_id,t.version,t.state,t.created_at'),
  'worker-pack-use-events':row('worker_pack_use_events','subject_id','t.operation_id,t.use_id,t.subject_id,t.version,t.kind,t.consent_id,t.payload_text,t.payload_hash,t.created_at','t.operation_id::text'),
  'hub-heads-v2':row('hub_heads_v2','owner_id','t.id,t.owner_id,t.version,t.state,t.created_at'),
  'hub-events-v2':{...row('hub_events_v2','subject_id','t.id,t.hub_id,t.subject_id,t.kind,t.charter_version,t.object_id,t.object_version,t.consent_id,t.payload_text,t.payload_hash,t.received_at,i.expires_at','t.id::text','to_timestamp(t.received_at)'),
    from:'hub_events_v2 t LEFT JOIN hub_intake_v2 i ON i.id=t.object_id',transform:(item,now)=>item.kind.startsWith('intake-')&&item.expires_at<=now?{...item,payload_text:'',contentExpired:true,originalSignatureReverifiable:false}:item},
  'hub-memberships-v2':row('hub_memberships_v2','subject_id','t.id,t.hub_id,t.subject_id,t.version,t.charter_version,t.state,t.scopes,t.invite_id,t.decision_id,t.expires_at,t.created_at'),
  'hub-intake-receipts-v2':row('hub_intake_v2','subject_id','t.id,t.hub_id,t.subject_id,t.version,t.state,t.created_at,t.expires_at','t.id::text','to_timestamp(t.created_at)'),
  'hub-peering-agreements-v2':row('hub_peering_agreements_v2','subject_id','t.id,t.hub_id,t.subject_id,t.version,t.agreement_hash,t.state,t.event_id,t.expires_at,t.created_at'),
  'hub-peering-events-v2':row('hub_peering_events_v2','subject_id','t.id,t.hub_id,t.subject_id,t.kind,t.object_id,t.consent_id,t.payload_text,t.payload_hash,t.received_at','t.id::text','to_timestamp(t.received_at)'),
  'hub-peering-grants-v2':row('hub_peering_grants_v2','subject_id','t.id,t.hub_id,t.subject_id,t.agreement_id,t.agreement_version,t.requester_ids,t.expires_at,t.revoked_at,t.last_state,t.created_at'),
  'hub-peering-changes-v2':row('hub_peering_changes_v2','subject_id','t.sequence,t.grant_id,t.agreement_id,t.subject_id,t.state,t.observed_at','lpad(t.sequence::text,20,\'0\')','to_timestamp(t.observed_at)'),
  'hub-peering-receipts-v2':row('hub_peering_receipts_v2','subject_id','t.query_id,t.side,t.agreement_id,t.subject_id,t.request_hash,t.response_hash,t.state,t.created_at,t.checked_at',"t.query_id::text||':'||t.side",'to_timestamp(t.created_at)'),
  'trust-package-permissions':row('trust_package_permissions','subject_id','t.id,t.subject_id,t.grantee_id,t.operation_id,t.payload_text,t.signed,t.signature_hash,t.identity,t.created_at,t.expires_at,t.revoked_at,t.revoke_operation_id,t.revoke_payload_text,t.revoke_signed,t.revoke_signature_hash'),
  'qualification-request-receipts':row('qualification_permission_requests','subject_id','t.id,t.subject_id,t.source_author_id,t.task_id,t.scope_hash,t.root_event_id,t.version,t.state,t.expires_at,t.created_at'),
  'qualification-request-events':{...row('qualification_permission_request_events','subject_id',"t.id,t.request_id,t.subject_id,t.version,t.kind,t.consent_id,t.payload_text,t.payload_hash,t.created_at,r.expires_at"),
    from:'qualification_permission_request_events t JOIN qualification_permission_requests r ON r.id=t.request_id',transform:(item,now)=>Date.parse(item.expires_at)<=now*1000?{...item,payload_text:'',content_expired:true,originalSignatureReverifiable:false}:item},
  'chat-attachment-receipts':row('chat_attachments','subject_id','t.id,t.room_id,t.subject_id,t.message_id,t.request_hash,t.name,t.media_type,t.byte_size,t.sha256,t.state,t.created_at,t.uploaded_at,t.expires_at,t.prepare_expires_at,t.scan_result,t.revoked_at,t.purge_pending,t.purged_at,t.policy_version'),
  'configuration-objects':row('configuration_objects','subject_id','t.id,t.subject_id,t.version,t.state,t.created_at'),
  'configuration-events':row('configuration_events','subject_id',"t.operation_id,t.configuration_id,t.subject_id,t.version,t.kind,t.consent_id,t.payload_text,t.payload_hash,t.created_at,(t.payload_text='') AS content_erased",'t.operation_id::text'),
  'choice-snapshot-preferences':row('choice_snapshot_preferences','subject_id','t.subject_id,t.revision,t.endpoint,t.enabled,t.snapshot_ids,t.updated_at','t.subject_id','t.updated_at'),
  'choice-snapshot-heads':row('choice_snapshot_heads','subject_id','t.subject_id,t.snapshot_id,t.revision,t.current_version_id,t.deleted_at,t.created_at,t.updated_at',"t.subject_id||':'||t.snapshot_id::text"),
  'choice-snapshot-version-receipts':row('choice_snapshot_versions','subject_id','t.subject_id,t.snapshot_id,t.version_id,t.base_revision,t.revision,t.request_hash,t.state,t.created_at,t.expires_at',"t.subject_id||':'||t.version_id::text"),
  'task-comments-v2':row('task_comments_v2','subject_id','t.id,t.task_id,t.subject_id,t.revision,t.current_event_id,t.reply_to_id,t.reply_to_revision,t.state,t.review_state,t.rule_version,t.rule_reasons,t.created_at,t.expires_at'),
  'task-comment-events-v2':{...row('task_comment_events_v2','subject_id','t.id,t.comment_id,t.task_id,t.subject_id,t.revision,t.kind,t.consent_id,t.payload_text,t.payload_hash,t.created_at,t.erased_at,c.expires_at'),from:'task_comment_events_v2 t JOIN task_comments_v2 c ON c.id=t.comment_id',transform:(item,now)=>Date.parse(item.expires_at)<=now*1000?{...item,payload_text:'',content_expired:true,originalSignatureReverifiable:false}:item},
  'target-report-receipts-v2':row('target_reports_v2','subject_id','t.id,t.subject_id,t.target_type,t.task_id,t.room_id,t.target_version,t.root_event_id,t.version,t.state,t.restriction_scopes,t.restriction_until,t.closed_at,t.created_at'),
  'target-governance-events-v2':{...row('target_governance_events_v2','subject_id','t.id,t.report_id,t.subject_id,t.version,t.kind,t.consent_id,t.payload_text,t.payload_hash,t.created_at,t.erased_at,r.closed_at'),from:'target_governance_events_v2 t JOIN target_reports_v2 r ON r.id=t.report_id',transform:(item,now)=>item.closed_at&&Date.parse(item.closed_at)+180*86400000<=now*1000?{...item,payload_text:'',content_expired:true,originalSignatureReverifiable:false}:item},
  'comment-report-receipts-v2':row('comment_reports_v2','reporter_id','t.id,t.comment_id,t.comment_revision,t.reporter_id,t.version,t.state,t.pause_until,t.closed_at,t.created_at'),
  'comment-governance-events-v2':{...row('comment_governance_events_v2','subject_id','t.id,t.report_id,t.subject_id,t.version,t.kind,t.consent_id,t.payload_text,t.payload_hash,t.created_at,t.erased_at,r.closed_at'),from:'comment_governance_events_v2 t JOIN comment_reports_v2 r ON r.id=t.report_id',transform:(item,now)=>item.closed_at&&Date.parse(item.closed_at)+180*86400000<=now*1000?{...item,payload_text:'',content_expired:true,originalSignatureReverifiable:false}:item},
  'ci-requests-v2':row('ci_requests_v2','subject_id','t.id,t.subject_id,t.consent_id,t.case_id,t.evidence_id,t.evidence_version,t.result_id,t.result_version,t.source_key,t.payload_text,t.payload_hash,t.state,t.created_at'),
  'ci-observations-v2':{...row('ci_observations_v2','subject_id','t.id,t.request_id,t.job_id,t.attempt,t.observation,t.created_at'),from:'ci_observations_v2 t JOIN ci_requests_v2 r ON r.id=t.request_id',owner:'r.subject_id'},
  'ci-proofs-v2':row('ci_proofs_v2','subject_id','t.id,t.subject_id,t.request_id,t.observation_id,t.consent_id,t.payload_text,t.payload_hash,t.signed,t.revoked_at,t.created_at'),
  'context-grants-v2': { ...row('context_grants_v2','subject_id',"t.id,t.task_id,t.participation_id,t.subject_id,t.participant_id,t.scope_version,t.scope_event_id,t.consent_id,t.payload_text,t.payload_hash,t.materials_hash,t.expires_at,t.state,t.response_event_id,t.revoked_at,t.erased_at,t.created_at,(t.payload_text='') AS content_erased"),
    transform: (item,now) => Date.parse(item.expires_at)<=now*1000 ? {...item,payload_text:'',content_expired:true,originalSignatureReverifiable:false} : item },
  'context-events-v2': row('context_events_v2','subject_id',"t.id,t.grant_id,t.subject_id,t.kind,t.consent_id,t.payload_text,t.payload_hash,t.created_at,(t.payload_text='') AS content_erased"),
  'contribution-publications': row('contribution_publications','subject_id','t.id,t.subject_id,t.consent_id,t.source_refs,t.payload_text,t.payload_hash,t.revoked_at,t.revoke_id,t.revoke_consent_id,t.revoke_payload_text,t.revoke_payload_hash,t.created_at'),
  'recruitment-opportunities': {...row('recruitment_opportunities','subject_id','t.id,t.project_id,t.creator_id,t.publisher_id,t.contact_subject_id,t.revision,t.state,t.current_event_id,t.expires_at,t.created_at,t.updated_at'),
    from:'recruitment_opportunities t JOIN projects_v2 p ON p.id=t.project_id CROSS JOIN LATERAL (SELECT p.owner_id subject_id UNION SELECT t.publisher_id) own',owner:'own.subject_id',
    transform:(item,now)=>item.state==='active'&&Date.parse(item.expires_at)<=now*1000?{...item,state:'expired'}:item},
  'recruitment-events':row('recruitment_events','subject_id',"t.operation_id,t.recruitment_id,t.subject_id,t.revision,t.kind,t.consent_id,t.payload_text,t.payload_hash,t.created_at,(t.payload_text='') AS content_erased",'t.operation_id::text'),
  'recruitment-task-links':row('recruitment_task_links','subject_id','t.recruitment_id,t.task_id,t.subject_id,t.operation_id,t.created_at',"t.recruitment_id::text||':'||t.task_id::text"),
  'room-shared-summary-receipts': row('room_shared_summaries','subject_id','t.share_id,t.subject_id,t.room_id,t.member_revision,t.request_hash,t.notice_hash,t.message_id,t.supersedes_share_id,t.state,t.created_at,t.expires_at,t.retracted_at','t.share_id::text'),
  'notification-options-v2': row('notification_options_v2','subject_id','t.subject_id,t.revision,t.settings,t.updated_at','t.subject_id','t.updated_at'),
  'notification-presentations': row('notification_presentations','subject_id','t.subject_id,t.kind,t.event_id,t.client_id,t.claim_id,t.lease_until,t.presented_at,t.expires_at',"t.subject_id||':'||t.kind||':'||t.event_id::text","t.lease_until - interval '30 seconds'"),
  'personal-summary-preferences': row('personal_summary_preferences','subject_id','t.subject_id,t.revision,t.endpoint,t.enabled,t.room_ids,t.include_existing,t.enabled_since,t.updated_at','t.subject_id','t.updated_at'),
  'personal-summary-heads': row('personal_summary_heads','subject_id','t.subject_id,t.summary_id,t.room_id,t.revision,t.current_version_id,t.deleted_at,t.created_at,t.updated_at',"t.subject_id||':'||t.summary_id::text"),
  // Content may quote other authors. Use the current-authorized summary view for
  // it, never export a raw content JSON snapshot after its sources disappear.
  'personal-summary-version-receipts': row('personal_summary_versions','subject_id','t.subject_id,t.summary_id,t.version_id,t.base_revision,t.revision,t.request_hash,t.state,t.created_at,t.expires_at',"t.subject_id||':'||t.version_id::text"),
  'projects-v2': row('projects_v2','owner_id','t.id,t.creator_id,t.owner_id,t.revision,t.state,t.document_event_id,t.policy_event_id,t.source_statement_id,t.created_at,t.updated_at'),
  'project-events-v2': row('project_events_v2','subject_id',"t.operation_id,t.project_id,t.subject_id,t.revision,t.kind,t.consent_id,t.payload_text,t.payload_hash,t.affected_fields,t.created_at,(t.payload_text='') AS content_erased",'t.operation_id::text'),
  'project-roles-v2': row('project_roles_v2','subject_id','t.project_id,t.subject_id,t.role,t.grant_event_id,t.revoke_event_id,t.state,t.created_at,t.updated_at',"t.project_id::text||':'||t.subject_id||':'||t.role"),
  'project-field-sources-v2': { ...row('project_field_sources_v2','subject_id','t.project_id,t.field_name,t.event_id',"t.project_id::text||':'||md5(t.field_name)",'p.updated_at'),
    from:'project_field_sources_v2 t JOIN projects_v2 p ON p.id=t.project_id',owner:'p.owner_id' },
  'project-transfers-v2': { ...row('project_transfers_v2','subject_id','t.id,t.project_id,t.from_subject_id,t.to_subject_id,t.state,t.offer_event_id,t.response_event_id,t.created_at,t.updated_at'),
    from:'project_transfers_v2 t CROSS JOIN LATERAL (SELECT t.from_subject_id subject_id UNION SELECT t.to_subject_id) own',owner:'own.subject_id' },
  'project-preferences-v2': row('project_preferences_v2','subject_id','t.project_id,t.subject_id,t.revision,t.settings,t.updated_at',"t.project_id::text||':'||t.subject_id",'t.updated_at'),
  'contacts-v2': { ...row('contacts_v2','subject_id','t.id,t.initiator_id,t.recipient_id,t.purpose,t.state,t.revision,t.create_event_id,t.response_event_id,t.room_id,t.expires_at,t.created_at,t.updated_at'),
    from:'contacts_v2 t CROSS JOIN LATERAL (SELECT t.initiator_id subject_id UNION SELECT t.recipient_id) own',owner:'own.subject_id',
    transform:(item,now)=>item.state==='sent'&&Date.parse(item.expires_at)<=now*1000?{...item,state:'expired'}:item },
  'contact-events-v2': { ...row('contact_events_v2','subject_id',"t.operation_id,t.contact_id,t.subject_id,t.revision,t.kind,t.consent_id,t.payload_text,t.payload_hash,t.created_at,(t.payload_text='') AS content_erased",'t.operation_id::text'),
    transform:(item,now)=>Date.parse(item.created_at)+90*86400000<=now*1000?{...item,payload_text:'',content_expired:true,originalSignatureReverifiable:false}:item },
  'experience-objects': row('experience_objects','subject_id','t.id,t.object_type,t.subject_id,t.version,t.state,t.source_key,t.experience_id,t.created_at'),
  'experience-events': { ...row('experience_events','subject_id',"t.operation_id,t.object_id,t.version,t.consent_id,t.payload_text,t.payload_hash,t.context,t.created_at,(t.payload_text='') AS content_erased",'t.operation_id::text'),
    from:'experience_events t JOIN experience_objects o ON o.id=t.object_id',owner:'o.subject_id' },
  'qualification-calculation-grants': row('qualification_calculation_grants','subject_id','t.id,t.subject_id,t.task_id,t.consent_id,t.payload_text,t.payload_hash,t.revoked_at,t.revoke_id,t.revoke_consent_id,t.revoke_payload_text,t.revoke_payload_hash,t.created_at'),
  // Transport bodies use /v2/chat/export/owned. These are only the requesting
  // subject's own receipts/settings, never a dump of a mixed-author room.
  'chat-created-room-receipts': row('chat_rooms','creator_subject_id','t.room_id,t.creator_subject_id,t.operation_id,t.request_hash,t.created_at','t.room_id::text'),
  'chat-proposal-receipts': row('chat_decisions','proposer_subject_id','t.decision_id,t.room_id,t.proposer_subject_id,t.action,t.request_hash,t.state,t.created_at,t.expires_at','t.decision_id::text'),
  'chat-memberships': row('chat_memberships','subject_id','t.room_id,t.subject_id,t.controller_ref,t.joined_at,t.left_at,t.dismissed_revision',"t.room_id::text||':'||t.subject_id",'t.joined_at'),
  'chat-message-receipts': row('chat_message_refs','subject_id','t.message_id,t.sequence,t.room_id,t.subject_id,t.client_message_id,t.payload_hash,t.actor_kind,t.agent_grant_id,t.archive_id,t.reply_to,t.state,t.revision,t.sent_at,t.expires_at,t.edited_at,t.retracted_at,t.purge_pending,t.content_bytes','t.message_id::text','t.sent_at'),
  'chat-message-operations': row('chat_message_operations','subject_id',"t.operation_id,t.room_id,t.message_id,t.subject_id,t.kind,t.request_hash,t.created_at,t.state,t.previous_content_bytes,t.target_content_bytes,t.base_revision,t.result->>'revision' AS result_revision,t.result->>'editedAt' AS result_edited_at",'t.operation_id::text'),
  'chat-cursors': row('chat_cursors','subject_id','t.room_id,t.subject_id,t.cursor_kind,t.agent_ref,t.sequence,t.updated_at',"t.room_id::text||':'||t.subject_id||':'||t.cursor_kind||':'||md5(t.agent_ref)",'t.updated_at'),
  'chat-message-preferences': row('chat_message_preferences','subject_id','t.room_id,t.subject_id,t.message_id,t.hidden,t.updated_at',"t.room_id::text||':'||t.subject_id||':'||t.message_id::text",'t.updated_at'),
  'chat-agent-grants': row('chat_agent_grants','subject_id','t.grant_id,t.room_id,t.subject_id,t.binding_id,t.mode,t.primary_responder,t.expires_at,t.revoked_at,t.created_at','t.grant_id::text'),
  'capsule-permissions': row('capsule_permissions','subject_id','t.id,t.subject_id,t.consent_id,t.payload_text,t.payload_hash,t.revoked_at,t.revoke_id,t.revoke_consent_id,t.revoke_payload_text,t.revoke_payload_hash,t.created_at'),
  'capsule-uses-v2': row('capsule_uses_v2','subject_id',"t.id,t.capsule_id,t.version_id,t.subject_id,t.case_id,t.attempt_id,t.attempt_version,t.result_id,t.result_version,t.prior_use_id,t.kind,t.observed_revision,t.verification_fingerprint,t.consent_id,t.payload_text,t.payload_hash,t.created_at,(t.payload_text='') AS content_erased"),
  'identity-control-heads': { ...row('subject_control_heads', 'subject_id', 't.subject_id,t.epoch,t.sequence,t.event_hash', 't.subject_id', 'e.accepted_at'), from: 'subject_control_heads t JOIN subject_control_events e ON e.subject_id=t.subject_id AND e.sequence=t.sequence' },
  'identity-control-events': row('subject_control_events', 'subject_id', 't.id,t.subject_id,t.sequence,t.epoch,t.kind,t.previous_event_hash,t.event_hash,t.payload_text,t.controller_signature,t.new_device_proof,t.signer_key_id,t.accepted_at', 't.id::text', 't.accepted_at'),
  'device-authorizations': { ...row('device_authorizations', 'subject_id', 't.device_id,t.subject_id,t.key_id,t.public_key,t.epoch,t.scopes,t.status,t.source_event_id,t.revoked_at', 't.device_id::text', 'e.accepted_at'), from: 'device_authorizations t JOIN subject_control_events e ON e.id=t.source_event_id' },
  'recovery-authorizations': { ...row('recovery_authorizations', 'subject_id', 't.subject_id,t.generation,t.epoch,t.public_key,t.source_event_id,t.status,t.save_declared_at', "t.subject_id||':'||lpad(t.generation::text,10,'0')", 'e.accepted_at'), from: 'recovery_authorizations t JOIN subject_control_events e ON e.id=t.source_event_id' },
  'identity-operation-receipts': row('identity_control_operations', 'subject_id', 't.id,t.subject_id,t.request_hash,t.state,t.expires_at,t.committed_at', 't.id::text', 'COALESCE(t.committed_at,t.expires_at)'),
  'case-task-links': row('case_task_links', 'subject_id', 't.task_id,t.case_id,t.operation_id,t.subject_id,t.payload_hash,t.receipt,t.created_at', 't.task_id::text'),
  'community-account-links': row('community_account_links', 'subject_id', 't.identity_link_id,t.account_id,t.subject_id,t.created_at', 't.identity_link_id::text'),
  'community-accounts': { ...row('community_accounts', 'id', 't.id,t.endpoint,t.issuer,t.external_subject,t.verification_method,t.verified_at,t.created_at,t.tier_override,t.restricted_until,t.restriction_reason'),
    from: 'community_accounts t JOIN (SELECT DISTINCT account_id,subject_id FROM community_account_links) own ON own.account_id=t.id', owner: 'own.subject_id' },
  'community-daily-usage': { ...row('community_daily_usage', 'account_id', 't.account_id,t.day,t.category,t.used', "t.account_id::text||':'||t.day::text||':'||t.category", 't.day::timestamptz'),
    from: 'community_daily_usage t JOIN (SELECT DISTINCT account_id,subject_id FROM community_account_links) own ON own.account_id=t.account_id', owner: 'own.subject_id' },
  'community-interactions': { ...row('community_interactions', 'account_id', 't.account_id,t.source_id,t.source_kind,t.counterparty_id,t.created_at,t.invalidated_at', "t.account_id::text||':'||t.source_id::text"),
    from: 'community_interactions t JOIN task_events e ON e.id=t.source_id JOIN (SELECT DISTINCT account_id,subject_id FROM community_account_links) own ON own.account_id=t.account_id AND own.subject_id=e.subject_id', owner: 'own.subject_id' },
  'community-write-receipts': row('community_write_receipts', 'subject_id', 't.account_id,t.operation_id,t.category,t.subject_id,t.payload_hash,t.task_id,t.room_id,t.contact_id,t.recruitment_id,t.recipient_id,t.created_at,t.responded_at', "t.account_id::text||':'||t.category||':'||t.operation_id::text"),
  'tasks': row('task_requests', 'requester_id', 't.id,t.case_id,t.requester_id,t.root_event_id,t.version,t.created_at'),
  'task-participations': row('task_participations', 'subject_id', 't.id,t.task_id,t.subject_id,t.version,t.created_at'),
  'task-events': { ...row('task_events', 'subject_id', "t.id,t.task_id,t.participation_id,t.subject_id,t.version,t.participation_version,t.kind,t.consent_id,t.payload_text,t.payload_hash,t.created_at,(t.payload_text='') AS content_erased"),
    transform: (item, now) => productV2Retention.taskEvents.temporaryKinds.includes(item.kind) && Date.parse(item.created_at)+90*86400000<=now*1000
      ? { ...item, payload_text: '', content_expired: true, originalSignatureReverifiable: false } : item },
  'verification-objects': row('verification_objects', 'subject_id', 't.id,t.object_type,t.case_id,t.subject_id,t.version,t.state,t.created_at'),
  'verification-events': { ...row('verification_events', 'subject_id', "t.operation_id,t.object_id,t.version,t.consent_id,t.payload,t.payload_text,t.payload_hash,t.context,t.created_at,(t.payload_text='') AS content_erased", 't.operation_id::text'),
    from: 'verification_events t JOIN verification_objects o ON o.id=t.object_id', owner: 'o.subject_id' },
  'verification-dependencies': { ...row('verification_dependencies', 'subject_id', 't.object_id,t.object_version,t.target_type,t.target_id,t.target_version',
    "t.object_id::text||':'||lpad(t.object_version::text,10,'0')||':'||t.target_type||':'||t.target_id::text||':'||lpad(t.target_version::text,10,'0')", 'e.created_at'),
    from: 'verification_dependencies t JOIN verification_objects o ON o.id=t.object_id JOIN verification_events e ON e.object_id=t.object_id AND e.version=t.object_version', owner: 'o.subject_id' },
  'lifecycle-erasures': row('lifecycle_erasure_records', 'subject_id', 't.id,t.table_name,t.object_key,t.subject_id,t.reason,t.policy_version,t.original_payload_hash,t.request_id,t.erased_at,t.retained_until', 't.id::text', 't.erased_at'),
};
export const productV2ExportDatasets = Object.freeze(Object.keys(productV2ExportSources));
