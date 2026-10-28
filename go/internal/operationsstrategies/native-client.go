package operationsstrategies

import (
	"context"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"net/url"
	"unicode/utf8"
)

// StrategyTransport is the closed AgentOS transport over its already loaded
// configuration and execution JWT. No model/provider credentials cross here.
type StrategyTransport interface {
	StrategyStatus(context.Context) (Object, error)
	StrategyRequest(context.Context, string, string, string, url.Values, string) (Object, error)
	RunDetail(context.Context, string) (any, error)
}
type NativeClient struct{ Client StrategyTransport }

func (n *NativeClient) Status(ctx context.Context) (Object, error) {
	if n == nil || n.Client == nil {
		return Object{"state": "not-configured", "modelState": "not-configured", "framework": "agno", "version": "3.1.7", "workflow": WorkflowID}, nil
	}
	return n.Client.StrategyStatus(ctx)
}
func (n *NativeClient) Start(ctx context.Context, row Object) (Object, error) {
	status, e := n.Status(ctx)
	if e != nil {
		return nil, e
	}
	if status["state"] != "connected" {
		return nil, fail("p13_native_workflow_not_connected", 503)
	}
	return n.Client.StrategyRequest(ctx, str(row["execution_id"]), str(row["id"]), "/start", url.Values{"session_id": {str(row["session_id"])}}, str(row["id"]))
}

var nativeStepNames = []string{"核对策略、授权与源版本", "复杂条件才使用AI", "复杂条件判断", "普通事项缺输入时补充", "补充本事项处理选择", "需要人工时暂停", "人工确认本事项", "执行原受控命令并记录结果"}

