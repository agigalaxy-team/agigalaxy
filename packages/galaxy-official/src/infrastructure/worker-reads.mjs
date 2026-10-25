// Functions are provisioned explicitly by the database owner. All calls use
// the caller's current transaction; no new connection or authorization cache.
export const workerReads = Object.freeze({
  lockMessagingPlan: (db,id,endpoint) => db.query(`SELECT p.*,v.config
    FROM public.galaxy_worker_lock_messaging_plan($1,$2) p
    JOIN public.operations_messaging_versions_v1 v ON v.plan_id=p.id AND v.version=p.version`,[id,endpoint]),
  readBuilder: (db,id) => db.query('SELECT * FROM public.galaxy_worker_lock_builder($1)',[id]),
  readCase: (db, caseId, subjectId) => db.query('SELECT * FROM public.galaxy_worker_lock_case($1,$2)', [caseId, subjectId]),
  readGrant: (db, id, subjectId, now) => db.query('SELECT * FROM public.galaxy_worker_lock_consent($1,$2,$3)',
    [id, subjectId, new Date(now * 1000).toISOString()]),
});
