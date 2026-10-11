import { searchV2QuerySchema, searchV2ReferenceSchema } from './shared/search-v2-schema.mjs';
import { ServiceError } from './shared/service-error.mjs';
import { transaction } from './database.mjs';
import { sourceFingerprint, historyVisibleValue } from './domain/history-v2.mjs';

const unavailable = e => e instanceof ServiceError && [403, 404, 409, 422].includes(e.status);
const parse = (schema, input) => { const p = schema.safeParse(input); if (!p.success) throw new ServiceError('invalid_search_v2_query'); return p.data; };
// This service adapts one source at a time. Source combinations and semantic
// interpretation stay in the user's client/Agent; there is no cloud ranking.
export class SearchV2Service {
  constructor(access, { history, capsules, ciV2, assistance, discovery, legacy }) {
    Object.assign(this, { access, history, capsules, ciV2, assistance, discovery, legacy });
  }
  async query(actor, input) {
    const { type, query } = parse(searchV2QuerySchema, input);
    if (type === 'worker' || type === 'hub') {
      const page = await this.legacy.query(actor, { type, query });
      return this.page(type, page.items.map(item => this.item(type, item.id, item.title, item.summary, item.record,
        item.matchReasons, item.limitations, 'owner-declaration', item.source)), page.nextCursor, { windowLimited: page.windowLimited, sourceVersion: 1 });
    }
    if (type === 'history' || type === 'case') {
      const read = db => this.history.queryWithin(db, actor, { ...query, subjectId: query.subjectId ?? null,
        ...(type === 'case' ? { recordKind: 'case-history' } : {}) });
      const page = actor ? await this.access.runAuthorized(actor, 'history', read) : await transaction(this.access.db, read);
      return this.page(type, page.items.map(record => this.item(type, record.caseId ?? record.taskId,
        record.title ?? '授权工作事实', record.summary ?? '', record, record.matchReasons,
        ['Only currently authorized facts; private and unavailable sources are excluded.',
          'Attempt, failure, diagnosis, partial work, acceptance and verification retain separate meanings.',
          'No current willingness, expertise or success probability is inferred.'],
        'source-authored-events-and-current-dependent-reports', { key: record.key, projectionRule: page.rebuild.ruleId,
          subjectId: query.subjectId ?? null }, sourceFingerprint(record))), page.nextCursor,
      { sourceScan: page.sourceScan, sourceVersion: 2, windowLimited: false });
    }
    if (type === 'capsule') {
      const page = await this.capsules.query(actor, query);
      return this.page(type, page.items.map(record => this.item(type, record.capsuleId, record.title, record.problemPattern,
        record, [{ kind: 'current-title-or-problem-field', query: query.query }],
        ['Reading is not application or successful reuse.', 'Check current version, license, required tools and notices before applying.'],
        'author-published-method-with-current-source-permissions', { id: record.capsuleId, versionId: record.versionId, version: record.sourceVersion })),
      page.nextAfter, { sourceVersion: 2, windowLimited: false });
    }
    if (type === 'task') {
      const page = actor ? await this.assistance.queryTasks(actor, query) : await this.assistance.queryPublicTasks(query);
      return this.page(type, page.items.map(record => this.item(type, record.taskId, record.request.title, record.request.summary,
        (({version: _aggregateVersion, ...visible}) => visible)(record), [{ kind: 'current-visible-task-title-or-summary', query: query.query }],
        ['A published request is not performed work, an application, a contract or an accepted result.',
          'Open assistance remains available to new participants without previous history.'], 'requester-declaration-and-current-task-state',
        { taskId: record.taskId, operationId: record.request.operationId })), page.nextAfter, { sourceVersion: 2, windowLimited: false });
    }
    if (type === 'opportunity') {
      const page = await this.discovery.query(actor, query);
      return this.page(type, page.items.map(record => this.item(type, record.id, record.project.title, record.project.summary,
        record, record.match, ['Self-declared functions and expressed willingness; not a proven capability or sent invitation.',
          'Same functionality can use different technologies; ordinary conversation does not require a failed Case.'],
        'current-declaration-and-expressed-preference', record.opportunityRef)), page.nextAfter,
      { ...page.coverage, enabled: page.enabled, disabledReason: page.disabledReason, sourceVersion: 2 });
    }
    const read = db => this.proofsWithin(db, actor, query);
    return actor ? this.access.runAuthorized(actor, 'proof', read) : transaction(this.access.db, read);
  }
  item(type, id, title, summary, record, matchReasons, limitations, authority, source, version = null) {
    const value = historyVisibleValue(record);
    // Projection version is a digest of permitted content, not a global event
    // counter. Hidden writes cannot be inferred through its changing number.
    const sourceVersion = version ?? sourceFingerprint({ record: value, source });
    return { type, id, title, summary, sourceVersion, ref: { id, version: sourceVersion }, source,
      ...(record.textView?{textView:record.textView}:{}),
      record: value, recordKind: value.kind ?? type, authority, matchReasons, limitations,
      sourceStatus: 'current-readable', capabilityVerified: false, selected: false, applied: false };
  }
  page(type, items, nextCursor, coverage) {
    return { schemaVersion: 2, type, items, nextCursor: nextCursor ?? null, coverage,
      sourceState: coverage.enabled === false ? 'disabled' : items.length ? 'available' : 'no-visible-match-in-this-page',
      countsScope: 'visible-page-only', pageCount: items.length, globalCountProvided: false,
      checkedAt: this.access.now(), order: type === 'opportunity' ? 'source-functional-match-within-window' : 'stable-source-id',
      interpretation: 'user-or-user-agent', cacheable: false, capabilityVerified: false,
      emptyMeaning: 'No matching currently readable item in this page; not proof that no suitable help exists.',
      helpPaths: ['continue-current-ai', 'capsule-or-history', 'open-assistance', 'bounty-or-expert-assistance'] };
  }
  async proofsWithin(db, actor, query) {
    let after = query.after ?? null; const items = [], terms = query.query.toLowerCase().split(/\s+/).filter(Boolean);
    for (;;) {
      const rows = (await db.query(`SELECT id FROM ci_proofs_v2 WHERE ($1::uuid IS NULL OR id>$1)
        AND ($2::text IS NULL OR subject_id=$2) ORDER BY id LIMIT 100`, [after, query.subjectId ?? null])).rows;
      for (const row of rows) {
        try {
          const record = await this.ciV2.proofWithin(db, actor, row.id), data = record.data;
          const fields = { repository: `${data.source.owner}/${data.source.repository}`, commit: data.source.commit,
            conclusion: data.conclusion, runId: String(data.source.runId), scope: data.scope };
          const matches = terms.map(term => ({ term, fields: Object.keys(fields).filter(key => String(fields[key]).toLowerCase().includes(term)) }));
          if (matches.some(m => !m.fields.length) || query.conclusion && data.conclusion !== query.conclusion) continue;
          items.push(this.item('proof', row.id, `${fields.repository} · run ${fields.runId}`, data.conclusion, record, matches,
            data.limitations, 'repository-controlled-ci-observation; not-independent-expertise', { id: row.id, schemaVersion: 2 }));
          if (items.length > query.limit) break;
        } catch (error) { if (!unavailable(error)) throw error; }
      }
      if (items.length > query.limit || rows.length < 100) break;
      after = rows.at(-1).id;
    }
    return this.page('proof', items.slice(0, query.limit), items.length > query.limit ? items[query.limit - 1].id : null,
      { sourceVersion: 2, windowLimited: false, legacyProofs: '/v1/search/query type=proof' });
  }
  async reference(actor, input) {
    const { search, ref } = parse(searchV2ReferenceSchema, input);
    // Replay the original bounded query with the original viewer. No author's
    // identity substitution and no stored snippet can restore revoked access.
    let query = { ...search.query, after: undefined }; const cursors = new Set();
    for (;;) {
      const page = await this.query(actor, { type: search.type, query });
      const item = page.items.find(value => value.id === ref.id);
      if (item) return { schemaVersion: 2, ref, state: item.sourceVersion === ref.version ? 'current' : 'changed', item,
        priorRationaleCurrent: item.sourceVersion === ref.version, checkedAt: this.access.now() };
      if (!page.nextCursor) return { schemaVersion: 2, ref, state: 'unavailable-in-current-query', item: null,
        priorRationaleCurrent: false, checkedAt: this.access.now() };
      if (cursors.has(page.nextCursor)) throw new ServiceError('search_source_cursor_loop', 503);
      cursors.add(page.nextCursor); query = { ...query, after: page.nextCursor };
    }
  }
}
