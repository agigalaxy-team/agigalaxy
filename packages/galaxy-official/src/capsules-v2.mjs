import { capsuleEventV2Schema, capsuleUseV2Schema, capsulePreviewV2Schema, capsuleReadSchema,
  capsuleQuerySchema, capsuleUsesQuerySchema } from './shared/capsule-v2-schema.mjs';
import { CapsuleSourcesV2, capsuleRule as rule, parseCapsuleV2 as parse } from './capsule-sources-v2.mjs';
import { ServiceError } from './shared/service-error.mjs';
import { digest } from './shared/digest.mjs';
import { transaction } from './database.mjs';
import { recordObjectAudit } from './infrastructure/object-audit.mjs';
import {capsuleReceiptV2Schema,capsuleVersionsV2Schema,capsulePermissionsQueryV2Schema} from './shared/capsule-v2-schema.mjs';
const absent = e => e instanceof ServiceError && [400, 403, 404, 409, 422, 503].includes(e.status);
const json = value => JSON.stringify(value);
const ownControl=(actor,row,type)=>actor?.subjectId===row.subject_id?{ownerControl:{type,operationId:row.id,consentId:row.consent_id,payloadHash:row.payload_hash}}:{};
const audit = (db, actor, authorization, id, action) => recordObjectAudit(db, { subjectId: actor.subjectId,
  objectId: id, action, httpRequestId: actor.httpRequestId ?? null, ...authorization });

