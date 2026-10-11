import canonicalize from 'canonicalize';
import {
  qualificationPlanSchema,
  qualificationRequestEventSchema,
  qualificationRequestReadSchema,
  qualificationRequestQuerySchema,
  qualificationRequestReceiptSchema,
} from './shared/qualification-requests-v2-schema.mjs';
import { ServiceError } from './shared/service-error.mjs';
import { canReadProjection } from './domain/consent-policy.mjs';
import { digest } from './shared/digest.mjs';
import { recordObjectAudit } from './infrastructure/object-audit.mjs';
const rule = (ok, code, status = 409) => {
  if (!ok) throw new ServiceError(code, status);
};
const parse = (s, x) => {
  const p = s.safeParse(x);
  rule(p.success, 'invalid_qualification_permission_request', 400);
  return p.data;
};
const unavailable = (e) =>
  e instanceof ServiceError && [403, 404, 409, 422, 503].includes(e.status);
const sort = (refs) =>
  [...refs].sort(
    (a, b) => a.kind.localeCompare(b.kind) || a.id.localeCompare(b.id),
  );
const refKey = (r) => r.kind + ':' + r.id + ':' + r.payloadHash;
const same = (a, b) => canonicalize(a) === canonicalize(b);
const scopeHash = (taskId, authorId, refs) =>
  digest(canonicalize({ taskId, authorId, sourceRefs: sort(refs) }));
