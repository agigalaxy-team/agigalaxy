package workerconfig

import (
	"context"
	"encoding/json"
	"github.com/agigalaxy-team/agigalaxy/go/internal/databaseschema"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/jobs"
	"github.com/agigalaxy-team/agigalaxy/go/internal/testsupport"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
	"time"
)

// One combined handoff fixture. Current Go migrations create the pg-boss
// schema; the real PgBoss sends both selected jobs and actually forwards
// the recurring minute. No application worker, model, SMTP or publisher runs.
func TestLegacyPendingAdoptionAndRecurringSlotHandoff(t *testing.T) {
	pool, dsn := testsupport.PostgreSQL(t)
	ctx, cancel := context.WithTimeout(context.Background(), 100*time.Second)
	defer cancel()
	if _, e := databaseschema.Migrate(ctx, pool, nil); e != nil {
		t.Fatal(e)
	}
	root, _ := filepath.Abs("../../..")
	script := `import {createRequire} from 'node:module';
const require=createRequire(import.meta.url),pg=require('pg'),{PgBoss}=require('pg-boss');
import {randomUUID} from 'node:crypto';
const url=new URL(process.env.GALAXY_GO_TEST_DATABASE_URL);if(url.hostname!=='127.0.0.1'||!/^\/galaxy_go_test_[a-z0-9_]+$/.test(url.pathname))throw Error('isolated database required');
const db=new pg.Pool({connectionString:url.href,max:4}),endpoint='https://adoption.example.invalid',runId=randomUUID(),planId=randomUUID(),operator='isolated-adoption';
let boss;const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
try{
 await db.query("INSERT INTO operations_operator_principals_v1(operator_id,endpoint,issuer,external_subject,display_name,created_at,updated_at) VALUES($1,$2,'https://issuer.invalid',$1,'Isolated handoff metadata',now(),now())",[operator,endpoint]);
 await db.query("INSERT INTO operations_retention_runs_v1(id,endpoint,target,state,requested_by,request_actor,created_at,updated_at) VALUES($1,$2,'data-exports','queued',$3,$4,now(),now())",[runId,endpoint,operator,{kind:'business-operator',endpoint,operatorId:operator,role:'administrator'}]);
 const config={channels:['inapp'],content:{purpose:'service-update',title:'Isolated handoff',body:'No delivery consumer is started',expiresAt:new Date(Date.now()+3600000).toISOString()},audience:{kind:'attributes',subjectTypes:['person']},schedule:{kind:'recurring',cron:'* * * * * *',timezone:'UTC'}};
 await db.query("INSERT INTO operations_messaging_plans_v1(id,endpoint,version,revision,state,created_by,updated_by,approved_by,approved_role,approved_at,created_at,updated_at) VALUES($1,$2,1,1,'active',$3,$3,$3,'administrator',now(),now(),now())",[planId,endpoint,operator]);
 await db.query("INSERT INTO operations_messaging_versions_v1(plan_id,version,config,created_by,created_at) VALUES($1,1,$2,$3,now())",[planId,config,operator]);
 // Avoid crossing a minute while the small Go transaction assertions run.
 const remaining=60000-Date.now()%60000;if(remaining<20000)await delay(remaining+100);
 boss=new PgBoss({db:{executeSql:(text,values)=>db.query(text,values)},schema:'galaxy_jobs',migrate:false,createSchema:false,schedule:true,supervise:false,cronMonitorIntervalSeconds:1,registerInstance:false,persistQueueStats:false,persistWarnings:false});
 await boss.start();
 const selectedId=await boss.send('retention-cleanup',{runId},{singletonKey:'retention:'+runId});
 await db.query('UPDATE operations_retention_runs_v1 SET job_id=$2 WHERE id=$1',[runId,selectedId]);
 const activeId=await boss.send('retention-cleanup',{runId},{singletonKey:'controlled-active:'+runId});
 await db.query("UPDATE galaxy_jobs.job SET state='active',started_on=now() WHERE id=$1",[activeId]);
 const key=planId,businessKey='messaging:'+planId;
 // Preserve the real legacy defect: its business-derived colon key is passed
 // unchanged and is rejected. The next definition is a controlled, valid-key
 // legacy record through the same real scheduler, not a successful old plan flow.
 let legacyColonRejected=false;
 try{await boss.schedule('messaging-run','* * * * * *',{planId,planVersion:1},{key:businessKey,tz:'UTC',missed:'skip'});}
 catch(error){if(error.code!=='ERR_ASSERTION')throw error;legacyColonRejected=true;}
 if(!legacyColonRejected)throw Error('expected legacy colon key rejection was not observed');
 await boss.schedule('messaging-run','* * * * * *',{planId,planVersion:1},{key,tz:'UTC',missed:'skip'});
 let fired;const deadline=Date.now()+15000;
 while(Date.now()<deadline){
  fired=(await db.query("SELECT j.id AS job_id,to_char(f.singleton_on,'YYYY-MM-DD HH24:MI:SS') AS slot FROM galaxy_jobs.schedule s JOIN galaxy_jobs.job j ON j.id=s.last_job_id JOIN galaxy_jobs.job f ON f.name='__pgboss__send-it' AND f.data->>'name'=s.name AND f.data->>'key'=s.key AND f.state='completed' WHERE s.name='messaging-run' AND s.key=$1 ORDER BY f.singleton_on DESC LIMIT 1",[key])).rows[0];
  if(fired)break;await delay(50);
 }
 if(!fired)throw Error('original scheduler did not forward its minute');
 await boss.stop({graceful:true,timeout:5000});boss=null;
 console.log(JSON.stringify({endpoint,runId,planId,selectedId,activeId,messageId:fired.job_id,slot:fired.slot,key:businessKey,legacyKey:key,legacyColonRejected}));
}finally{if(boss)await boss.stop({graceful:true,timeout:5000});await db.end();}`
	command := exec.CommandContext(ctx, "node", "--no-warnings", "--input-type=module", "-e", script)
	command.Dir = root
	command.Env = append(os.Environ(), "GALAXY_GO_TEST_DATABASE_URL="+dsn)
	raw, e := command.CombinedOutput()
	if e != nil {
		t.Fatalf("original migration/PgBoss fixture: %v %s", e, raw)
	}
	var fixture struct {
		Endpoint, RunID, PlanID, SelectedID, ActiveID, MessageID, Slot, Key, LegacyKey string
		LegacyColonRejected                                                            bool
	}
	if e = json.Unmarshal(raw, &fixture); e != nil {
		t.Fatal(e, string(raw))
	}
	if !fixture.LegacyColonRejected {
		t.Fatal("legacy invalid-key failure was hidden")
	}
	tx, e := pool.Begin(ctx)
	if e != nil {
		t.Fatal(e)
	}
	defer tx.Rollback(context.Background())
	if e = jobs.MigrateWithin(ctx, pool, tx); e != nil {
		t.Fatal(e)
	}
	if _, e = tx.Exec(ctx, "INSERT INTO galaxy_go_jobs.control_v1(endpoint,backend) VALUES($1,'disabled')", fixture.Endpoint); e != nil {
		t.Fatal(e)
	}
	if e = tx.Commit(ctx); e != nil {
		t.Fatal(e)
	}
	q, e := jobs.New(pool, nil)
	if e != nil {
		t.Fatal(e)
	}
	selected := []string{fixture.SelectedID, fixture.MessageID}
	tx, e = pool.Begin(ctx)
	if e != nil {
		t.Fatal(e)
	}
	if _, e = q.AdoptPendingWithin(ctx, tx, fixture.Endpoint, selected, VerifyLegacyPendingSourceWithin); e != nil {
		tx.Rollback(ctx)
		t.Fatal(e)
	}
	if e = tx.Rollback(ctx); e != nil {
		t.Fatal(e)
	}
	var state string
	var count int
	if e = pool.QueryRow(ctx, "SELECT state::text FROM galaxy_jobs.job WHERE id=$1", fixture.SelectedID).Scan(&state); e != nil || state != "created" {
		t.Fatal("rollback consumed old UUID", state, e)
	}
	if e = pool.QueryRow(ctx, "SELECT count(*) FROM galaxy_go_jobs.executions_v1").Scan(&count); e != nil || count != 0 {
		t.Fatal("rollback left River mapping", count, e)
	}
	tx, e = pool.Begin(ctx)
	if e != nil {
		t.Fatal(e)
	}
	adopted, e := q.AdoptPendingWithin(ctx, tx, fixture.Endpoint, selected, VerifyLegacyPendingSourceWithin)
	if e != nil {
		tx.Rollback(ctx)
		t.Fatal(e)
	}
	if adopted["gateChanged"] != false {
		t.Fatal("handoff changed gate", adopted)
	}
	if e = tx.Commit(ctx); e != nil {
		t.Fatal(e)
	}
	v, e := q.Get(ctx, fixture.Endpoint, fixture.SelectedID)
	if e != nil || v.ID != fixture.SelectedID || v.SourceID != fixture.RunID || v.OperationID == nil || *v.OperationID != fixture.RunID || v.ID == v.SourceID {
		t.Fatal("original queue/business IDs changed", v, e)
	}
	tx, e = pool.Begin(ctx)
	if e != nil {
		t.Fatal(e)
	}
	replay, e := q.AdoptPendingWithin(ctx, tx, fixture.Endpoint, selected, VerifyLegacyPendingSourceWithin)
	if e != nil {
		tx.Rollback(ctx)
		t.Fatal(e)
	}
	for _, item := range replay["items"].([]any) {
		if item.(map[string]any)["replayed"] != true {
			t.Fatal("handoff replay dispatched", replay)
		}
	}
	if e = tx.Commit(ctx); e != nil {
		t.Fatal(e)
	}
	tx, e = pool.Begin(ctx)
	if e != nil {
		t.Fatal(e)
	}
	if _, e = q.AdoptPendingWithin(ctx, tx, fixture.Endpoint, []string{fixture.ActiveID}, VerifyLegacyPendingSourceWithin); fault.Code(e) != "operations_job_adoption_not_unclaimed" {
		tx.Rollback(ctx)
		t.Fatal("active old job imported", e)
	}
	tx.Rollback(ctx)
	schedule := &jobs.ScheduleQueue{Pool: pool, Queue: q, Endpoint: fixture.Endpoint}
	tx, e = pool.Begin(ctx)
	if e != nil {
		t.Fatal(e)
	}
	moved, e := schedule.AdoptLegacyRecurringWithin(ctx, tx, fixture.Key, VerifyLegacyRecurringSourceWithin)
	if e != nil {
		tx.Rollback(ctx)
		t.Fatal(e)
	}
	if moved["oldMinuteSuppressed"] != true || moved["legacyKey"] != fixture.LegacyKey {
		tx.Rollback(ctx)
		t.Fatal("actual old slot not retained", moved)
	}
	if e = tx.Commit(ctx); e != nil {
		t.Fatal(e)
	}
	var before, after time.Time
	if e = pool.QueryRow(ctx, "SELECT next_at FROM galaxy_go_jobs.schedules_v1 WHERE key=$1", fixture.Key).Scan(&before); e != nil {
		t.Fatal(e)
	}
	slot, e := time.ParseInLocation("2006-01-02 15:04:05", fixture.Slot, time.UTC)
	if e != nil || before.Before(slot.Add(time.Minute)) {
		t.Fatal("forwarded minute eligible again", before, fixture.Slot, e)
	}
	tx, e = pool.Begin(ctx)
	if e != nil {
		t.Fatal(e)
	}
	if _, e = schedule.AdoptLegacyRecurringWithin(ctx, tx, fixture.Key, VerifyLegacyRecurringSourceWithin); e != nil {
		tx.Rollback(ctx)
		t.Fatal(e)
	}
	if e = tx.Commit(ctx); e != nil {
		t.Fatal(e)
	}
	if e = pool.QueryRow(ctx, "SELECT next_at FROM galaxy_go_jobs.schedules_v1 WHERE key=$1", fixture.Key).Scan(&after); e != nil || !after.Equal(before) {
		t.Fatal("schedule replay reset next slot", before, after, e)
	}
	if _, e = pool.Exec(ctx, "UPDATE galaxy_go_jobs.control_v1 SET backend='river' WHERE endpoint=$1", fixture.Endpoint); e != nil {
		t.Fatal(e)
	}
	if n, e := schedule.Tick(ctx, 1); e != nil || n != 0 {
		t.Fatal("same minute scheduled again", n, e)
	}
	if e = pool.QueryRow(ctx, "SELECT count(*) FROM galaxy_go_jobs.executions_v1").Scan(&count); e != nil || count != 2 {
		t.Fatal("duplicate transport created", count, e)
	}
	// No Work callback or q.Start exists in this fixture: these are transport and
	// original-slot assertions, never claims of publication/mail/business success.
}
