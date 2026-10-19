import {randomUUID} from 'node:crypto';
import {createWorkStore, workError} from './store.mjs';
import {redactLocalWorkData} from '../local-data-redaction.mjs';
import {parseWorkInput, normalizeWorkEnvironment, workListInputSchema, workGetInputSchema, workPendingInputSchema,
  workSummaryInputSchema, workNoteInputSchema, workObservationInputSchema, workEnvironmentInputSchema, workExportInputSchema, workDeleteInputSchema} from './schema.mjs';
export * from './schema.mjs';

const one = (db, sql, ...args) => db.prepare(sql).get(...args);
const all = (db, sql, ...args) => db.prepare(sql).all(...args);
const run = (db, sql, ...args) => db.prepare(sql).run(...args);
const json = value => value == null ? null : JSON.stringify(value);
const decode = value => value == null ? null : JSON.parse(value);
const exclusionsOf = row => decode(row?.exclusions_json) || [];
const mergeExclusions = (...groups) => [...new Map(groups.flat().map(item => [`${item.path}:${item.kind}`, item])).values()];
function protectedInput(schema, input) {
  const redacted = redactLocalWorkData(parseWorkInput(schema, input)), value = redacted.value;
  if (value.title) value.title = value.title.slice(0, 180);
  if (value.summary) value.summary = value.summary.slice(0, 12000);
  if (value.content) {
    value.content.excerpt = value.content.excerpt.slice(0, 4000);
    if (value.content.retained === 'full' && redacted.exclusions.some(item => item.path.startsWith('$.content')))
      value.content.retained = 'excerpt';
  }
  return {value, exclusions: redacted.exclusions};
}
const observationsSql = 'SELECT o.*,(SELECT MAX(n.revision) FROM work_observations n WHERE n.work_id=o.work_id AND n.source_id=o.source_id) AS latest_revision FROM work_observations o';

