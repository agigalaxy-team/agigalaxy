import { randomUUID } from 'node:crypto';
import { ServiceError } from './shared/service-error.mjs';
import {
  informationWatchCommandSchema,
  informationWatchReadSchema,
  informationWatchCheckSchema,
  informationWatchReceiptSchema,
} from './shared/information-v2-schema.mjs';
import {
  informationDigest,
  informationWithCursor,
  informationScope,
} from './information-v2.mjs';
import { recordNotificationAudit } from './infrastructure/notification-audit.mjs';
import { transaction } from './database.mjs';
import { cleanupInformationWatchesWithin } from './operations/information-watch-retention-v2.mjs';
const stamp = (n) => new Date(n * 1000).toISOString(),
  seconds = (v) => Date.parse(v) / 1000,
  day = 86400;
const fail = (code, status = 409) => {
  throw new ServiceError(code, status);
};
function parse(schema, input) {
  const p = schema.safeParse(input);
  if (!p.success) fail('invalid_information_watch', 400);
  return p.data;
}
const refKey = (ref) => ref.id;
const runtime = {
  scheduledBy: 'user-host',
  cloudModel: false,
  continuesAfterHostExit: false,
  modelCalls: 0,
};

export class InformationWatchServiceV2 {
  constructor(access, { information, retirement = null }) {
    Object.assign(this, { access, information, retirement });
  }
  now() {
    return this.access.now();
  }
  run(actor, write, fn, control = false) {
    return write
      ? this.access.runResourceWrite(actor, 'notifications', { control }, fn)
      : this.access.runAuthorized(actor, 'notifications', fn);
  }
  async rowWithin(db, actor, id, lock = false) {
    const row = (
      await db.query(
        'SELECT * FROM information_watches_v2 WHERE id=$1 AND subject_id=$2' +
          (lock ? ' FOR UPDATE' : ''),
        [id, actor.subjectId],
      )
    ).rows[0];
    if (!row) fail('information_watch_not_found', 404);
    return row;
  }
  view(row) {
    return {
      watchId: row.id,
      revision: row.revision,
      state:
        row.state === 'active' && seconds(row.expires_at) <= this.now()
          ? 'expired'
          : row.state,
      plan: row.plan,
      lastCheckedAt: row.last_checked_at ? seconds(row.last_checked_at) : null,
      nextCheckAt: row.next_check_at ? seconds(row.next_check_at) : null,
      sourceCoverage: Object.entries(row.scan ?? {}).map(([key, s]) => ({
        key,
        complete: s.complete === true,
        continuationAvailable: !!s.after,
        state: s.state ?? 'not-checked',
      })),
      hostRuntimeState: 'last-check-only; host-running-state-not-confirmed',
      ...runtime,
    };
  }
  async command(actor, input) {
    const x = parse(informationWatchCommandSchema, input),
      requestHash = informationDigest(x);
    return this.run(
      actor,
      true,
      async (db, authorization) => {
        const prior = (
          await db.query(
            'SELECT * FROM information_watch_operations_v2 WHERE operation_id=$1',
            [x.operationId],
          )
        ).rows[0];
        if (prior) {
          if (
            prior.subject_id !== actor.subjectId ||
            prior.request_hash !== requestHash
          )
            fail('information_operation_conflict');
          return { ...prior.result, replayed: true };
        }
        if (
          !['pause', 'end'].includes(x.action) &&
          this.retirement &&
          !this.retirement.canProcessEvidence()
        )
          fail('service_writes_stopped', 410);
        if (x.plan) {
          if (x.plan.expiresAt <= this.now()) fail('information_watch_expired');
          for (const s of x.plan.sources)
            if (
              !authorization.credentialScopes.includes(
                informationScope(s.source),
              )
            )
              fail('information_source_scope_required', 403);
          // A continuation does not silently turn into a different subscription.
          for (const s of x.plan.sources)
            if (
              s.source.kind !== 'reference' &&
              (s.source.kind === 'honor'
                ? s.source.request.after
                : s.source.request.query.after)
            )
              fail('watch_scope_must_start_at_source_beginning', 400);
        }
        let row;
        if (x.action === 'start') {
          if (x.expectedRevision !== 0)
            fail('information_watch_revision_conflict');
          const count = (
            await db.query(
              "SELECT count(*)::int n FROM information_watches_v2 WHERE subject_id=$1 AND state<>'ended' AND expires_at>$2",
              [actor.subjectId, stamp(this.now())],
            )
          ).rows[0].n;
          if (count >= 20) fail('information_watch_limit', 429);
          const inserted = await db.query(
            "INSERT INTO information_watches_v2(id,subject_id,revision,state,plan,expires_at,created_at,updated_at,next_check_at) VALUES($1,$2,1,'active',$3,$4,$5,$5,$5) ON CONFLICT DO NOTHING RETURNING id",
            [
              x.watchId,
              actor.subjectId,
              JSON.stringify(x.plan),
              stamp(x.plan.expiresAt),
              stamp(this.now()),
            ],
          );
          if (!inserted.rows.length) fail('information_watch_exists');
          row = await this.rowWithin(db, actor, x.watchId, true);
        } else {
          row = await this.rowWithin(db, actor, x.watchId, true);
          if (row.revision !== x.expectedRevision)
            fail('information_watch_revision_conflict');
          if (row.state === 'ended') fail('information_watch_ended');
          if (x.action === 'resume' && seconds(row.expires_at) <= this.now())
            fail('information_watch_expired');
          const state =
            x.action === 'end'
              ? 'ended'
              : x.action === 'pause'
                ? 'paused'
                : x.action === 'resume'
                  ? 'active'
                  : row.state;
          const plan = x.plan ?? row.plan;
          await db.query(
            `UPDATE information_watches_v2 SET revision=revision+1,state=$3,plan=$4,expires_at=$5,updated_at=$6,
     ended_at=CASE WHEN $3='ended' THEN $6 ELSE ended_at END,next_check_at=$6,
     baseline=CASE WHEN $7 THEN '{}'::jsonb ELSE baseline END,scan=CASE WHEN $7 THEN '{}'::jsonb ELSE scan END WHERE id=$1 AND subject_id=$2`,
            [
              x.watchId,
              actor.subjectId,
              state,
              JSON.stringify(plan),
              stamp(plan.expiresAt),
              stamp(this.now()),
              x.action === 'revise',
            ],
          );
          row = await this.rowWithin(db, actor, x.watchId);
        }
        const result = {
          operationId: x.operationId,
          watchId: x.watchId,
          revision: row.revision,
          state: this.view(row).state,
          requestHash,
          ...runtime,
        };
        await db.query(
          'INSERT INTO information_watch_operations_v2(operation_id,subject_id,watch_id,request_hash,result,created_at) VALUES($1,$2,$3,$4,$5,$6)',
          [
            x.operationId,
            actor.subjectId,
            x.watchId,
            requestHash,
            JSON.stringify(result),
            stamp(this.now()),
          ],
        );
        await recordNotificationAudit(db, actor, authorization, {
          action: 'notification.preferences',
          objectId: x.watchId,
          idempotencyKey: 'information-watch:' + x.operationId,
        });
        return result;
      },
      ['pause', 'end'].includes(x.action),
    );
  }
  stop(actor, input) {
    if (!['pause', 'end'].includes(input?.action))
      fail('invalid_information_stop', 400);
    return this.command(actor, input);
  }
  receipt(actor, input) {
    const x = parse(informationWatchReceiptSchema, input);
    return this.run(actor, false, async (db) => {
      const row = (
        await db.query(
          'SELECT * FROM information_watch_operations_v2 WHERE operation_id=$1 AND subject_id=$2',
          [x.operationId, actor.subjectId],
        )
      ).rows[0];
      return !row
        ? { state: 'absent' }
        : row.request_hash !== x.requestHash
          ? { state: 'conflict' }
          : { state: 'acknowledged', result: row.result };
    });
  }
  list(actor, input = {}) {
    const x = parse(informationWatchReadSchema, input);
    return this.run(actor, false, async (db) => {
      if (x.watchId)
        return {
          items: [this.view(await this.rowWithin(db, actor, x.watchId))],
          nextAfter: null,
          ...runtime,
        };
      const rows = (
        await db.query(
          "SELECT * FROM information_watches_v2 WHERE subject_id=$1 AND ($2::uuid IS NULL OR id>$2) AND (NOT $4::boolean OR state='active' AND expires_at>$5) ORDER BY id LIMIT $3",
          [
            actor.subjectId,
            x.after ?? null,
            x.limit + 1,
            x.activeOnly,
            stamp(this.now()),
          ],
        )
      ).rows;
      return {
        items: rows.slice(0, x.limit).map((r) => this.view(r)),
        nextAfter: rows.length > x.limit ? rows[x.limit - 1].id : null,
        ...runtime,
      };
    });
  }
  async scanSource(actor, selection, previous = {}, baseline = null) {
    let after = previous.after ?? null,
      refs = previous.after ? [...(previous.refs ?? [])] : [];
    const seen = new Set();
    let last;
    for (let pageNumber = 0; pageNumber < 5; pageNumber++) {
      last = await this.information.source(actor, {
        key: selection.key,
        source: informationWithCursor(selection.source, after),
      });
      if (!last.complete && last.nextCursor === null)
        return {
          state: last.state,
          after: null,
          refs: [],
          complete: false,
          baseline,
          changes:
            baseline && previous.state !== last.state
              ? [
                  {
                    key: selection.key,
                    kind: 'availability-changed',
                    state: last.state,
                  },
                ]
              : [],
        };
      const known = new Map(refs.map((r) => [refKey(r), r]));
      for (const r of last.sourceVersions) known.set(refKey(r), r);
      refs = [...known.values()];
      after = last.nextCursor;
      if (!after) break;
      if (seen.has(after)) fail('information_source_cursor_loop', 503);
      seen.add(after);
    }
    if (after)
      return {
        state: last.state,
        after,
        refs,
        complete: false,
        baseline,
        changes: [],
      };
    const changes = [];
    if (
      baseline &&
      previous.complete === false &&
      !previous.after &&
      previous.state &&
      previous.state !== last.state
    )
      changes.push({
        key: selection.key,
        kind: 'availability-changed',
        state: last.state,
      });
    if (baseline) {
      const old = new Map(baseline.map((r) => [r.id, r.version])),
        current = new Map(refs.map((r) => [r.id, r.version]));
      for (const r of refs)
        if (old.get(r.id) !== r.version)
          changes.push({
            key: selection.key,
            id: r.id,
            kind: old.has(r.id) ? 'source-changed' : 'new-visible-source',
            version: r.version,
          });
      for (const r of baseline)
        if (!current.has(r.id))
          changes.push({
            key: selection.key,
            id: r.id,
            kind: 'no-longer-in-current-scope',
          });
    }
    return {
      state: last.state,
      after: null,
      refs: [],
      complete: true,
      baseline: refs,
      changes,
    };
  }
  async check(actor, input) {
    const x = parse(informationWatchCheckSchema, input);
    if (this.retirement && !this.retirement.canProcessEvidence())
      fail('service_writes_stopped', 410);
    const capture = await this.run(actor, false, async (db) => {
      const row = await this.rowWithin(db, actor, x.watchId);
      if (row.revision !== x.expectedRevision)
        fail('information_watch_revision_conflict');
      return row;
    });
    if (capture.state !== 'active' || seconds(capture.expires_at) <= this.now())
      return { state: this.view(capture).state, changed: false, ...runtime };
    if (capture.next_check_at && seconds(capture.next_check_at) > this.now())
      return {
        state: 'not-due',
        nextCheckAt: seconds(capture.next_check_at),
        ...runtime,
      };
    const scan = {},
      baseline = { ...capture.baseline },
      changes = [];
    for (const selected of capture.plan.sources) {
      const result = await this.scanSource(
        actor,
        selected,
        capture.scan[selected.key],
        baseline[selected.key] ?? null,
      );
      scan[selected.key] = {
        state: result.state,
        after: result.after,
        refs: result.refs,
        complete: result.complete,
      };
      if (result.complete) baseline[selected.key] = result.baseline;
      changes.push(...result.changes);
    }
    return this.run(actor, true, async (db) => {
      const row = await this.rowWithin(db, actor, x.watchId, true);
      if (
        row.state !== 'active' ||
        row.revision !== capture.revision ||
        row.check_revision !== capture.check_revision ||
        seconds(row.expires_at) <= this.now()
      )
        return { state: 'superseded-during-check', changed: false, ...runtime };
      const failed = Object.values(scan).some(
          (s) => s.state === 'temporarily-unavailable',
        ),
        partial = Object.values(scan).some((s) => !!s.after),
        failures = failed ? row.failures + 1 : 0;
      const next =
        this.now() +
        (failed
          ? Math.min(1800, 60 * 2 ** Math.min(failures - 1, 5))
          : partial
            ? 0
            : 900);
      await db.query(
        'UPDATE information_watches_v2 SET baseline=$3,scan=$4,check_revision=check_revision+1,last_checked_at=$5,next_check_at=$6,failures=$7 WHERE id=$1 AND subject_id=$2',
        [
          row.id,
          actor.subjectId,
          JSON.stringify(baseline),
          JSON.stringify(scan),
          stamp(this.now()),
          stamp(next),
          failures,
        ],
      );
      let eventId = null;
      if (changes.length) {
        let due = this.now(),
          batchKey = randomUUID();
        if (row.plan.report.mode === 'daily') {
          due =
            Math.floor(this.now() / day) * day + row.plan.report.utcMinute * 60;
          if (due <= this.now()) due += day;
          batchKey = 'daily:' + row.revision + ':' + due;
        }
        const existing = (
          await db.query(
            'SELECT id,changes FROM information_watch_changes_v2 WHERE watch_id=$1 AND batch_key=$2 FOR UPDATE',
            [row.id, batchKey],
          )
        ).rows[0];
        const merged = [...(existing?.changes ?? []), ...changes];
        // Only references/status are durable. Bodies and model rationale stay out.
        const unique = [
          ...new Map(
            merged.map((c) => [c.key + ':' + (c.id ?? 'availability'), c]),
          ).values(),
        ];
        eventId = existing?.id ?? randomUUID();
        await db.query(
          `INSERT INTO information_watch_changes_v2(id,subject_id,watch_id,batch_key,changes,created_at,available_at,expires_at,watch_revision)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT(watch_id,batch_key) DO UPDATE SET changes=EXCLUDED.changes`,
          [
            eventId,
            actor.subjectId,
            row.id,
            batchKey,
            JSON.stringify(unique),
            stamp(this.now()),
            stamp(due),
            stamp(Math.min(due + 90 * day, seconds(row.expires_at) + 90 * day)),
            row.revision,
          ],
        );
      }
      return {
        state: partial
          ? 'coverage-in-progress'
          : failed
            ? 'partial-source-failure'
            : changes.length
              ? 'changed'
              : 'unchanged',
        watchId: row.id,
        eventId,
        changed: changes.length > 0,
        nextCheckAt: next,
        coverage: Object.entries(scan).map(([key, s]) => ({
          key,
          complete: s.complete,
          sourceState: s.state,
        })),
        ...runtime,
      };
    });
  }
  // The inbox carries only a private check receipt. Opening it re-queries the
  // selected scope; a receipt never grants access to a prior source body.
  async notificationWithin(db, actor, eventId) {
    const row = (
      await db.query(
        `SELECT e.*,w.state,w.expires_at watch_expires FROM information_watch_changes_v2 e
  JOIN information_watches_v2 w ON w.id=e.watch_id WHERE e.id=$1 AND e.subject_id=$2 AND e.available_at<=$3 AND e.expires_at>$3
  AND w.state='active' AND w.expires_at>$3 AND w.revision=e.watch_revision`,
        [eventId, actor.subjectId, stamp(this.now())],
      )
    ).rows[0];
    if (!row) return null;
    return {
      title: '关注的资料有变化，请按当前权限查看',
      eventKind: 'information-change',
      actorId: actor.subjectId,
      object: { type: 'information-watch', id: row.watch_id, eventId: row.id },
      sourceExpiresAt: new Date(row.expires_at).toISOString(),
      receiptOnly: true,
      sourceState: 'recheck-required',
    };
  }
  async events(actor, input) {
    const { watchId } = parse(informationWatchReadSchema, input);
    if (!watchId) fail('invalid_information_watch', 400);
    const capture = await this.run(actor, false, async (db) => {
      const watch = await this.rowWithin(db, actor, watchId);
      const rows = (
        await db.query(
          'SELECT id,changes,created_at,available_at FROM information_watch_changes_v2 WHERE watch_id=$1 AND subject_id=$2 AND expires_at>$3 AND available_at<=$3 ORDER BY created_at DESC LIMIT 20',
          [watchId, actor.subjectId, stamp(this.now())],
        )
      ).rows;
      return { watch, rows };
    });
    const current = await this.information.query(actor, {
      purpose: capture.watch.plan.purpose,
      sources: capture.watch.plan.sources,
    });
    // Historical hashes/IDs are not repeated after current source permission was
    // lost. Own watch scope remains readable; protected source data does not.
    const visible = new Map(
      current.items.map((s) => [s.key, new Set(s.items.map((i) => i.id))]),
    );
    return {
      watch: this.view(capture.watch),
      current,
      events: capture.rows.map((e) => ({
        id: e.id,
        at: seconds(e.created_at),
        changes: e.changes.map((c) =>
          visible.get(c.key)?.has(c.id)
            ? c
            : { key: c.key, kind: 'current-source-recheck-required' },
        ),
      })),
      ...runtime,
    };
  }
  async eraseSubjectWithin(db, subjectId) {
    await db.query(
      'DELETE FROM information_watch_changes_v2 WHERE subject_id=$1',
      [subjectId],
    );
    await db.query(
      'DELETE FROM information_watch_operations_v2 WHERE subject_id=$1',
      [subjectId],
    );
    await db.query('DELETE FROM information_watches_v2 WHERE subject_id=$1', [
      subjectId,
    ]);
  }
  async purgeExpired(db = this.access.db) {
    return transaction(db, (tx) =>
      cleanupInformationWatchesWithin(tx, this.now()),
    );
  }
}