const clean = ({ authorId: _authorId, label: _label, ...ref }) => ref;
export class QualificationRequestServiceV2 {
  constructor(
    access,
    consents,
    { qualification, calculations, tasks, inbox } = {},
  ) {
    Object.assign(this, {
      access,
      consents,
      qualification,
      calculations,
      tasks,
      inbox,
    });
  }
  async sourcesWithin(db, actor, input) {
    const p = parse(qualificationPlanSchema, input),
      now = this.access.now();
    rule(
      Date.parse(p.expiresAt) > now * 1000 &&
        Date.parse(p.expiresAt) <= (now + 29 * 86400) * 1000,
      'qualification_request_expiry_required',
    );
    const task = await this.tasks.requireTaskWithin(db, actor, p.taskId),
      request = task.snapshot.request;
    rule(
      request.qualification?.profile === 'facts-v2',
      'qualification_scoped_profile_required',
      422,
    );
    const policy = await this.qualification.legacy.policyWithin(
        db,
        request.qualification.policyId,
        request.qualification.policyVersion,
        request.capabilityId,
        request.collaboration,
      ),
      seen = new Map();
    const trace = {
      readEventWithin: async (kind, row) => {
        rule(row?.payload_text, 'qualification_source_unavailable');
        const ref = {
            kind,
            id: row.id,
            eventVersion: 1,
            payloadHash: row.payload_hash,
          },
          g = await this.calculations.sourceGrantWithin(db, ref, row);
        rule(
          canReadProjection(g, { viewerId: actor.subjectId, now }),
          'qualification_candidate_source_unavailable',
          403,
        );
        const payload = JSON.parse(row.payload_text),
          event = payload.event ?? payload;
        seen.set(refKey(ref), {
          ...ref,
          authorId: row.subject_id,
          label: event.kind ?? 'task-created',
        });
        return g;
      },
    };
    for (const id of new Set(p.participationIds)) {
      const result = await this.qualification.participationWithin(
        db,
        actor,
        id,
        actor.subjectId,
        policy,
        trace,
      );
      rule(result.usable, 'qualification_current_accepted_scope_required');
    }
    const externalRefs=[...new Map(p.externalReviewRefs.map(ref=>[ref.id+':'+ref.version,ref])).values()]
      .sort((a,b)=>a.id.localeCompare(b.id)||a.version-b.version);
    for(const ref of externalRefs){
      const result=await this.qualification.externalReviewWithin(db,actor,ref,actor.subjectId,policy,trace);
      rule(result.usable,'qualification_current_accepted_scope_required');
    }
    const sources = sort([...seen.values()]);
    rule(
      sources.length > 0 && sources.length <= 128,
      'qualification_source_limit',
    );
    return {
      task,
      candidateId: actor.subjectId,
      recipientId: task.requesterId,
      sources,
      evidence: {
        participationIds: [...new Set(p.participationIds)].sort((left,right)=>left<right?-1:left>right?1:0),
        externalReviewRefs: externalRefs,
        capsuleUseIds: [],
        proofIds: [],
        assistanceIds: [],
      },
    };
  }
  async planWithin(db, actor, input) {
    const p = parse(qualificationPlanSchema, input),
      value = await this.sourcesWithin(db, actor, p),
      own = value.sources.filter((r) => r.authorId === actor.subjectId),
      foreign = value.sources.filter((r) => r.authorId !== actor.subjectId),
      authors = [];
    for (const authorId of new Set(foreign.map((r) => r.authorId))) {
      const refs = foreign.filter((r) => r.authorId === authorId),
        hash = scopeHash(p.taskId, authorId, refs.map(clean));
      const request = (
        await db.query(
          'SELECT id FROM qualification_permission_requests WHERE subject_id=$1 AND source_author_id=$2 AND task_id=$3 AND scope_hash=$4 ORDER BY created_at DESC,id DESC LIMIT 1',
          [actor.subjectId, authorId, p.taskId, hash],
        )
      ).rows[0];
      const grants = (
        await db.query(
          'SELECT id FROM qualification_calculation_grants WHERE subject_id=$1 AND task_id=$2 ORDER BY created_at DESC,id DESC',
          [authorId, p.taskId],
        )
      ).rows;
      let permission = null;
      for (const row of grants)
        try {
          const r = await this.calculations.readGrantWithin(db, actor, row.id),
            g = r.payload;
          if (
            g.kind !== 'source-permission' ||
            g.candidateId !== actor.subjectId ||
            g.recipientId !== value.recipientId ||
            Date.parse(g.expiresAt) < Date.parse(p.expiresAt)
          )
            continue;
          const covered = new Set(g.sourceRefs.map(refKey));
          if (refs.every((ref) => covered.has(refKey(ref)))) {
            await this.calculations.permissionsWithin(db, actor, {
              ...g,
              permissionIds: [row.id],
            });
            permission = { id: row.id, expiresAt: g.expiresAt };
            break;
          }
        } catch (e) {
          if (!unavailable(e)) throw e;
        }
      let requestView = null;
      if (request)
        try {
          requestView = await this.readWithin(db, actor, {
            requestId: request.id,
          });
        } catch (e) {
          if (!unavailable(e)) throw e;
        }
      authors.push({
        sourceAuthorId: authorId,
        sourceRefs: refs.map(clean),
        materials: refs.map((r) => ({
          id: r.id,
          kind: r.kind,
          label: r.label,
        })),
        permission,
        request: requestView,
      });
    }
    const common = {
      taskId: p.taskId,
      candidateId: actor.subjectId,
      recipientId: value.recipientId,
      purpose: 'this-task-eligibility-computation-only',
      expiresAt: p.expiresAt,
      disclosure:
        'public-conditions-and-bounded-satisfaction-only; no-source-text-or-other-party-identity',
    };
    return {
      ...common,
      ownMaterials: own.map((r) => ({
        id: r.id,
        kind: r.kind,
        label: r.label,
      })),
      authors,
      ready: authors.every((a) => a.permission),
      sourceReadGranted: false,
      compute: {
        ...common,
        kind: 'compute',
        sourceRefs: value.sources.map(clean),
        permissionIds: authors
          .filter((a) => a.permission)
          .map((a) => a.permission.id),
        evidence: value.evidence,
      },
    };
  }
  plan(actor, input) {
    return this.access.runAuthorized(actor, 'assistance', (db) =>
      this.planWithin(db, actor, input),
    );
  }
  async rootWithin(db, actor, row) {
    const event = (
      await db.query(
        'SELECT * FROM qualification_permission_request_events WHERE id=$1',
        [row.root_event_id],
      )
    ).rows[0];
    rule(event?.payload_text, 'qualification_request_source_erased', 404);
    const g = await this.consents.require(db, {
      id: event.consent_id,
      subjectId: event.subject_id,
      objectId: event.id,
      action: 'qualification.request',
      recipient: this.access.endpoint,
      payloadJson: event.payload_text,
    });
    rule(
      canReadProjection(g, {
        viewerId: actor.subjectId,
        now: this.access.now(),
      }),
      'qualification_request_unavailable',
      404,
    );
    return parse(
      qualificationRequestEventSchema,
      JSON.parse(event.payload_text),
    );
  }
  async readWithin(db, actor, input) {
    const p = parse(qualificationRequestReadSchema, input),
      row = (
        await db.query(
          'SELECT * FROM qualification_permission_requests WHERE id=$1 AND (subject_id=$2 OR source_author_id=$2) FOR SHARE',
          [p.requestId, actor.subjectId],
        )
      ).rows[0];
    rule(row, 'qualification_request_unavailable', 404);
    const base = {
      requestId: row.id,
      version: row.version,
      state: row.state,
      role: row.subject_id === actor.subjectId ? 'candidate' : 'source-author',
      permissionGranted: false,
    };
    if (Date.parse(row.expires_at) <= this.access.now() * 1000)
      return {
        ...base,
        state: 'expired',
        expiresAt: new Date(row.expires_at).toISOString(),
      };
    let root;
    try {
      root = await this.rootWithin(db, actor, row);
    } catch (e) {
      if (!unavailable(e)) throw e;
      return { ...base, state: 'request-source-unavailable' };
    }
    const recipient = (
      await db.query('SELECT requester_id FROM task_requests WHERE id=$1', [
        row.task_id,
      ])
    ).rows[0]?.requester_id;
    const materials = [];
    let available = true;
    for (const ref of root.sourceRefs)
      try {
        const source = await this.calculations.sourceWithin(db, ref),
          g = await this.calculations.sourceGrantWithin(db, ref, source);
        rule(
          source.subject_id === row.source_author_id &&
            canReadProjection(g, {
              viewerId: actor.subjectId,
              now: this.access.now(),
            }),
          'qualification_source_unavailable',
        );
        const payload = JSON.parse(source.payload_text),
          event = payload.event ?? payload;
        materials.push({
          ...ref,
          label: event.kind ?? 'task-created',
          summary:
            event.summary ??
            event.description ??
            event.agreedScope ??
            event.title ??
            null,
        });
      } catch (e) {
        if (!unavailable(e)) throw e;
        available = false;
      }
    let target = null;
    try {
      const t = await this.tasks.requireTaskWithin(db, actor, row.task_id);
      target = {
        title: t.snapshot.request.title,
        capabilityId: t.snapshot.request.capabilityId,
        qualification: t.snapshot.request.qualification,
      };
    } catch (e) {
      if (!unavailable(e)) throw e;
    }
    const events = (
        await db.query(
          'SELECT * FROM qualification_permission_request_events WHERE request_id=$1 ORDER BY version',
          [row.id],
        )
      ).rows,
      history = [];
    let grantId = null;
    for (const event of events)
      try {
        if (!event.payload_text) continue;
        const g = await this.consents.require(db, {
          id: event.consent_id,
          subjectId: event.subject_id,
          objectId: event.id,
          action: 'qualification.request',
          recipient: this.access.endpoint,
          payloadJson: event.payload_text,
        });
        if (
          !canReadProjection(g, {
            viewerId: actor.subjectId,
            now: this.access.now(),
          })
        )
          continue;
        const data = JSON.parse(event.payload_text);
        history.push({
          eventId: event.id,
          kind: data.kind,
          version: event.version,
          reason: data.reason ?? null,
          by: event.subject_id,
        });
        if (data.kind === 'record-permission') grantId = data.grantId;
      } catch (e) {
        if (!unavailable(e)) throw e;
      }
    let permission = null;
    if (grantId)
      try {
        const g = await this.calculations.readGrantWithin(db, actor, grantId);
        permission = {
          grantId,
          state: 'current',
          expiresAt: g.payload.expiresAt,
        };
      } catch (e) {
        if (!unavailable(e)) throw e;
        permission = { grantId, state: 'unavailable' };
      }
    return {
      ...base,
      state:
        Date.parse(row.expires_at) <= this.access.now() * 1000
          ? 'expired'
          : !available
            ? 'source-unavailable'
            : base.state,
      candidateId: row.subject_id,
      sourceAuthorId: row.source_author_id,
      recipientId: recipient,
      taskId: row.task_id,
      target,
      materials,
      sourceRefs: root.sourceRefs,
      participationIds:
        row.subject_id === actor.subjectId ? root.participationIds : undefined,
      externalReviewRefs:
        row.subject_id === actor.subjectId ? root.externalReviewRefs : undefined,
      expiresAt: new Date(row.expires_at).toISOString(),
      history,
      permission,
      permissionGranted: permission?.state === 'current',
      sourceReadGranted: false,
      grant:
        available && row.source_author_id === actor.subjectId
          ? {
              taskId: row.task_id,
              candidateId: row.subject_id,
              recipientId: recipient,
              kind: 'source-permission',
              purpose: 'this-task-eligibility-computation-only',
              expiresAt: new Date(row.expires_at).toISOString(),
              sourceRefs: root.sourceRefs,
              disclosure:
                'public-conditions-and-bounded-satisfaction-only; no-source-text-or-other-party-identity',
            }
          : null,
    };
  }
  read(actor, input) {
    return this.access.runAuthorized(actor, 'assistance', (db) =>
      this.readWithin(db, actor, input),
    );
  }
  query(actor, input = {}) {
    const p = parse(qualificationRequestQuerySchema, input);
    return this.access.runAuthorized(actor, 'assistance', async (db) => {
      const rows = (
        await db.query(
          `SELECT id FROM qualification_permission_requests WHERE ${p.view === 'sent' ? 'subject_id' : 'source_author_id'}=$1 AND ($2::uuid IS NULL OR task_id=$2) AND ($3::uuid IS NULL OR id>$3) ORDER BY id LIMIT $4`,
          [actor.subjectId, p.taskId ?? null, p.after ?? null, p.limit + 1],
        )
      ).rows;
      const items = [];
      for (const row of rows.slice(0, p.limit))
        items.push(await this.readWithin(db, actor, { requestId: row.id }));
      return {
        items,
        nextAfter: rows.length > p.limit ? items.at(-1).requestId : null,
      };
    });
  }
  async submit(actor, input) {
    let x;
    try {
      x = parse(qualificationRequestEventSchema, JSON.parse(input.payloadJson));
      rule(
        Buffer.byteLength(input.payloadJson) <= 48000,
        'qualification_request_too_large',
        413,
      );
    } catch (e) {
      if (e instanceof ServiceError) throw e;
      throw new ServiceError('invalid_qualification_permission_request', 400);
    }
    return this.access.runResourceWrite(
      actor,
      'assistance',
      { control: ['cancel', 'decline'].includes(x.kind) },
      async (db, authorization) => {
        const grant = await this.consents.require(db, {
            id: input.consentId,
            subjectId: actor.subjectId,
            objectId: x.eventId,
            action: 'qualification.request',
            recipient: this.access.endpoint,
            payloadJson: input.payloadJson,
          }),
          hash = digest(input.payloadJson);
        const prior = (
          await db.query(
            'SELECT * FROM qualification_permission_request_events WHERE id=$1',
            [x.eventId],
          )
        ).rows[0];
        if (prior) {
          rule(
            prior.subject_id === actor.subjectId &&
              prior.request_id === x.requestId &&
              prior.payload_hash === hash &&
              prior.consent_id === input.consentId,
            'qualification_request_conflict',
          );
          return {
            eventId: x.eventId,
            requestId: x.requestId,
            version: prior.version,
            acknowledged: true,
          };
        }
        if (x.kind === 'request') {
          rule(x.expectedVersion === 0, 'qualification_request_conflict');
          const value = await this.sourcesWithin(db, actor, {
              taskId: x.taskId,
              participationIds: x.participationIds,
              externalReviewRefs: x.externalReviewRefs,
              expiresAt: x.expiresAt,
            }),
            refs = value.sources
              .filter((r) => r.authorId === x.sourceAuthorId)
              .map(clean);
          rule(
            refs.length > 0 &&
              x.sourceAuthorId !== actor.subjectId &&
              same(sort(refs), sort(x.sourceRefs)),
            'qualification_request_exact_author_sources_required',
            403,
          );
          rule(
            !this.inbox ||
              !(await this.inbox.isBlockedWithin(
                db,
                actor.subjectId,
                x.sourceAuthorId,
              )),
            'qualification_request_blocked',
            403,
          );
          await db.query(
            'SELECT pg_advisory_xact_lock(hashtextextended($1,0))',
            [
              `qualification-request:${actor.subjectId}:${x.sourceAuthorId}:${x.taskId}`,
            ],
          );
          const old = (
            await db.query(
              `SELECT id,state,created_at,expires_at FROM qualification_permission_requests WHERE subject_id=$1 AND source_author_id=$2 AND task_id=$3 ORDER BY created_at DESC LIMIT 1`,
              [actor.subjectId, x.sourceAuthorId, x.taskId],
            )
          ).rows[0];
          rule(
            !old ||
              (Date.parse(old.created_at) <= (this.access.now() - 86400) * 1000 &&
                (old.state !== 'pending' || Date.parse(old.expires_at) <= this.access.now() * 1000)),
            'qualification_request_cooldown',
            429,
          );
          await db.query(
            'INSERT INTO qualification_permission_requests(id,subject_id,source_author_id,task_id,scope_hash,root_event_id,expires_at,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',
            [
              x.requestId,
              actor.subjectId,
              x.sourceAuthorId,
              x.taskId,
              scopeHash(x.taskId, x.sourceAuthorId, refs),
              x.eventId,
              x.expiresAt,
              new Date(this.access.now() * 1000).toISOString(),
            ],
          );
        }
        const row = (
          await db.query(
            'SELECT * FROM qualification_permission_requests WHERE id=$1 FOR UPDATE',
            [x.requestId],
          )
        ).rows[0];
        rule(
          row &&
            [row.subject_id, row.source_author_id].includes(actor.subjectId),
          'qualification_request_unavailable',
          404,
        );
        rule(
          grant.visibility === 'Private' &&
            grant.viewers.every((id) =>
              [row.subject_id, row.source_author_id].includes(id),
            ) &&
            [row.subject_id, row.source_author_id].every((viewerId) =>
              canReadProjection(grant, { viewerId, now: this.access.now() }),
            ),
          'qualification_request_private_audience_required',
          403,
        );
        rule(
          row.version === x.expectedVersion,
          'qualification_request_version_conflict',
        );
        let state = row.state;
        if (x.kind === 'cancel') {
          rule(
            row.subject_id === actor.subjectId,
            'qualification_candidate_required',
            403,
          );
          rule(
            ['pending', 'permission-recorded'].includes(row.state),
            'qualification_request_closed',
          );
          state = 'cancelled';
        }
        if (x.kind === 'decline') {
          rule(
            row.source_author_id === actor.subjectId,
            'qualification_source_author_required',
            403,
          );
          rule(row.state === 'pending', 'qualification_request_closed');
          state = 'declined';
        }
        if (x.kind === 'record-permission') {
          rule(
            row.source_author_id === actor.subjectId &&
              row.state === 'pending' &&
              Date.parse(row.expires_at) > this.access.now() * 1000,
            'qualification_request_closed',
          );
          const root = await this.rootWithin(db, actor, row),
            p = await this.calculations.readGrantWithin(db, actor, x.grantId),
            g = p.payload;
          const target = (
            await db.query(
              'SELECT requester_id FROM task_requests WHERE id=$1',
              [row.task_id],
            )
          ).rows[0];
          rule(
            p.row.subject_id === actor.subjectId &&
              g.kind === 'source-permission' &&
              g.candidateId === row.subject_id &&
              g.taskId === row.task_id &&
              g.recipientId === target?.requester_id &&
              same(sort(g.sourceRefs), sort(root.sourceRefs)) &&
              Date.parse(g.expiresAt) >= Date.parse(row.expires_at),
            'qualification_request_permission_mismatch',
          );
          state = 'permission-recorded';
        }
        await db.query(
          'INSERT INTO qualification_permission_request_events(id,request_id,subject_id,version,kind,consent_id,payload_text,payload_hash,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',
          [
            x.eventId,
            row.id,
            actor.subjectId,
            row.version + 1,
            x.kind,
            input.consentId,
            input.payloadJson,
            hash,
            new Date(this.access.now() * 1000).toISOString(),
          ],
        );
        await db.query(
          'UPDATE qualification_permission_requests SET version=version+1,state=$2 WHERE id=$1',
          [row.id, state],
        );
        await recordObjectAudit(db, {
          subjectId: actor.subjectId,
          objectId: x.eventId,
          action: 'qualification.request.event',
          httpRequestId: actor.httpRequestId ?? null,
          ...authorization,
        });
        return {
          eventId: x.eventId,
          requestId: row.id,
          version: row.version + 1,
          state,
          acknowledged: true,
          permissionGranted: false,
        };
      },
    );
  }
  receipt(actor, input) {
    const p = parse(qualificationRequestReceiptSchema, input);
    return this.access.runAuthorized(actor, 'assistance', async (db) => {
      const r = (
        await db.query(
          'SELECT request_id,version,payload_hash,consent_id FROM qualification_permission_request_events WHERE id=$1 AND subject_id=$2',
          [p.eventId, actor.subjectId],
        )
      ).rows[0];
      return {
        eventId: p.eventId,
        state: !r
          ? 'absent'
          : r.payload_hash === p.payloadHash
            ? 'acknowledged'
            : 'conflict',
        ...(r?.payload_hash === p.payloadHash
          ? {
              requestId: r.request_id,
              version: r.version,
              consentId: r.consent_id,
            }
          : {}),
        currentReadPermissionConfirmed: false,
      };
    });
  }
}
