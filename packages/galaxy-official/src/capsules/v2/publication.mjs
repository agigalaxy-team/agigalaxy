import {capsuleEventV2Schema,capsulePreviewV2Schema} from "../../shared/capsule-v2-schema.mjs";
import {capsuleRule as rule,parseCapsuleV2 as parse} from "./sources.mjs";
import {digest} from "../../shared/digest.mjs";
import {absent,json,compareSubject,audit} from './helpers.mjs';
import {CapsuleVersionReads} from './versions.mjs';

// Original user-side preview and exact-consent publication/maintenance commands. Preview never stores draft text or issues consent.
export class CapsulePublication extends CapsuleVersionReads{
  async preview(actor, input) {
    const parsed = capsulePreviewV2Schema.safeParse(input); rule(parsed.success, 'invalid_capsule_v2_payload', 400);
    return this.access.runAuthorized(actor, 'capsules', async db => {
      const {payload, visibility} = parsed.data;
      // Preview does not store draft text or issue a Consent. The final exact
      // publication and its chosen recipient scope are checked again on write.
      try {
        const sources = await this.publicationSourcesWithin(db, actor, payload, { visibility }, {includeCoverage:true});
        const ready = sources.uncovered.length === 0;
        const attributions = await this.attributionsWithin(db, actor, sources.attributions);
        // Do not return a selected message body after its actual lifetime ends
        // while the other read-only checks are awaiting transport or storage.
        for (const source of sources.sourceCoverage.sources) if (source.reading?.expiresAt)
          rule(Date.parse(source.reading.expiresAt) > this.access.now() * 1000, 'chat_message_version_unavailable', 409);
        return { readyForPublication: ready, visibility, readyForPublicPublication: ready && visibility === 'Public',
          ...(ready ? {} : {reason:'capsule_source_permission_required'}), sourceCoverage:sources.sourceCoverage,
          published: false, draftStorage: 'user-side-only', payload,
          permissions: sources.permissions, attributions, capabilityVerified: false,
          requiredFinalStep: 'exact publication Consent with chosen visibility', coauthorApproval: false };
      } catch (error) { if (!absent(error)) throw error; return { readyForPublication:false, visibility, readyForPublicPublication: false, published: false,
        draftStorage: 'user-side-only', reason: error.code, capabilityVerified: false, automaticPublication: false }; }
    });
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
        rule(grant.visibility === current.grant.visibility && json([...grant.viewers].sort(compareSubject)) === json([...current.grant.viewers].sort(compareSubject)), 'capsule_notice_visibility_mismatch', 403);
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
}
