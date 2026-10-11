import * as z from 'zod/v4';
import { transaction } from './database.mjs';
import { TaskRepository } from './infrastructure/task-repository.mjs';
import { productV2Retention } from './infrastructure/lifecycle-registry-v2.mjs';
import { digest } from './shared/digest.mjs';
import { ServiceError } from './shared/service-error.mjs';
import { recordObjectAudit } from './infrastructure/object-audit.mjs';
import { taskRequestV2Schema, taskEnvelopeV2Schema, participationProposalV2Schema,
  participationEventV2Schema, taskReceiptV2Schema, taskQueryV2Schema } from './shared/task-schema-v2.mjs';
import { createTaskV2, applyTaskV2, proposeParticipationV2, applyParticipationV2, legacyAssistanceTaskV2 } from './domain/task-v2.mjs';
import { targetRestrictionsWithin, assertTargetOperation } from './target-governance-restrictions-v2.mjs';
import {hasTaskMaterials,hasTaskText,taskMaterialSubmissionSchema,taskMaterialLimits} from './shared/task-material-v1-schema.mjs';

const uuid = value => z.uuid().safeParse(value).success;
function parse(payloadJson, schema) {
  try {
    if (typeof payloadJson !== 'string' || Buffer.byteLength(payloadJson) > 100000) throw new Error();
    return schema.parse(JSON.parse(payloadJson));
  } catch { throw new ServiceError('invalid_task_payload'); }
}
function absent(error) { return error instanceof ServiceError && [403, 404].includes(error.status); }

