import {TaskRepository} from "../../infrastructure/task-repository.mjs";
import {productV2Retention} from "../../infrastructure/lifecycle-registry-v2.mjs";
import {digest} from "../../shared/digest.mjs";
import {ServiceError} from "../../shared/service-error.mjs";
import {recordObjectAudit} from "../../infrastructure/object-audit.mjs";
import {targetRestrictionsWithin} from "../../governance/target-governance-restrictions-v2.mjs";
import './helpers.mjs';

// Existing Access/Consent references, exact retained Task/Participation source qualification, lock order, quota and original accepted-event receipts.
export class TaskAuthorityV2{
  constructor(access, consents) { this.access = access; this.consents = consents; this.taskRepository = new TaskRepository(); }
  attachCaseWithin(db, input) { return this.taskRepository.attachCase(db, input); }
  async taskGrant(db, row) {
    if (!row || !row.payload_text || productV2Retention.taskEvents.temporaryKinds.includes(row.kind)
      && Date.parse(row.created_at) + 90*86400000 <= this.access.now()*1000) throw new ServiceError('task_content_unavailable',403);
    return this.grant(db, row.subject_id, row.consent_id, row.id, row.payload_text);
  }
  async taskReplay(db, actor, taskId, eventId, consentId, payloadJson) {
    const prior = await this.taskRepository.event(db, eventId);
    if (!prior) return null;
    if (prior.task_id !== taskId || prior.subject_id !== actor.subjectId || prior.consent_id !== consentId || prior.payload_hash !== digest(payloadJson))
      throw new ServiceError('task_event_conflict', 409);
    return { taskId, eventId, version: prior.version,
      ...(prior.participation_id ? { participationId: prior.participation_id, participationVersion: prior.participation_version } : {}) };
  }
  async recordTaskEvent(db, actor, authorization, task, { eventId, kind, consentId, payloadJson, participation = null }) {
    await db.query(`INSERT INTO task_events(id,task_id,participation_id,subject_id,version,participation_version,kind,consent_id,payload_text,payload_hash)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`, [eventId, task.request.taskId, participation?.participationId ?? null,
      actor.subjectId, task.version, participation?.version ?? null, kind, consentId, payloadJson, digest(payloadJson)]);
    await recordObjectAudit(db, { subjectId: actor.subjectId, objectId: eventId, action: 'task.event',
      httpRequestId: actor.httpRequestId ?? null, ...authorization });
    return { taskId: task.request.taskId, eventId, version: task.version,
      ...(participation ? { participationId: participation.participationId, participationVersion: participation.version, state: participation.state } : { state: task.state }) };
  }
  async requireTaskWithin(db, actor, id, { write = false } = {}) {
    const row = await this.taskRepository.get(db, id, { lock: write });
    if (!row || row.snapshot?.contentDeleted) throw new ServiceError('not_found', 404);
    const root = await this.taskRepository.event(db, row.root_event_id);
    if (!root || !root.payload_text) throw new ServiceError('not_found', 404);
    const grant = await this.taskGrant(db, root);
    if (!this.visible(grant, actor?.subjectId ?? null)) throw new ServiceError('not_found', 404);
    if (row.case_id) {
      const caseRow = (await db.query('SELECT id,state FROM cases WHERE id=$1 AND subject_id=$2 FOR SHARE', [row.case_id, row.requester_id])).rows[0];
      if (!caseRow || caseRow.state === 'withdrawn') throw new ServiceError('task_case_unavailable', 403);
    }
    const paused = row.case_id ? (await db.query('SELECT id FROM moderation_reports WHERE case_id=$1 AND paused=true LIMIT 1', [row.case_id])).rows.length > 0 : false;
    const governance=await targetRestrictionsWithin(db,'task',id,this.access.now());
    if(governance.scopes.includes('discovery-hidden')&&actor?.subjectId!==row.requester_id){
      const related=actor?.subjectId&&(row.snapshot.invitations.some(i=>i.recipientId===actor.subjectId)
        ||(await db.query('SELECT 1 FROM task_participations WHERE task_id=$1 AND subject_id=$2 UNION SELECT 1 FROM task_events WHERE task_id=$1 AND subject_id=$2 LIMIT 1',[id,actor.subjectId])).rows.length>0);
      if(!related)throw new ServiceError('not_found',404);
    }
    return { row, snapshot: row.snapshot, requesterId: row.requester_id, caseId: row.case_id, rootGrant: grant, paused, governance };
  }
  async requirePrivateTaskGrant(db, actor, { consentId, eventId, payloadJson }, recipientIds) {
    const grant = await this.grant(db, actor.subjectId, consentId, eventId, payloadJson);
    const allowed = new Set([actor.subjectId, ...recipientIds]);
    if (grant.visibility !== 'Private' || grant.viewers.some(id => !allowed.has(id)) || recipientIds.some(id => !this.visible(grant, id)))
      throw new ServiceError('task_private_recipient_consent_required', 403);
    return grant;
  }
  async requireParticipationWithin(db, actor, { taskId, participationId, write = false }) {
    const task = await this.requireTaskWithin(db, actor, taskId, { write });
    const row = await this.taskRepository.getParticipation(db, participationId, { lock: write });
    if (!row || row.snapshot?.contentDeleted || row.task_id !== taskId || ![row.subject_id, task.requesterId].includes(actor.subjectId))
      throw new ServiceError('participation_not_authorized', 403);
    const state = row.snapshot;
    for (const id of new Set([state.proposalEventId, state.scopeEventId])) {
      const event = await this.taskRepository.event(db, id), grant = await this.taskGrant(db, event);
      if (!this.visible(grant, actor.subjectId)) throw new ServiceError('participation_not_authorized', 403);
    }
    return { ...state, paused: task.paused, taskState: task.snapshot.state };
  }
  async taskQuota(db, actor, kind, operationId, payloadJson, extra = {}) {
    if (!this.publicWrites?.consumeWithin) throw new ServiceError('public_write_verification_unavailable', 503);
    return this.publicWrites.consumeWithin(db, actor, { kind, operationId, payloadHash: digest(payloadJson), ...extra });
  }
}
