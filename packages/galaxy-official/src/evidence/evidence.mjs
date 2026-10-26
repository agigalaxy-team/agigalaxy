import { recordObjectAudit } from "../infrastructure/object-audit.mjs";
import { resourceBudgetPolicySchema } from "../infrastructure/resource-budgets.mjs";
import { evidenceRepository } from "../infrastructure/evidence-repository.mjs";
import * as z from 'zod/v4';
import { randomUUID } from 'node:crypto';
import { digest } from "../shared/digest.mjs";
import { ServiceError } from "../shared/service-error.mjs";
import { transaction } from "../infrastructure/database.mjs";
import { githubEvidenceSource } from './github-evidence.mjs';
import { evidenceSource, checkedObservation } from './evidence-source.mjs';
import { currentVerificationJob } from "../domain/verification-current.mjs";

export class EvidenceService {
  // General references use the v2 object/event service. Existing submit/get and
  // background CI observation behavior retain their original payload semantics.
  async submitV2(actor,request){
    if(!this.records)throw new ServiceError('verification_records_unavailable',503);
    if(this.records.parse(request).kind!=='evidence')throw new ServiceError('invalid_evidence');
    return this.records.submit(actor,request);
  }
  async getV2(actor,id,version){
    if(!this.records)throw new ServiceError('verification_records_unavailable',503);
    return this.records.get(actor,{type:'evidence',id,version});
  }
  constructor(access, consents, { db = access?.db, endpoint = access?.endpoint, now = access?.now, readCase, lockEvidenceWrite, source = githubEvidenceSource, resourceBudgetPolicy=access?.resourceBudgetPolicy } = {}) {
    this.source = evidenceSource(source);
    this.resourceBudgetPolicy=resourceBudgetPolicy?resourceBudgetPolicySchema.parse(resourceBudgetPolicy):null;
    this.schema = z.strictObject({ id: z.uuid(), caseId: z.uuid(), resultId: z.uuid(), source: source.referenceSchema });
    this.access = access; this.consents = consents;
    this.lockEvidenceWrite = lockEvidenceWrite;
    this.readCase = readCase; this.db = db; this.endpoint = endpoint; this.now = now;
  }

  async live(db, evidence) {
    const parent = (await (this.readCase ? this.readCase(db, evidence.case_id, evidence.subject_id) : evidenceRepository(db).lockCase([evidence.case_id, evidence.subject_id]))).rows[0];
    if (!parent || parent.state === 'withdrawn') throw new ServiceError('case_unavailable', 403);
    const result = (await evidenceRepository(db).result([evidence.result_id, evidence.case_id])).rows[0];
    if (!result) throw new ServiceError('result_required');
    const ancestors = (await evidenceRepository(db).ancestors([evidence.case_id, result.payload.attemptId])).rows;
    if (ancestors.length !== 2) throw new ServiceError('source_history_incomplete');
    for (const grant of [
      ...ancestors.map(event => ({ id: event.consent_id, objectId: event.id, action: 'case.teaser.publish', payloadJson: event.payload_text })),
      { id: result.consent_id, objectId: result.id, action: 'case.teaser.publish', payloadJson: result.payload_text },
      { id: evidence.consent_id, objectId: evidence.id, action: 'evidence.submit', payloadJson: evidence.payload_text },
    ]) await this.consents.require(db, { ...grant, subjectId: evidence.subject_id, recipient: this.endpoint });
  }

  async submit(actor, { consentId, payloadJson }) {
    let data;
    try { if (typeof payloadJson !== 'string' || payloadJson.length > 4096) throw new Error(); data = this.schema.parse(JSON.parse(payloadJson)); }
    catch { throw new ServiceError('invalid_evidence'); }
    return this.access.runResourceWrite(actor,'evidence',{}, async (db, authorization) => {
      const record = { id: data.id, subject_id: actor.subjectId, case_id: data.caseId, result_id: data.resultId,
        consent_id: consentId, payload_text: payloadJson };
      await this.live(db, record);
      const hash = digest(payloadJson);
      await evidenceRepository(db).insert([data.id, actor.subjectId, data.caseId, data.resultId,
        consentId, this.source.sourceKey(data.source), payloadJson, hash]);
      const saved = (await (this.lockEvidenceWrite ? this.lockEvidenceWrite(db, data.id, actor.subjectId) : evidenceRepository(db).lock([data.id]))).rows[0];
      if (!saved || saved.subject_id !== actor.subjectId || saved.payload_hash !== hash || saved.consent_id !== consentId)
        throw new ServiceError('evidence_conflict', 409);
      await evidenceRepository(db).enqueue([randomUUID(), `verify:${data.id}`, JSON.stringify({ evidenceId: data.id }), this.source.jobKind]);
      await recordObjectAudit(db, { subjectId: actor.subjectId, objectId: data.id, action: 'evidence.submit',
        httpRequestId: actor.httpRequestId ?? null, credentialScopes: authorization.credentialScopes, callerBindingId: authorization.callerBindingId });
      return { evidenceId: data.id, state: saved.state, capabilityVerified: false };
    });
  }