export class CapsuleServiceV2 extends CapsuleSourcesV2 {
  async receipt(actor, input) {
    const options = capsuleReceiptV2Schema.safeParse(input);
    rule(options.success,'invalid_capsule_receipt',400);
    return this.access.runAuthorized(actor,'capsules',async db=>{
      const {type,operationId,payloadHash}=options.data;
      // Receipt ownership is independent of now-withdrawn source/body access.
      // A recorded hash confirms accepted bytes, never current permission.
      let row;
      if(type==='publication') row=(await db.query('SELECT id,capsule_id,version_id,revision,consent_id,payload_hash FROM capsule_events WHERE id=$1 AND subject_id=$2',[operationId,actor.subjectId])).rows[0];
      else if(type==='use') row=(await db.query('SELECT id,capsule_id,version_id,kind,consent_id,payload_hash FROM capsule_uses_v2 WHERE id=$1 AND subject_id=$2',[operationId,actor.subjectId])).rows[0];
      else row=(await db.query(`SELECT id AS permission_id,CASE WHEN id=$1 THEN consent_id ELSE revoke_consent_id END AS consent_id,
        CASE WHEN id=$1 THEN payload_hash ELSE revoke_payload_hash END AS payload_hash FROM capsule_permissions WHERE subject_id=$2 AND (id=$1 OR revoke_id=$1)`,[operationId,actor.subjectId])).rows[0];
      if(!row)return {state:'absent',operationId,currentReadPermissionConfirmed:false};
      if(row.payload_hash!==payloadHash)return {state:'conflict',operationId,currentReadPermissionConfirmed:false};
      return {state:'acknowledged',operationId,consentId:row.consent_id,...(row.capsule_id?{capsuleId:row.capsule_id,versionId:row.version_id}:{}),
        ...(row.permission_id?{permissionId:row.permission_id}:{}),...(row.revision?{revision:row.revision}:{}),currentReadPermissionConfirmed:false};
    });
  }
  async versions(actor,input){
    const options=capsuleVersionsV2Schema.safeParse(input);
    rule(options.success,'invalid_capsule_query',400);
    const read=async db=>{
      const p=options.data,rows=(await db.query("SELECT id,subject_id FROM capsule_events WHERE capsule_id=$1 AND kind='version' ORDER BY id",[p.capsuleId])).rows,items=[];
      for(const row of rows)try{
        const current=await this.versionWithin(db,actor,p.capsuleId,row.id);
        items.push({versionId:row.id,version:current.payload.version,title:current.sourceStatus==='source-unavailable'?null:current.payload.title,
          ...ownControl(actor,current.row,'publication'),
          sourceStatus:current.sourceStatus,deprecated:current.deprecated,securityIssue:current.securityIssue,
          ...(actor?.subjectId===row.subject_id?{disclosure:{visibility:current.grant.visibility,viewers:current.grant.viewers}}:{})});
      }catch(error){if(!absent(error))throw error;}
      const remaining=items.filter(i=>!p.after||i.versionId>p.after),page=remaining.slice(0,p.limit);
      const parent=actor?(await db.query('SELECT revision FROM capsules WHERE id=$1 AND subject_id=$2',[p.capsuleId,actor.subjectId])).rows[0]:null;
      return {capsuleId:p.capsuleId,items:page,nextAfter:remaining.length>p.limit?page.at(-1).versionId:null,
        ...(parent?{management:{revision:parent.revision,publishedVersionCount:rows.length}}:{}),coverage:'currently-authorized-versions; no-latest-fallback'};
    };
    return actor?this.access.runAuthorized(actor,'capsules',read):transaction(this.access.db,read);
  }
  async permissions(actor,input={}){
    const options=capsulePermissionsQueryV2Schema.safeParse(input);
    rule(options.success,'invalid_capsule_query',400);
    return this.access.runAuthorized(actor,'capsules',async db=>{
      const p=options.data,rows=(await db.query(`SELECT p.id FROM capsule_permissions p JOIN consents c ON c.id=p.consent_id
        WHERE p.payload_text<>'' AND ($2='owned' AND p.subject_id=$1 OR $2='granted' AND p.subject_id<>$1
        AND (c.intent->'viewers' ? $1 OR c.intent->>'visibility'='Public')) ORDER BY p.id`,[actor.subjectId,p.view])).rows,items=[];
      for(const row of rows)try{
        const {row:source,payload}=await this.permissionWithin(db,actor,row.id,{allowRevoked:true});
        if(p.view==='granted'&&!payload.grantees.includes(actor.subjectId))continue;
        let sourceStatus='current';
        try{for(const ref of payload.sources)await this.sourceWithin(db,{subjectId:source.subject_id},ref);}
        catch(error){if(!absent(error))throw error;sourceStatus='source-unavailable';}
        items.push({permissionId:row.id,authorId:source.subject_id,payload,revoked:!!source.revoked_at,
          expired:!!payload.expiresAt&&Date.parse(payload.expiresAt)<=this.access.now()*1000,sourceStatus,
          coauthorApproval:false,externalRightsVerified:false});
      }catch(error){if(!absent(error))throw error;}
      const remaining=items.filter(i=>!p.after||i.permissionId>p.after),page=remaining.slice(0,p.limit);
      return {items:page,nextAfter:remaining.length>p.limit?page.at(-1).permissionId:null,coverage:'currently-authorized-explicit-permissions'};
    });
  }
  async getPermission(actor, { permissionId }) {
    return this.access.runAuthorized(actor, 'capsules', async db => {
      const { row, payload } = await this.permissionWithin(db, actor, permissionId, { allowRevoked: true });
      return { permissionId, authorId: row.subject_id, payload, revoked: !!row.revoked_at,
        coauthorApproval: false, externalRightsVerified: false };
    });
  }
  async preview(actor, input) {
    const parsed = capsulePreviewV2Schema.safeParse(input); rule(parsed.success, 'invalid_capsule_v2_payload', 400);
    return this.access.runAuthorized(actor, 'capsules', async db => {
      const payload = parsed.data.payload;
      // Preview does not store draft text or issue a Consent. The final exact
      // publication and its chosen recipient scope are checked again on write.
      try {
        const sources = await this.publicationSourcesWithin(db, actor, payload, { visibility: 'Public' });
        return { readyForPublicPublication: true, published: false, draftStorage: 'user-side-only', payload,
          permissions: sources.permissions, attributions: sources.attributions, capabilityVerified: false,
          requiredFinalStep: 'exact publication Consent with chosen visibility', coauthorApproval: false };
      } catch (error) { if (!absent(error)) throw error; return { readyForPublicPublication: false, published: false,
        draftStorage: 'user-side-only', reason: error.code, capabilityVerified: false, automaticPublication: false }; }
    });
  }
  async maintenanceWithin(db, actor, capsuleId, versionId) {
    const rows = (await db.query("SELECT * FROM capsule_events WHERE capsule_id=$1 AND version_id=$2 AND kind<>'version' ORDER BY revision", [capsuleId, versionId])).rows;
    let deprecated = false, securityIssue = false; const notices = [];
    for (const row of rows) {
      // Operational withdrawal is not undone by revoking its explanatory text.
      if (row.kind === 'deprecate') deprecated = true;
      if (row.kind === 'security-issue') securityIssue = true;
      if (row.kind === 'resolve-security') securityIssue = false;
      if (!row.payload_text) continue;
      try { if (this.legacy.visible(await this.legacy.grant(db, row, 'capsule.publish'), actor)) notices.push(JSON.parse(row.payload_text)); }
      catch (error) { if (!absent(error)) throw error; }
    }
    return { deprecated, securityIssue, notices };
  }
  async versionWithin(db, actor, capsuleId, versionId, { tolerateUnavailableSource = true } = {}) {
    const rows = (await db.query("SELECT * FROM capsule_events WHERE capsule_id=$1 AND kind='version' AND ($2::uuid IS NULL OR id=$2) ORDER BY revision DESC", [capsuleId, versionId ?? null])).rows;
    // A no-version read targets the latest published version, and does not
    // silently fall back to an old visible version when that latest one is private.
    const row = rows[0]; rule(row?.payload_text, 'capsule_unavailable', 404);
    const grant = await this.legacy.grant(db, row, 'capsule.publish');
    rule(this.legacy.visible(grant, actor), 'capsule_unavailable', 404);
    const payload = JSON.parse(row.payload_text), maintenance = await this.maintenanceWithin(db, actor, capsuleId, row.id);
    if (payload.schemaVersion !== 2) {
      const legacy = await this.legacy.readWithin(db, actor, { capsuleId, versionId: row.id });
      return { row, grant, payload, ...maintenance, source: { legacy, sourceCurrent: !legacy.sourceNeedsReview,
        synthetic: null, permissions: [], attributions: [], capabilityVerified: false }, sourceStatus: 'legacy-v1-source-policy',
      compatibility: 'legacy-author-declared-attribution; no-retroactive-source-signatures' };
    }
    let source, sourceStatus = 'current';
    try {
      // Current source checks use the publisher's licensed access, not a public
      // reader's raw-room identity. Only selected published content is returned.
      source = await this.publicationSourcesWithin(db, { subjectId: row.subject_id }, payload, grant, { requireCurrentResult: false });
      if (!source.sourceCurrent) sourceStatus = 'source-result-superseded';
    } catch (error) { if (!absent(error) || !tolerateUnavailableSource) throw error; sourceStatus = 'source-unavailable'; source = { reason: error.code }; }
    return { row, grant, payload, ...maintenance, source, sourceStatus, compatibility: 'native-v2' };
  }
  async publish(actor, request) {
    const payload = parse(request.payloadJson, capsuleEventV2Schema);
    return this.access.runResourceWrite(actor, 'capsules', { control: payload.kind !== 'version' }, async (db, authorization) => {
      if (payload.kind === 'version' && payload.expectedRevision === 0)
        await db.query('INSERT INTO capsules(id,subject_id) VALUES($1,$2) ON CONFLICT DO NOTHING', [payload.capsuleId, actor.subjectId]);
      const parent = (await db.query('SELECT * FROM capsules WHERE id=$1 AND subject_id=$2 FOR UPDATE', [payload.capsuleId, actor.subjectId])).rows[0];
      rule(parent, 'capsule_owner_required', 403);
      const grant = await this.legacy.grant(db, { id: payload.id, subject_id: actor.subjectId, consent_id: request.consentId, payload_text: request.payloadJson }, 'capsule.publish');
      rule(['Private', 'Public'].includes(grant.visibility), 'capsule_visibility_required', 403);
      const prior = (await db.query('SELECT * FROM capsule_events WHERE id=$1', [payload.id])).rows[0];
      if (prior) { rule(prior.subject_id === actor.subjectId && prior.capsule_id === parent.id && prior.consent_id === request.consentId && prior.payload_hash === digest(request.payloadJson), 'capsule_conflict');
        return { capsuleId: parent.id, versionId: prior.version_id, revision: prior.revision, eventId: prior.id }; }
      rule(parent.revision === payload.expectedRevision && parent.revision < 200, 'capsule_revision_conflict');
      let versionId = payload.versionId;
      if (payload.kind === 'version') {
        const versions = Number((await db.query("SELECT count(*) FROM capsule_events WHERE capsule_id=$1 AND kind='version'", [parent.id])).rows[0].count);
        rule(payload.version === versions + 1, 'capsule_version_conflict');
        await this.publicationSourcesWithin(db, actor, payload, grant);
        await this.legacy.proofReferences(db, actor, payload.sourceResolution.proofIds, payload.sourceResolution.caseId, payload.sourceResolution.resultId, true);
        versionId = payload.id;
      } else {
        // Maintenance remains possible after a source is unavailable.
        const current = await this.versionWithin(db, actor, parent.id, versionId);
        rule(grant.visibility === current.grant.visibility && json([...grant.viewers].sort()) === json([...current.grant.viewers].sort()), 'capsule_notice_visibility_mismatch', 403);
        rule(!(payload.kind === 'deprecate' && current.deprecated || payload.kind === 'security-issue' && current.securityIssue || payload.kind === 'resolve-security' && !current.securityIssue), 'capsule_transition_denied');
        if (payload.replacementVersionId) { rule(payload.replacementVersionId !== versionId, 'capsule_replacement_mismatch'); await this.versionWithin(db, actor, parent.id, payload.replacementVersionId); }
      }
      await db.query('INSERT INTO capsule_events(id,capsule_id,subject_id,revision,version_id,kind,consent_id,payload_text,payload_hash) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',
        [payload.id, parent.id, actor.subjectId, parent.revision + 1, versionId, payload.kind, request.consentId, request.payloadJson, digest(request.payloadJson)]);
      await db.query('UPDATE capsules SET revision=$2 WHERE id=$1', [parent.id, parent.revision + 1]);
      await audit(db, actor, authorization, payload.id, 'capsule.event');
      return { capsuleId: parent.id, versionId, revision: parent.revision + 1, eventId: payload.id,
        contributorsAuthority: 'publisher-attributed; source-permission-separate', coauthorApproval: false, capabilityVerified: false };
    });
  }
  async readWithin(db, actor, input) {
    const current = await this.versionWithin(db, actor, input.capsuleId, input.versionId);
    const ownState = actor?.subjectId === current.row.subject_id ? (await db.query('SELECT revision FROM capsules WHERE id=$1',[input.capsuleId])).rows[0] : null;
    if (current.sourceStatus === 'source-unavailable') return { capsuleId: input.capsuleId, versionId: current.row.id,
      ...ownControl(actor,current.row,'publication'),
      version: null, sourceStatus: current.sourceStatus, reason: current.source.reason,
      ...(ownState?{authorId:current.row.subject_id,revision:ownState.revision}:{}),
      ...await this.maintenanceWithin(db, actor, input.capsuleId, current.row.id), newApplicationAllowed: false, capabilityVerified: false };
    return { capsuleId: input.capsuleId, versionId: current.row.id, authorId: current.row.subject_id, version: current.payload,
      ...ownControl(actor,current.row,'publication'),
      ...(ownState ? { revision: ownState.revision } : {}),
      sourceStatus: current.sourceStatus, permissions: current.source.permissions, attributions: current.source.attributions,
      deprecated: current.deprecated, securityIssue: current.securityIssue, notices: current.notices,
      newApplicationAllowed: !current.deprecated && !current.securityIssue && current.source.sourceCurrent,
      synthetic: current.source.synthetic, compatibility: current.compatibility,
      readingIsReuse: false, coauthorApproval: false, capabilityVerified: false };
  }
  async visibleUpdateWithin(db,actor,event){
    // A prior authorized reference/application establishes interest. Read alone
    // never does. Recheck exact use Consent instead of trusting candidate SQL.
    const uses=(await db.query(`SELECT id,subject_id,consent_id,payload_text FROM capsule_uses
      WHERE capsule_id=$1 AND subject_id=$2 AND observed_revision<$3
      UNION ALL SELECT id,subject_id,consent_id,payload_text FROM capsule_uses_v2
      WHERE capsule_id=$1 AND subject_id=$2 AND observed_revision<$3`,[event.capsule_id,actor.subjectId,event.revision])).rows;
    let authorized=false;
    for(const use of uses)try{if(this.legacy.visible(await this.legacy.grant(db,use,'capsule.use'),actor)){authorized=true;break;}}
      catch(error){if(!absent(error))throw error;}
    if(!authorized)return null;
    const current=await this.versionWithin(db,actor,event.capsule_id,event.version_id),payload=JSON.parse(event.payload_text);
    const unavailable=current.sourceStatus==='source-unavailable';
    return {title:unavailable?'Capsule 来源或版本状态已变化':current.payload.title,
      capsuleId:event.capsule_id,versionId:event.version_id,actorId:event.subject_id,eventKind:payload.kind,
      sourceStatus:current.sourceStatus,deprecated:current.deprecated,securityIssue:current.securityIssue,
      summary:unavailable?null:payload.summary??'New Capsule version',
      object:{type:'capsule',id:event.capsule_id,versionId:event.version_id},sourceBodyIncluded:false};
  }
  get(actor, input) { rule(capsuleReadSchema.safeParse(input).success, 'invalid_capsule_query', 400);
    return actor ? this.access.runAuthorized(actor, 'capsules', db => this.readWithin(db, actor, input)) : transaction(this.access.db, db => this.readWithin(db, null, input)); }
  async applicationWithin(db, actor, payload, { latest = false } = {}) {
    const attempt = await this.sourceWithin(db, actor, { kind: 'attempt', ...payload.attemptRef, caseId: payload.caseId });
    const result = await this.sourceWithin(db, actor, { kind: 'result', ...payload.resultRef, caseId: payload.caseId }, { latest });
    rule(attempt.authorId === actor.subjectId && result.authorId === actor.subjectId, 'capsule_application_author_required', 403);
    const origin = result.fact.origin;
    rule(origin.kind === 'attempt' && origin.id === payload.attemptRef.id && origin.version === payload.attemptRef.version, 'capsule_result_mismatch');
    rule(result.fact.reportedOutcome === payload.outcome, 'capsule_result_mismatch');
    const environment = typeof attempt.fact.environment === 'object' ? attempt.fact.environment : { name: 'unknown', version: 'unknown' };
    rule(environment.name === payload.environment.name && environment.version === payload.environment.version, 'capsule_environment_mismatch');
    rule((result.fact.taskId ?? null) === (payload.taskId ?? null) && (result.fact.participationId ?? null) === (payload.participationId ?? null), 'capsule_application_context_mismatch');
    return { attempt, result, synthetic: result.synthetic, currentResult: result.currentVersion === payload.resultRef.version };
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
      if (previous) { rule(previous.subject_id === actor.subjectId && previous.payload_hash === digest(request.payloadJson) && previous.consent_id === request.consentId, 'capsule_use_conflict'); return { eventId: payload.id, kind: payload.kind }; }
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
          rule(prior.result_id === payload.resultRef.id && prior.attempt_id === payload.attemptRef.id, 'capsule_application_mismatch');
          for (const ref of payload.verificationRefs) {
            const verification = await this.verificationRecords.requireReferenceWithin(db, actor, { kind: 'verification', ...ref }, { caseId: payload.caseId });
            rule(verification.record.target.type === 'result' && verification.record.target.id === payload.resultRef.id && verification.record.target.version === payload.resultRef.version, 'capsule_verification_mismatch');
          }
        }
      }
      const fingerprint = payload.kind === 'reverify' ? digest(json(payload.verificationRefs.map(ref => `${ref.id}:${ref.version}`).sort())) : '';
      try {
        await db.query(`INSERT INTO capsule_uses_v2(id,capsule_id,version_id,subject_id,case_id,attempt_id,attempt_version,result_id,result_version,prior_use_id,
          kind,observed_revision,verification_fingerprint,consent_id,payload_text,payload_hash) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
        [payload.id, payload.capsuleId, payload.versionId, actor.subjectId, payload.caseId, payload.attemptRef?.id ?? null, payload.attemptRef?.version ?? null,
          payload.resultRef?.id ?? null, payload.resultRef?.version ?? null, payload.priorUseId ?? null, payload.kind, parent.revision, fingerprint,
          request.consentId, request.payloadJson, digest(request.payloadJson)]);
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
    return { ...base, record: payload, sourceStatus: applied && !applied.currentResult ? 'application-result-superseded' : 'current',
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
  async query(actor, input = {}) {
    const parsed = capsuleQuerySchema.safeParse(input); rule(parsed.success, 'invalid_capsule_query', 400); const options = parsed.data;
    const read = async db => {
      let cursor = null; const items = [];
      for (;;) {
        const rows = (await db.query('SELECT id FROM capsules WHERE ($1::text IS NULL OR subject_id=$1) AND ($2::uuid IS NULL OR id>$2) ORDER BY id LIMIT 100', [options.authorId ?? null, cursor])).rows;
        for (const row of rows) try {
          const item = await this.readWithin(db, actor, { capsuleId: row.id });
          if (!item.version || options.capabilityId && item.version.capabilityId !== options.capabilityId
            || !`${item.version.title} ${item.version.problemPattern}`.toLowerCase().includes(options.query.toLowerCase())) continue;
          items.push({ capsuleId: row.id, versionId: item.versionId, sourceVersion: item.version.version,
            authorId: item.authorId, publicationClass: item.version.publicationClass, synthetic: item.version.synthetic,
            title: item.version.title, problemPattern: item.version.problemPattern, capabilityId: item.version.capabilityId,
            sourceStatus: item.sourceStatus, deprecated: item.deprecated, securityIssue: item.securityIssue,
            newApplicationAllowed: item.newApplicationAllowed, capabilityVerified: false });
        } catch (error) { if (!absent(error)) throw error; }
        if (rows.length < 100) break; cursor = rows.at(-1).id;
      }
      const remaining = items.filter(item => !options.after || item.capsuleId > options.after), page = remaining.slice(0, options.limit);
      return { items: page, nextAfter: remaining.length > options.limit ? page.at(-1).capsuleId : null, coverage: 'visible-page-only', windowLimited: false };
    };
    return actor ? this.access.runAuthorized(actor, 'capsules', read) : transaction(this.access.db, read);
  }
}
