import {ServiceError} from "../../shared/service-error.mjs";
import {taskRequestV2Schema,taskEnvelopeV2Schema,participationProposalV2Schema,participationEventV2Schema} from "../../shared/task-schema-v2.mjs";
import {createTaskV2,applyTaskV2,proposeParticipationV2,applyParticipationV2} from "../../domain/task-v2.mjs";
import {assertTargetOperation} from "../../governance/target-governance-restrictions-v2.mjs";
import {hasTaskMaterials,taskMaterialSubmissionSchema,taskMaterialLimits} from "../../shared/task-material-v1-schema.mjs";
import {parse} from './helpers.mjs';
import {TaskReadModelV2} from './read-model.mjs';

// Original Task and Participation command lifecycle kept together: atomic source material/Case linkage, current qualification, stable event receipts and separate participant effects.
export class TaskServiceV2 extends TaskReadModelV2{
  constructor(access,consents){super(access,consents);}

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
    return this.access.runResourceWrite(actor, 'assistance', { control: ['cancel', 'close', 'stop-enrollment', 'withdraw-application', 'revoke-invitation'].includes(event.kind) }, async (db, authorization) => {
      const { row, paused, governance } = await this.requireTaskWithin(db, actor, id, { write: true });
      const replay = await this.taskReplay(db, actor, id, event.eventId, consentId, payloadJson); if (replay) return replay;
      if(['invite','apply','extend-enrollment'].includes(event.kind))assertTargetOperation(governance,'new-participation-paused');
      if (paused && !['cancel', 'stop-enrollment', 'withdraw-application', 'revoke-invitation'].includes(event.kind)) throw new ServiceError('task_paused', 403);
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
}
