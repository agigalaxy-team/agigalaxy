import {capsuleUseV2Schema,capsuleUsesQuerySchema,capsuleUseOriginRef} from "../../shared/capsule-v2-schema.mjs";
import {capsuleRule as rule,parseCapsuleV2 as parse} from "./sources.mjs";
import {ServiceError} from "../../shared/service-error.mjs";
import {digest} from "../../shared/digest.mjs";
import {transaction} from "../../database.mjs";
import {absent,json,ownControl,audit} from './helpers.mjs';
import {CapsulePublication} from './publication.mjs';

// Actual reference/application/reverification records and current evidence. Reading is not use and a retained foreign use does not restore a source body.
export class CapsuleUses extends CapsulePublication{
  async applicationWithin(db, actor, payload, { latest = false } = {}) {
    const originRef = capsuleUseOriginRef(payload);
    const origin = await this.sourceWithin(db, actor, { ...originRef, caseId: payload.caseId });
    const result = await this.sourceWithin(db, actor, { kind: 'result', ...payload.resultRef, caseId: payload.caseId }, { latest });
    rule(origin.authorId === actor.subjectId && result.authorId === actor.subjectId, 'capsule_application_author_required', 403);
    const recorded = result.fact.origin;
    rule(recorded.kind === originRef.kind && recorded.id === originRef.id && recorded.version === originRef.version, 'capsule_result_mismatch');
    rule(result.fact.reportedOutcome === payload.outcome, 'capsule_result_mismatch');
    let environment = originRef.kind === 'attempt' && typeof origin.fact.environment === 'object' ? origin.fact.environment : { name: 'unknown', version: 'unknown' };
    let environmentSource = originRef.kind === 'attempt' ? 'recorded-attempt; subject-reported' : 'unknown-origin-conditions';
    if (payload.configurationRef) {
      rule(this.configurations, 'capsule_configuration_source_unavailable', 503);
      rule(origin.fact.sourceRefs.some(ref => ref.kind === 'configuration' && ref.id === payload.configurationRef.id
        && ref.version === payload.configurationRef.version), 'capsule_configuration_not_in_origin');
      const selected = await this.configurations.requireReferenceWithin(db, actor, payload.configurationRef);
      environment = { name: selected.record.conditions.environment.name ?? 'unknown', version: selected.record.conditions.environment.version ?? 'unknown' };
      environmentSource = 'selected-origin-configuration; subject-reported';
    }
    rule(environment.name === payload.environment.name && environment.version === payload.environment.version, 'capsule_environment_mismatch');
    rule((result.fact.taskId ?? null) === (payload.taskId ?? null) && (result.fact.participationId ?? null) === (payload.participationId ?? null), 'capsule_application_context_mismatch');
    if (latest && payload.participationId) {
      rule(this.cases.tasks, 'capsule_participation_source_unavailable', 503);
      const p = await this.cases.tasks.requireParticipationWithin(db, actor, { taskId: payload.taskId, participationId: payload.participationId });
      rule(p.subjectId === actor.subjectId && p.scopeVersion === result.fact.participationScopeVersion, 'capsule_application_scope_changed', 403);
    }
    return { origin, result, environmentSource, synthetic: result.synthetic,
      currentResult: result.currentness === 'current', resultCurrentness: result.currentness };
  }
  async recordUse(actor, request) {
    const payload = parse(request.payloadJson, capsuleUseV2Schema);
    return this.access.runResourceWrite(actor, 'capsules', {}, async (db, authorization) => {
      // Match Task → Case lock order used by actual participant writes.
      if(payload.taskId)await this.cases.tasks.requireTaskWithin(db,actor,payload.taskId,{write:false});
      const parent = (await db.query('SELECT * FROM capsules WHERE id=$1 FOR UPDATE', [payload.capsuleId])).rows[0]; rule(parent, 'capsule_unavailable', 404);
      const grant = await this.legacy.grant(db, { id: payload.id, subject_id: actor.subjectId, consent_id: request.consentId, payload_text: request.payloadJson }, 'capsule.use');
      rule(['Private', 'Public'].includes(grant.visibility), 'capsule_visibility_required', 403);
      const previous = (await db.query('SELECT * FROM capsule_uses_v2 WHERE id=$1', [payload.id])).rows[0];
      if (previous) { rule(previous.subject_id === actor.subjectId && previous.payload_hash === digest(request.payloadJson) && previous.consent_id === request.consentId, 'capsule_use_conflict');
        return { eventId: payload.id, capsuleId: payload.capsuleId, versionId: payload.versionId, kind: payload.kind,
          reportedOutcome: payload.outcome ?? null, verifiedReuse: false, capabilityVerified: false }; }
      rule(payload.attribution === parent.subject_id, 'capsule_attribution_mismatch');
      const current = await this.versionWithin(db, actor, payload.capsuleId, payload.versionId, { tolerateUnavailableSource: false });
      if (payload.kind === 'reference') {
        const reader = await this.cases.readV2Within(db, actor, payload.caseId, { taskId: payload.taskId }); rule(reader, 'capsule_case_unavailable');
      } else {
        rule(!current.deprecated && !current.securityIssue && current.source.sourceCurrent, 'capsule_not_applicable');
        rule(payload.caseId !== current.payload.sourceResolution.caseId, 'capsule_new_case_required');
        await this.applicationWithin(db, actor, payload, { latest: true });
        if (payload.kind === 'reverify') {
          const prior = (await db.query("SELECT * FROM capsule_uses_v2 WHERE id=$1 AND subject_id=$2 AND version_id=$3 AND case_id=$4 AND kind='apply'", [payload.priorUseId, actor.subjectId, payload.versionId, payload.caseId])).rows[0];
          rule(prior?.payload_text, 'capsule_application_required'); await this.legacy.grant(db, prior, 'capsule.use');
          const original = parse(prior.payload_text, capsuleUseV2Schema), originalOrigin = capsuleUseOriginRef(original), selectedOrigin = capsuleUseOriginRef(payload);
          rule(original.resultRef.id === payload.resultRef.id && original.resultRef.version === payload.resultRef.version
            && originalOrigin.kind === selectedOrigin.kind && originalOrigin.id === selectedOrigin.id && originalOrigin.version === selectedOrigin.version,
          'capsule_application_mismatch');
          rule((original.configurationRef?.id ?? null) === (payload.configurationRef?.id ?? null)
            && (original.configurationRef?.version ?? null) === (payload.configurationRef?.version ?? null), 'capsule_application_mismatch');
          for (const ref of payload.verificationRefs) {
            const verification = await this.verificationRecords.requireReferenceWithin(db, actor, { kind: 'verification', ...ref }, { caseId: payload.caseId });
            rule(verification.record.target.type === 'result' && verification.record.target.id === payload.resultRef.id && verification.record.target.version === payload.resultRef.version, 'capsule_verification_mismatch');
          }
        }
      }
      const fingerprint = payload.kind === 'reverify' ? digest(json(payload.verificationRefs.map(ref => `${ref.id}:${ref.version}`).sort())) : '';
      const originRef = payload.kind === 'reference' ? null : capsuleUseOriginRef(payload);
      try {
        await db.query(`INSERT INTO capsule_uses_v2(id,capsule_id,version_id,subject_id,case_id,attempt_id,attempt_version,result_id,result_version,prior_use_id,
          kind,observed_revision,verification_fingerprint,consent_id,payload_text,payload_hash,origin_kind,origin_id,origin_version) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)`,
        [payload.id, payload.capsuleId, payload.versionId, actor.subjectId, payload.caseId, originRef?.kind === 'attempt' ? originRef.id : null, originRef?.kind === 'attempt' ? originRef.version : null,
          payload.resultRef?.id ?? null, payload.resultRef?.version ?? null, payload.priorUseId ?? null, payload.kind, parent.revision, fingerprint,
          request.consentId, request.payloadJson, digest(request.payloadJson), originRef?.kind ?? null, originRef?.id ?? null, originRef?.version ?? null]);
      } catch (error) { if (error.code === '23505') throw new ServiceError('capsule_use_already_recorded', 409); throw error; }
      await audit(db, actor, authorization, payload.id, 'capsule.use');
      return { eventId: payload.id, capsuleId: payload.capsuleId, versionId: payload.versionId, kind: payload.kind,
        reportedOutcome: payload.outcome ?? null, verifiedReuse: false, capabilityVerified: false };
    });
  }
  async useWithin(db, actor, row) {
    rule(row?.payload_text, 'capsule_use_unavailable', 404);
    const grant = await this.legacy.grant(db, row, 'capsule.use'); rule(this.legacy.visible(grant, actor), 'capsule_use_unavailable', 404);
    const payload = parse(row.payload_text, capsuleUseV2Schema), base = { eventId: row.id, capsuleId: row.capsule_id,
      ...ownControl(actor,row,'use'),
      versionId: row.version_id, caseId: row.case_id, subjectId: row.subject_id, kind: row.kind,
      recordedAt: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
      actualExecutionIndependentlyVerified: false, verifiedReuse: false, capabilityVerified: false };
    let current;
    try { current = await this.versionWithin(db, actor, row.capsule_id, row.version_id); }
    catch (error) { if (!absent(error)) throw error; return { ...base, sourceStatus: 'capsule-unavailable', record: null }; }
    let applied;
    try {
      if (payload.kind === 'reference') await this.cases.readV2Within(db, { subjectId: row.subject_id }, row.case_id, { taskId: payload.taskId });
      else applied = await this.applicationWithin(db, { subjectId: row.subject_id }, payload);
    } catch (error) { if (!absent(error)) throw error; return { ...base, sourceStatus: 'application-source-unavailable', record: null }; }
    if (current.sourceStatus === 'source-unavailable') return { ...base, sourceStatus: 'capsule-source-unavailable', record: null };
    const verifications = [];
    for (const ref of payload.verificationRefs ?? []) {
      try { verifications.push(await this.verificationRecords.readWithin(db, actor ?? { subjectId: null }, { type: 'verification', ...ref })); }
      catch (error) { if (!absent(error)) throw error; verifications.push({ id: ref.id, version: ref.version, referenceStatus: 'unavailable', record: null }); }
    }
    if (payload.kind === 'reverify') {
      const prior = (await db.query('SELECT * FROM capsule_uses_v2 WHERE id=$1', [payload.priorUseId])).rows[0];
      try { rule(prior?.payload_text, 'capsule_application_required'); const pg = await this.legacy.grant(db, prior, 'capsule.use'); rule(this.legacy.visible(pg, actor), 'capsule_application_required'); }
      catch (error) { if (!absent(error)) throw error; return { ...base, sourceStatus: 'prior-application-unavailable', record: null }; }
    }
      return { ...base, record: payload, sourceStatus: applied && !applied.currentResult
        ? applied.resultCurrentness === 'unavailable' ? 'application-currentness-unavailable' : 'application-result-superseded' : 'current',
      ...(applied ? { originRef: capsuleUseOriginRef(payload), environmentSource: applied.environmentSource } : {}),
      capsuleSourceStatus: current.sourceStatus, capsuleDeprecated: current.deprecated, capsuleSecurityIssue: current.securityIssue,
      synthetic: applied?.synthetic===true || current.source.synthetic===true ? true : applied?.synthetic===false && current.source.synthetic===false ? false : null, verifications,
      verificationMeaning: 'current-scoped-reports; not-independent-causality-or-expertise',
      reportedOutcome: payload.outcome ?? null, readingIsReuse: false };
  }
  async historyWithin(db,actor,caseId){
    const rows=(await db.query('SELECT * FROM capsule_uses_v2 WHERE case_id=$1 ORDER BY id',[caseId])).rows,items=[];
    for(const row of rows)try{items.push(await this.useWithin(db,actor,row));}catch(error){if(!absent(error))throw error;}
    return {items,readingIsReuse:false,capabilityVerified:false,sourceScope:'currently-authorized-v2-use-records; no-aggregate-capability'};
  }
  async usesWithin(db, actor, input) {
    const options = capsuleUsesQuerySchema.parse(input), items = []; let cursor = null;
    for (;;) {
      const rows = (await db.query(`SELECT * FROM capsule_uses_v2 WHERE ($1::uuid IS NULL OR capsule_id=$1)
        AND ($2::uuid IS NULL OR version_id=$2) AND ($3::uuid IS NULL OR case_id=$3) AND ($4::uuid IS NULL OR id>$4) ORDER BY id LIMIT 100`,
      [options.capsuleId ?? null, options.versionId ?? null, options.caseId ?? null, cursor])).rows;
      for (const row of rows) { try { items.push(await this.useWithin(db, actor, row)); } catch (error) { if (!absent(error)) throw error; } }
      if (rows.length < 100) break; cursor = rows.at(-1).id;
    }
    const afterItems = items.filter(item => !options.after || item.eventId > options.after), page = afterItems.slice(0, options.limit);
    const groups = new Map();
    for (const item of items) if (item.record && item.kind !== 'reference' && item.sourceStatus === 'current' && item.synthetic === false) {
      const set = groups.get(item.caseId) ?? new Set(); set.add(item.reportedOutcome); groups.set(item.caseId, set);
    }
    return { items: page, nextAfter: afterItems.length > options.limit ? page.at(-1).eventId : null,
      countsScope: 'currently-visible-v2-records-for-requested-filter', readingIsReuse: false, capabilityVerified: false,
      counts: { references: items.filter(i => i.kind === 'reference' && i.record).length,
        applications: items.filter(i => i.kind === 'apply' && i.record).length, reverifications: items.filter(i => i.kind === 'reverify' && i.record).length,
        syntheticApplications: items.filter(i=>i.record && i.kind==='apply' && i.synthetic===true).length,
        distinctTargetCases: groups.size, reportedSuccessfulTargetCases: [...groups.values()].filter(set => set.size === 1 && set.has('succeeded')).length,
        mixedOutcomeTargetCases: [...groups.values()].filter(set => set.size > 1).length, independentlyVerifiedReuseCases: 0 },
      legacyUses: 'available-separately-through-v1; counts-not-merged' };
  }
  uses(actor, input) { rule(capsuleUsesQuerySchema.safeParse(input).success, 'invalid_capsule_query', 400);
    return actor ? this.access.runAuthorized(actor, 'capsules', db => this.usesWithin(db, actor, input)) : transaction(this.access.db, db => this.usesWithin(db, null, input)); }
}
