package agentos

import (
	"context"
	"encoding/json"
	"fmt"
	"github.com/agigalaxy-team/agigalaxy/go/internal/operationspermissions"
	"github.com/agigalaxy-team/agigalaxy/go/internal/postgres"
	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"math"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"time"
	"unicode/utf16"
)

// RunOverview owns the original global metadata-only audit read. Dialogue text
// remains on the separate current-owner conversation path.
type RunOverview struct {
	Pool            *pgxpool.Pool
	Endpoint        string
	Human           operationspermissions.Authority
	Client          *Client
	Now             func() time.Time
	ProjectWorkflow func(Object) (Object, error)
}

var overviewID = regexp.MustCompile(`^[A-Za-z0-9_-]{1,128}$`)
var overviewVersion = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$`)
var overviewSpanName = regexp.MustCompile(`^[A-Za-z0-9_. -]{1,100}$`)
var overviewEventName = regexp.MustCompile(`^[A-Za-z][A-Za-z0-9_]{0,99}$`)
var overviewDomains = []string{"overview", "governance", "messaging", "discovery", "maintenance"}
var overviewStates = []string{"PENDING", "RUNNING", "COMPLETED", "PAUSED", "CANCELLED", "ERROR", "REGENERATED"}

func overviewHas(a []string, s string) bool {
	for _, v := range a {
		if s == v {
			return true
		}
	}
	return false
}
func overviewText(o Object, k string) string { s, _ := o[k].(string); return s }
func overviewNativeID(v any) any {
	s, ok := v.(string)
	if ok && overviewID.MatchString(s) {
		return s
	}
	return nil
}
func overviewUUID(v any) any {
	s, ok := v.(string)
	if !ok {
		return nil
	}
	u, e := uuid.Parse(s)
	if e == nil && strings.EqualFold(u.String(), s) && (u == uuid.Nil || strings.EqualFold(s, "ffffffff-ffff-ffff-ffff-ffffffffffff") || u.Variant() == uuid.RFC4122 && u.Version() >= 1 && u.Version() <= 8) {
		return s
	}
	return nil
}
func overviewNumber(v any) any {
	var f float64
	switch n := v.(type) {
	case json.Number:
		var e error
		f, e = n.Float64()
		if e != nil {
			return nil
		}
	case float64:
		f = n
	case int:
		f = float64(n)
	case int64:
		f = float64(n)
	default:
		return nil
	}
	if math.IsNaN(f) || math.IsInf(f, 0) || f < 0 {
		return nil
	}
	return f
}
func overviewInteger(v any) (int64, bool) {
	n, ok := overviewNumber(v).(float64)
	return int64(n), ok && n == math.Trunc(n) && n <= 9007199254740991
}
func overviewTime(v any) any {
	if _, ok := v.(string); !ok {
		return overviewNumber(v)
	}
	s := v.(string)
	for _, layout := range []string{time.RFC3339Nano, "2006-01-02", time.RFC1123, time.RFC1123Z} {
		if _, e := time.Parse(layout, s); e == nil {
			return s
		}
	}
	return nil
}
func overviewLabel(v any) any {
	s, ok := v.(string)
	if !ok {
		return nil
	}
	s = strings.TrimSpace(s)
	if s == "" {
		return nil
	}
	units := utf16.Encode([]rune(s))
	if len(units) <= 200 {
		return s
	}
	units = units[:200]
	if units[199] >= 0xd800 && units[199] <= 0xdbff {
		var b strings.Builder
		b.WriteByte('"')
		for _, u := range units {
			fmt.Fprintf(&b, `\u%04x`, u)
		}
		b.WriteByte('"')
		return json.RawMessage(b.String())
	}
	return string(utf16.Decode(units))
}
func overviewTokens(v any) Object {
	o := object(v)
	return Object{"input": overviewNumber(o["input"]), "output": overviewNumber(o["output"]), "total": overviewNumber(o["total"])}
}
func overviewChoice(v any, allowed []string) any {
	s, ok := v.(string)
	if ok && overviewHas(allowed, s) {
		return s
	}
	return nil
}
func overviewModelVersion(v any) any {
	s, ok := v.(string)
	if ok && overviewVersion.MatchString(s) {
		return s
	}
	return nil
}
func overviewRun(v Object) (Object, error) {
	if overviewNativeID(v["runId"]) == nil {
		return nil, fail("operations_agentos_response_invalid", 503)
	}
	var role, versions, boundary, errorCode any
	if n, ok := overviewInteger(v["rolePromptVersion"]); ok && n > 0 {
		role = n
	}
	if a, ok := v["modelSettingsVersions"].([]any); ok && len(a) > 0 {
		valid := true
		for _, item := range a {
			valid = valid && overviewModelVersion(item) != nil
		}
		if valid {
			versions = a
		}
	}
	if v["boundaryVersion"] == "galaxy-conversation-boundary-v3" {
		boundary = v["boundaryVersion"]
	}
	if v["state"] == "ERROR" {
		errorCode = overviewChoice(v["errorCode"], []string{"operations_agentos_run_failed", "operations_authorization_unavailable", "operations_agentos_authority_changed"})
	}
	return Object{"runId": v["runId"], "executionId": overviewUUID(v["executionId"]), "conversationId": overviewUUID(v["conversationId"]), "sessionId": overviewNativeID(v["sessionId"]), "componentId": overviewNativeID(v["componentId"]), "componentType": overviewChoice(v["componentType"], []string{"agent", "team", "workflow"}), "domain": overviewChoice(v["domain"], overviewDomains), "state": overviewChoice(v["state"], overviewStates), "errorCode": errorCode, "createdAt": overviewTime(v["createdAt"]), "updatedAt": overviewTime(v["updatedAt"]), "promptVersion": overviewChoice(v["promptVersion"], []string{"galaxy-operations-v1", "galaxy-prepared-review-v1", "galaxy-conversation-v1", "galaxy-conversation-v2", "galaxy-p13-selected-content-v1"}), "rolePromptVersion": role, "boundaryVersion": boundary, "modelSettingsVersion": overviewModelVersion(v["modelSettingsVersion"]), "modelSettingsVersions": versions, "tokens": overviewTokens(v["tokens"]), "durationMs": overviewNumber(v["durationMs"]), "retryCount": nil, "retryState": "not-recorded", "metadataOnly": true, "executor": nil, "conversation": nil}, nil
}
func overviewSpan(v Object) Object {
	if overviewNativeID(v["spanId"]) == nil || overviewNativeID(v["traceId"]) == nil {
		return nil
	}
	name := overviewText(v, "name")
	if !overviewSpanName.MatchString(name) {
		name = "agno.operation"
	}
	return Object{"spanId": v["spanId"], "traceId": v["traceId"], "parentSpanId": overviewNativeID(v["parentSpanId"]), "name": name, "kind": overviewChoice(v["kind"], []string{"AGENT", "CHAIN", "LLM", "TOOL", "RETRIEVER", "EMBEDDING", "RERANKER", "GUARDRAIL", "EVALUATOR"}), "state": overviewChoice(v["state"], []string{"OK", "ERROR", "UNSET"}), "startTime": overviewTime(v["startTime"]), "endTime": overviewTime(v["endTime"]), "durationMs": overviewNumber(v["durationMs"]), "tokens": overviewTokens(v["tokens"]), "input": Object{"state": "not-recorded", "value": nil}, "output": Object{"state": "not-recorded", "value": nil}}
}
func (s *RunOverview) now() int64 {
	if s.Now != nil {
		return s.Now().Unix()
	}
	return time.Now().Unix()
}
func (s *RunOverview) human(ctx context.Context, a operationspermissions.Actor) error {
	if s == nil || s.Human == nil || s.Pool == nil {
		return fail("operations_authorization_unavailable", 503)
	}
	_, e := postgres.InTx(ctx, s.Pool, func(tx pgx.Tx) (operationspermissions.Actor, error) {
		return s.Human.RequireWithin(ctx, tx, a, "audit.read")
	})
	return e
}
func overviewRow(ctx context.Context, tx pgx.Tx, query string, args ...any) (Object, error) {
	var raw []byte
	e := tx.QueryRow(ctx, query, args...).Scan(&raw)
	if e == pgx.ErrNoRows {
		return nil, nil
	}
	if e != nil {
		return nil, e
	}
	var out Object
	e = protocol.Decode(raw, &out)
	return out, e
}
func (s *RunOverview) bind(ctx context.Context, run Object) (Object, error) {
	return postgres.InTx(ctx, s.Pool, func(tx pgx.Tx) (Object, error) {
		if run["conversationId"] != nil {
			r, e := overviewRow(ctx, tx, `SELECT jsonb_build_object('id',c.id,'domain',c.domain,'session_id',c.session_id,'display_name',p.display_name) FROM operations_agentos_conversations_v1 c LEFT JOIN operations_operator_principals_v1 p ON p.operator_id=c.operator_id AND p.endpoint=c.endpoint WHERE c.endpoint=$1 AND c.id=$2`, s.Endpoint, run["conversationId"])
			if e != nil {
				return nil, e
			}
			if r != nil && r["domain"] == run["domain"] && r["session_id"] == run["sessionId"] {
				run["conversation"] = Object{"id": r["id"], "operatorDisplayName": overviewLabel(r["display_name"])}
			}
			if run["conversation"] == nil {
				run["conversationId"] = nil
			}
		}
		if run["conversation"] == nil || run["componentId"] != "galaxy-conversation-"+overviewText(run, "domain") {
			run["rolePromptVersion"], run["boundaryVersion"] = nil, nil
		}
		if run["executionId"] != nil {
			r, e := overviewRow(ctx, tx, `SELECT jsonb_build_object('executor_kind',e.executor_kind,'mode',e.mode,'operator_id',e.operator_id,'grant_id',e.grant_id,'display_name',p.display_name) FROM operations_agentos_executions_v1 e LEFT JOIN operations_operator_principals_v1 p ON p.operator_id=e.operator_id AND p.endpoint=e.endpoint WHERE e.endpoint=$1 AND e.id=$2`, s.Endpoint, run["executionId"])
			if e != nil {
				return nil, e
			}
			if r != nil {
				run["executor"] = Object{"kind": r["executor_kind"], "mode": r["mode"], "onBehalfOf": r["operator_id"], "onBehalfOfDisplayName": overviewLabel(r["display_name"]), "grantId": r["grant_id"]}
			}
		}
		return run, nil
	})
}
func overviewQuery(input Object) (Object, error) {
	q := Object{"page": int64(1), "limit": int64(30)}
	for k, v := range input {
		switch k {
		case "page", "limit":
			n, ok := overviewInteger(v)
			max := int64(100000)
			if k == "limit" {
				max = 100
			}
			if !ok || n < 1 || n > max {
				return nil, fail("invalid_operations_agentos_request", 400)
			}
			q[k] = n
		case "domain":
			if overviewChoice(v, overviewDomains) == nil {
				return nil, fail("invalid_operations_agentos_request", 400)
			}
			q[k] = v
		case "state":
			if overviewChoice(v, overviewStates) == nil {
				return nil, fail("invalid_operations_agentos_request", 400)
			}
			q[k] = v
		default:
			return nil, fail("invalid_operations_agentos_request", 400)
		}
	}
	return q, nil
}
func (s *RunOverview) Runs(ctx context.Context, a operationspermissions.Actor, input Object) (Object, error) {
	q, e := overviewQuery(input)
	if e != nil {
		return nil, e
	}
	if e = s.human(ctx, a); e != nil {
		return nil, e
	}
	if s.Client == nil {
		return nil, fail("operations_agentos_not_configured", 503)
	}
	values := url.Values{}
	for k, v := range q {
		switch n := v.(type) {
		case int64:
			values.Set(k, strconv.FormatInt(n, 10))
		case string:
			values.Set(k, n)
		}
	}
	raw, e := s.Client.Runs(ctx, values)
	if e != nil {
		return nil, e
	}
	value := object(raw)
	items, ok := value["items"].([]any)
	total, valid := overviewInteger(value["total"])
	if !ok || !valid {
		return nil, fail("operations_agentos_response_invalid", 503)
	}
	out := []Object{}
	for _, v := range items {
		run, e := overviewRun(object(v))
		if e != nil {
			return nil, e
		}
		run, e = s.bind(ctx, run)
		if e != nil {
			return nil, e
		}
		out = append(out, run)
	}
	if e = s.human(ctx, a); e != nil {
		return nil, e
	}
	var next any
	if n, ok := overviewInteger(value["nextPage"]); ok && n > q["page"].(int64) && n <= 100000 {
		next = n
	}
	at := s.now()
	return Object{"items": out, "total": total, "page": q["page"], "nextPage": next, "metadataOnly": true, "scope": "all-runtime-run-metadata", "checkedAt": at, "readExpiresAt": at + 30}, nil
}
func (s *RunOverview) RunDetail(ctx context.Context, a operationspermissions.Actor, id string) (Object, error) {
	if !overviewID.MatchString(id) {
		return nil, fail("invalid_operations_agentos_request", 400)
	}
	if e := s.human(ctx, a); e != nil {
		return nil, e
	}
	if s.Client == nil {
		return nil, fail("operations_agentos_not_configured", 503)
	}
	raw, e := s.Client.RunDetail(ctx, id)
	if e != nil {
		return nil, e
	}
	value := object(raw)
	if object(value["run"])["runId"] != id {
		return nil, fail("operations_agentos_response_invalid", 503)
	}
	run, e := overviewRun(object(value["run"]))
	if e != nil {
		return nil, e
	}
	run, e = s.bind(ctx, run)
	if e != nil {
		return nil, e
	}
	spans, events := []Object{}, []Object{}
	if ss, ok := value["spans"].([]any); ok {
		for _, v := range ss {
			if span := overviewSpan(object(v)); span != nil {
				spans = append(spans, span)
			}
		}
	}
	if ee, ok := value["events"].([]any); ok {
		for _, v := range ee {
			event := object(v)
			name := overviewText(event, "event")
			if overviewEventName.MatchString(name) && !strings.Contains(name, "Reasoning") {
				var index any
				if n, ok := overviewInteger(event["eventIndex"]); ok {
					index = n
				}
				events = append(events, Object{"event": name, "eventIndex": index, "createdAt": overviewTime(event["createdAt"])})
			}
		}
	}
	var workflow any
	if run["componentType"] == "workflow" && run["componentId"] == "galaxy-p13-selected-content-v1" {
		if s.ProjectWorkflow == nil {
			return nil, fail("operations_agentos_response_invalid", 503)
		}
		if projected, e := s.ProjectWorkflow(object(value["strategyWorkflow"])); e == nil && projected["runId"] == id {
			workflow = projected
		}
	}
	if e = s.human(ctx, a); e != nil {
		return nil, e
	}
	var traces any
	if n, ok := overviewInteger(value["traceCount"]); ok {
		traces = n
	}
	at := s.now()
	return Object{"run": run, "spans": spans, "events": events, "workflow": workflow, "traceCount": traces, "input": Object{"state": "withheld", "value": nil}, "output": Object{"state": "withheld", "value": nil}, "metadataOnly": true, "checkedAt": at, "readExpiresAt": at + 30}, nil
}