// AssistanceService supplies the shared v1 grant/visibility/Case authorization.
// v2 stores its own events so v1 selected can never overwrite multiple people.
export class TaskServiceV2 {
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
  async createTask(actor, submission) {
    let {consentId}=submission;const {payloadJson}=submission;
    const input = parse(payloadJson, taskRequestV2Schema);
    const material=hasTaskMaterials(input);
    if(material){if(!taskMaterialSubmissionSchema.safeParse(submission).success||!this.taskMaterials)throw new ServiceError('invalid_task_material_request');
      if(Buffer.byteLength(JSON.stringify(submission))>taskMaterialLimits.envelopeBytes)throw new ServiceError('request_too_large',413);}
    else if(submission.signedIntent!==undefined||submission.materialBodies!==undefined)throw new ServiceError('invalid_task_payload');
    return this.access.runResourceWrite(actor, 'assistance', {}, async (db, authorization) => {
      await this.taskRepository.lockId(db, input.taskId);
      // An accepted material operation remains a fact after source loss. Prior
      // receipt lookup neither creates a new Consent nor grants current text.
      const prior=material?await this.taskRepository.event(db,input.operationId):null;
      const replay = await this.taskReplay(db, actor, input.taskId, input.operationId, material&&prior?prior.consent_id:consentId, payloadJson);
      if (replay) return replay;
      if (await this.taskRepository.get(db, input.taskId)
        || (await db.query('SELECT id FROM assistance_requests WHERE id=$1', [input.taskId])).rows.length)
        throw new ServiceError('task_conflict', 409);
      if(material)consentId=(await this.consents.createWithin(db,actor,submission.signedIntent,authorization,{taskMaterial:true})).consentId;
      const grant = await this.grant(db, actor.subjectId, consentId, input.operationId, payloadJson);
      if (grant.visibility !== input.visibility) throw new ServiceError('task_visibility_mismatch', 403);
      if (input.caseId) await this.caseLive(db, input.caseId, actor.subjectId);
      if (input.workContext.attemptRefs.length) {
        if (!input.caseId || !this.facts?.validateTaskContextWithin) throw new ServiceError('task_fact_validation_required', 409);
        await this.facts.validateTaskContextWithin(db, actor, { caseId: input.caseId, attemptRefs: input.workContext.attemptRefs });
      }
      if (input.parentTaskId) {
        const parent = await this.requireTaskWithin(db, actor, input.parentTaskId);
        if (parent.requesterId !== actor.subjectId) throw new ServiceError('task_parent_not_authorized', 403);
      }
      if (input.qualification) {
        if (!this.qualification) throw new ServiceError('qualification_unavailable', 503);
        await this.qualification.policyWithin(db, input.qualification.policyId, input.qualification.policyVersion, input.capabilityId, input.collaboration);
      }
      const materialRows=material?await this.taskMaterials.validateWithin(db,actor,input,submission.materialBodies,grant):[];
      const state = createTaskV2(actor.subjectId, input, this.access.now());
      const quota = input.visibility === 'Public' ? await this.taskQuota(db, actor, 'task', input.operationId, payloadJson, { taskId: input.taskId }) : null;
      await db.query('INSERT INTO task_requests(id,case_id,requester_id,root_event_id,version,snapshot) VALUES($1,$2,$3,$4,1,$5)',
        [input.taskId, input.caseId, actor.subjectId, input.operationId, JSON.stringify(state)]);
      if(material)await this.taskMaterials.insertWithin(db,actor,input,consentId,materialRows);
      const receipt = await this.recordTaskEvent(db, actor, authorization, state, { eventId: input.operationId, kind: 'task-created', consentId, payloadJson });
      return { ...receipt, caseId: input.caseId, requestPublished: true, contactSuggestionsState: 'not-requested', paymentExecuted: false, quota };
    });
  }
  async submitTaskEvent(actor, id, { consentId, payloadJson }) {
    const input = parse(payloadJson, taskEnvelopeV2Schema), event = input.event;
    if (input.taskId !== id) throw new ServiceError('task_target_mismatch');
    return this.access.runResourceWrite(actor, 'assistance', { control: ['cancel', 'close', 'withdraw-application', 'revoke-invitation'].includes(event.kind) }, async (db, authorization) => {
      const { row, paused, governance } = await this.requireTaskWithin(db, actor, id, { write: true });
      const replay = await this.taskReplay(db, actor, id, event.eventId, consentId, payloadJson); if (replay) return replay;
      if(['invite','apply','extend-enrollment'].includes(event.kind))assertTargetOperation(governance,'new-participation-paused');
      if (paused && !['cancel', 'withdraw-application', 'revoke-invitation'].includes(event.kind)) throw new ServiceError('task_paused', 403);
      const state = row.snapshot, next = applyTaskV2(state, actor.subjectId, event, this.access.now());
      const recipientIds = [row.requester_id];
      if (event.kind === 'invite') recipientIds.push(event.recipientId);
      if (event.kind === 'revoke-invitation') recipientIds.push(state.invitations.find(i => i.invitationId === event.invitationId).recipientId);
      await this.requirePrivateTaskGrant(db, actor, { consentId, eventId: event.eventId, payloadJson }, recipientIds);
      let quota = null;
      if (event.kind === 'invite') {
        if (!(await db.query('SELECT id FROM subjects WHERE id=$1', [event.recipientId])).rows.length)
          throw new ServiceError('invitation_recipient_unavailable', 403);
        await this.requireTaskWithin(db, { subjectId: event.recipientId }, id);
        quota = await this.taskQuota(db, actor, 'invitation', event.eventId, payloadJson, { taskId: id, recipientId: event.recipientId });
      }
      if (event.kind === 'invitation-reply') await this.publicWrites?.markInvitationRespondedWithin?.(db, { taskId: id, recipientId: actor.subjectId });
      await this.taskRepository.save(db, next);
      const receipt = await this.recordTaskEvent(db, actor, authorization, next, { eventId: event.eventId, kind: event.kind, consentId, payloadJson });
      return { ...receipt, quota };
    });
  }
  async proposeParticipation(actor, taskId, { consentId, payloadJson }) {
    const input = parse(payloadJson, participationProposalV2Schema);
    return this.access.runResourceWrite(actor, 'assistance', {}, async (db, authorization) => {
      const { row, paused, governance } = await this.requireTaskWithin(db, actor, taskId, { write: true });
      const replay = await this.taskReplay(db, actor, taskId, input.eventId, consentId, payloadJson); if (replay) return replay;
      assertTargetOperation(governance,'new-participation-paused');
      if (paused) throw new ServiceError('task_paused', 403);
      if (await this.taskRepository.getParticipation(db, input.participationId)) throw new ServiceError('participation_conflict', 409);
      const { task, participation } = proposeParticipationV2(row.snapshot, actor.subjectId, input, this.access.now());
      await this.requireTaskWithin(db, { subjectId: input.subjectId }, taskId);
      await this.requirePrivateTaskGrant(db, actor, { consentId, eventId: input.eventId, payloadJson }, [input.subjectId]);
      const peers = await this.taskRepository.participations(db, taskId);
      if (peers.some(p => p.subject_id === input.subjectId && p.snapshot.role === input.role
        && !['declined', 'withdrawn', 'closed'].includes(p.snapshot.state))) throw new ServiceError('participation_already_exists', 409);
      await this.taskQualification(db, actor, task, participation);
      await this.taskRepository.saveParticipation(db, participation);
      await this.taskRepository.save(db, task);
      return this.recordTaskEvent(db, actor, authorization, task, { eventId: input.eventId, kind: 'participation-proposed', consentId, payloadJson, participation });
    });
  }
  async taskQualification(db, actor, task, participation) {
    const request = task.request;
    if (!request.qualification) return;
    if (!this.qualification) throw new ServiceError('qualification_unavailable', 503);
    const application = task.applications.find(a => a.applicationId === participation.applicationId);
    if(request.qualification.profile==='facts-v2'){
      if(!this.qualification.v2)throw new ServiceError('qualification_v2_unavailable',503);
      const evaluation=await this.qualification.v2.evaluateWithin(db,actor,{taskId:request.taskId,subjectId:participation.subjectId,
        policyId:request.qualification.policyId,policyVersion:request.qualification.policyVersion,capabilityId:request.capabilityId,
        evidence:application?.qualificationEvidence??{}},request.collaboration);
      if(evaluation.state!=='satisfied')throw new ServiceError('qualification_required',403);
      return;
    }
    const evaluation = await this.qualification.evaluateWithin(db, actor, { ...request.qualification,
      capabilityId: request.capabilityId, subjectId: participation.subjectId,
      evidence: application?.qualificationEvidence ?? { proofIds: [], assistanceIds: [] } }, request.collaboration);
    if (!evaluation.eligible) throw new ServiceError('qualification_required', 403);
  }
  async submitParticipationEvent(actor, participationId, { consentId, payloadJson }) {
    const input = parse(payloadJson, participationEventV2Schema);
    return this.access.runResourceWrite(actor, 'assistance', { control: ['decline', 'withdraw', 'dispute','requester-feedback'].includes(input.kind) }, async (db, authorization) => {
      // Locate without locking, then always acquire task before participation.
      const located = (await db.query('SELECT task_id FROM task_participations WHERE id=$1', [participationId])).rows[0];
      if (!located) throw new ServiceError('not_found', 404);
      const { row, paused, governance } = await this.requireTaskWithin(db, actor, located.task_id, { write: true });
      const replay = await this.taskReplay(db, actor, row.id, input.eventId, consentId, payloadJson); if (replay) return replay;
      if (paused && !['decline', 'withdraw', 'dispute','requester-feedback'].includes(input.kind)) throw new ServiceError('task_paused', 403);
      const prior = await this.requireParticipationWithin(db, actor, { taskId: row.id, participationId, write: true });
      if(input.kind==='confirm'&&!prior.confirmedAt)assertTargetOperation(governance,'new-participation-paused');
      const { paused: _paused, taskState: _taskState, ...participationState } = prior;
      const { task, participation } = applyParticipationV2(row.snapshot, participationState, actor.subjectId, input, this.access.now());
      await this.requirePrivateTaskGrant(db, actor, { consentId, eventId: input.eventId, payloadJson }, [prior.requesterId, prior.subjectId]);
      if (input.kind === 'confirm' || input.kind === 'confirm-scope') await this.taskQualification(db, actor, task, participation);
      if (input.kind === 'deliver' || input.kind === 'accept') {
        if (!this.facts?.validateDeliveryWithin) throw new ServiceError('task_fact_validation_unavailable', 503);
        const delivery = input.kind === 'deliver' ? input : prior.deliveries.find(d => d.deliveryId === input.deliveryId);
        await this.facts.validateDeliveryWithin(db, actor, { taskId: row.id, caseId: row.case_id, participationId,
          subjectId: prior.subjectId, scopeVersion: delivery.scopeVersion ?? prior.scopeVersion,
          resultRef: delivery.resultRef, interventionRefs: delivery.interventionRefs, evidenceRefs: delivery.evidenceRefs });
      }
      await this.taskRepository.saveParticipation(db, participation);
      await this.taskRepository.save(db, task);
      if (input.kind === 'confirm' || input.kind === 'accept') {
        for (const [subjectId, counterpartyId] of [[prior.requesterId, prior.subjectId], [prior.subjectId, prior.requesterId]])
          await this.communityAccounts?.recordInteractionWithin(db, { subjectId, counterpartyId, sourceId: input.eventId,
            sourceKind: input.kind === 'confirm' ? 'accepted-participation' : 'accepted-delivery' });
      }
      return this.recordTaskEvent(db, actor, authorization, task, { eventId: input.eventId, kind: input.kind, consentId, payloadJson, participation });
    });
  }
  async taskReceipt(actor, input) {
    const parsed = taskReceiptV2Schema.safeParse(input); if (!parsed.success) throw new ServiceError('invalid_task_receipt');
    return this.access.runAuthorized(actor, 'assistance', async db => {
      const row = await this.taskRepository.event(db, parsed.data.eventId);
      if (row && row.subject_id !== actor.subjectId) throw new ServiceError('not_found', 404);
      const matches = row && row.task_id === input.taskId && row.payload_hash === input.payloadHash;
      return { ...parsed.data, state: !row ? 'absent' : matches ? 'acknowledged' : 'conflict', checkedAt: this.access.now(),
        ...(matches ? { version: row.version, participationVersion: row.participation_version,
          participationId: row.participation_id ?? null, kind: row.kind } : {}),
        authority: 'accepted-event-only; not-current-authorization' };
    });
  }
  async readTaskWithin(db, actor, id) {
    const { row, paused, governance } = await this.requireTaskWithin(db, actor, id);
    const state = row.snapshot, requester = actor?.subjectId === row.requester_id;
    const result = { schemaVersion: 2, taskId: id, caseId: row.case_id, request: state.request, requesterId: row.requester_id,
      version: state.version, state: state.state, enrollmentOpen: state.state === 'open' && state.request.enrollmentExpiresAt > this.access.now()&&!governance.scopes.includes('new-participation-paused'),
      paused, governance, paymentExecuted: false, contextAccessGranted: false, roomMembershipGranted: false,
      compatibility: { writableApiVersion: 2, legacyWrites: false }, view: requester ? 'requester' : actor ? 'participant-or-reader' : 'public' };
    if(hasTaskMaterials(state.request)||hasTaskText(state.request)){
      if(!this.taskMaterials)throw new ServiceError('task_material_reader_unavailable',503);
      Object.assign(result,await this.taskMaterials.projectWithin(db,actor,row));
    }
    if (!actor) return result;
    const visibleIds = new Set(), events = await this.taskRepository.events(db, id);
    for (const event of events) {
      try { if (this.visible(await this.taskGrant(db, event), actor.subjectId)) visibleIds.add(event.id); }
      catch (error) { if (!absent(error)) throw error; }
    }
    const visible = eventId => visibleIds.has(eventId);
    const suggestions = requester && visible(state.suggestions.eventId) ? structuredClone(state.suggestions)
      : { state: requester ? 'not-available' : 'private', items: [] };
    const invitations = state.invitations.filter(i => (requester || i.recipientId === actor.subjectId) && visible(i.invitationId)).map(i => {
      const replies = i.replies.filter(r => visible(r.eventId));
      return { ...i, state: i.state === 'revoked' ? 'revoked' : i.expiresAt <= this.access.now() ? 'expired' : replies.at(-1)?.response ?? 'pending', replies };
    });
    const applications = state.applications.filter(a => (requester || a.subjectId === actor.subjectId) && visible(a.applicationId));
    result.contacts = { suggestions, responses: { invitations, applications } };
    const rows = await this.taskRepository.participations(db, id);
    result.participations = rows.filter(p => (requester || p.subject_id === actor.subjectId) && visible(p.snapshot.proposalEventId)).map(p => {
      const own = structuredClone(p.snapshot);
      if (!visible(own.scopeEventId)) { own.agreedScope = null; own.scopeAvailable = false; }
      if (own.pendingScope && !visible(own.pendingScope.eventId)) own.pendingScope = null;
      own.deliveries = own.deliveries.filter(d => visible(d.deliveryId)).map(d => ({ ...d,
        acceptance: d.acceptance && visible(d.acceptance.eventId) ? d.acceptance : null }));
      if (own.dispute && !visible(own.dispute.eventId)) own.dispute = null;
      if (own.disputeResolution && !visible(own.disputeResolution.eventId)) own.disputeResolution = null;
      if (own.feedback && !visible(own.feedback.eventId)) own.feedback = null;
      own.events = own.events.filter(e => visible(e.event.eventId));
      return own;
    });
    return result;
  }
  async getTask(actor, id) {
    if (!uuid(id)) throw new ServiceError('not_found', 404);
    return this.access.runAuthorized(actor, 'assistance', async db => {
      if (await this.taskRepository.get(db, id)) return this.readTaskWithin(db, actor, id);
      const legacy = await this.readWithin(db, actor, id); return legacyAssistanceTaskV2(legacy);
    });
  }
  async getPublicTask(id) {
    if (!uuid(id)) throw new ServiceError('not_found', 404);
    return transaction(this.access.db, db => this.readTaskWithin(db, null, id));
  }
  async queryTasksWithin(db, actor, options) {
    const items = []; let position = options.after ?? null;
    for (;;) {
    const candidates = (await db.query(`SELECT id FROM task_requests
      WHERE ($1::uuid IS NULL OR id>$1)
      AND ($2='open' AND snapshot->>'state'='open' AND (snapshot->'request'->>'enrollmentExpiresAt')::bigint>$3
        OR $2='requested' AND requester_id=$4
        OR $2='participating' AND EXISTS(SELECT 1 FROM task_participations p WHERE p.task_id=task_requests.id AND p.subject_id=$4)
        OR $2='participating' AND snapshot->'invitations' @> jsonb_build_array(jsonb_build_object('recipientId',$4::text))
        OR $2='participating' AND EXISTS(SELECT 1 FROM task_events e WHERE e.task_id=task_requests.id AND e.subject_id=$4))
      ORDER BY id LIMIT 100`, [position, options.view, this.access.now(), actor?.subjectId ?? null])).rows;
    for (const candidate of candidates) {
      try {
        const item = await this.readTaskWithin(db, actor, candidate.id);
        if (options.view === 'open' && (item.paused||item.governance.scopes.some(s=>['discovery-hidden','new-participation-paused'].includes(s)))) continue;
        // Match only the currently readable request. Neither private keyword
        // hits nor an unavailable candidate's ID become a count or cursor.
        if (!`${item.request.title} ${item.request.summary}`.toLowerCase().includes(options.query.toLowerCase())) continue;
        const { contacts: _contacts, participations: _participations, ...publicSummary } = item;
        items.push(publicSummary);
        if (items.length > options.limit) break;
      } catch (error) { if (!absent(error)) throw error; }
    }
    if (items.length > options.limit || candidates.length < 100) break;
    position = candidates.at(-1).id;
    }
    return { items: items.slice(0, options.limit), nextAfter: items.length > options.limit ? items[options.limit - 1].taskId
      : null, coverage: 'visible-page-only' };
  }
  async queryTasks(actor, input = {}) {
    const options = taskQueryV2Schema.safeParse(input); if (!options.success) throw new ServiceError('invalid_task_query');
    return this.access.runAuthorized(actor, 'assistance', db => this.queryTasksWithin(db, actor, options.data));
  }
  async queryPublicTasks(input = {}) {
    const options = taskQueryV2Schema.safeParse(input); if (!options.success || options.data.view !== 'open') throw new ServiceError('invalid_task_query');
    return transaction(this.access.db, db => this.queryTasksWithin(db, null, options.data));
  }
}
