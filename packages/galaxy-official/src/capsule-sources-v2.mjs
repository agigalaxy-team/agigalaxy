import { caseRepository } from './infrastructure/case-repository.mjs';
import { projectCaseFacts } from './domain/intervention.mjs';
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
  async factCurrentnessWithin(db, actor, rows, facts, kind, ref) {
    // Exact historical access and current support are separate. Use the owning
    // Case service's metadata guard instead of inferring latest from surviving
    // bodies, which would resurrect an earlier fact after a retained change.
    try {
      await this.cases.requireFactWithin(db, actor, rows, facts, kind, ref, { latest: true });
      return 'current';
    } catch (error) {
      if (!(error instanceof ServiceError)) throw error;
      if (error.code === 'fact_version_conflict') return 'superseded';
      if (error.code === 'fact_currentness_unavailable') return 'unavailable';
      throw error;
    }
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
          reading: { text: message.text, roomId: message.roomId, expiresAt: message.expiresAt,
            permission: 'current-room-read-only', publicationPermission: false },
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
        return { ref, authorId: root.subject_id, dependencies: [rootDependency], synthetic: facts.synthetic, sourceState: 'current',
          caseReading: { title: root.payload.title ?? null, summary: root.payload.summary ?? null } };
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
          currentness: latest ? 'current' : await this.factCurrentnessWithin(db, actor, rows, facts, ref.kind, ref), synthetic: sourceSynthetic,
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
  async resolutionReadingWithin(db, actor, resolution) {
    const viewer = actor ?? { subjectId: null };
    const resultRef = { kind: 'result', id: resolution.resultId, version: resolution.resultVersion, caseId: resolution.caseId };
    const reading = { case: { status: 'unavailable' }, result: { status: 'unavailable', ref: resultRef } };
    const unavailable = error => error instanceof ServiceError && [403, 404, 409, 422, 503].includes(error.status);
    // A published method does not grant its readers access to the publisher's
    // original work. Resolve only this exact root/result under the reader's ACL.
    try {
      const rows = await caseRepository(db).events(resolution.caseId);
      const root = rows.find(row => ['case', 'case-created'].includes(row.kind));
      capsuleRule(root, 'capsule_source_unavailable', 403);
      const ref = { kind: 'case-root', id: root.id, version: 1, caseId: resolution.caseId };
      const source = await this.sourceWithin(db, viewer, ref);
      reading.case = { status: 'available', ref, authorId: source.authorId, ...source.caseReading };
    } catch (error) { if (!unavailable(error)) throw error; }
    try {
      const source = await this.sourceWithin(db, viewer, resultRef);
      reading.result = { status: 'available', ref: resultRef, authorId: source.authorId,
        summary: source.fact.summary, reportedOutcome: source.fact.reportedOutcome,
        limitations: source.fact.limitations, currentness: source.currentness };
    } catch (error) { if (!unavailable(error)) throw error; }
    return reading;
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
  async publicationSourcesWithin(db, actor, payload, disclosure, { requireCurrentResult = true, includeCoverage = false } = {}) {
    const resolution = payload.sourceResolution, mainRef = { kind: 'result', id: resolution.resultId, version: resolution.resultVersion, caseId: resolution.caseId };
    const primary = await this.sourceWithin(db, actor, mainRef, { latest: requireCurrentResult });
    capsuleRule(primary.fact.reportedOutcome === 'succeeded', 'capsule_resolution_required');
    capsuleRule(payload.synthetic || primary.synthetic !== true, 'synthetic_mismatch');
    const refs = [mainRef, ...payload.sourceRefs, ...payload.attributionRefs.map(a => a.source),
      ...resolution.verificationRefs.map(ref => ({ kind: 'verification', ...ref, caseId: resolution.caseId }))];
    const resolved = [];
    for (const ref of new Map(refs.map(r => [sourceKey(r), r])).values()) resolved.push(await this.sourceWithin(db, actor, ref));
    capsuleRule(payload.synthetic || !resolved.some(source=>source.synthetic===true),'synthetic_mismatch');
    const dependencies = unique(resolved.flatMap(source => source.dependencies)), coverage = new Map(), permissions = [], coveringPermissions = new Map();
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
        for (const dependency of source.dependencies) if (dependency.authorId === grantor.subjectId) {
          coverage.set(dependency.key, grantor.subjectId);
          coveringPermissions.set(dependency.key, [...new Set([...(coveringPermissions.get(dependency.key) ?? []), permissionId])]);
        }
      }
      permissions.push({ permissionId, authorId: grantor.subjectId, license: license.license, scope: license.scope,
        basis: license.basis, attribution: license.attribution, licenseReference: license.licenseReference ?? null,
        status: 'current-source-permission', coauthorApproval: false, legalOwnershipIndependentlyVerified: false });
    }
    const uncovered = dependencies.filter(dep => coverage.get(dep.key) !== dep.authorId);
    // A private, read-only preview can describe the current coverage gap. The
    // publication path still rejects it and never treats reading as a license.
    capsuleRule(includeCoverage || !uncovered.length, 'capsule_source_permission_required', 403);
    const attributions = payload.attributionRefs.map(attribution => {
      const source = resolved.find(s => sourceKey(s.ref) === sourceKey(attribution.source));
      capsuleRule(source?.authorId === attribution.subjectId, 'capsule_attribution_mismatch');
      return { ...attribution, authority: 'source-author-observed; publisher-attribution',
        contributionResponses: 'read-original-intervention-under-its-own-permission', coauthorApproval: false };
    });
    for (const contributor of payload.contributors) capsuleRule(payload.attributionRefs.some(a => a.subjectId === contributor), 'capsule_contributor_source_required');
    const sourceCoverage = includeCoverage ? {
      sources: resolved.map(source => ({ ref: source.ref, authorId: source.authorId, sourceState: source.sourceState,
        currentness: source.currentness ?? null,
        ...(source.reading ? { reading: source.reading } : source.fact ? { reading: {
          text: source.fact.summary ?? source.fact.description ?? source.fact.strategy ?? '',
          permission: 'current-source-read-only', publicationPermission: false } } : {}),
      })),
      dependencies: dependencies.map(dependency => ({ ...dependency,
        covered: coverage.get(dependency.key) === dependency.authorId,
        permissionIds: coveringPermissions.get(dependency.key) ?? [],
        sourceRefs: resolved.filter(source => source.dependencies.some(item => item.key === dependency.key && item.authorId === dependency.authorId)).map(source => source.ref),
      })),
    } : null;
    if (includeCoverage) for (const source of resolved) if (source.reading?.expiresAt)
      capsuleRule(Date.parse(source.reading.expiresAt) > this.access.now() * 1000, 'chat_message_version_unavailable', 409);
    return { primary, permissions, attributions, sourceRefs: refs, synthetic: payload.synthetic || primary.synthetic === true,
      ...(includeCoverage ? { sourceCoverage, uncovered } : {}),
      sourceCurrent: primary.currentness === 'current', sourceCurrentness: primary.currentness, capabilityVerified: false };
  }
  async attributionResponsesWithin(db, actor, attribution, cache) {
    const base = { meaning: 'responses-to-exact-original-intervention; not-capsule-coauthorship',
      coverage: 'currently-authorized-latest-response-per-actor; hidden-responses-not-inferred', coauthorApproval: false };
    if (attribution.source.kind !== 'intervention') return { ...base, status: 'not-an-intervention', confirmation: null, responses: [] };
    const ref = attribution.source, viewer = actor ?? { subjectId: null };
    try {
      let source = cache.get(ref.caseId);
      if (!source) {
        const repo = caseRepository(db), parent = await repo.lockAnyForRead(ref.caseId);
        capsuleRule(parent && parent.state !== 'withdrawn', 'capsule_source_unavailable', 403);
        const rows = await repo.events(ref.caseId);
        source = { parent, rows, facts: projectCaseFacts(rows.filter(row => row.payload_text), parent) };
        cache.set(ref.caseId, source);
      }
      const { rows, facts } = source;
      const root = rows.find(row => ['case', 'case-created'].includes(row.kind));
      await this.cases.requireEventVisibleWithin(db, viewer, root);
      const fact = await this.cases.requireFactWithin(db, viewer, rows, facts, 'intervention', ref);
      const responses = [];
      // Select the latest original response before checking its visibility. A
      // withdrawn/private newer response must not resurrect an older acceptance.
      for (const response of fact.responses) {
        const row = rows.find(item => item.id === response.id);
        // Retained rows whose body has been erased cannot establish which
        // Intervention they addressed. Do not reuse an earlier author's answer.
        if (rows.some(item => item.kind === 'intervention-response' && item.subject_id === response.actorId
          && item.version > row.version && !item.payload_text)) continue;
        try {
          await this.cases.requireEventVisibleWithin(db, viewer, row);
          responses.push({ eventId: response.id, actorId: response.actorId, relationship: response.relationship,
            state: response.state, interventionRef: response.interventionRef });
        } catch (error) {
          if (!(error instanceof ServiceError) || !['consent_required', 'origin_not_authorized', 'case_event_unavailable'].includes(error.code)) throw error;
        }
      }
      const others = responses.filter(response => response.relationship !== 'self');
      const confirmation = others.some(r => r.state === 'disputed') ? 'disputed' : others.some(r => r.state === 'partial')
        ? 'partially-confirmed' : others.some(r => r.state === 'accepted') ? 'confirmed' : 'unconfirmed';
      const currentness = await this.factCurrentnessWithin(db, viewer, rows, facts, 'intervention', ref);
      return { ...base, status: currentness === 'current' ? 'current'
        : currentness === 'unavailable' ? 'source-currentness-unavailable' : 'source-version-superseded',
        source: { ...ref }, taskId: fact.taskId, confirmation, responses };
    } catch (error) {
      if (!(error instanceof ServiceError) || ![403, 404, 409, 422, 503].includes(error.status)) throw error;
      return { ...base, status: 'source-not-readable', confirmation: null, responses: [] };
    }
  }
  async attributionsWithin(db, actor, attributions) {
    const cache = new Map(), items = [];
    for (const attribution of attributions) items.push({ ...attribution,
      contributionResponses: await this.attributionResponsesWithin(db, actor, attribution, cache) });
    return items;
  }
}
