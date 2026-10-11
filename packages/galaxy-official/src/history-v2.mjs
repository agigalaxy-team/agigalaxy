import { historyV2QuerySchema } from './shared/history-v2-schema.mjs';
import { historyV2Repository } from './infrastructure/history-v2-repository.mjs';
import { caseRepository } from './infrastructure/case-repository.mjs';
import { transaction } from './database.mjs';
import { ServiceError } from './shared/service-error.mjs';
import { historyVisibleValue, visibleFactVersions, sourceFingerprint, matchesHistoryWindow, historyRelevance } from './domain/history-v2.mjs';

const unavailable = error => error instanceof ServiceError && [403, 404, 409, 422].includes(error.status);
const timestamp = value => typeof value === 'number' ? new Date(value * 1000).toISOString() : value instanceof Date ? value.toISOString() : value ?? null;
async function scan(read, visit) {
  let after = null;
  for (;;) {
    const page = await read(after);
    for (const item of page) await visit(item);
    if (page.length < 100) break;
    after = page.at(-1).id;
  }
}

// On-demand source projection: no mutable resume table, hidden global counters,
// user-model inference, or derived Honor/paid-qualification decision is written.
export class HistoryV2Service {
  constructor(access, { cases, verificationRecords, assistance, profiles, capsules } = {}) {
    Object.assign(this, { access, cases, verificationRecords, assistance, profiles, capsules });
  }
  async query(actor, input) {
    const parsed = historyV2QuerySchema.safeParse(input);
    if (!parsed.success) throw new ServiceError('invalid_history_v2_query');
    const read = db => this.queryWithin(db, actor, parsed.data);
    return actor ? this.access.runAuthorized(actor, 'history', read) : transaction(this.access.db, read);
  }
  async taskWithin(db, actor, taskId, subjectId, repo) {
    const task = await this.assistance.readTaskWithin(db, actor, taskId);
    const root = await repo.rootTaskEvent(taskId);
    if (!root) return null;
    const participations = (task.participations ?? []).filter(p => !subjectId || p.subjectId === subjectId || task.requesterId === subjectId).map(p => ({
      participationId: p.participationId, subjectId: p.subjectId, role: p.role,
      // Only current explicitly visible agreement text is copied. Aggregate
      // versions/state include invisible writes and are not History evidence.
      agreedScope: p.scopeAvailable === false ? null : p.agreedScope,
      scopeVersion: p.scopeAvailable === false ? null : p.scopeVersion,
      events: historyVisibleValue(p.events),
      deliveries: historyVisibleValue(p.deliveries),
      capabilityVerified: false, stateMeaning: 'visible-historical-events; use Task for current participation state',
    }));
    if (subjectId && task.requesterId !== subjectId && !participations.some(p => p.subjectId === subjectId)) return null;
    return {
      kind: 'task-history', key: `task:${taskId}`, taskId, taskIds: [taskId], caseId: task.caseId,
      title: task.request.title, summary: task.request.summary, subjectId, requesterId: task.requesterId,
      ...(task.textView?{textView:{format:task.textView.format,checkedAt:task.textView.checkedAt,fields:{title:task.textView.fields.title,summary:task.textView.fields.summary}}}:{}),
      subjectRoles: [...(!subjectId || task.requesterId === subjectId ? ['requester'] : []), ...new Set(participations.filter(p => !subjectId || p.subjectId === subjectId).map(p => p.role))],
      capabilityIds: task.request.capabilityId ? [task.request.capabilityId] : [],
      participation: participations, publication: { eventId: root.id, reportedBy: root.subject_id, recordedAt: timestamp(root.created_at) },
      activityTimes: [timestamp(root.created_at), ...participations.flatMap(p => p.events.map(e => timestamp(e.at)))].filter(Boolean),
      workPerformedInferred: false, capabilityVerified: false, taskOutcomeVerified: false,
      sourceScope: 'task-publication-and-authorized-participation; not-work-success',
    };
  }
  async caseWithin(db, actor, parent, subjectId, tasks, repo) {
    const records = caseRepository(db), locked = await records.lockAnyForRead(parent.id);
    if (!locked || locked.state === 'withdrawn') return null;
    const allRows = await records.events(parent.id);
    const { view, rows } = await this.cases.projectAuthorizedWithin(db, actor, locked, allRows);
    const reports = [], proofs = [];
    for (const record of await repo.records(parent.id)) {
      try {
        const report = await this.verificationRecords.readWithin(db, actor ?? { subjectId: null }, { type: record.object_type, id: record.id });
        reports.push({ ...report, reportedBy: record.subject_id });
      } catch (error) { if (!unavailable(error)) throw error; }
    }
    if (this.verificationRecords.proofs) for (const record of await repo.proofs(parent.id)) {
      try {
        const proof = await this.verificationRecords.proofs.readWithin(db, actor, record.id);
        proofs.push({ proofId: record.id, status: proof.status, provenance: proof.provenance, capabilityVerified: false,
          taskOutcomeVerified: false, scope: 'referenced-ci-run-only' });
      } catch (error) { if (!unavailable(error)) throw error; }
    }
    const linked = tasks.filter(t => t.caseId === parent.id);
    const capsuleReuse=this.capsules?.v2 ? await this.capsules.v2.historyWithin(db,actor,parent.id) : {items:[],sourceScope:'adapter-unavailable',capabilityVerified:false};
    const ownRows = rows.filter(row => !subjectId || row.subject_id === subjectId);
    if (!ownRows.length && !reports.some(r => !subjectId || r.reportedBy === subjectId) && !linked.length) return null;
    const root = rows.find(row => ['case', 'case-created'].includes(row.kind));
    const attempts = visibleFactVersions(view.attempts), interventions = visibleFactVersions(view.interventions), results = visibleFactVersions(view.results);
    const refs = (kind, ref) => ({ attempt: attempts, intervention: interventions, result: results })[kind]?.some(f => f.id === ref.id && f.version === ref.version);
    for (const task of linked) for (const participant of task.participation) for (const delivery of participant.deliveries) {
      delivery.resultReferenceStatus = refs('result', delivery.resultRef) ? 'exact-visible-version' : 'unavailable';
      delivery.interventionReferenceStatus = delivery.interventionRefs.every(ref => refs('intervention', ref)) ? 'exact-visible-versions' : 'unavailable';
      delivery.acceptanceMeaning = 'requester-accepted-specific-delivery; not-verification-or-resolution';
      delivery.capabilityVerified = false;
      // The delivery's summary is derived from these facts. Keep a minimal
      // acceptance/version tombstone when its source is withdrawn or deleted.
      if (delivery.resultReferenceStatus === 'unavailable' || delivery.interventionReferenceStatus === 'unavailable') {
        delete delivery.summary;
        if (delivery.acceptance) delivery.acceptance = { eventId: delivery.acceptance.eventId, actorId: delivery.acceptance.actorId, at: delivery.acceptance.at };
        for (const event of participant.events) if (event.event.eventId === delivery.deliveryId || event.event.deliveryId === delivery.deliveryId)
          delete event.event.summary;
      }
    }
    const subjectRoles = new Set(linked.flatMap(t => t.subjectRoles));
    if (root && (!subjectId || root.subject_id === subjectId)) subjectRoles.add('requester');
    for (const a of attempts) if (!subjectId || a.actorId === subjectId) subjectRoles.add(a.role);
    for (const i of interventions) if (!subjectId || i.actorId === subjectId) for (const type of i.types) subjectRoles.add(type);
    if (reports.some(r => (!subjectId || r.reportedBy === subjectId) && r.type === 'verification')) subjectRoles.add('verification-reporter');
    if(capsuleReuse.items.some(item=>item.subjectId===subjectId && item.kind!=='reference' && item.record))subjectRoles.add('capsule-applicant');
    if (ownRows.length && !subjectRoles.size) subjectRoles.add('reporter; executor-unknown');
    const events = rows.map(row => ({ eventId: row.id, reportedBy: row.subject_id, recordedAt: timestamp(row.created_at), payload: historyVisibleValue(row.payload) }));
    // Raw resolution/response events duplicate derived text. The Case service
    // has already excluded each event with unavailable exact dependencies.
    const resolution = historyVisibleValue(view.resolution);
    if (resolution.resultRefs?.some(ref => !results.some(r => r.id === ref.id && r.version === ref.version && !r.supersededInVisibleHistory))) {
      resolution.currentSupport = 'referenced-result-superseded';
      resolution.currentDecisionAvailable = false;
    } else if (resolution.status !== 'unrecorded') { resolution.currentSupport = 'exact-current-visible-references'; resolution.currentDecisionAvailable = true; }
    return {
      kind: 'case-history', key: `case:${parent.id}`, caseId: parent.id, subjectId,
      title: root?.payload.title ?? null, summary: root?.payload.summary ?? null,
      requesterId: root?.subject_id ?? null, subjectRoles: [...subjectRoles].sort((left,right)=>left<right?-1:left>right?1:0),
      taskIds: [...new Set([...linked.map(t => t.taskId), ...rows.map(row => row.payload.taskId).filter(Boolean)])].sort((left,right)=>left<right?-1:left>right?1:0),
      capabilityIds: [...new Set(linked.flatMap(t => t.capabilityIds))].sort((left,right)=>left<right?-1:left>right?1:0),
      attempts, interventions, results, responses: historyVisibleValue(view.responses),
      resolutions: historyVisibleValue(view.resolutions), resolution,
      verificationRecords: historyVisibleValue(reports), proofs, collaborations: linked, events, capsuleReuse,
      legacyCorrections: events.filter(e => e.payload.kind === 'revision'),
      activityTimes: [...events.map(e => e.payload.observedAt ?? e.payload.endedAt ?? e.payload.startedAt ?? e.recordedAt),
        ...reports.map(r => r.record?.observedAt ?? r.observedAt ?? r.provenance?.recordedAt), ...linked.flatMap(t => t.activityTimes),...capsuleReuse.items.map(i=>i.recordedAt)].filter(Boolean),
      synthetic: view.synthetic, configurationMeaning: 'reported-attempt-conditions; unknown-is-not-equivalent',
      sourceScope: 'currently-authorized-facts-and-reports', capabilityVerified: false, taskOutcomeVerified: false,
    };
  }
  async queryWithin(db, actor, options) {
    // This metadata gate only avoids materializing wholly invisible candidates.
    // Task/Case locks and every final grant/dependency check remain canonical.
    const repo = historyV2Repository(db, { viewerId: actor?.subjectId ?? null,
      now: this.access.now(), endpoint: this.access.endpoint }), tasks = [], taskIds = [], items = [];
    // Acquire Task locks before any Case locks, including profiles containing
    // more than one Task for a Case. Writers use the same Task -> Case order.
    await scan(after => repo.tasks(options.subjectId, after), row => taskIds.push(row.id));
    if (taskIds.length) await db.query('SELECT id FROM task_requests WHERE id=ANY($1::uuid[]) ORDER BY id FOR SHARE', [taskIds]);
    for (const id of taskIds) {
      try { const task = await this.taskWithin(db, actor, id, options.subjectId, repo); if (task) tasks.push(task); }
      catch (error) { if (!unavailable(error)) throw error; }
    }
    const coveredTasks = new Set();
    await scan(after => repo.cases(options.subjectId, after), async parent => {
      const item = await this.caseWithin(db, actor, parent, options.subjectId, tasks, repo);
      if (item) { items.push(item); for (const task of item.collaborations) coveredTasks.add(task.taskId); }
    });
    for (const task of tasks) if (!coveredTasks.has(task.taskId)) items.push(task);
    const profile = this.profiles && options.subjectId ? await this.profiles.readWithin(db, actor, options.subjectId) : { selfDeclared: {} };
    const selected = items.filter(item => (!options.recordKind || item.kind === options.recordKind) && item.activityTimes.some(at => matchesHistoryWindow(at, options.timeWindow, this.access.now())))
      .map(item => historyRelevance(item, options)).filter(Boolean).sort((a, b) => a.key.localeCompare(b.key));
    const { after, ...query } = options, queryHash = sourceFingerprint(query), viewerId = actor?.subjectId ?? null;
    // No scanned IDs, hidden counts, global event versions, or checkedAt values
    // enter this digest. A private unrelated write cannot invalidate a cursor.
    const sourceHash = sourceFingerprint({ profile, items: selected });
    let lastKey = null;
    if (after) {
      let cursor;
      try { cursor = JSON.parse(Buffer.from(after, 'base64url').toString('utf8')); }
      catch { throw new ServiceError('invalid_history_cursor'); }
      if (cursor.v !== 2 || cursor.queryHash !== queryHash || cursor.viewerId !== viewerId || typeof cursor.lastKey !== 'string')
        throw new ServiceError('invalid_history_cursor');
      if (cursor.sourceHash !== sourceHash) throw new ServiceError('history_sources_changed_retry', 409);
      if (!selected.some(item => item.key === cursor.lastKey)) throw new ServiceError('invalid_history_cursor');
      lastKey = cursor.lastKey;
    }
    const remaining = selected.filter(item => !lastKey || item.key.localeCompare(lastKey) > 0), page = remaining.slice(0, options.limit);
    const nextCursor = remaining.length > options.limit ? Buffer.from(JSON.stringify({ v: 2, queryHash, viewerId, sourceHash, lastKey: page.at(-1).key })).toString('base64url') : null;
    return {
      schemaVersion: 2, subjectId: options.subjectId, ...profile, items: page, nextCursor,
      timeWindow: options.timeWindow, coverage: 'current-visible-page', sourceScan: options.subjectId ? 'all-candidates-for-specified-subject' : 'on-demand-current-authorized-facts; not-global-capability-ranking',
      totalVisibleCountProvided: false, globalCountProvided: false, capabilityVerified: false,
      collaborationEntry: 'open-assistance-remains-available; paid-qualification-is-separate',
      rebuild: { ruleId: 'history-facts-v2', ruleVersion: 1, sourceHash, checkedAt: new Date(this.access.now() * 1000).toISOString(),
        mode: 'on-demand', persistedProjection: false, backgroundQueue: false },
    };
  }
}
