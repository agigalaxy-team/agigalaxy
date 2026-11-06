package operationsautonomy

import (
	"context"
	"fmt"

	"github.com/agigalaxy-team/agigalaxy/go/internal/communitygrowth"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/jackc/pgx/v5"
)

func assessmentUnavailable() error {
	return fault.New("community_assessment_executor_unavailable", 503)
}

// ConnectCommunityAssessments reuses the current discovery identity, human
// configuration, original task ledger, River queue and native AgentOS runner.
// It grants no model/prompt editing, recognition or ordinary operations tools.
func (s *Service) ConnectCommunityAssessments(assessment *communitygrowth.AssessmentService) {
	if assessment == nil {
		return
	}
	if s.TaskOwners == nil {
		s.TaskOwners = make(map[string]func(context.Context, pgx.Tx, Object) (bool, error))
	}
	s.TaskOwners["community-assessment"] = func(ctx context.Context, tx pgx.Tx, task Object) (bool, error) {
		bound := obj(obj(task["configuration"])["communityAssessment"])
		if task["source"] != "event" || task["domain"] != "discovery" || bound["taskId"] != task["id"] {
			return false, dutyFail("operations_autonomy_scope_denied")
		}
		var enabled bool
		e := tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM community_assessment_tasks_v1 t
			JOIN community_assessment_config_v1 c ON c.endpoint=t.endpoint
			WHERE t.endpoint=$1 AND t.id=$2 AND t.native_task_id=t.id AND c.enabled
			AND t.account_id::text=$3 AND t.domain=$4 AND t.purpose=$5
			AND t.input_revision=$6 AND t.config_version=$7
			AND t.configuration->>'executorConfigId'=$8 AND c.executor_config_id::text=$8)`,
			s.Endpoint, task["id"], bound["accountId"], bound["domain"], bound["purpose"],
			bound["inputRevision"], bound["configVersion"], str(task["config_id"])).Scan(&enabled)
		return enabled, e
	}
	assessment.CreateTaskWithin = func(ctx context.Context, tx pgx.Tx, input communitygrowth.AssessmentTask) (string, error) {
		configID := str(input.Configuration["executorConfigId"])
		if !schemaUUID.MatchString(configID) || s.AIWork == nil || s.EnqueueWithin == nil {
			return "", assessmentUnavailable()
		}
		cfg, e := s.configWithin(ctx, tx, "discovery", " FOR SHARE")
		if e != nil {
			return "", e
		}
		configuration := obj(clone(cfg["configuration"]))
		if cfg["id"] != configID {
			return "", assessmentUnavailable()
		}
		role, e := s.AIWork.AuthorizationWithin(ctx, tx, "discovery", nil)
		if e != nil {
			return "", e
		}
		if !role.Enabled || !has(role.Permissions, "analytics.read") {
			return "", dutyFail("operations_permission_denied")
		}
		// This is a one-time source calculation, independent of the routine's
		// schedule/actions. Its existing human role prompt is copied unchanged.
		configuration["plan"] = Object{"strategyIds": []string{}, "grantIds": []string{}, "actions": []string{}, "resourceIds": []string{}, "eventTypes": []string{}}
		configuration["schedule"] = Object{"kind": "manual"}
		configuration["mode"] = "ai"
		configuration["enabled"] = true
		configuration["taskOwner"] = Object{"kind": "community-assessment"}
		configuration["goal"] = "根据本次绑定的社区公开材料，按人工计算说明计算指定账户、领域与用途的权重并保存结构化结果。"
		configuration["executionGoal"] = "读取本次社区权重计算材料，理解证据、覆盖与缺项。instructions为共用计算说明，purposeInstruction仅适用于本次绑定的purpose；据此计算本用途，不将其他用途的证据要求套入本次判断。使用save_community_assessment_result保存指定输入版本的结果。reason与missing会向管理人员展示，须用自然业务语言解释本用途的实际判断、依据与缺项，不以内部枚举、工具字段或JSON代替说明。保存成功、材料不足或来源变化按真实返回表达；不授予荣誉，不修改模型、岗位提示词或配置。"
		configuration["communityAssessment"] = Object{"taskId": input.ID, "accountId": input.AccountID, "domain": input.Domain, "purpose": input.Purpose,
			"inputRevision": input.InputRevision, "configVersion": input.ConfigVersion, "instructions": input.Configuration["instructions"], "purposeInstruction": str(input.Configuration["purposeInstruction"])}
		cfg["configuration"] = configuration
		title := "计算社区领域权重"
		row, e := s.createTaskWithin(ctx, tx, cfg, TaskInput{ID: input.ID, Source: "event", Key: "community-assessment:" + input.ID, Title: &title})
		if e != nil {
			return "", e
		}
		if row == nil {
			row, e = s.taskWithin(ctx, tx, input.ID, "")
		}
		if e != nil {
			return "", e
		}
		if row["id"] != input.ID || row["config_id"] != configID || row["ai_account_id"] != role.AccountID {
			return "", fail("operations_autonomy_operation_conflict")
		}
		return input.ID, nil
	}
	assessment.TaskStatusWithin = func(ctx context.Context, tx pgx.Tx, id string) (string, error) {
		row, e := s.taskWithin(ctx, tx, id, "")
		if e != nil {
			return "", e
		}
		if obj(obj(row["configuration"])["communityAssessment"])["taskId"] != id {
			return "", dutyFail("operations_autonomy_scope_denied")
		}
		return str(row["state"]), nil
	}
	assessment.TaskVersionsWithin = func(ctx context.Context, tx pgx.Tx, id string) (string, string, error) {
		row, e := s.taskWithin(ctx, tx, id, "")
		if e != nil {
			return "", "", e
		}
		if s.Native == nil || obj(obj(row["configuration"])["communityAssessment"])["taskId"] != id {
			return "", "", assessmentUnavailable()
		}
		value, e := s.Native.Read(ctx, row)
		if e != nil {
			return "", "", e
		}
		if value["taskId"] != id || value["sessionId"] != row["session_id"] || str(value["nativeRunId"]) == "" || value["nativeRunId"] != row["native_run_id"] || RequireNativeAttempt(row, value) != nil {
			return "", "", dutyFail("operations_autonomy_scope_denied")
		}
		run := obj(value["run"])
		model := str(run["modelSettingsVersion"])
		if model == "" || num(run["promptVersion"]) != num(row["prompt_version"]) {
			return "", "", fault.New("community_assessment_versions_unavailable", 503)
		}
		return model, fmt.Sprint(num(row["prompt_version"])), nil
	}
	s.CommunityAssessmentAllowedWithin = func(ctx context.Context, tx pgx.Tx, row Object, actor Actor) error {
		bound := obj(obj(row["configuration"])["communityAssessment"])
		if row["domain"] != "discovery" || row["source"] != "event" || bound["taskId"] != row["id"] || !has(actor.Permissions, "analytics.read") {
			return dutyFail("operations_autonomy_scope_denied")
		}
		var valid bool
		e := tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM community_assessment_tasks_v1 t
			WHERE t.endpoint=$1 AND t.id=$2 AND t.native_task_id=$2
			AND t.account_id::text=$3 AND t.domain=$4 AND t.purpose=$5 AND t.input_revision=$6 AND t.config_version=$7 AND t.configuration->>'executorConfigId'=$8)`,
			s.Endpoint, row["id"], bound["accountId"], bound["domain"], bound["purpose"], bound["inputRevision"], bound["configVersion"], str(row["config_id"])).Scan(&valid)
		if e != nil {
			return e
		}
		if !valid {
			return dutyFail("operations_autonomy_scope_denied")
		}
		return nil
	}
	s.CommunityAssessmentCompletionWithin = func(ctx context.Context, tx pgx.Tx, row Object) (Object, error) {
		var current, saved bool
		var taskState string
		e := tx.QueryRow(ctx, `SELECT t.state,
			EXISTS(SELECT 1 FROM community_assessment_scopes_v1 x JOIN community_assessment_config_v1 c ON c.endpoint=x.endpoint
			WHERE x.endpoint=t.endpoint AND x.account_id=t.account_id AND x.domain=t.domain AND x.purpose=t.purpose
			AND x.input_revision=t.input_revision AND x.task_id=t.id AND c.enabled AND c.version=t.config_version),
			EXISTS(SELECT 1 FROM community_assessment_results_v1 r WHERE r.endpoint=t.endpoint AND r.task_id=t.id AND r.status IN ('assessed','insufficient-material'))
			FROM community_assessment_tasks_v1 t WHERE t.endpoint=$1 AND t.id=$2 AND t.native_task_id=$2`, s.Endpoint, row["id"]).Scan(&taskState, &current, &saved)
		if e != nil {
			return nil, e
		}
		if !current || taskState == "superseded" {
			return Object{"businessState": "no-action", "eligibleToComplete": true, "disposition": "completed", "reasonCode": "community-assessment-source-changed", "nextAction": "本次输入已更换，结束原计算"}, nil
		}
		if saved && taskState == "saved" {
			return Object{"businessState": "completed", "eligibleToComplete": true, "disposition": "completed", "reasonCode": "community-assessment-result-saved", "nextAction": "本次计算结果已保存"}, nil
		}
		if taskState == "failed" {
			return Object{"businessState": "failed", "eligibleToComplete": false, "disposition": "failed", "reasonCode": "community-assessment-failed", "nextAction": "本次计算未形成有效结果"}, nil
		}
		return Object{"businessState": "not-started", "eligibleToComplete": false, "disposition": "continue", "continuationKind": "current-task-work", "reasonCode": "community-assessment-result-required", "nextAction": "继续本次材料理解和计算，保存相应版本的权重或材料不足结果"}, nil
	}
	s.CommunityAssessmentTool = func(ctx context.Context, actor Actor, taskID, tool string, args Object) (Object, error) {
		return assessment.TaskToolsAuthorized(ctx, taskID, tool, args, func(ctx context.Context, tx pgx.Tx) error {
			// RequireDutyAction reuses the unforgeable proof from this exact
			// original task/run/call and holds the task/config authorization
			// barrier through the result write.
			fresh, e := s.RequireDutyAction(ctx, tx, actor, "analytics.read", "query")
			if e != nil {
				return e
			}
			metadata, e := s.DutyMetadata(fresh)
			if e != nil || metadata["taskId"] != taskID {
				return dutyFail("operations_autonomy_scope_denied")
			}
			row, e := s.taskWithin(ctx, tx, taskID, " FOR SHARE")
			if e != nil {
				return e
			}
			if tool == "save-community-assessment-result" && obj(row["control_state"])["kind"] == "manual-pause" && has([]string{"requested", "paused"}, str(obj(row["control_state"])["phase"])) {
				return fault.New("operations_autonomy_pause_requested", 409)
			}
			return s.CommunityAssessmentAllowedWithin(ctx, tx, row, fresh)
		})
	}
}
