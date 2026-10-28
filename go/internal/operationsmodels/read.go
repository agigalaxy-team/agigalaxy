package operationsmodels

import (
	"context"
	"github.com/agigalaxy-team/agigalaxy/go/internal/postgres"
	"github.com/jackc/pgx/v5"
)

func (s *Service) Overview(ctx context.Context, a Actor) (Object, error) {
	actor, e := s.current(ctx, a, "models.read")
	if e != nil {
		return nil, e
	}
	before, e := s.state(ctx, s.Pool)
	if e != nil {
		return nil, e
	}
	if before["pending_operation"] != nil {
		if _, e = s.reconcile(ctx, str(before["pending_operation"])); e != nil {
			return nil, e
		}
	}
	native, _ := s.nativeStatus(ctx)
	state, e := s.state(ctx, s.Pool)
	if e != nil {
		return nil, e
	}
	active, e := s.version(ctx, s.Pool, state["active_id"])
	if e != nil {
		return nil, e
	}
	draft, e := s.version(ctx, s.Pool, state["draft_id"])
	if e != nil {
		return nil, e
	}
	var pendingRow Object
	if state["pending_operation"] != nil {
		pendingRow, e = s.operation(ctx, s.Pool, state["pending_operation"])
		if e != nil {
			return nil, e
		}
	}
	current, e := s.current(ctx, actor, "models.read")
	if e != nil {
		return nil, e
	}
	nativeMatches := native != nil && obj(native["availability"])["state"] == "available" && native["appliedVersionId"] == state["active_id"]
	var pendingView any
	if pendingRow != nil {
		pendingView = operationView(pendingRow, false)
	}
	return s.envelope(Object{"revision": state["revision"], "active": versionView(active), "draft": versionView(draft), "pending": pendingView, "native": native, "capabilities": Object{"canConfigure": has(current.Permissions, "models.configure") && pendingRow == nil, "canProvisionCredentials": has(current.Permissions, "models.configure") && s.Native != nil, "canApply": has(current.Permissions, "models.apply") && pendingRow == nil && draft != nil && nativeMatches}, "formats": append([]string{}, Formats...), "domains": append([]string{}, Domains...), "basis": Object{"management": "human-only", "providerSecrets": "protected-native-only", "modelContact": "not-checked", "capabilitySource": "manual-declaration", "temperature": "not-configurable", "billing": "not-provided"}}), nil
}
func (s *Service) Operation(ctx context.Context, a Actor, id string) (Object, error) {
	id, ok := parseUUID(id)
	if !ok {
		return nil, invalid()
	}
	if _, e := s.current(ctx, a, "models.read"); e != nil {
		return nil, e
	}
	row, e := s.operation(ctx, s.Pool, id)
	if e != nil {
		return nil, e
	}
	if row == nil {
		return nil, fail("model_settings_operation_unavailable", 404)
	}
	if pending(row["phase"]) {
		row, e = s.reconcile(ctx, id)
		if e != nil {
			return nil, e
		}
	}
	if _, e = s.current(ctx, a, "models.read"); e != nil {
		return nil, e
	}
	return s.envelope(operationView(row, false)), nil
}
func (s *Service) History(ctx context.Context, a Actor, input Object) (Object, error) {
	query, e := ParseQuery("history", input)
	if e != nil {
		return nil, e
	}
	if _, e = s.current(ctx, a, "models.read"); e != nil {
		return nil, e
	}
	rows, e := s.Pool.Query(ctx, `SELECT to_jsonb(q) FROM(SELECT o.*,o.sequence::text AS sequence_text,v.version,p.display_name AS operator_display_name FROM operations_model_settings_operations_v1 o LEFT JOIN operations_model_settings_versions_v1 v ON v.id=o.version_id AND v.endpoint=o.endpoint LEFT JOIN operations_operator_principals_v1 p ON p.operator_id=o.operator_id AND p.endpoint=o.endpoint WHERE o.endpoint=$1 AND ($2::bigint IS NULL OR o.sequence<$2::bigint) ORDER BY o.sequence DESC LIMIT $3)q`, s.Endpoint, query["after"], num(query["limit"])+1)
	if e != nil {
		return nil, e
	}
	data := []Object{}
	for rows.Next() {
		var raw []byte
		if e = rows.Scan(&raw); e != nil {
			rows.Close()
			return nil, e
		}
		r, e := decode(raw)
		if e != nil {
			rows.Close()
			return nil, e
		}
		data = append(data, r)
	}
	e = rows.Err()
	rows.Close()
	if e != nil {
		return nil, e
	}
	if _, e = s.current(ctx, a, "models.read"); e != nil {
		return nil, e
	}
	limit := int(num(query["limit"]))
	var next any
	if len(data) > limit {
		next = data[limit-1]["sequence_text"]
		data = data[:limit]
	}
	items := []any{}
	for _, row := range data {
		o := operationView(row, false)
		for k, v := range (Object{"sequence": row["sequence_text"], "operatorId": row["operator_id"], "operatorDisplayName": row["operator_display_name"], "version": row["version"], "changes": row["changes"], "reason": row["reason"]}) {
			o[k] = v
		}
		items = append(items, o)
	}
	return s.envelope(Object{"items": items, "nextAfter": next}), nil
}
func (s *Service) Usage(ctx context.Context, a Actor, input Object) (Object, error) {
	query, e := ParseQuery("usage", input)
	if e != nil {
		return nil, e
	}
	if _, e = s.current(ctx, a, "models.read"); e != nil {
		return nil, e
	}
	var native Object
	if s.Native != nil {
		v, err := s.Native.Call(ctx, Object{"kind": "models-usage", "days": query["days"]})
		if err == nil {
			v, err = ProjectUsage(v)
			if err == nil && num(v["days"]) == num(query["days"]) {
				native = v
			}
		}
	}
	if _, e = s.current(ctx, a, "models.read"); e != nil {
		return nil, e
	}
	out := Object{"availability": Object{"state": "unavailable"}, "days": query["days"], "from": nil, "to": nil, "coverageFrom": nil, "coversWholeWindow": nil, "calls": counts(nil, callKeys), "tokens": counts(nil, tokenKeys), "unknownUsageCalls": nil, "byScenario": []any{}, "byModel": []any{}}
	if native != nil {
		out = native
	}
	source := "not-connected"
	if s.Native != nil {
		source = "native-model-gateway-ledger"
	}
	out["basis"] = Object{"source": source, "billing": "not-provided"}
	return s.envelope(out), nil
}
func (s *Service) AuthorizeNative(ctx context.Context, input Object) (Object, error) {
	x, e := ParseNativeCommand(input, true)
	if e != nil {
		return nil, e
	}
	return postgres.InTx(ctx, s.Pool, func(tx pgx.Tx) (Object, error) {
		row, e := s.operation(ctx, tx, x["operationId"])
		if e != nil {
			return nil, e
		}
		kind, action := "credential-provision", "models.configure"
		if x["kind"] == "models-apply" {
			kind, action = "apply", "models.apply"
		}
		denied := func() (Object, error) { return nil, fail("model_settings_execution_not_authorized", 403) }
		if row == nil || row["kind"] != kind || row["operator_id"] != x["operatorId"] || !has([]string{"submitting", "pending", "result-unknown"}, str(row["phase"])) {
			return denied()
		}
		if s.StoredAuthority == nil {
			return nil, fail("operations_authorization_unavailable", 503)
		}
		if e = s.StoredAuthority.Revalidate(ctx, tx, str(row["operator_id"]), action); e != nil {
			return nil, e
		}
		actor, e := s.StoredAuthority.PersonWithin(ctx, tx, str(row["operator_id"]), false)
		if e != nil {
			return nil, e
		}
		if actor.ID != row["operator_id"] || actor.Endpoint != s.Endpoint || !has(actor.Permissions, action) {
			return denied()
		}
		if kind == "apply" {
			state, e := s.state(ctx, tx)
			if e != nil {
				return nil, e
			}
			version, e := s.version(ctx, tx, row["version_id"])
			if e != nil {
				return nil, e
			}
			if state["pending_operation"] != row["operation_id"] || x["versionId"] != row["version_id"] || !same(x["revision"], obj(row["input"])["expectedRevision"]) || version == nil || !same(x["configuration"], version["configuration"]) {
				return denied()
			}
		} else if x["modelRecordId"] != obj(row["input"])["modelRecordId"] {
			return denied()
		}
		return Object{"authorized": true, "operationId": x["operationId"], "operatorId": actor.ID, "kind": x["kind"], "endpoint": s.Endpoint}, nil
	})
}
