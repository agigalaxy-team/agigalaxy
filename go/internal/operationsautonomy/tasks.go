package operationsautonomy

import (
	"context"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"time"
)

var defaultSettings = Object{"concurrency": 2, "healthSeconds": 30, "startGraceSeconds": 120, "roundSeconds": 600, "eventCoalesceSeconds": 30}

func defaultConfiguration(domain string) Object {
	schedule := Object{"kind": "interval", "minutes": map[string]int{"overview": 30, "governance": 20, "messaging": 30, "discovery": 60}[domain], "timezone": "Asia/Shanghai"}
	if domain == "maintenance" {
		schedule = Object{"kind": "daily", "at": nil, "timezone": "Asia/Shanghai"}
	}
	return Object{"enabled": false, "mode": "ai-human", "schedule": schedule, "purpose": "operations-" + domain, "goal": "", "prompt": "", "plan": Object{"strategyIds": []string{}, "grantIds": []string{}, "actions": []string{}, "resourceIds": []string{}, "eventTypes": []string{}}}
}
func (s *Service) RuntimeSettingsWithin(ctx context.Context, tx pgx.Tx) (Object, error) {
	if _, e := tx.Exec(ctx, `INSERT INTO operations_autonomy_runtime_v1(endpoint,revision,configuration,updated_at) VALUES($1,1,$2,$3) ON CONFLICT DO NOTHING`, s.Endpoint, jsonText(defaultSettings), s.now()); e != nil {
		return nil, e
	}
	r, e := one(ctx, tx, `SELECT to_jsonb(r) FROM operations_autonomy_runtime_v1 r WHERE endpoint=$1`, s.Endpoint)
	if e != nil {
		return nil, e
	}
	out := Object{"revision": r["revision"]}
	for k, v := range obj(r["configuration"]) {
		out[k] = v
	}
	return out, nil
}
func (s *Service) EnsureWithin(ctx context.Context, tx pgx.Tx) error {
	if _, e := s.refreshSettingsWithin(ctx, tx); e != nil {
		return e
	}
	for _, domain := range domains {
		row, e := optional(ctx, tx, `INSERT INTO operations_autonomy_configs_v1(id,endpoint,domain,revision,enabled,configuration,prompt_version,plan_version,created_at,updated_at) VALUES($1,$2,$3,1,false,$4,1,1,$5,$5) ON CONFLICT(endpoint,domain) DO NOTHING RETURNING to_jsonb(operations_autonomy_configs_v1)`, uuid.NewString(), s.Endpoint, domain, jsonText(defaultConfiguration(domain)), s.now())
		if e != nil {
			return e
		}
		if row != nil {
			if e = s.versionWithin(ctx, tx, row, nil); e != nil {
				return e
			}
		}
	}
	return nil
}
func (s *Service) versionWithin(ctx context.Context, tx pgx.Tx, r Object, operator any) error {
	_, e := tx.Exec(ctx, `INSERT INTO operations_autonomy_versions_v1(config_id,revision,configuration,prompt_version,plan_version,delegation_version,operator_id,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8)`, r["id"], r["revision"], jsonText(r["configuration"]), r["prompt_version"], r["plan_version"], r["delegation_version"], operator, s.now())
	return e
}

type TaskInput struct {
	ID, Source, Key      string
	Title                *string
	Due                  *time.Time
	EventIDs             []string
	TargetType, TargetID *string
}