  async get(actor, id) {
    if (!z.uuid().safeParse(id).success) throw new ServiceError('not_found', 404);
    return this.access.runAuthorized(actor, 'evidence', async db => {
      const saved = (await evidenceRepository(db).getOwned([id, actor.subjectId])).rows[0];
      if (!saved) throw new ServiceError('not_found', 404);
      await this.live(db, saved);
      const attempts = (await evidenceRepository(db).observations([id])).rows;
      const latest = attempts[0]?.observation;
      const job=await currentVerificationJob(db,id,this.source.jobKind);
      const current=attempts[0]?.job_id===job?.id;
      const state=job?.payload.revalidation&&['pending','running'].includes(job.state)?'revalidating':!current&&job?.state==='failed'?'unavailable':saved.state;
      return { evidenceId: id, state: state === 'observed' && latest?.validUntil <= this.now() ? 'stale' : state,
        verificationGeneration:job?.payload.revalidation?.generation??0,
        observations: attempts.map(row => row.observation), capabilityVerified: false };
    });
  }

  async revalidationLive(db,job){
    const command=job.payload.revalidation;if(!command)return;
    const event=(await db.query('SELECT * FROM moderation_events WHERE id=$1 AND report_id=$2',[command.eventId,command.reportId])).rows[0];
    if(!event||event.subject_id!==command.subjectId||event.consent_id!==command.consentId)throw new ServiceError('revalidation_consent_required',403);
    const payload=JSON.parse(event.payload_text);
    if(payload.kind!=='revalidate'||payload.evidenceId!==job.payload.evidenceId)throw new ServiceError('revalidation_target_mismatch',403);
    await this.consents.require(db,{id:event.consent_id,subjectId:event.subject_id,action:'moderation.publish',objectId:event.id,recipient:this.endpoint,payloadJson:event.payload_text});
  }

  async processNext(verify = this.source.verify) {
    const now = this.now();
    const job = await transaction(this.db, async db => {
      if(this.resourceBudgetPolicy){
        await db.query('SELECT pg_advisory_xact_lock(734912310)');
        const active=Number((await db.query("SELECT count(*) FROM jobs WHERE state='running' AND locked_until>$1",[new Date(now*1000).toISOString()])).rows[0].count);
        if(active>=this.resourceBudgetPolicy.maxActiveJobsGlobal)return {budgetLimited:true};
      }
      const records = evidenceRepository(db);
      const exhausted = (await records.failExhausted([new Date(now * 1000).toISOString(), this.source.jobKind])).rows;
      for (const item of exhausted) await records.auditJobTransition(item.payload.evidenceId, this.source.jobKind,
        'verification.exhausted', this.source.verifier, item.id);
      const unavailable = (await records.markUnavailable([this.source.jobKind])).rows;
      for (const item of unavailable) await records.auditJobTransition(item.id, this.source.jobKind,
        'evidence.unavailable', this.source.verifier);
      const selected = (await (this.resourceBudgetPolicy?records.claimBudgetCandidate([new Date(now*1000).toISOString(),this.source.jobKind,this.resourceBudgetPolicy.maxActiveJobsPerSubject])
        :records.claimCandidate([new Date(now * 1000).toISOString(), this.source.jobKind]))).rows[0];
      if (!selected) return null;
      const lease = randomUUID();
      await evidenceRepository(db).lease([selected.id, lease, new Date((now + 30) * 1000).toISOString()]);
      return { ...selected, lease_id: lease, attempts: selected.attempts + 1 };
    });
    if (!job) return { processed: false };
    if(job.budgetLimited)return {processed:false,budgetLimited:true};
    const evidence = (await evidenceRepository(this.db).get([job.payload.evidenceId])).rows[0];
    if(!evidence)return {processed:false,leaseLost:true};
    let observation;
    try {
      await transaction(this.db, async db => {await this.live(db, evidence);await this.revalidationLive(db,job);});
      try {
        const reference = this.source.referenceSchema.parse(JSON.parse(evidence.payload_text).source);
        const collectedAt = this.now();
        observation = checkedObservation(this.source, await verify(reference, collectedAt), reference, collectedAt);
      }
      catch { observation = { status: 'unavailable', capabilitiesVerified: false, collectedAt: this.now(), reason: 'source_unavailable_or_invalid' }; }
    } catch (error) {
      if (!(error instanceof ServiceError)) throw error;
      observation = { status: 'revoked', capabilitiesVerified: false, collectedAt: this.now() };
    }
    return transaction(this.db, async db => {
      const current = (await evidenceRepository(db).lockJob([job.id])).rows[0];
      if (!current || current.lease_id !== job.lease_id || current.state !== 'running') return { processed: false, leaseLost: true };
      try { await this.live(db, evidence);await this.revalidationLive(db,job); }
      catch (error) {
        if (!(error instanceof ServiceError)) throw error;
        observation = { status: 'revoked', capabilitiesVerified: false, collectedAt: this.now() };
      }
      await evidenceRepository(db).insertObservation([randomUUID(), evidence.id, job.id, job.attempts, JSON.stringify(observation)]);
      await evidenceRepository(db).updateState([evidence.id, observation.status]);
      const retry = observation.status === 'unavailable' && job.attempts < 5;
      await evidenceRepository(db).finishJob([job.id, retry ? 'pending' : observation.status === 'unavailable' ? 'failed' : 'completed',
          new Date((this.now() + Math.min(300, 10 * 2 ** job.attempts)) * 1000).toISOString()]);
      await evidenceRepository(db).auditObservation([evidence.id, job.id, observation.status, this.source.verifier, job.attempts]);
      return { processed: true, state: observation.status };
    });
  }
}
