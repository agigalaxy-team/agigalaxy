package operationsautonomy

import (
	"context"
	"fmt"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/postgres"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"sync"
	"time"
)

type Worker struct {
	Service *Service
	owner   string
	mu      sync.Mutex
}

func NewWorker(s *Service) *Worker { return &Worker{Service: s, owner: uuid.NewString()} }
func (w *Worker) ownerID() string {
	w.mu.Lock()
	defer w.mu.Unlock()
	if w.owner == "" {
		w.owner = uuid.NewString()
	}
	return w.owner
}
func (s *Service) log(o Object) {
	if s.Log != nil {
		s.Log(o)
	}
}
func (w *Worker) Execute(ctx context.Context, input Object) (Object, error) {
	s := w.Service
	if str(input["taskId"]) == "" {
		return Object{"state": "invalid"}, nil
	}
	type claimed struct {
		row             Object
		skip, reconcile bool
	}
	saved, e := postgres.InTx(ctx, s.Pool, func(tx pgx.Tx) (claimed, error) {
		if _, e := tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended($1,734912483))`, s.Endpoint); e != nil {
			return claimed{}, e
		}
		reference, e := s.taskWithin(ctx, tx, str(input["taskId"]), "")
		if e != nil {
			return claimed{}, e
		}
		if _, e = s.configWithin(ctx, tx, str(reference["domain"]), " FOR SHARE"); e != nil {
			return claimed{}, e
		}
		row, e := s.taskWithin(ctx, tx, str(input["taskId"]), " FOR UPDATE")
		if e != nil {
			return claimed{}, e
		}
		if row["source"] == "workbench" || has(terminal, str(row["state"])) || has([]string{"paused", "waiting-human"}, str(row["state"])) {
			return claimed{row: row, skip: true}, nil
		}
		if row["dispatch_started_at"] != nil {
			return claimed{row: row, reconcile: true}, nil
		}
		cfg, e := s.configWithin(ctx, tx, str(row["domain"]), "")
		if e != nil {
			return claimed{}, e
		}
		if cfg["enabled"] != true {
			if _, e = tx.Exec(ctx, `UPDATE operations_autonomy_tasks_v1 SET state='paused',code='plan-disabled',revision=revision+1,updated_at=$3 WHERE endpoint=$1 AND id=$2`, s.Endpoint, row["id"], s.now()); e != nil {
				return claimed{}, e
			}
			return claimed{row: row, skip: true}, nil
		}
		settings, e := s.refreshSettingsWithin(ctx, tx)
		if e != nil {
			return claimed{}, e
		}
		var concurrent int
		var same bool
		if e = tx.QueryRow(ctx, `SELECT count(*)::int FROM operations_autonomy_tasks_v1 WHERE endpoint=$1 AND state IN ('running','unknown') AND source<>'workbench' AND dispatch_started_at IS NOT NULL AND id<>$2`, s.Endpoint, row["id"]).Scan(&concurrent); e != nil {
			return claimed{}, e
		}
		if e = tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM operations_autonomy_tasks_v1 WHERE endpoint=$1 AND domain=$2 AND state IN ('running','unknown') AND id<>$3 AND source<>'workbench' AND dispatch_started_at IS NOT NULL)`, s.Endpoint, row["domain"], row["id"]).Scan(&same); e != nil {
			return claimed{}, e
		}
		if int64(concurrent) >= num(settings["concurrency"]) || same {
			return claimed{row: row, skip: true}, nil
		}
		state := "running"
		if row["mode"] == "human-ai" {
			state = "waiting-human"
		}
		round := obj(obj(row["configuration"])["runtime"])["roundSeconds"]
		if round == nil {
			round = settings["roundSeconds"]
		}
		current, e := one(ctx, tx, `UPDATE operations_autonomy_tasks_v1 SET state=$3,started_at=$4,lease_owner=$5,lease_until=$6,revision=revision+1,updated_at=$4 WHERE endpoint=$1 AND id=$2 RETURNING to_jsonb(operations_autonomy_tasks_v1)`, s.Endpoint, row["id"], state, s.now(), w.ownerID(), s.now().Add(time.Duration(num(round))*time.Second))
		if e != nil {
			return claimed{}, e
		}
		if state == "waiting-human" {
			return claimed{row: current, skip: true}, nil
		}
		if _, e = s.DutyForTaskWithin(ctx, tx, str(current["id"]), "query"); e != nil {
			code := errorCode(e)
			if _, save := tx.Exec(ctx, `UPDATE operations_autonomy_tasks_v1 SET state='blocked',code=$3,lease_until=NULL,updated_at=$4 WHERE endpoint=$1 AND id=$2`, s.Endpoint, row["id"], code, s.now()); save != nil {
				return claimed{}, save
			}
			return claimed{row: current, skip: true}, nil
		}
		if _, e = tx.Exec(ctx, `UPDATE operations_autonomy_tasks_v1 SET dispatch_started_at=$3,model_state=CASE WHEN mode='code' THEN 'not-required' ELSE 'dispatching' END WHERE endpoint=$1 AND id=$2`, s.Endpoint, row["id"], s.now()); e != nil {
			return claimed{}, e
		}
		current["dispatch_started_at"] = s.now()
		return claimed{row: current}, nil
	})
	if e != nil {
		return nil, e
	}
	if saved.skip {
		return Object{"state": saved.row["state"]}, nil
	}
	if saved.reconcile {
		return w.Reconcile(ctx, saved.row)
	}
	row := saved.row
	if row["mode"] == "code" {
		var result Object
		if s.CodeRunner != nil {
			result, e = s.CodeRunner(ctx, str(row["id"]))
		} else {
			result, e = s.RunCodeTask(ctx, Object{"taskId": row["id"]})
		}
		if e == nil {
			return Object{"state": result["state"]}, nil
		}
		_, save := s.Pool.Exec(ctx, `UPDATE operations_autonomy_tasks_v1 SET state='unknown',code=$3,updated_at=$4 WHERE endpoint=$1 AND id=$2`, s.Endpoint, row["id"], errorCode(e), s.now())
		return Object{"state": "unknown"}, save
	}
	var value Object
	if s.Native == nil {
		e = fault.New("operations_agentos_not_configured", 503)
	} else {
		value, e = s.Native.Run(ctx, row)
	}
	if e == nil {
		report := Object{"taskId": row["id"], "modelState": value["modelState"], "status": "running"}
		if report["modelState"] == nil {
			report["modelState"] = "accepted"
		}
		runID := value["nativeRunId"]
		if runID == nil {
			runID = value["runId"]
		}
		if str(runID) != "" {
			report["nativeRunId"] = runID
		}
		if value["awaitingHuman"] == true {
			report["status"] = "waiting-human"
		}
		return s.Report(ctx, report)
	}
	_, save := s.Pool.Exec(ctx, `UPDATE operations_autonomy_tasks_v1 SET state='unknown',model_state='unknown',code=$3,revision=revision+1,updated_at=$4 WHERE endpoint=$1 AND id=$2 AND state='running'`, s.Endpoint, row["id"], errorCode(e), s.now())
	return Object{"state": "unknown"}, save
}
func (w *Worker) Reconcile(ctx context.Context, row Object) (Object, error) {
	s := w.Service
	var value Object
	var e error
	if s.Native == nil {
		e = fault.New("operations_agentos_not_configured", 503)
	} else {
		value, e = s.Native.Read(ctx, row)
	}
	if e != nil {
		s.log(Object{"event": "autonomy_reconcile_deferred", "taskId": row["id"], "code": errorCode(e)})
		return Object{"state": "unknown"}, nil
	}
	runID := value["nativeRunId"]
	if runID == nil {
		runID = value["runId"]
	}
	if value["status"] == "NOT_RECORDED" || str(row["native_run_id"]) != "" && str(runID) != "" && row["native_run_id"] != runID {
		return Object{"state": "unknown"}, nil
	}
	if _, e = s.Pool.Exec(ctx, `UPDATE operations_autonomy_tasks_v1 SET native_continuable=$3,native_run_id=COALESCE(native_run_id,$4) WHERE endpoint=$1 AND id=$2`, s.Endpoint, row["id"], value["continuable"] == true, runID); e != nil {
		return nil, e
	}
	status := "running"
	switch {
	case value["awaitingHuman"] == true || value["status"] == "PAUSED":
		status = "waiting-human"
	case value["status"] == "COMPLETED":
		status = "completed"
	case value["status"] == "ERROR" || value["status"] == "CANCELLED":
		status = "failed"
	default:
		lease, _ := time.Parse(time.RFC3339Nano, str(row["lease_until"]))
		if row["lease_until"] != nil && !lease.After(s.now()) {
			status = "unknown"
		}
	}
	if run := obj(value["run"]); run != nil && str(runID) != "" {
		tokens := obj(run["tokens"])
		usage := Object{"calls": finite(run["calls"]), "inputTokens": finite(tokens["input"]), "outputTokens": finite(tokens["output"]), "totalTokens": finite(tokens["total"]), "durationMs": finite(run["durationMs"])}
		if _, e = postgres.InTx(ctx, s.Pool, func(tx pgx.Tx) (bool, error) {
			if _, e := tx.Exec(ctx, `UPDATE operations_autonomy_tasks_v1 SET primary_model_usage=$3 WHERE endpoint=$1 AND id=$2`, s.Endpoint, row["id"], jsonText(usage)); e != nil {
				return false, e
			}
			_, e := s.refreshUsageWithin(ctx, tx, str(row["id"]))
			return true, e
		}); e != nil {
			return nil, e
		}
	}
	report := Object{"taskId": row["id"], "modelState": value["modelState"], "status": status}
	if report["modelState"] == nil {
		report["modelState"] = "unknown"
	}
	if str(runID) != "" {
		report["nativeRunId"] = runID
	}
	return s.Report(ctx, report)
}
func (w *Worker) Tick(ctx context.Context) (Object, error) {
	s := w.Service
	if s.EnqueueWithin == nil {
		return nil, fault.New("operations_autonomy_unavailable", 503)
	}
	_, e := postgres.InTx(ctx, s.Pool, func(tx pgx.Tx) (bool, error) {
		if _, e := tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended($1,734912482))`, s.Endpoint); e != nil {
			return false, e
		}
		at := s.now()
		if _, e := tx.Exec(ctx, `INSERT INTO operations_autonomy_health_v1(endpoint,started_at,checked_at,last_tick_at) VALUES($1,$2,$2,$2) ON CONFLICT(endpoint) DO UPDATE SET checked_at=EXCLUDED.checked_at,last_tick_at=EXCLUDED.last_tick_at`, s.Endpoint, at); e != nil {
			return false, e
		}
		if e := s.EnsureWithin(ctx, tx); e != nil {
			return false, e
		}
		configs, e := many(ctx, tx, `SELECT to_jsonb(c) FROM operations_autonomy_configs_v1 c WHERE endpoint=$1 AND enabled ORDER BY domain FOR UPDATE`, s.Endpoint)
		if e != nil {
			return false, e
		}
		if e = s.scheduleStrategiesWithin(ctx, tx, configs); e != nil {
			return false, e
		}
		for _, cfg := range configs {
			var busy bool
			if e := tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM operations_autonomy_tasks_v1 WHERE endpoint=$1 AND domain=$2 AND source<>'workbench' AND state IN ('queued','running','unknown'))`, s.Endpoint, cfg["domain"]).Scan(&busy); e != nil {
				return false, e
			}
			due, _ := time.Parse(time.RFC3339Nano, str(cfg["next_due_at"]))
			if cfg["next_due_at"] != nil && !due.After(at) && !busy {
				if _, e = s.createTaskWithin(ctx, tx, cfg, TaskInput{Key: "routine:" + str(cfg["id"]) + ":" + str(iso(cfg["next_due_at"])), Due: &due}); e != nil {
					return false, e
				}
				next, e := NextDue(obj(obj(cfg["configuration"])["schedule"]), at)
				if e != nil {
					return false, e
				}
				if _, e = tx.Exec(ctx, `UPDATE operations_autonomy_configs_v1 SET next_due_at=$3 WHERE endpoint=$1 AND id=$2`, s.Endpoint, cfg["id"], next); e != nil {
					return false, e
				}
			}
			events, e := many(ctx, tx, `SELECT to_jsonb(e) FROM operations_autonomy_events_v1 e WHERE endpoint=$1 AND domain=$2 AND processed_at IS NULL AND available_at<=$3 ORDER BY created_at,id LIMIT 100 FOR UPDATE`, s.Endpoint, cfg["domain"], at)
			if e != nil {
				return false, e
			}
			if len(events) > 0 && !busy {
				eligible := []Object{}
				for _, event := range events {
					if has(texts(obj(obj(cfg["configuration"])["plan"])["eventTypes"]), str(event["event_type"])) {
						eligible = append(eligible, event)
					}
				}
				if len(eligible) > 0 {
					same := true
					ids := []string{}
					for _, event := range eligible {
						same = same && event["target_type"] == eligible[0]["target_type"] && event["target_id"] == eligible[0]["target_id"]
						ids = append(ids, str(event["id"]))
					}
					var targetType, targetID *string
					if same {
						targetType, targetID = ptr(eligible[0]["target_type"]), ptr(eligible[0]["target_id"])
					}
					task, e := s.createTaskWithin(ctx, tx, cfg, TaskInput{Source: "event", Key: "event:" + str(eligible[0]["id"]), EventIDs: ids, TargetType: targetType, TargetID: targetID})
					if e != nil {
						return false, e
					}
					if task != nil {
						if _, e = tx.Exec(ctx, `UPDATE operations_autonomy_events_v1 SET task_id=$3,processed_at=$4 WHERE endpoint=$1 AND id=ANY($2::uuid[])`, s.Endpoint, ids, task["id"], at); e != nil {
							return false, e
						}
					}
				}
			}
		}
		recover, e := many(ctx, tx, `SELECT to_jsonb(t) FROM operations_autonomy_tasks_v1 t WHERE endpoint=$1 AND source<>'workbench' AND (state='unknown' OR state='running' AND lease_until<=$2 OR state='queued' AND due_at<=$2) ORDER BY due_at LIMIT 30 FOR UPDATE`, s.Endpoint, at)
		if e != nil {
			return false, e
		}
		for _, row := range recover {
			if row["state"] == "running" {
				if _, e = tx.Exec(ctx, `UPDATE operations_autonomy_tasks_v1 SET state='unknown',model_state='unknown',code='lease-expired',lease_owner=NULL,lease_until=NULL,revision=revision+1,updated_at=$3 WHERE endpoint=$1 AND id=$2`, s.Endpoint, row["id"], at); e != nil {
					return false, e
				}
			}
			if e = s.EnqueueWithin(ctx, tx, "autonomy-task", Object{"taskId": row["id"], "reconcile": row["dispatch_started_at"] != nil}, fmt.Sprintf("%s:health:%d", str(row["id"]), s.now().Unix()/30), nil); e != nil {
				return false, e
			}
		}
		next := at.Add(time.Duration(s.defaultNumber("healthSeconds")) * time.Second)
		if e = s.EnqueueWithin(ctx, tx, "autonomy-tick", Object{}, fmt.Sprintf("%s:%d", s.Endpoint, s.now().Unix()/30+1), &next); e != nil {
			return false, e
		}
		return true, nil
	})
	if e != nil {
		return nil, e
	}
	if e = w.ReconcileWorkbench(ctx); e != nil {
		return nil, e
	}
	pending, e := postgres.InTx(ctx, s.Pool, func(tx pgx.Tx) ([]Object, error) {
		return many(ctx, tx, `SELECT to_jsonb(t) FROM operations_autonomy_tasks_v1 t WHERE endpoint=$1 AND source<>'workbench' AND state IN ('waiting-human','paused') AND native_run_id IS NOT NULL ORDER BY updated_at LIMIT 10`, s.Endpoint)
	})
	if e != nil {
		return nil, e
	}
	for _, row := range pending {
		if _, e = w.Reconcile(ctx, row); e != nil {
			return nil, e
		}
	}
	return Object{"state": "checked"}, nil
}