func (s *Service) createTaskWithin(ctx context.Context, tx pgx.Tx, cfg Object, in TaskInput) (Object, error) {
	if in.ID == "" {
		in.ID = uuid.NewString()
	}
	if in.Source == "" {
		in.Source = "routine"
	}
	due := s.now()
	if in.Due != nil {
		due = *in.Due
	}
	account, e := optional(ctx, tx, `SELECT to_jsonb(w) FROM(SELECT id FROM operations_ai_work_accounts_v1 WHERE endpoint=$1 AND domain=$2)w`, s.Endpoint, cfg["domain"])
	if e != nil {
		return nil, e
	}
	configuration := obj(clone(cfg["configuration"]))
	plan := obj(configuration["plan"])
	grants, e := many(ctx, tx, `SELECT to_jsonb(g) FROM(SELECT id,version FROM operations_automation_grants_v1 WHERE endpoint=$1 AND id=ANY($2::uuid[]))g`, s.Endpoint, texts(plan["grantIds"]))
	if e != nil {
		return nil, e
	}
	var head Object
	if len(texts(plan["strategyIds"])) > 0 {
		head, e = optional(ctx, tx, `SELECT to_jsonb(h) FROM(SELECT active_id FROM operations_p13_strategy_heads_v1 WHERE endpoint=$1)h`, s.Endpoint)
		if e != nil {
			return nil, e
		}
	}
	var delegation Object
	if account != nil {
		delegation, e = optional(ctx, tx, `SELECT to_jsonb(d) FROM(SELECT version FROM operations_ai_role_delegations_v1 WHERE endpoint=$1 AND source_ai_account_id=$2)d`, s.Endpoint, account["id"])
		if e != nil {
			return nil, e
		}
	}
	runtime, e := s.refreshSettingsWithin(ctx, tx)
	if e != nil {
		return nil, e
	}
	configuration["runtime"] = runtime
	configuration["versionBindings"] = Object{"grants": grants, "strategyVersionId": head["active_id"]}
	if in.Source != "workbench" && configuration["strategyExecution"] == nil && head["active_id"] != nil {
		published, e := optional(ctx, tx, `SELECT to_jsonb(v) FROM(SELECT configuration FROM operations_p13_strategy_versions_v1 WHERE endpoint=$1 AND id=$2)v`, s.Endpoint, head["active_id"])
		if e != nil {
			return nil, e
		}
		strategies := []Object{}
		inspection := []string{}
		for _, v := range list(obj(published["configuration"])["strategies"]) {
			r := obj(v)
			if has(texts(plan["strategyIds"]), str(r["id"])) {
				strategies = append(strategies, r)
				if r["execution"] != nil && obj(obj(r["execution"])["trigger"])["kind"] != "manual" {
					inspection = append(inspection, str(r["id"]))
				}
			}
		}
		configuration["inspectionStrategyIds"] = inspection
		if len(inspection) > 0 {
			actions := []string{}
			for _, action := range texts(plan["actions"]) {
				for _, strategy := range strategies {
					if !has(inspection, str(strategy["id"])) && (has(texts(obj(strategy["execution"])["actions"]), action) || strategy["template"] == "selected-public-content-visibility" && has([]string{"content.hide", "content.restore"}, action)) {
						actions = append(actions, action)
						break
					}
				}
			}
			plan["actions"] = actions
		}
	}
	title := map[string]string{"overview": "总控", "governance": "治理", "messaging": "消息", "discovery": "数据与发现", "maintenance": "运维"}[str(cfg["domain"])]
	if in.Source == "event" {
		title += "事项处理"
	} else {
		title += "例行巡检"
	}
	if in.Title != nil {
		title = *in.Title
	}
	modelState := "not-started"
	if configuration["mode"] == "code" {
		modelState = "not-required"
	}
	events := in.EventIDs
	if events == nil {
		events = []string{}
	}
	row, e := optional(ctx, tx, `INSERT INTO operations_autonomy_tasks_v1(id,endpoint,config_id,config_revision,ai_account_id,domain,source,source_key,title,mode,state,model_state,business_state,configuration,prompt_version,plan_version,delegation_version,session_id,event_ids,target_type,target_id,due_at,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'queued',$11,'not-started',$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$21) ON CONFLICT(endpoint,source_key) DO NOTHING RETURNING to_jsonb(operations_autonomy_tasks_v1)`, in.ID, s.Endpoint, cfg["id"], cfg["revision"], account["id"], cfg["domain"], in.Source, in.Key, title, configuration["mode"], modelState, jsonText(configuration), cfg["prompt_version"], cfg["plan_version"], delegation["version"], uuid.NewString(), events, in.TargetType, in.TargetID, due, s.now())
	if e != nil {
		return nil, e
	}
	if row != nil && in.Source != "workbench" && s.EnqueueWithin != nil {
		if e = s.EnqueueWithin(ctx, tx, "autonomy-task", Object{"taskId": row["id"]}, str(row["id"]), &due); e != nil {
			return nil, e
		}
	}
	return row, nil
}

type WorkbenchLink struct {
	OperationID, Domain, AIAccountID                                         string
	NativeRunID, TargetType, TargetID, ConversationID, SessionID, OperatorID *string
	ModelState                                                               string
}

// LinkWorkbenchWithin runs in the caller's already-authorized conversation tx.
func (s *Service) LinkWorkbenchWithin(ctx context.Context, tx pgx.Tx, in WorkbenchLink) (Object, error) {
	if !schemaUUID.MatchString(in.OperationID) {
		return nil, fault.New("invalid_operations_autonomy_request", 400)
	}
	if e := s.EnsureWithin(ctx, tx); e != nil {
		return nil, e
	}
	cfg, e := s.configWithin(ctx, tx, in.Domain, "")
	if e != nil {
		return nil, e
	}
	title := map[string]string{"overview": "总控", "governance": "治理", "messaging": "消息", "discovery": "数据与发现", "maintenance": "运维"}[in.Domain] + "工作台事项"
	row, e := s.createTaskWithin(ctx, tx, cfg, TaskInput{ID: in.OperationID, Source: "workbench", Key: "workbench:" + in.OperationID, Title: &title, TargetType: in.TargetType, TargetID: in.TargetID})
	if e != nil {
		return nil, e
	}
	if row == nil {
		return s.taskWithin(ctx, tx, in.OperationID, "")
	}
	snapshot := obj(row["configuration"])
	snapshot["externalWorkbench"] = Object{"conversationId": in.ConversationID, "sessionId": in.SessionID, "operatorId": in.OperatorID, "turnOperationId": in.OperationID}
	modelState := in.ModelState
	if modelState == "" {
		modelState = "accepted"
	}
	if _, e = tx.Exec(ctx, `UPDATE operations_autonomy_tasks_v1 SET ai_account_id=$3,state='running',mode='human-ai',configuration=$7,model_state=$4,native_run_id=$5,dispatch_started_at=$6 WHERE endpoint=$1 AND id=$2`, s.Endpoint, in.OperationID, in.AIAccountID, modelState, in.NativeRunID, s.now(), jsonText(snapshot)); e != nil {
		return nil, e
	}
	status := "running"
	return s.UpdateWorkbenchWithin(ctx, tx, WorkbenchUpdate{OperationID: in.OperationID, TurnOperationID: &in.OperationID, NativeRunID: in.NativeRunID, ModelState: &modelState, Status: &status})
}
