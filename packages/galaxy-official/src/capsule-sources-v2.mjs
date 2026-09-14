import { caseRepository } from './infrastructure/case-repository.mjs';
import { projectCaseFacts, latestFact } from './domain/intervention.mjs';
import { ServiceError } from './shared/service-error.mjs';
import { capsulePermissionV2Schema } from './shared/capsule-v2-schema.mjs';
import { digest } from './shared/digest.mjs';
import { recordObjectAudit } from './infrastructure/object-audit.mjs';

export const capsuleRule = (ok, code, status = 409) => { if (!ok) throw new ServiceError(code, status); };
export function parseCapsuleV2(payloadJson, schema) { try {
  if (typeof payloadJson !== 'string' || Buffer.byteLength(payloadJson) > 48000) throw new Error();
  return schema.parse(JSON.parse(payloadJson));
} catch { throw new ServiceError('invalid_capsule_v2_payload'); } }
const unique = rows => [...new Map(rows.map(r => [r.key, r])).values()];
const sourceKey = ref => `${ref.kind}:${ref.id}:${ref.version}`;

// This validates rights to the selected registered content, not ownership of
// arbitrary upstream files linked by a reporter or legal compatibility of a license.
export class CapsuleSourcesV2 {
  constructor(legacy, { cases, verificationRecords, configurations, readSelectedWithin, outcomeMaterials } = {}) {
    Object.assign(this, { legacy, cases, verificationRecords, configurations, readSelectedWithin, outcomeMaterials });
    this.access = legacy.access; this.consents = legacy.consents;
  }
  async sourceWithin(db, actor, ref, { latest = false, visited = new Set() } = {}) {
    const key = sourceKey(ref); capsuleRule(!visited.has(key), 'capsule_source_cycle'); visited.add(key);
    try {
      if(ref.kind==='configuration'){
        capsuleRule(this.configurations,'capsule_configuration_source_unavailable',503);
        const configuration=await this.configurations.requireReferenceWithin(db,actor,ref);
        return {ref,authorId:configuration.subjectId,dependencies:[{key,authorId:configuration.subjectId}],
          synthetic:configuration.record.synthetic,sourceState:configuration.sourceStatus,
          rightsScope:'selected-registered-conditions-only; no-local-prompt-or-file-rights-inferred'};
      }
      if (ref.kind === 'selected-message') {
        capsuleRule(this.readSelectedWithin, 'capsule_chat_source_unavailable', 503);
        const message = await this.readSelectedWithin(db, actor, { messageId: ref.id, revision: ref.version });
        return { ref, authorId: message.authorId, contentHash: message.contentHash,
          dependencies: [{ key, authorId: message.authorId }], sourceState: 'current',
          rightsScope: 'exact-message-content; room-read-is-not-publication-permission' };
      }
      if (ref.kind === 'outcome-material') {
        capsuleRule(this.outcomeMaterials, 'capsule_outcome_material_source_unavailable', 503);
        const material = await this.outcomeMaterials.readWithin(db, actor, ref.id);
        capsuleRule(material.caseId === ref.caseId && material.contentAvailable && material.uses.includes('capsule-publication'), 'capsule_outcome_material_source_unavailable', 403);
        return { ref, authorId: material.authorId, contentHash: material.sha256,
          dependencies: [{ key, authorId: material.authorId }], sourceState: material.state,
          rightsScope: 'independently-authorised-outcome-copy; capsule-publication-use-only' };
      }
      const repo = caseRepository(db), parent = await repo.lockAnyForRead(ref.caseId);
      capsuleRule(parent && parent.state !== 'withdrawn', 'capsule_source_unavailable', 403);
      const rows = await repo.events(ref.caseId), facts = projectCaseFacts(rows.filter(row=>row.payload_text), parent);
      const root = rows.find(row => ['case', 'case-created'].includes(row.kind));
      capsuleRule(root, 'capsule_source_unavailable', 403);
      await this.cases.requireEventVisibleWithin(db, actor, root);
      const rootDependency = { key: `case-event:${root.id}`, authorId: root.subject_id };
      if (ref.kind === 'case-root') {
        capsuleRule(ref.id === root.id && ref.version === 1, 'capsule_source_version_mismatch');
        return { ref, authorId: root.subject_id, dependencies: [rootDependency], synthetic: facts.synthetic, sourceState: 'current' };
      }
      if (['attempt', 'intervention', 'result'].includes(ref.kind)) {
        const fact = await this.cases.requireFactWithin(db, actor, rows, facts, ref.kind, ref, { latest });
        let sourceSynthetic=facts.synthetic;
        const dependencies = [rootDependency, ...fact.recordEventIds.map(id => {
          const row = rows.find(r => r.id === id); capsuleRule(row, 'capsule_source_unavailable');
          return { key: `case-event:${id}`, authorId: row.subject_id };
        })];
        for (const id of fact.recordEventIds) {
          const row = rows.find(r => r.id === id);
          for (const source of [...(row.payload.sourceRefs ?? []), ...(row.payload.deliverableRefs ?? [])]) {
            const nested = await this.sourceWithin(db, actor, { ...source, ...(['configuration','selected-message','outcome-material'].includes(source.kind) ? {} : { caseId: ref.caseId }) }, { visited });
            dependencies.push(...nested.dependencies);
            sourceSynthetic ||= nested.synthetic===true;
          }
        }
        return { ref, authorId: fact.actorId === 'unknown' ? fact.reportedBy : fact.actorId, fact,
          currentVersion: latestFact(facts, ref.kind, ref.id)?.version, synthetic: sourceSynthetic,
          dependencies: unique(dependencies), sourceState: 'current', provenance: fact.provenance };
      }
      const record = await this.verificationRecords.requireReferenceWithin(db, actor, { kind: ref.kind, id: ref.id, version: ref.version }, { caseId: ref.caseId });
      const dependencies = [rootDependency, { key, authorId: record.record.reportedBy }];
      if (ref.kind === 'verification') {
        const target = await this.sourceWithin(db, actor, { kind: record.record.target.type, id: record.record.target.id,
          version: record.record.target.version, caseId: ref.caseId }, { visited });
        dependencies.push(...target.dependencies);
        for (const evidence of record.record.evidenceRefs) dependencies.push(...(await this.sourceWithin(db, actor,
          { kind: 'evidence', ...evidence, caseId: ref.caseId }, { visited })).dependencies);
      }
      return { ref, authorId: record.record.reportedBy, record, dependencies: unique(dependencies), synthetic: record.synthetic,
        sourceState: 'current', rightsScope: 'registered-report-metadata-only; external-linked-content-rights-not-inferred' };
    } finally { visited.delete(key); }
  }
  async permissionWithin(db, actor, id, { allowRevoked = false } = {}) {
    const row = (await db.query('SELECT * FROM capsule_permissions WHERE id=$1 FOR SHARE', [id])).rows[0];
    capsuleRule(row?.payload_text, 'capsule_permission_unavailable', 403);
    const grant = await this.legacy.grant(db, row, 'capsule.permission');
    capsuleRule(this.legacy.visible(grant, actor), 'capsule_permission_unavailable', 403);
    const payload = parseCapsuleV2(row.payload_text, capsulePermissionV2Schema);
    capsuleRule(payload.kind === 'grant', 'capsule_permission_unavailable', 403);
    capsuleRule(allowRevoked || !row.revoked_at, 'capsule_permission_revoked', 403);
    capsuleRule(allowRevoked || !payload.expiresAt || Date.parse(payload.expiresAt) > this.access.now() * 1000, 'capsule_permission_expired', 403);
    return { row, payload, grant };
  }
  async permission(actor, input) {
    const payload = parseCapsuleV2(input.payloadJson, capsulePermissionV2Schema);
    return this.access.runResourceWrite(actor, 'capsules', { control: payload.kind === 'revoke' }, async (db, authorization) => {
      const grant = await this.legacy.grant(db, { id: payload.id, subject_id: actor.subjectId, consent_id: input.consentId, payload_text: input.payloadJson }, 'capsule.permission');
      capsuleRule(['Private', 'Public'].includes(grant.visibility), 'capsule_visibility_required', 403);
      if (payload.kind === 'grant') {
        for (const grantee of payload.grantees) capsuleRule(this.legacy.visible(grant, { subjectId: grantee }), 'capsule_grantee_visibility_required', 403);
        capsuleRule(!payload.expiresAt || Date.parse(payload.expiresAt) > this.access.now() * 1000, 'capsule_permission_expired');
        for (const ref of payload.sources) {
          const source = await this.sourceWithin(db, actor, ref);
          capsuleRule(source.authorId === actor.subjectId, 'capsule_source_author_required', 403);
        }
        const existing = (await db.query('SELECT * FROM capsule_permissions WHERE id=$1', [payload.id])).rows[0];
        if (existing) { capsuleRule(existing.subject_id === actor.subjectId && existing.consent_id === input.consentId && existing.payload_hash === digest(input.payloadJson), 'capsule_permission_conflict');
          return { permissionId: payload.id, state: existing.revoked_at ? 'revoked' : 'recorded', coauthorApproval: false }; }
        await db.query('INSERT INTO capsule_permissions(id,subject_id,consent_id,payload_text,payload_hash) VALUES($1,$2,$3,$4,$5)',
          [payload.id, actor.subjectId, input.consentId, input.payloadJson, digest(input.payloadJson)]);
      } else {
        const existing = (await db.query('SELECT * FROM capsule_permissions WHERE id=$1 AND subject_id=$2 FOR UPDATE', [payload.permissionId, actor.subjectId])).rows[0];
        capsuleRule(existing, 'capsule_permission_unavailable', 403);
        if (existing.revoked_at) { capsuleRule(existing.revoke_id === payload.id && existing.revoke_consent_id === input.consentId && existing.revoke_payload_hash === digest(input.payloadJson), 'capsule_permission_conflict'); }
        else await db.query('UPDATE capsule_permissions SET revoked_at=$2,revoke_id=$3,revoke_consent_id=$4,revoke_payload_text=$5,revoke_payload_hash=$6 WHERE id=$1',
          [payload.permissionId, new Date(this.access.now() * 1000).toISOString(), payload.id, input.consentId, input.payloadJson, digest(input.payloadJson)]);
      }
      await recordObjectAudit(db, { subjectId: actor.subjectId, objectId: payload.id, action: 'capsule.permission', httpRequestId: actor.httpRequestId ?? null, ...authorization });
      return { permissionId: payload.permissionId ?? payload.id, state: payload.kind === 'grant' ? 'recorded' : 'revoked',
        authorId: actor.subjectId, coauthorApproval: false, legalOwnershipIndependentlyVerified: false };
    });
  }
  async publicationSourcesWithin(db, actor, payload, disclosure, { requireCurrentResult = true } = {}) {
    const resolution = payload.sourceResolution, mainRef = { kind: 'result', id: resolution.resultId, version: resolution.resultVersion, caseId: resolution.caseId };
    const primary = await this.sourceWithin(db, actor, mainRef, { latest: requireCurrentResult });
    capsuleRule(primary.fact.reportedOutcome === 'succeeded', 'capsule_resolution_required');
    capsuleRule(payload.synthetic || primary.synthetic !== true, 'synthetic_mismatch');
    const refs = [mainRef, ...payload.sourceRefs, ...payload.attributionRefs.map(a => a.source),
      ...resolution.verificationRefs.map(ref => ({ kind: 'verification', ...ref, caseId: resolution.caseId }))];
    const resolved = [];
    for (const ref of [...new Map(refs.map(r => [sourceKey(r), r])).values()]) resolved.push(await this.sourceWithin(db, actor, ref));
    capsuleRule(payload.synthetic || !resolved.some(source=>source.synthetic===true),'synthetic_mismatch');
    const dependencies = unique(resolved.flatMap(source => source.dependencies)), coverage = new Map(), permissions = [];
    // The publisher's exact publication Consent covers their own selected
    // registered content. It cannot stand in for another author's permission.
    for (const dependency of dependencies) if (dependency.authorId === actor.subjectId) coverage.set(dependency.key, actor.subjectId);
    for (const permissionId of payload.permissionRefs) {
      const permission = await this.permissionWithin(db, actor, permissionId), license = permission.payload;
      capsuleRule(license.grantees.includes(actor.subjectId), 'capsule_permission_grantee_mismatch', 403);
      capsuleRule(license.license === payload.license, 'capsule_license_mismatch', 403);
      capsuleRule(disclosure.visibility !== 'Public' || license.allowPublic, 'capsule_publication_not_permitted', 403);
      // The permission owner can validate their exact source without exposing
      // it to the Capsule reader. Permission does not widen the raw Case/room ACL.
      const grantor = { subjectId: permission.row.subject_id };
      for (const ref of license.sources) {
        const source = await this.sourceWithin(db, grantor, ref);
        capsuleRule(source.authorId === grantor.subjectId, 'capsule_source_author_required', 403);
        for (const dependency of source.dependencies) if (dependency.authorId === grantor.subjectId) coverage.set(dependency.key, grantor.subjectId);
      }
      permissions.push({ permissionId, authorId: grantor.subjectId, license: license.license, scope: license.scope,
        basis: license.basis, attribution: license.attribution, licenseReference: license.licenseReference ?? null,
        status: 'current-source-permission', coauthorApproval: false, legalOwnershipIndependentlyVerified: false });
    }
    const uncovered = dependencies.filter(dep => coverage.get(dep.key) !== dep.authorId);
    capsuleRule(!uncovered.length, 'capsule_source_permission_required', 403);
    const attributions = payload.attributionRefs.map(attribution => {
      const source = resolved.find(s => sourceKey(s.ref) === sourceKey(attribution.source));
      capsuleRule(source?.authorId === attribution.subjectId, 'capsule_attribution_mismatch');
      return { ...attribution, authority: 'source-author-observed; publisher-attribution',
        contributionResponses: 'read-original-intervention-under-its-own-permission', coauthorApproval: false };
    });
    for (const contributor of payload.contributors) capsuleRule(payload.attributionRefs.some(a => a.subjectId === contributor), 'capsule_contributor_source_required');
    return { primary, permissions, attributions, sourceRefs: refs, synthetic: payload.synthetic || primary.synthetic === true,
      sourceCurrent: primary.currentVersion === mainRef.version, capabilityVerified: false };
  }
}