func ProjectNativeRun(value Object) (Object, error) {
	if value == nil {
		return nil, fail("p13_native_response_invalid", 503)
	}
	if _, ok := value["runId"]; !ok || value["runId"] != nil && !nativeID.MatchString(str(value["runId"])) {
		return nil, fail("p13_native_response_invalid", 503)
	}
	if !has([]string{"NOT_RECORDED", "PENDING", "RUNNING", "PAUSED", "COMPLETED", "CANCELLED", "ERROR"}, str(value["status"])) || value["workflowId"] != WorkflowID || !integer(value["workflowVersion"], 1, 1) {
		return nil, fail("p13_native_response_invalid", 503)
	}
	if _, ok := value["awaitingHuman"].(bool); !ok {
		return nil, fail("p13_native_response_invalid", 503)
	}
	out := Object{"runId": value["runId"], "status": value["status"], "awaitingHuman": value["awaitingHuman"], "workflowId": value["workflowId"], "workflowVersion": value["workflowVersion"]}
	if v, ok := value["pauseKind"]; ok {
		if v != nil && !has([]string{"input", "confirmation"}, str(v)) {
			return nil, fail("p13_native_response_invalid", 503)
		}
		out["pauseKind"] = v
	}
	if v, ok := value["pauseId"]; ok {
		if v != nil && !pauseID.MatchString(str(v)) {
			return nil, fail("p13_native_response_invalid", 503)
		}
		out["pauseId"] = v
	}
	if v, ok := value["currentStep"]; ok {
		if v != nil && !has(nativeStepNames, str(v)) {
			return nil, fail("p13_native_response_invalid", 503)
		}
		out["currentStep"] = v
	}
	if v, ok := value["steps"]; ok {
		if !array(v) || len(list(v)) > 50 {
			return nil, fail("p13_native_response_invalid", 503)
		}
		steps := []any{}
		for _, v := range list(v) {
			r := obj(v)
			if !has(nativeStepNames, str(r["name"])) {
				return nil, fail("p13_native_response_invalid", 503)
			}
			if _, ok := r["success"].(bool); !ok {
				return nil, fail("p13_native_response_invalid", 503)
			}
			step := Object{"name": r["name"], "success": r["success"]}
			if typ, ok := r["type"]; ok {
				if typ != nil {
					if s, ok := typ.(string); !ok || utf8.RuneCountInString(s) > 30 {
						return nil, fail("p13_native_response_invalid", 503)
					}
				}
				step["type"] = typ
			}
			steps = append(steps, step)
		}
		out["steps"] = steps
	}
	return out, nil
}
func (n *NativeClient) retained(ctx context.Context, row Object) (Object, bool) {
	if n == nil || n.Client == nil || !nativeID.MatchString(str(row["native_run_id"])) {
		return nil, false
	}
	value, e := n.Client.RunDetail(ctx, str(row["native_run_id"]))
	if e != nil {
		return nil, false
	}
	raw := obj(value)
	run := obj(raw["run"])
	if raw["metadataOnly"] != true || run["runId"] != row["native_run_id"] || run["executionId"] != row["execution_id"] || run["sessionId"] != row["session_id"] || run["componentId"] != WorkflowID || run["componentType"] != "workflow" {
		return nil, false
	}
	return raw, true
}
func (n *NativeClient) Read(ctx context.Context, row Object, history bool) (Object, error) {
	if n == nil || n.Client == nil {
		return nil, nil
	}
	if history {
		raw, ok := n.retained(ctx, row)
		if !ok {
			return nil, nil
		}
		v, e := ProjectNativeRun(obj(raw["strategyWorkflow"]))
		if e != nil || v["runId"] != row["native_run_id"] {
			return nil, nil
		}
		return v, nil
	}
	raw, e := n.Client.StrategyRequest(ctx, str(row["execution_id"]), str(row["id"]), "", nil, "")
	if e == nil {
		raw, e = ProjectNativeRun(raw)
	}
	if e != nil {
		if fault.Status(e) == 403 {
			return nil, e
		}
		return nil, nil
	}
	return raw, nil
}
func projectContinuation(value Object, acceptedOnly bool) (Object, error) {
	if !closed(value, []string{"operationId", "runId", "nativeRunId", "pauseId", "state"}, nil) || !uuidPattern.MatchString(str(value["operationId"])) || !uuidPattern.MatchString(str(value["runId"])) || !nativeID.MatchString(str(value["nativeRunId"])) || !pauseID.MatchString(str(value["pauseId"])) || !has([]string{"accepted", "not-recorded", "unknown"}, str(value["state"])) || acceptedOnly && value["state"] != "accepted" {
		return nil, fail("p13_native_response_invalid", 503)
	}
	return clone(value), nil
}
func (n *NativeClient) Continuation(ctx context.Context, row Object, operationID string, history bool, expectedPause *string) (Object, error) {
	if n == nil || n.Client == nil {
		return nil, nil
	}
	if history {
		if !uuidPattern.MatchString(operationID) || expectedPause == nil || !pauseID.MatchString(*expectedPause) {
			return nil, nil
		}
		raw, ok := n.retained(ctx, row)
		if !ok {
			return nil, nil
		}
		value := obj(raw["strategyContinuations"])
		if !closed(value, []string{"state", "complete", "items"}, nil) || !has([]string{"available", "unavailable"}, str(value["state"])) || !array(value["items"]) || len(list(value["items"])) > 50 {
			return nil, nil
		}
		if _, ok := value["complete"].(bool); !ok {
			return nil, nil
		}
		rows := []Object{}
		for _, v := range list(value["items"]) {
			r, e := projectContinuation(obj(v), true)
			if e != nil {
				return nil, nil
			}
			rows = append(rows, r)
		}
		if value["state"] != "available" || value["complete"] != true {
			return nil, nil
		}
		for _, r := range rows {
			if r["operationId"] == operationID {
				if r["runId"] != row["id"] || r["nativeRunId"] != row["native_run_id"] || r["pauseId"] != *expectedPause {
					return nil, nil
				}
				return r, nil
			}
		}
		return Object{"operationId": operationID, "runId": row["id"], "nativeRunId": row["native_run_id"], "pauseId": *expectedPause, "state": "not-recorded"}, nil
	}
	value, e := n.Client.StrategyRequest(ctx, str(row["execution_id"]), str(row["id"]), "/continuations/"+operationID, nil, "")
	if e == nil {
		value, e = projectContinuation(value, false)
	}
	if e != nil {
		if fault.Status(e) == 403 {
			return nil, e
		}
		return nil, nil
	}
	return value, nil
}
func (n *NativeClient) Continue(ctx context.Context, row, input Object) (Object, error) {
	if n == nil || n.Client == nil {
		return nil, fail("p13_native_workflow_not_connected", 503)
	}
	form := url.Values{"session_id": {str(row["session_id"])}}
	if confirmed, ok := input["confirmed"]; ok {
		form.Set("confirmed", "false")
		if confirmed == true {
			form.Set("confirmed", "true")
		}
	} else {
		form.Set("input_decision", str(input["inputDecision"]))
	}
	return n.Client.StrategyRequest(ctx, str(row["execution_id"]), str(row["id"]), "/continue", form, str(input["operationId"]))
}