/** Local facts and user-model summaries. No account, network or model execution. */
export function createLocalWorkHistory({dataDirectory, getIdentity, now = () => new Date().toISOString()} = {}) {
  const store = createWorkStore({dataDirectory, getIdentity});
  function find(db, owner, x) {
    if (!db) return null;
    return x.workId ? one(db, 'SELECT * FROM work_sessions WHERE owner_id=? AND id=?', owner, x.workId)
      : one(db, 'SELECT * FROM work_sessions WHERE owner_id=? AND host=? AND session_id=?', owner, x.host, x.sessionId);
  }
  const summary = (db, workId) => one(db, 'SELECT * FROM work_summaries WHERE work_id=? ORDER BY revision DESC LIMIT 1', workId);
  function workView(db, row) {
    const s = summary(db, row.id);
    const environment = one(db, 'SELECT * FROM work_environments WHERE owner_id=? AND host=? AND session_id=? ORDER BY version DESC LIMIT 1', row.owner_id, row.host, row.session_id);
    return {workId: row.id, galaxyId: row.owner_id, host: row.host, sessionId: row.session_id,
      title: s?.title || row.title || 'Recorded work', summary: s?.summary || '', outcome: s?.outcome || 'unknown',
      summaryRevision: s?.revision || 0, lastSequence: row.last_sequence, startedAt: row.started_at, updatedAt: row.updated_at,
      exclusions: exclusionsOf(s),
      processing: one(db, 'SELECT state,code,updated_at AS updatedAt FROM work_summary_state WHERE work_id=?', row.id) || {state: 'pending', code: null},
      pending: row.last_sequence > (s?.through_sequence || 0), environmentVersion: environment ? {id: environment.id, version: environment.version, observedAt: environment.observed_at} : null,
      sourceKind: s ? 'user-model' : 'host-observations', localOnly: true};
  }
  const observationView = row => ({id: row.id, sequence: row.sequence, sourceId: row.source_id, revision: row.revision, kind: row.kind,
    latestRevision:row.latest_revision??row.revision,superseded:row.latest_revision!==undefined&&row.revision<row.latest_revision,
    occurredAt: row.occurred_at, observedAt: row.observed_at, source: decode(row.source_json), content: decode(row.content_json),
    details: decode(row.details_json), exclusions: exclusionsOf(row), environmentId: row.environment_id, environmentMeaning: 'observed-at-collection', localOnly: true});
  function environmentWithin(db, owner, x) {
    const redacted = redactLocalWorkData(x.facts), facts = normalizeWorkEnvironment(redacted.value), encoded = json(facts);
    const old = one(db, 'SELECT * FROM work_environments WHERE owner_id=? AND host=? AND session_id=? ORDER BY version DESC LIMIT 1', owner, x.host, x.sessionId);
    if (old?.facts_json === encoded) {
      const exclusions = mergeExclusions(exclusionsOf(old), redacted.exclusions);
      if (json(exclusions) !== old.exclusions_json) run(db, 'UPDATE work_environments SET exclusions_json=? WHERE id=?', json(exclusions), old.id);
      return {id: old.id, version: old.version, observedAt: old.observed_at, facts, exclusions, changed: false};
    }
    const next = {id: randomUUID(), version: (old?.version || 0) + 1, observedAt: x.observedAt || now(), facts, exclusions: redacted.exclusions, changed: true};
    run(db, 'INSERT INTO work_environments(id,owner_id,host,session_id,version,observed_at,facts_json,exclusions_json) VALUES(?,?,?,?,?,?,?,?)', next.id, owner, x.host, x.sessionId, next.version, next.observedAt, encoded, json(next.exclusions));
    return next;
  }
  async function observeEnvironment(input) {
    const x = parseWorkInput(workEnvironmentInputSchema, input);
    return store.write(x.galaxyId, (db, owner) => ({galaxyId: owner, ...environmentWithin(db, owner, x)}));
  }
  // Foreground capture resumes its own window after restart. Changing the
  // controlling identity starts a new window, rather than replaying the previous
  // controller's conversation into the new identity's history.
  async function beginCapture(input) {
    const x = parseWorkInput(workEnvironmentInputSchema, {...input, facts: {}});
    return store.write(x.galaxyId, (db, owner) => {
      const prior = one(db, 'SELECT * FROM work_capture_scopes WHERE host=? AND session_id=?', x.host, x.sessionId);
      const startedAt = prior?.owner_id === owner ? prior.started_at : x.observedAt || now();
      run(db, 'INSERT INTO work_capture_scopes(host,session_id,owner_id,started_at,observed_at) VALUES(?,?,?,?,?) ON CONFLICT(host,session_id) DO UPDATE SET owner_id=excluded.owner_id,started_at=excluded.started_at,observed_at=excluded.observed_at',
        x.host, x.sessionId, owner, startedAt, now());
      run(db, 'UPDATE work_summary_state SET state=\'pending\',code=\'host_model_interrupted\',updated_at=? WHERE state=\'running\' AND work_id IN (SELECT id FROM work_sessions WHERE owner_id=? AND host=? AND session_id=?)', now(), owner, x.host, x.sessionId);
      return {galaxyId: owner, host: x.host, sessionId: x.sessionId, startedAt, resumed: prior?.owner_id === owner};
    });
  }
  async function observe(input) {
    const {value: x, exclusions} = protectedInput(workObservationInputSchema, input);
    if (Buffer.byteLength(json(x.details)) > 16384) throw workError('local_work_observation_too_large');
    return store.write(x.galaxyId, (db, owner) => {
      const observedAt = now();
      let work = find(db, owner, x);
      if (!work) {
        const workId = randomUUID();
        run(db, 'INSERT INTO work_sessions(id,owner_id,host,session_id,started_at,updated_at,title) VALUES(?,?,?,?,?,?,?)', workId, owner, x.host, x.sessionId, observedAt, observedAt, x.title || '');
        work = find(db, owner, {workId});
      }
      const environment = x.environment ? environmentWithin(db, owner, {...x, facts: x.environment})
        : one(db, 'SELECT id FROM work_environments WHERE owner_id=? AND host=? AND session_id=? ORDER BY version DESC LIMIT 1', owner, x.host, x.sessionId);
      const source = json(x.source), content = json(x.content), details = json(x.details);
      const old = one(db, 'SELECT * FROM work_observations WHERE work_id=? AND source_id=? ORDER BY revision DESC LIMIT 1', work.id, x.sourceId);
      const same = row => row && row.kind === x.kind && row.source_json === source && row.content_json === content && row.details_json === details && row.occurred_at === (x.occurredAt || null);
      if (same(old)) {
        const combined = mergeExclusions(exclusionsOf(old), exclusions);
        if (json(combined) !== old.exclusions_json) run(db, 'UPDATE work_observations SET exclusions_json=? WHERE id=?', json(combined), old.id);
        return {workId: work.id, galaxyId: owner, duplicate: true, observation: observationView({...old, exclusions_json: json(combined)})};
      }
      const revision = x.revision ?? (old ? old.revision + 1 : 0);
      const prior = one(db, 'SELECT * FROM work_observations WHERE work_id=? AND source_id=? AND revision=?', work.id, x.sourceId, revision);
      if (prior) {if (!same(prior)) throw workError('local_work_source_revision_conflict'); return {workId: work.id, galaxyId: owner, duplicate: true, observation: observationView(prior)};}
      const id = randomUUID();
      run(db, 'INSERT INTO work_observations(id,work_id,source_id,revision,kind,occurred_at,observed_at,source_json,content_json,details_json,environment_id,exclusions_json) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)',
        id, work.id, x.sourceId, revision, x.kind, x.occurredAt || null, observedAt, source, content, details, environment?.id || null, json(exclusions));
      const saved = one(db, 'SELECT * FROM work_observations WHERE id=?', id);
      const hostTitleUpdate=x.title&&x.kind==='session'&&x.source.kind==='host-event'&&x.details.event==='session-title'&&(!old||revision>=old.revision);
      run(db, 'UPDATE work_sessions SET updated_at=?, last_sequence=?, title=CASE WHEN title=\'\' OR ? THEN ? ELSE title END WHERE id=?', observedAt, saved.sequence,hostTitleUpdate?1:0, x.title || '', work.id);
      run(db, 'UPDATE work_capture_scopes SET observed_at=? WHERE host=? AND session_id=? AND owner_id=?', observedAt, x.host, x.sessionId, owner);
      return {workId: work.id, galaxyId: owner, duplicate: false, late: !!old && revision < old.revision,
        observation: observationView({...saved,latest_revision:Math.max(old?.revision??0,revision)})};
    });
  }
  async function list(input = {}) {
    const x = parseWorkInput(workListInputSchema, input);
    return store.read(x.galaxyId, (db, owner) => {
      if (!db) return {galaxyId: owner, items: [], nextAfter: null};
      const rows = all(db, 'SELECT * FROM work_sessions WHERE owner_id=? AND (? IS NULL OR host=?) AND (? IS NULL OR last_sequence<?) ORDER BY last_sequence DESC LIMIT ?',
        owner, x.host || null, x.host || null, x.after || null, x.after ? Number(x.after) : null, x.limit + 1);
      return {galaxyId: owner, items: rows.slice(0, x.limit).map(row => workView(db, row)), nextAfter: rows.length > x.limit ? String(rows[x.limit - 1].last_sequence) : null};
    });
  }
  async function get(input) {
    const x = parseWorkInput(workGetInputSchema, input);
    return store.read(x.galaxyId, (db, owner) => {
      const work = find(db, owner, x); if (!work) return null;
      const rows = all(db, observationsSql+' WHERE o.work_id=? AND o.sequence>? ORDER BY o.sequence LIMIT ?', work.id, x.afterSequence, x.limit + 1);
      return {work: workView(db, work), observations: rows.slice(0, x.limit).map(observationView), nextAfter: rows.length > x.limit ? rows[x.limit - 1].sequence : null,
        summaries: all(db, 'SELECT * FROM work_summaries WHERE work_id=? ORDER BY revision DESC LIMIT 20', work.id).map(s => ({revision: s.revision, throughSequence: s.through_sequence, title: s.title,
          summary: s.summary, outcome: s.outcome, model: s.model, execution: decode(s.execution_json), exclusions: exclusionsOf(s), createdAt: s.created_at, sourceKind: 'user-model', sourceObservationIds: decode(s.sources_json)})),
        environments: all(db, 'SELECT * FROM work_environments WHERE owner_id=? AND host=? AND session_id=? ORDER BY version', owner, work.host, work.session_id).map(e => ({id: e.id, version: e.version, observedAt: e.observed_at, facts: decode(e.facts_json), exclusions: exclusionsOf(e)}))};
    });
  }
  async function pending(input) {
    const x = parseWorkInput(workPendingInputSchema, input);
    return store.read(x.galaxyId, (db, owner) => {
      const work = find(db, owner, x); if (!work) throw workError('local_work_unavailable');
      const s = summary(db, work.id), afterSequence = s?.through_sequence || 0;
      const rows = all(db, observationsSql+' WHERE o.work_id=? AND o.sequence>? ORDER BY o.sequence LIMIT ?', work.id, afterSequence, x.limit + 1);
      const visible = rows.slice(0, x.limit);
      const environments = [...new Set(visible.map(item => item.environment_id).filter(Boolean))].map(id => one(db, 'SELECT * FROM work_environments WHERE owner_id=? AND id=?', owner, id))
        .filter(Boolean).map(e => ({id:e.id,version:e.version,observedAt:e.observed_at,facts:decode(e.facts_json),exclusions:exclusionsOf(e)}));
      return {galaxyId: owner, workId: work.id, expectedRevision: s?.revision || 0, afterSequence, throughSequence: visible.at(-1)?.sequence || afterSequence,
        observations: visible.map(observationView), environments, hasMore: rows.length > x.limit,
        processing: one(db, 'SELECT state,code,updated_at AS updatedAt FROM work_summary_state WHERE work_id=?', work.id) || {state: 'pending', code: null},
        previousSummary: s ? {title: s.title, summary: s.summary, outcome: s.outcome, exclusions: exclusionsOf(s)} : null};
    });
  }
  async function submitSummary(input) {
    const {value: x, exclusions} = protectedInput(workSummaryInputSchema, input);
    return store.write(x.galaxyId, (db, owner) => {
      const work = find(db, owner, x); if (!work) throw workError('local_work_unavailable');
      const old = summary(db, work.id);
      if ((old?.revision || 0) !== x.expectedRevision) throw workError('local_work_summary_revision_conflict');
      const after = old?.through_sequence || 0;
      if (x.throughSequence <= after || x.throughSequence > work.last_sequence) throw workError('local_work_summary_coverage_invalid');
      const covered = all(db, 'SELECT id FROM work_observations WHERE work_id=? AND sequence>? AND sequence<=?', work.id, after, x.throughSequence);
      const sources = [...new Set(x.sourceObservationIds)];
      if (!covered.length || covered.some(row => !sources.includes(row.id)) || sources.some(id => !one(db, 'SELECT id FROM work_observations WHERE id=? AND work_id=? AND sequence<=?', id, work.id, x.throughSequence)))
        throw workError('local_work_summary_sources_invalid');
      const revision = x.expectedRevision + 1, createdAt = now();
      run(db, 'INSERT INTO work_summaries(work_id,revision,through_sequence,created_at,title,summary,outcome,model,sources_json,execution_json,exclusions_json) VALUES(?,?,?,?,?,?,?,?,?,?,?)', work.id, revision, x.throughSequence, createdAt,
        x.title, x.summary, x.outcome, x.model || null, json(sources), json(x.execution), json(exclusions));
      run(db, 'INSERT INTO work_summary_state(work_id,state,code,updated_at) VALUES(?,?,NULL,?) ON CONFLICT(work_id) DO UPDATE SET state=excluded.state,code=NULL,updated_at=excluded.updated_at', work.id,
        work.last_sequence > x.throughSequence ? 'pending' : 'idle', createdAt);
      return {workId: work.id, galaxyId: owner, revision, throughSequence: x.throughSequence, createdAt, sourceKind: 'user-model', outcome: x.outcome, exclusions, localOnly: true};
    });
  }
  async function recordNote(input) {
    const x = parseWorkInput(workNoteInputSchema, input);
    return observe({galaxyId: x.galaxyId, host: x.host, sessionId: x.sessionId, sourceId: x.sourceId || randomUUID(), kind: 'claim', title: x.title,
      source: {kind: x.sourceKind}, content: {excerpt: x.text, originalLength: x.text.length, retained: 'full', availableFromHost: false}, details: {statementOnly: true}});
  }
  async function setSummaryState({galaxyId, workId, state, code = null}) {
    if (!['running', 'pending', 'failed', 'model-unavailable'].includes(state) || (code !== null && !/^[a-z0-9_]{1,120}$/.test(code))) throw workError('local_work_summary_state_invalid');
    return store.write(galaxyId, (db, owner) => {
      if (!find(db, owner, {workId})) throw workError('local_work_unavailable');
      run(db, 'INSERT INTO work_summary_state(work_id,state,code,updated_at) VALUES(?,?,?,?) ON CONFLICT(work_id) DO UPDATE SET state=excluded.state,code=excluded.code,updated_at=excluded.updated_at', workId, state, code, now());
    });
  }
  async function exportWork(input) {
    const x = parseWorkInput(workExportInputSchema, input);
    return store.read(x.galaxyId,(db,owner)=>{
      const row=find(db,owner,x);if(!row)throw workError('local_work_unavailable');
      return {format:'galaxy-local-work-v1',exportedAt:now(),work:workView(db,row),
        observations:all(db,observationsSql+' WHERE o.work_id=? ORDER BY o.sequence',row.id).map(observationView),
        summaries:all(db,'SELECT * FROM work_summaries WHERE work_id=? ORDER BY revision',row.id).map(s=>({revision:s.revision,throughSequence:s.through_sequence,
          title:s.title,summary:s.summary,outcome:s.outcome,model:s.model,execution:decode(s.execution_json),exclusions:exclusionsOf(s),sourceObservationIds:decode(s.sources_json),createdAt:s.created_at,sourceKind:'user-model'})),
        environments:all(db,'SELECT * FROM work_environments WHERE owner_id=? AND host=? AND session_id=? ORDER BY version',owner,row.host,row.session_id).map(e=>({id:e.id,version:e.version,observedAt:e.observed_at,facts:decode(e.facts_json),exclusions:exclusionsOf(e)})),
        materialScope:'retained-observations-and-summaries',completeConversation:false,localOnly:true};
    });
  }
  async function deleteWork(input) {
    const x = parseWorkInput(workDeleteInputSchema, input);
    return store.write(x.galaxyId, (db, owner) => {
      const work = find(db, owner, x); if (!work) throw workError('local_work_unavailable');
      run(db, 'DELETE FROM work_observations WHERE work_id=?', work.id);
      run(db, 'DELETE FROM work_summaries WHERE work_id=?', work.id);
      run(db, 'DELETE FROM work_summary_state WHERE work_id=?', work.id);
      run(db, 'DELETE FROM work_environments WHERE owner_id=? AND host=? AND session_id=?', owner, work.host, work.session_id);
      run(db, 'DELETE FROM work_capture_scopes WHERE owner_id=? AND host=? AND session_id=?', owner, work.host, work.session_id);
      run(db, 'DELETE FROM work_sessions WHERE owner_id=? AND id=?', owner, work.id);
      return {workId: work.id, galaxyId: owner, deleted: true, hostOriginalsAffected: false, conversationArchiveAffected: false};
    });
  }
  const identity = () => store.read(undefined, (_db, _galaxyId, currentIdentity) => currentIdentity || null);
  return Object.freeze({identity, beginCapture, observe, observeEnvironment, list, get, pending, submitSummary, setSummaryState, recordNote, exportWork, deleteWork});
}
