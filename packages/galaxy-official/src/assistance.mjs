import { TaskServiceV2 } from './tasks-v2.mjs';
import * as z from 'zod/v4';
import { createAssistance, applyAssistance } from './domain/assistance.mjs';
import { canReadProjection } from './domain/consent-policy.mjs';
import { ServiceError } from './shared/service-error.mjs';
import { digest } from './shared/digest.mjs';
import { recordObjectAudit } from './infrastructure/object-audit.mjs';
import { readAssistanceCaseReview } from './domain/assistance-case-review.mjs';
import { projectRequesterHistory, requesterHistoryPreview, requesterFactKinds } from './domain/requester-history.mjs';

import { assistanceRequestSchema, assistanceQuerySchema, assistanceReceiptSchema, requesterHistorySchema, requesterHistoryFactsSchema, assistanceEnvelopeSchema as envelope,publicContributionEventKinds } from './shared/assistance-schema.mjs';
function parse(payloadJson, schema) {
  try {
    if (typeof payloadJson !== 'string' || Buffer.byteLength(payloadJson) > 16000) throw new Error();
    return schema.parse(JSON.parse(payloadJson));
  } catch { throw new ServiceError('invalid_assistance_payload'); }
}
export class AssistanceService extends TaskServiceV2 {
  constructor(access, consents) { super(access, consents); }
  receipt(actor, input) {
    const parsed = assistanceReceiptSchema.safeParse(input);
    if (!parsed.success) throw new ServiceError('invalid_assistance_query');
    return this.access.runAuthorized(actor, 'assistance', async db => {
      const query = parsed.data;
      const row = (await db.query('SELECT assistance_id,subject_id,consent_id,payload_hash,version FROM assistance_events WHERE id=$1', [query.eventId])).rows[0];
      if (row && row.subject_id !== actor.subjectId) throw new ServiceError('not_found', 404);
      const matches = row && row.assistance_id === query.assistanceId && row.payload_hash === query.payloadHash;
      return { ...query, checkedAt: this.access.now(), state: !row ? 'absent' : matches ? 'acknowledged' : 'conflict',
        ...(matches ? { consentId: row.consent_id, version: row.version } : {}),
        authority: 'accepted-event-only; no current access or capability conclusion' };
    });
  }
  async caseLive(db, caseId, owner) {
    const parent = (await db.query('SELECT * FROM cases WHERE id=$1 AND subject_id=$2 FOR SHARE', [caseId, owner])).rows[0];
    if (!parent || parent.state === 'withdrawn') throw new ServiceError('assistance_case_unavailable', 403);
    const rows = (await db.query('SELECT * FROM case_events WHERE case_id=$1 ORDER BY version LIMIT 1001', [caseId])).rows;
    if (rows.length > 1000) throw new ServiceError('case_event_limit', 413);
    // The Case owner does not become the signer of another participant's fact.
    // Selected v2 Attempt references still pass their separate current read check.
    for (const row of rows) await this.consents.require(db, { id: row.consent_id, subjectId: row.subject_id, action: 'case.teaser.publish',
      objectId: row.id, recipient: this.access.endpoint, payloadJson: row.payload_text });
  }
  async grant(db, actorId, id, objectId, payloadJson) {
    return this.consents.require(db, { id, subjectId: actorId, action: 'assistance.publish', objectId,
      recipient: this.access.endpoint, payloadJson });
  }
  async insert(db, actor, authorization, assistanceId, eventId, version, consentId, payloadJson) {
    await db.query(`INSERT INTO assistance_events(id,assistance_id,subject_id,version,consent_id,payload_text,payload_hash)
      VALUES($1,$2,$3,$4,$5,$6,$7)`, [eventId, assistanceId, actor.subjectId, version, consentId, payloadJson, digest(payloadJson)]);
    await recordObjectAudit(db, { subjectId: actor.subjectId, objectId: eventId, action: 'assistance.event',
      httpRequestId: actor.httpRequestId ?? null, ...authorization });
  }
  async create(actor, { consentId, payloadJson }) {
    const request = parse(payloadJson, assistanceRequestSchema);
    return this.access.runResourceWrite(actor,'assistance',{}, async (db, authorization) => {
      await this.caseLive(db, request.caseId, actor.subjectId);
      const grant = await this.grant(db, actor.subjectId, consentId, request.id, payloadJson);
      if (grant.visibility !== request.visibility) throw new ServiceError('assistance_visibility_mismatch', 403);
      const existing = (await db.query('SELECT * FROM assistance_requests WHERE id=$1 FOR UPDATE', [request.id])).rows[0];
      if (existing) {
        const root = (await db.query('SELECT * FROM assistance_events WHERE id=$1', [request.id])).rows[0];
        if (existing.requester_id !== actor.subjectId || existing.case_id !== request.caseId
          || root?.payload_hash !== digest(payloadJson) || root?.consent_id !== consentId)
          throw new ServiceError('assistance_conflict', 409);
        return { assistanceId: request.id, eventId: request.id, version: 1 };
      }
      if (await this.taskRepository.get(db, request.id)) throw new ServiceError('unsupported_semantics', 409);
      if (request.qualification) await this.qualification.policyWithin(db,request.qualification.policyId, request.qualification.policyVersion, request.capabilityId, request.collaboration);
      const state = createAssistance(actor.subjectId, request, this.access.now());
      if (request.visibility === 'Public') await this.taskQuota(db, actor, 'task', request.id, payloadJson, { taskId: request.id });
      await db.query(`INSERT INTO assistance_requests(id,case_id,requester_id,version,snapshot) VALUES($1,$2,$3,1,$4)
        ON CONFLICT(id) DO NOTHING`, [request.id, request.caseId, actor.subjectId, JSON.stringify(state)]);
      const row = (await db.query('SELECT * FROM assistance_requests WHERE id=$1 FOR UPDATE', [request.id])).rows[0];
      const prior = (await db.query('SELECT * FROM assistance_events WHERE id=$1', [request.id])).rows[0];
      if (row.requester_id !== actor.subjectId || row.case_id !== request.caseId) throw new ServiceError('assistance_conflict', 409);
      if (prior) {
        if (prior.payload_hash !== digest(payloadJson) || prior.consent_id !== consentId) throw new ServiceError('assistance_conflict', 409);
      } else await this.insert(db, actor, authorization, request.id, request.id, 1, consentId, payloadJson);
      return { assistanceId: request.id, eventId: request.id, version: 1 };
    });
  }
  async load(db, id, {readOnly=false}={}) {
    const row = (await db.query(readOnly?'SELECT * FROM assistance_requests WHERE id=$1 FOR SHARE':'SELECT * FROM assistance_requests WHERE id=$1 FOR UPDATE', [id])).rows[0];
    if (!row) {
      if (await this.taskRepository.get(db, id)) throw new ServiceError('unsupported_semantics', 409);
      throw new ServiceError('not_found', 404);
    }
    await this.caseLive(db, row.case_id, row.requester_id);
    const events = (await db.query('SELECT * FROM assistance_events WHERE assistance_id=$1 ORDER BY version LIMIT 1002', [id])).rows;
    if (events.length > 1001) throw new ServiceError('assistance_event_limit', 413);
    const grants = new Map();
    for (const event of events) grants.set(event.id, await this.grant(db, event.subject_id, event.consent_id, event.id, event.payload_text));
    const paused=(await db.query('SELECT id FROM moderation_reports WHERE (assistance_id=$1 OR case_id=$2) AND paused=true LIMIT 1',[id,row.case_id])).rows.length>0;
    return { row, events, grants, paused };
  }
  visible(grant, actorId) { return canReadProjection(grant, { viewerId: actorId, projection: 'history', now: this.access.now() }); }
  async submit(actor, id, { consentId, payloadJson }) {
    const data = parse(payloadJson, envelope);
    if (data.assistanceId !== id) throw new ServiceError('assistance_target_mismatch');
    return this.access.runResourceWrite(actor,'assistance',{control:['cancel','withdraw-offer','expire','dispute'].includes(data.event.kind)}, async (db, authorization) => {
      const { row, grants, paused } = await this.load(db, id);
      if (!this.visible(grants.get(id), actor.subjectId)) throw new ServiceError('not_found', 404);
      if(paused && data.event.kind!=='cancel')throw new ServiceError('assistance_paused',403);
      const grant = await this.grant(db, actor.subjectId, consentId, data.event.id, payloadJson);
      const previous = (await db.query('SELECT * FROM assistance_events WHERE id=$1', [data.event.id])).rows[0];
      if (previous) {
        if (previous.assistance_id !== id || previous.subject_id !== actor.subjectId || previous.consent_id !== consentId
          || previous.payload_hash !== digest(payloadJson)) throw new ServiceError('assistance_event_conflict', 409);
        return { assistanceId: id, eventId: data.event.id, version: previous.version };
      }
      if (data.event.kind === 'invite') {
        if (!this.visible(grants.get(id), data.event.participantId)
          || !(await db.query('SELECT id FROM subjects WHERE id=$1', [data.event.participantId])).rows.length)
          throw new ServiceError('invitation_recipient_unavailable', 403);
      }
      const state = applyAssistance(row.snapshot, actor.subjectId, data.event, this.access.now());
      if (row.snapshot.request.qualification && ['select','confirm'].includes(data.event.kind)) {
        const selected=state.offers.find(offer=>offer.id===state.selected?.offerId);
        const evaluation=await this.qualification.evaluateWithin(db,actor,{...row.snapshot.request.qualification,
          capabilityId:row.snapshot.request.capabilityId,subjectId:state.selected.providerId,
          evidence:selected.qualificationEvidence??{proofIds:[],assistanceIds:[]}},row.snapshot.request.collaboration);
        if(!evaluation.eligible)throw new ServiceError('qualification_required',403);
      }

      const recipients = [row.requester_id];
      if (data.event.kind === 'invite') recipients.push(data.event.participantId);
      if (data.event.kind !== 'shortlist' && state.selected) recipients.push(state.selected.providerId);
      const publicContribution=grant.visibility==='Public'&&grant.purpose==='public-profile'&&row.snapshot.request.visibility==='Public'
        &&publicContributionEventKinds.includes(data.event.kind);
      if (grant.visibility !== 'Private' && !publicContribution || recipients.some(subjectId => !this.visible(grant, subjectId)))
        throw new ServiceError('assistance_participant_consent_required', 403);
      if (data.event.kind === 'invite') await this.taskQuota(db, actor, 'invitation', data.event.id, payloadJson,
        { taskId: id, recipientId: data.event.participantId });
      if (data.event.kind === 'offer') await this.publicWrites?.markInvitationRespondedWithin?.(db,
        { taskId: id, recipientId: actor.subjectId });
      if (data.event.kind === 'deliver') {
        if(data.event.caseReviewVersion!==undefined){
          const source=await readAssistanceCaseReview(db,{caseId:row.case_id,viewerId:actor.subjectId,consents:this.consents,endpoint:this.access.endpoint,now:this.access.now()});
          if(source.reviewVersion!==data.event.caseReviewVersion)throw new ServiceError('assistance_case_version_changed',409);
        }
        const attempt = (await db.query("SELECT id FROM case_events WHERE id=$1 AND case_id=$2 AND kind='attempt'", [data.event.attemptId, row.case_id])).rows[0];
        if (!attempt) throw new ServiceError('assistance_attempt_required', 409);
        for (const evidenceId of data.event.evidenceIds) {
          const evidence = (await db.query(`SELECT e.id FROM evidence_submissions e JOIN case_events r ON r.id=e.result_id
            WHERE e.id=$1 AND e.case_id=$2 AND r.payload->>'attemptId'=$3`, [evidenceId, row.case_id, data.event.attemptId])).rows[0];
          if (!evidence) throw new ServiceError('assistance_evidence_mismatch', 409);
        }
      }
      await this.insert(db, actor, authorization, id, data.event.id, state.version, consentId, payloadJson);
      if(data.event.kind==='accept'&&row.snapshot.delivery?.caseReviewVersion!==undefined){
        const source=await readAssistanceCaseReview(db,{caseId:row.case_id,viewerId:actor.subjectId,consents:this.consents,endpoint:this.access.endpoint,now:this.access.now()});
        if(source.reviewVersion!==row.snapshot.delivery.caseReviewVersion)throw new ServiceError('assistance_case_version_changed',409);
      }
      await db.query('UPDATE assistance_requests SET version=$2,snapshot=$3 WHERE id=$1', [id, state.version, JSON.stringify(state)]);
      return { assistanceId: id, eventId: data.event.id, version: state.version };
    });
  }
  async readWithin(db, actor, id) {
    const { row, grants, paused } = await this.load(db, id);
    if (!this.visible(grants.get(id), actor.subjectId)) throw new ServiceError('not_found', 404);
    const state = row.snapshot;
    const eventFeatures={deliveryCaseReview:1,resumeWorkResolution:1,publicRequesterFeedback:1};
    let deliverySource=null;
    if(actor.subjectId===row.requester_id||state.selected?.providerId===actor.subjectId){
      try{deliverySource=await readAssistanceCaseReview(db,{caseId:row.case_id,viewerId:actor.subjectId,consents:this.consents,endpoint:this.access.endpoint,now:this.access.now()});
      }catch(error){if(!(error instanceof ServiceError))throw error;}
    }
    if (actor.subjectId === row.requester_id) return { ...state, paused, deliverySource,eventFeatures, view: 'requester' };
    const ownOffers = state.offers.filter(offer => offer.providerId === actor.subjectId);
    if (state.selected?.providerId !== actor.subjectId)
      return { request: state.request, paused,eventFeatures, requesterId: state.requesterId, version: state.version, state: state.state,
        view: 'applicant', offers: ownOffers, contextAccessGranted: false, paymentExecuted: false, capabilityVerified: false };
    return { ...state, paused, deliverySource,eventFeatures, view: 'selected-provider', offers: ownOffers, shortlist: [], invitations: (state.invitations ?? []).filter(item => item.participantId === actor.subjectId),
      events: state.events.filter(item => item.event.kind !== 'shortlist' && this.visible(grants.get(item.event.id), actor.subjectId)) };
  }
  async get(actor, id) {
    if (!z.uuid().safeParse(id).success) throw new ServiceError('not_found', 404);
    return this.access.runAuthorized(actor, 'assistance', db => this.readWithin(db, actor, id));
  }
  async query(actor, input = {}) {
    const parsed = assistanceQuerySchema.safeParse(input);
    if (!parsed.success) throw new ServiceError('invalid_assistance_query');
    return this.access.runAuthorized(actor, 'assistance', db => this.queryWithin(db, actor, parsed.data));
  }
  async queryWithin(db, actor, options) {
      const now = new Date(this.access.now() * 1000).toISOString();
      const candidates = (await db.query(`SELECT a.id FROM assistance_requests a
        JOIN cases parent ON parent.id=a.case_id
        JOIN assistance_events root ON root.id=a.id JOIN consents rootgrant ON rootgrant.id=root.consent_id
        WHERE ($1::uuid IS NULL OR a.id>$1) AND parent.state<>'withdrawn'
        AND ($2='open' AND NOT EXISTS(SELECT 1 FROM moderation_reports m WHERE (m.assistance_id=a.id OR m.case_id=a.case_id) AND m.paused=true) AND a.snapshot->>'state'='open' AND (a.snapshot->'request'->>'enrollmentExpiresAt')::bigint>$3
          OR $2='requested' AND a.requester_id=$4
          OR $2='requester-history' AND a.requester_id=$8
          OR $2='participating' AND EXISTS (SELECT 1 FROM assistance_events e WHERE e.assistance_id=a.id AND e.subject_id=$4))
        AND strpos(lower((a.snapshot->'request'->>'title') || ' ' || (a.snapshot->'request'->>'problem')),lower($5))>0
        AND (a.requester_id=$4 OR rootgrant.intent->>'visibility'='Public' AND rootgrant.intent->>'purpose'='public-profile'
          OR rootgrant.intent->>'visibility'='Private' AND rootgrant.intent->'viewers' ? $4)
        AND NOT EXISTS (SELECT 1 FROM assistance_events e LEFT JOIN consents c ON c.id=e.consent_id
          LEFT JOIN bindings b ON b.id=c.binding_id WHERE e.assistance_id=a.id AND
          (c.id IS NULL OR b.id IS NULL OR c.revoked_at IS NOT NULL OR b.revoked_at IS NOT NULL OR c.expires_at<=$6 OR b.expires_at<=$6))
        AND NOT EXISTS (SELECT 1 FROM case_events e LEFT JOIN consents c ON c.id=e.consent_id
          LEFT JOIN bindings b ON b.id=c.binding_id WHERE e.case_id=a.case_id AND
          (c.id IS NULL OR b.id IS NULL OR c.revoked_at IS NOT NULL OR b.revoked_at IS NOT NULL OR c.expires_at<=$6 OR b.expires_at<=$6))
        ORDER BY a.id LIMIT $7`, [options.after ?? null, options.view, this.access.now(), actor.subjectId, options.query, now, options.limit + 1, options.requesterId ?? actor.subjectId])).rows;
      const items = [];
      for (const candidate of candidates) {
        try {
          const visible = await this.readWithin(db, actor, candidate.id);
          items.push({ assistanceId: visible.request.id, requesterId: visible.requesterId, request: visible.request,
            state: visible.state, version: visible.version, view: visible.view, capabilityVerified: false });
        } catch (error) {
          if (!(error instanceof ServiceError) || !['not_found', 'consent_required', 'assistance_case_unavailable'].includes(error.code)) throw error;
        }
      }
      return { items: items.slice(0, options.limit), nextAfter: items.length > options.limit ? items[options.limit - 1].assistanceId
        : candidates.length === options.limit + 1 ? candidates.at(-1).id : null };
  }
  async requesterHistory(actor, input = {}) {
    const parsed = requesterHistorySchema.safeParse(input); if (!parsed.success) throw new ServiceError('invalid_requester_history_query');
    const options = parsed.data, subjectId = options.subjectId ?? actor.subjectId;
    return this.access.runAuthorized(actor, 'assistance', async db => {
      const page = await this.queryWithin(db, actor, { view: 'requester-history', requesterId: subjectId, query: '', limit: options.limit, after: options.after });
      const items = [];
      for (const candidate of page.items) {
        try {
          const { row, grants } = await this.load(db, candidate.assistanceId), state = row.snapshot;
          if (!this.visible(grants.get(row.id), actor.subjectId)) continue;
          items.push(requesterHistoryPreview(projectRequesterHistory(state, id => this.visible(grants.get(id), actor.subjectId))));
        } catch (error) { if (!(error instanceof ServiceError) || ![403,404].includes(error.status)) throw error; }
      }
      return { subjectId, items, nextAfter: page.nextAfter, summaryScope: 'visible-page-only',
        counts: { requests: items.length, acceptances: items.reduce((n,item) => n+item.counts.acceptances,0),
          cancellations: items.reduce((n,item) => n+item.counts.cancellations,0), disputes: items.reduce((n,item) => n+item.counts.disputes,0) },
        countBasis: 'visible-events; repeated-acceptance-is-not-another-request' };
    });
  }
  async requesterHistoryFacts(actor, input) {
    const parsed = requesterHistoryFactsSchema.safeParse(input); if (!parsed.success) throw new ServiceError('invalid_requester_history_query');
    const options = parsed.data;
    return this.access.runAuthorized(actor, 'assistance', async db => {
      const { row, grants } = await this.load(db, options.assistanceId, {readOnly:true});
      if (!this.visible(grants.get(row.id), actor.subjectId)) throw new ServiceError('not_found', 404);
      const projection = projectRequesterHistory(row.snapshot, id => this.visible(grants.get(id), actor.subjectId));
      const cursor = options.after && row.snapshot.events.findIndex(item => item.event.id === options.after && requesterFactKinds.includes(item.event.kind));
      if (cursor === -1) throw new ServiceError('invalid_requester_history_cursor');
      const tailIds = options.after ? new Set(row.snapshot.events.slice(cursor + 1).map(item => item.event.id)) : null;
      const remaining = projection.facts.filter(fact => !tailIds || tailIds.has(fact.eventId)), facts = remaining.slice(0, options.limit);
      return { ...projection, facts, nextAfter: remaining.length > facts.length ? facts.at(-1).eventId : null,
        summaryScope: 'visible-request-only', factsSupported: 1 };
    });
  }

}
