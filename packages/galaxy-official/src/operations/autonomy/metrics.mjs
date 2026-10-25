/** The API exporter is a process independent from the duty worker and models.
 * It reads metadata aggregates only. Prometheus owns elapsed-time evaluation. */
export function createAutonomyMetrics({db,gauge,now}){
 const available=gauge('autonomy_collection_success','Independent autonomy metadata query succeeded');
 const enabled=gauge('autonomy_enabled_accounts','Explicitly enabled duty plans');
 const health=gauge('autonomy_worker_health_available','Enabled endpoints with a recorded scheduler heartbeat are all observed');
 const age=gauge('autonomy_worker_tick_age_seconds','Oldest recorded duty scheduler heartbeat age for enabled endpoints');
 const limit=gauge('autonomy_worker_tick_limit_seconds','Current duty health and start grace allowance');
 const late=gauge('autonomy_overdue_start_tasks','Persisted duty intents overdue beyond their frozen start grace');
 const stalled=gauge('autonomy_overdue_round_tasks','Original dispatched duty tasks beyond their frozen round limit');
 const metrics=[enabled,health,age,limit,late,stalled];available.remove();for(const metric of metrics)metric.remove();
 return async function refreshAutonomyMetrics(){
  try{
   const row=(await db.query(`WITH settings AS (
    SELECT c.endpoint,count(*)::int AS enabled,
     COALESCE((r.configuration->>'healthSeconds')::int,30)+COALESCE((r.configuration->>'startGraceSeconds')::int,120) AS tolerance
    FROM operations_autonomy_configs_v1 c LEFT JOIN operations_autonomy_runtime_v1 r ON r.endpoint=c.endpoint WHERE c.enabled GROUP BY c.endpoint,r.configuration
   ) SELECT COALESCE(sum(s.enabled),0)::int AS enabled,count(h.endpoint)=count(s.endpoint) AS health_available,
    max(extract(epoch FROM ($1::timestamptz-h.checked_at))) AS tick_age,COALESCE(min(s.tolerance),150)::int AS tick_limit,
    (SELECT count(*)::int FROM operations_autonomy_tasks_v1 t WHERE source<>'workbench' AND state='queued' AND human_decision IS NULL
      AND due_at+COALESCE((configuration#>>'{runtime,startGraceSeconds}')::int,120)*interval '1 second'<$1) AS late,
    (SELECT count(*)::int FROM operations_autonomy_tasks_v1 t WHERE source<>'workbench' AND state IN ('running','unknown') AND human_decision IS NULL
      AND dispatch_started_at+COALESCE((configuration#>>'{runtime,roundSeconds}')::int,600)*interval '1 second'<$1) AS stalled
    FROM settings s LEFT JOIN operations_autonomy_health_v1 h ON h.endpoint=s.endpoint`,[new Date(now()).toISOString()])).rows[0];
   if(!row||![row.enabled,row.tick_limit,row.late,row.stalled].every(value=>Number.isFinite(Number(value))&&Number(value)>=0))throw Error('Invalid autonomy metadata aggregate');
   available.set(1);enabled.set(Number(row.enabled));health.set(row.health_available?1:0);limit.set(Number(row.tick_limit));late.set(Number(row.late));stalled.set(Number(row.stalled));
   if(row.tick_age===null)age.remove();else age.set(Math.max(0,Number(row.tick_age)));
  }catch{available.set(0);for(const metric of metrics)metric.remove();}
 };
}
