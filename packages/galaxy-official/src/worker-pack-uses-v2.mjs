import {
  packUseEventSchema,
  packUseReadSchema,
  packUseQuerySchema,
  packUseCandidatesSchema,
  packUseReceiptSchema,
} from './shared/worker-pack-uses-v2-schema.mjs';
import { ServiceError } from './shared/service-error.mjs';
import { transaction } from './database.mjs';
import { digest } from './shared/digest.mjs';
import { canReadProjection } from './domain/consent-policy.mjs';
import { caseRepository } from './infrastructure/case-repository.mjs';
import { recordObjectAudit } from './infrastructure/object-audit.mjs';
const rule = (ok, code, status = 409) => {
  if (!ok) throw new ServiceError(code, status);
};
const parse = (schema, input) => {
  const p = schema.safeParse(input);
  rule(p.success, 'invalid_pack_use_request', 400);
  return p.data;
};
const missing = (e) =>
  e instanceof ServiceError && [403, 404, 409, 422, 503].includes(e.status);
const same = (a, b) => a?.id === b?.id && a?.version === b?.version;
const exact = (list, ref) => list.find((v) => same(v, ref));
const safeActor = (actor) => actor ?? { subjectId: null };

// The signer reports their own use of a Pack. This never launches a Worker or
// turns configuration/declaration signatures into verified execution attribution.
export class WorkerPackUseServiceV2 {
  constructor(
    access,
    consents,
    { builders, cases, configurations, verificationRecords },
  ) {
    Object.assign(this, {
      access,
      consents,
      builders,
      cases,
      configurations,
      verificationRecords,
    });
  }
  grant(db, row) {
    return this.consents.require(db, {
      id: row.consent_id,
      subjectId: row.subject_id,
      objectId: row.operation_id,
      action: 'builder.publish',
      recipient: this.access.endpoint,
      payloadJson: row.payload_text,
    });
  }
  async eventWithin(db, actor, parent, version) {
    const row = (
      await db.query(
        'SELECT * FROM worker_pack_use_events WHERE use_id=$1 AND version=$2',
        [parent.id, version],
      )
    ).rows[0];
    rule(row?.payload_text, 'pack_use_unavailable', 404);
    rule(
      digest(row.payload_text) === row.payload_hash,
      'pack_use_integrity_mismatch',
      500,
    );
    const grant = await this.grant(db, row);
    rule(
      canReadProjection(grant, {
        viewerId: actor?.subjectId,
        now: this.access.now(),
        hubEndpoint: this.access.endpoint,
      }),
      'pack_use_unavailable',
      404,
    );
    return {
      row,
      grant,
      event: parse(packUseEventSchema, JSON.parse(row.payload_text)),
    };
  }
  async caseWithin(db, actor, id) {
    const repo = caseRepository(db),
      parent = await repo.lockAnyForRead(id);
    rule(
      parent && parent.state !== 'withdrawn',
      'pack_use_case_unavailable',
      404,
    );
    const projected = await this.cases.projectAuthorizedWithin(
      db,
      safeActor(actor),
      parent,
      await repo.events(id),
    );
    return projected.view;
  }
  async sourcesWithin(
    db,
    actor,
    event,
    { write = false, requireConfiguration = false, subjectId } = {},
  ) {
    const pack = await this.builders.manifestWithin(db, actor, event.pack);
    if (write)
      rule(
        !pack.delisted && !pack.securityIssue,
        'pack_use_maintenance_blocked',
        409,
      );
    const facts = await this.caseWithin(db, actor, event.caseId),
      attempt = exact(facts.attempts, event.attempt);
    rule(
      attempt && attempt.provenance === 'native-v2',
      'pack_use_attempt_unavailable',
      404,
    );
    rule(
      attempt.actorId === subjectId,
      'pack_use_attempt_author_required',
      403,
    );
    rule(
      same(attempt.configurationRef, event.configuration),
      'pack_use_configuration_mismatch',
      422,
    );
    const configuration = await this.configurations.conditionWithin(
      db,
      safeActor(actor),
      event.configuration,
    );
    if (requireConfiguration)
      rule(configuration.record, 'pack_use_configuration_unavailable', 403);
    let result = null;
    if (event.result) {
      result = exact(facts.results, event.result);
      rule(result, 'pack_use_result_unavailable', 404);
      rule(
        result.actorId === subjectId &&
          result.origin.kind === 'attempt' &&
          same(result.origin, event.attempt),
        'pack_use_result_origin_mismatch',
        422,
      );
    }
    const evidence = [],
      verifications = [];
    for (const [kind, refs, destination] of [
      ['evidence', event.evidenceRefs, evidence],
      ['verification', event.verificationRefs, verifications],
    ]) {
      for (const ref of refs) {
        try {
          const view = await this.verificationRecords.requireReferenceWithin(
            db,
            safeActor(actor),
            { kind, ...ref },
            { caseId: event.caseId },
          );
          if (kind === 'verification') {
            const t = view.record.target;
            rule(
              (t.type === 'attempt' && same(t, event.attempt)) ||
                (t.type === 'result' && event.result && same(t, event.result)),
              'pack_use_verification_target_mismatch',
              422,
            );
          }
          destination.push({
            id: ref.id,
            version: ref.version,
            state: 'current',
            record: view.record,
            provenance: view.provenance,
            relationship:
              kind === 'evidence'
                ? 'runner-associated-supporting-material'
                : 'reported-verification-of-exact-target',
            executionAttributionVerified: false,
          });
        } catch (e) {
          if (write || !missing(e)) throw e;
          destination.push({
            id: ref.id,
            version: ref.version,
            state: 'unavailable',
            record: null,
            executionAttributionVerified: false,
          });
        }
      }
    }
    const attemptLatest =
        facts.attempts.filter((v) => v.id === attempt.id).at(-1)?.version ===
        attempt.version,
      resultLatest =
        !result ||
        facts.results.filter((v) => v.id === result.id).at(-1)?.version ===
          result.version;
    return {
      pack,
      configuration,
      attempt,
      result,
      evidence,
      verifications,
      synthetic: facts.synthetic,
      attemptVersionStatus: attemptLatest ? 'current' : 'historical-version',
      resultVersionStatus: resultLatest ? 'current' : 'historical-version',
      reportedOutcome:
        result?.reportedOutcome ?? attempt.reportedOutcome ?? 'unrecorded',
      resolution: facts.resolution.status,
      executionAttribution:
        'runner-signed-association; not-independently-proven',
      roles: {
        packAuthorId: pack.authorId,
        runnerId: attempt.actorId,
        configurationAuthorId: configuration.subjectId ?? null,
        resultAuthorId: result?.actorId ?? null,
        verificationAuthorIds: [
          ...new Set(
            verifications.flatMap((v) =>
              v.record ? [v.record.reportedBy] : [],
            ),
          ),
        ],
      },
      successfulReuseVerified: false,
      professionalCapabilityVerified: false,
    };
  }
  async submit(actor, input) {
    let event;
    try {
      rule(
        typeof input?.payloadJson === 'string' &&
          Buffer.byteLength(input.payloadJson) <= 18000,
        'invalid_pack_use_request',
        400,
      );
      event = parse(packUseEventSchema, JSON.parse(input.payloadJson));
    } catch (e) {
      if (e instanceof ServiceError) throw e;
      throw new ServiceError('invalid_pack_use_request', 400);
    }
    return this.access.runResourceWrite(
      actor,
      'builders',
      { control: event.kind === 'revoke' },
      async (db, authorization) => {
        const hash = digest(input.payloadJson),
          prior = (
            await db.query(
              'SELECT * FROM worker_pack_use_events WHERE operation_id=$1',
              [event.operationId],
            )
          ).rows[0];
        if (prior) {
          rule(
            prior.use_id === event.id &&
              prior.subject_id === actor.subjectId &&
              prior.payload_hash === hash &&
              prior.consent_id === input.consentId,
            'pack_use_operation_conflict',
          );
          return {
            id: event.id,
            operationId: prior.operation_id,
            version: prior.version,
            acknowledged: true,
          };
        }
        const grant = await this.grant(db, {
          operation_id: event.operationId,
          subject_id: actor.subjectId,
          consent_id: input.consentId,
          payload_text: input.payloadJson,
        });
        rule(
          ['Private', 'Public'].includes(grant.visibility),
          'pack_use_visibility_required',
          403,
        );
        if (event.kind === 'record' && event.expectedVersion === 0) {
          await db.query(
            'INSERT INTO worker_pack_uses(id,subject_id,builder_id,manifest_id,case_id,attempt_id) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING',
            [
              event.id,
              actor.subjectId,
              event.pack.builderId,
              event.pack.manifestId,
              event.caseId,
              event.attempt.id,
            ],
          );
        }
        const parent = (
          await db.query(
            'SELECT * FROM worker_pack_uses WHERE id=$1 AND subject_id=$2 FOR UPDATE',
            [event.id, actor.subjectId],
          )
        ).rows[0];
        rule(parent, 'pack_use_unavailable_or_already_recorded', 409);
        rule(
          parent.version === event.expectedVersion,
          'pack_use_version_conflict',
        );
        rule(parent.state === 'active', 'pack_use_revoked');
        rule(parent.version < 1000, 'pack_use_version_limit', 413);
        if (event.kind === 'record') {
          rule(
            parent.builder_id === event.pack.builderId &&
              parent.manifest_id === event.pack.manifestId &&
              parent.case_id === event.caseId &&
              parent.attempt_id === event.attempt.id,
            'pack_use_origin_immutable',
          );
          const sources = await this.sourcesWithin(db, actor, event, {
            write: true,
            requireConfiguration: parent.version === 0,
            subjectId: actor.subjectId,
          });
          if (parent.version) {
            const previous = (
              await db.query(
                "SELECT payload_text FROM worker_pack_use_events WHERE use_id=$1 AND kind='record' ORDER BY version LIMIT 1",
                [parent.id],
              )
            ).rows[0];
            rule(previous?.payload_text, 'pack_use_source_erased');
            const original = JSON.parse(previous.payload_text);
            rule(
              same(original.configuration, event.configuration) &&
                JSON.stringify(original.follows) ===
                  JSON.stringify(event.follows),
              'pack_use_origin_immutable',
            );
          }
          if (event.follows) {
            rule(
              event.follows.id !== event.id,
              'pack_use_circular_relation',
              422,
            );
            const old = await this.readWithin(db, actor, {
              id: event.follows.id,
            });
            rule(
              old.subjectId === actor.subjectId &&
                old.record &&
                old.record.attempt.id !== event.attempt.id,
              'pack_use_prior_unavailable',
              422,
            );
            if (event.follows.kind === 'upgrade')
              rule(
                old.record.pack.builderId === event.pack.builderId &&
                  old.record.pack.manifestId !== event.pack.manifestId &&
                  !same(old.record.configuration, event.configuration),
                'pack_use_upgrade_requires_new_configuration',
                422,
              );
          }
          // Source bodies remain with their owners. We store only explicitly signed
          // reference relationships; reading the association cannot expand grants.
          rule(
            sources.attempt.actorId === actor.subjectId,
            'pack_use_attempt_author_required',
            403,
          );
        } else rule(parent.version > 0, 'pack_use_unavailable', 404);
        await db.query(
          'INSERT INTO worker_pack_use_events(operation_id,use_id,subject_id,version,kind,consent_id,payload_text,payload_hash) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',
          [
            event.operationId,
            event.id,
            actor.subjectId,
            parent.version + 1,
            event.kind,
            input.consentId,
            input.payloadJson,
            hash,
          ],
        );
        await db.query(
          'UPDATE worker_pack_uses SET version=$2,state=$3 WHERE id=$1',
          [
            event.id,
            parent.version + 1,
            event.kind === 'revoke' ? 'revoked' : 'active',
          ],
        );
        await recordObjectAudit(db, {
          subjectId: actor.subjectId,
          objectId: event.operationId,
          action: 'worker-pack.event',
          httpRequestId: actor.httpRequestId ?? null,
          ...authorization,
        });
        return {
          id: event.id,
          operationId: event.operationId,
          version: parent.version + 1,
          acknowledged: true,
        };
      },
    );
  }
  async readWithin(db, actor, input) {
    const p = parse(packUseReadSchema, input),
      parent = (
        await db.query('SELECT * FROM worker_pack_uses WHERE id=$1 FOR SHARE', [
          p.id,
        ])
      ).rows[0];
    rule(parent, 'pack_use_unavailable', 404);
    const owner = parent.subject_id === actor?.subjectId,
      base = {
        id: parent.id,
        subjectId: parent.subject_id,
        version: p.version ?? parent.version,
        currentVersion: parent.version,
        state: parent.state,
        workerStarted: false,
        successfulReuseVerified: false,
        professionalCapabilityVerified: false,
      };
    try {
      const { row, grant, event } = await this.eventWithin(
        db,
        actor,
        parent,
        base.version,
      );
      if (parent.state === 'revoked' || event.kind === 'revoke')
        return { ...base, record: null, sourceStatus: 'revoked' };
      // Reauthorization or narrowed visibility on a current association does not
      // silently revive its former broader audience via the version endpoint.
      if (base.version !== parent.version)
        await this.eventWithin(db, actor, parent, parent.version);
      const sources = await this.sourcesWithin(db, actor, event, {
        subjectId: parent.subject_id,
      });
      return {
        ...base,
        record: event,
        sources,
        sourceStatus: 'available',
        payloadHash: row.payload_hash,
        ...(owner
          ? {
              disclosure: {
                visibility: grant.visibility,
                viewers: grant.viewers,
              },
            }
          : {}),
      };
    } catch (e) {
      if (!missing(e) || !owner) throw e;
      return {
        ...base,
        record: null,
        sources: null,
        sourceStatus: 'unavailable',
      };
    }
  }
  get(actor, input) {
    const p = parse(packUseReadSchema, input);
    return actor
      ? this.access.runAuthorized(actor, 'builders', (db) =>
          this.readWithin(db, actor, p),
        )
      : transaction(this.access.db, (db) => this.readWithin(db, null, p));
  }
  query(actor, input = {}) {
    const p = parse(packUseQuerySchema, input),
      read = async (db) => {
        const rows = (
          await db.query(
            'SELECT id FROM worker_pack_uses WHERE ($1::uuid IS NULL OR builder_id=$1) AND ($2::text IS NULL OR subject_id=$2) AND ($3::uuid IS NULL OR id>$3) ORDER BY id',
            [p.builderId ?? null, p.subjectId ?? null, p.after ?? null],
          )
        ).rows;
        const items = [];
        for (const row of rows)
          try {
            items.push(await this.readWithin(db, actor, { id: row.id }));
            if (items.length > p.limit) break;
          } catch (e) {
            if (!missing(e)) throw e;
          }
        const page = items.slice(0, p.limit);
        return {
          items: page,
          nextAfter: items.length > p.limit ? page.at(-1).id : null,
          coverage: 'current-authorized-associations',
          countsAreCapabilityScores: false,
        };
      };
    return actor
      ? this.access.runAuthorized(actor, 'builders', read)
      : transaction(this.access.db, read);
  }
  candidates(actor, input = {}) {
    const p = parse(packUseCandidatesSchema, input);
    return this.access.runAuthorized(actor, 'builders', async (db) => {
      const rows = (
          await db.query(
            "SELECT DISTINCT case_id FROM case_events WHERE subject_id=$1 AND kind='attempt-start' AND ($2::uuid IS NULL OR case_id=$2) AND ($3::uuid IS NULL OR case_id>$3) ORDER BY case_id",
            [actor.subjectId, p.caseId ?? null, p.after ?? null],
          )
        ).rows,
        items = [];
      for (const row of rows)
        try {
          const facts = await this.caseWithin(db, actor, row.case_id),
            attempts = facts.attempts.filter(
              (a) =>
                a.actorId === actor.subjectId &&
                a.configurationRef &&
                a.configurationCondition?.record,
            );
          if (!attempts.length) continue;
          const evidence = [],
            verifications = [];
          const records = (
            await db.query(
              'SELECT id,object_type,version FROM verification_objects WHERE case_id=$1 ORDER BY id',
              [row.case_id],
            )
          ).rows;
          for (const r of records)
            try {
              const view =
                await this.verificationRecords.requireReferenceWithin(
                  db,
                  actor,
                  { kind: r.object_type, id: r.id, version: r.version },
                  { caseId: row.case_id },
                );
              (r.object_type === 'evidence' ? evidence : verifications).push(
                view,
              );
            } catch (e) {
              if (!missing(e)) throw e;
            }
          items.push({
            caseId: row.case_id,
            summary: facts.scopes.at(-1)?.summary ?? null,
            attempts,
            results: facts.results.filter(
              (r) =>
                r.actorId === actor.subjectId &&
                r.origin.kind === 'attempt' &&
                attempts.some((a) => same(a, r.origin)),
            ),
            evidence,
            verifications,
            synthetic: facts.synthetic,
          });
          if (items.length > p.limit) break;
        } catch (e) {
          if (!missing(e)) throw e;
        }
      const page = items.slice(0, p.limit);
      return {
        items: page,
        nextAfter: items.length > p.limit ? page.at(-1).caseId : null,
        automaticExecution: false,
      };
    });
  }
  receipt(actor, input) {
    const p = parse(packUseReceiptSchema, input);
    return this.access.runAuthorized(actor, 'builders', async (db) => {
      const row = (
        await db.query(
          'SELECT use_id,version,consent_id,payload_hash FROM worker_pack_use_events WHERE operation_id=$1 AND subject_id=$2',
          [p.operationId, actor.subjectId],
        )
      ).rows[0];
      return {
        operationId: p.operationId,
        state: !row
          ? 'absent'
          : row.payload_hash === p.payloadHash
            ? 'acknowledged'
            : 'conflict',
        currentReadPermissionConfirmed: false,
        ...(row?.payload_hash === p.payloadHash
          ? { id: row.use_id, version: row.version, consentId: row.consent_id }
          : {}),
      };
    });
  }
}
