import { transaction } from "../infrastructure/database.mjs";
import { bindingControl, lockSubjectControl } from "../infrastructure/identity-control-repository.mjs";
import { informationScope } from './information-v2.mjs';
import { ServiceError } from "../shared/service-error.mjs";
import { lockSubjectResourceBudget, subjectResourceUsage, enforceResourceGrowth } from "../infrastructure/resource-budgets.mjs";

const iso = seconds => new Date(seconds * 1000).toISOString();
const installed = new WeakMap();
const cancellationInstalled = new WeakSet();
const unavailable = () => new ServiceError('information_watch_authorization_required', 403);

// Internal actors are capabilities held in this WeakMap, never HTTP input.
// Only current, explicitly selected watch sources can use this read delegate.
export function installInformationWatchAuthority(access) {
  if (installed.has(access)) return installed.get(access);
  const actors = new WeakMap(), ordinary = access.runAuthorized.bind(access);
  access.runAuthorized = async function (actor, scope, operation, options = {}) {
    const delegated = actor && actors.get(actor);
    if (!delegated) return ordinary(actor, scope, operation, options);
    return transaction(access.db, async db => {
      const budget = options.resourceWrite ? access.resourceBudgetPolicy : null;
      if (budget) await lockSubjectResourceBudget(db, actor.subjectId);
      await lockSubjectControl(db, actor.subjectId);
      const binding = (await db.query('SELECT * FROM bindings WHERE id=$1 AND subject_id=$2 FOR SHARE',
        [delegated.bindingId, actor.subjectId])).rows[0];
      const current = binding && await bindingControl(db, binding, { scope });
      const watch = (await db.query('SELECT * FROM information_watches_v2 WHERE id=$1 AND subject_id=$2 FOR SHARE',
        [delegated.watchId, actor.subjectId])).rows[0];
      const authority = watch?.background_authority;
      if (!current || current.revoked_at || current.audience !== access.endpoint
        || Date.parse(current.expires_at) <= access.now() * 1000
        || !watch || watch.state !== 'active' || watch.revision !== delegated.revision
        || Date.parse(watch.expires_at) <= access.now() * 1000
        || authority?.bindingId !== delegated.bindingId
        || (authority.deviceId ?? null) !== (current.control?.deviceId ?? null)
        || authority.keyId && authority.keyId !== current.control?.keyId
        || (authority.controlEpoch ?? 0) !== (current.control?.epoch ?? 0)) throw unavailable();
      const scopes = ['notifications', ...new Set(watch.plan.sources.map(s => informationScope(s.source)))];
      if (!scopes.includes(scope) || !scopes.every(s => authority.scopes.includes(s) && current.scopes.includes(s))) throw unavailable();
      // Background writes are confined to the watch's own check/receipt path.
      if (options.resourceWrite && scope !== 'notifications') throw unavailable();
      const before = budget ? await subjectResourceUsage(db, actor.subjectId, access.now()) : null;
      const result = await operation(db, { callerBindingId: binding.id, credentialScopes: Object.freeze(scopes),
        identityControl: current.control });
      if (before) enforceResourceGrowth(before, await subjectResourceUsage(db, actor.subjectId, access.now()), budget);
      return result;
    }, { isolation: options.isolation ?? 'read committed' });
  };
  const delegate = row => {
    const authority = row.background_authority;
    if (!authority?.bindingId || !Array.isArray(authority.scopes)) throw unavailable();
    const actor = Object.freeze({ subjectId: row.subject_id, bindingId: authority.bindingId,
      scopes: Object.freeze([...authority.scopes]), deviceId: authority.deviceId ?? null,
      keyId: authority.keyId ?? null, controlEpoch: authority.controlEpoch ?? 0 });
    actors.set(actor, { watchId: row.id, revision: row.revision, bindingId: authority.bindingId });
    return actor;
  };
  installed.set(access, delegate);
  return delegate;
}

// Reuses the API's actual source readers/permission checks, not an omniscient
// worker projection. It keeps working after a page closes, with no model/key.
export function createInformationWatchWorker({ services, jobs, now = services.access.now,
  retirement = services.retirement, incident = services.incident, intervalMs = 15000, onError = () => {} }) {
  const watches = services.informationWatches, db = services.access.db;
  const delegate = installInformationWatchAuthority(services.access);
  watches.jobs = jobs;
  if (!cancellationInstalled.has(jobs)) {
    jobs.onCancel('information-watch', async (tx, data) => {
      await tx.query(`UPDATE information_watches_v2 SET state='paused',revision=revision+1,
        background_state='paused',updated_at=$4 WHERE id=$1 AND subject_id=$2 AND revision=$3 AND state='active'`,
      [data.watchId, data.subjectId, data.revision, iso(now())]);
    });
    cancellationInstalled.add(jobs);
  }
  let timer = null, reconciling = null, stopped = false;
  async function execute(input, { signal } = {}) {
    signal?.throwIfAborted();
    const row = (await db.query('SELECT * FROM information_watches_v2 WHERE id=$1 AND subject_id=$2',
      [input.watchId, input.subjectId])).rows[0];
    if (!row || row.state !== 'active' || row.revision !== input.revision
      || row.check_revision !== input.checkRevision || Date.parse(row.expires_at) <= now() * 1000)
      return { state: 'superseded' };
    if (retirement && !retirement.canProcessEvidence() || incident && !incident.canProcessEvidence()) {
      await db.query("UPDATE information_watches_v2 SET next_check_at=$3,background_state='service-paused' WHERE id=$1 AND revision=$2",
        [row.id, row.revision, iso(now() + 60)]);
      return { state: 'service-paused' };
    }
    try {
      const actor = delegate(row);
      const result = await watches.check(actor, { watchId: row.id, expectedRevision: row.revision }, { signal });
      return { state: result.state, changed: result.changed === true };
    } catch (error) {
      const latest = (await db.query('SELECT revision,state,expires_at FROM information_watches_v2 WHERE id=$1', [row.id])).rows[0];
      if (!latest || latest.revision !== row.revision || latest.state !== 'active' || Date.parse(latest.expires_at) <= now() * 1000)
        return { state: 'superseded' };
      const denied = error instanceof ServiceError && [401, 403, 404, 410].includes(error.status);
      await db.query(`UPDATE information_watches_v2 SET background_state=$3,background_error=$4,
        next_check_at=$5 WHERE id=$1 AND revision=$2 AND state='active'`,
      [row.id, row.revision, denied ? 'authorization-required' : 'temporarily-unavailable',
        denied ? 'information_watch_authorization_required' : 'information_watch_check_unavailable', iso(now() + 300)]);
      if (denied) return { state: 'authorization-required' };
      throw Object.assign(new Error('information_watch_check_unavailable',{cause:error}), { code: 'information_watch_check_unavailable' });
    }
  }
  async function reconcile() {
    if (stopped) return { queued: 0 };
    if (reconciling) return reconciling;
    reconciling = transaction(db, async tx => {
      const rows = (await tx.query(`SELECT w.* FROM information_watches_v2 w
        WHERE w.state='active' AND w.expires_at>$1 AND w.background_authority IS NOT NULL
        AND w.background_state<>'authorization-required' AND (w.next_check_at IS NULL OR w.next_check_at<=$1)
        AND NOT EXISTS(SELECT 1 FROM galaxy_jobs.job j WHERE j.name='information-watch'
          AND j.state IN ('created','retry','active','cancelled') AND j.data->>'watchId'=w.id::text
          AND (j.data->>'revision')::int=w.revision AND (j.data->>'checkRevision')::int=w.check_revision)
        ORDER BY w.next_check_at NULLS FIRST,w.id LIMIT 100 FOR UPDATE OF w SKIP LOCKED`, [iso(now())])).rows;
      for (const row of rows) await watches.queueWithin(tx, row);
      return { queued: rows.length };
    }).finally(() => { reconciling = null; });
    return reconciling;
  }
  return {
    execute, reconcile,
    async start() {
      if (timer) return;
      stopped = false;
      await jobs.start();
      await jobs.work('information-watch', execute);
      await reconcile();
      timer = setInterval(() => {
        const startedAt=performance.now();
        void reconcile().catch(error=>{try{onError({code:'information_watch_schedule_unavailable',stage:'watch-reconcile',startedAt,error});}catch{}});
      }, intervalMs);
      timer.unref?.();
    },
    async stop() {
      stopped = true; clearInterval(timer); timer = null;
      await jobs.stopWork('information-watch');
      await reconciling;
    },
  };
}
