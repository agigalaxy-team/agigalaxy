package native

import (
	"context"
	"encoding/json"
	"errors"
	"github.com/agigalaxy-team/agigalaxy/go/internal/identity"
	"github.com/agigalaxy-team/agigalaxy/go/internal/identitygroups"
)

func groupJournalKey(l *nativeIdentityLease) string {
	return "native-identity-group:" + l.scope.Endpoint + ":" + l.scope.Owner + ":identity-group-v2:" + l.scope.Endpoint + ":" + l.scope.Owner
}
func groupJournal(v map[string]any) (map[string]any, error) {
	if v == nil {
		return map[string]any{"pending": []any{}, "receipts": []any{}, "originals": []any{}}, nil
	}
	for _, key := range []string{"pending", "receipts", "originals"} {
		if v[key] == nil {
			v[key] = []any{}
		}
		if _, ok := v[key].([]any); !ok {
			return nil, connectionFailure("identity_group_original_changed")
		}
	}
	return v, nil
}
func groupRowsExcept(rows []any, id string) []any {
	out := []any{}
	for _, r := range rows {
		if uploadObject(r)["proofId"] != id {
			out = append(out, r)
		}
	}
	return out
}
func groupLocator(l *nativeIdentityLease, row map[string]any) map[string]any {
	return map[string]any{"endpoint": l.scope.Endpoint, "ownerId": l.scope.Owner, "operationId": row["operationId"], "groupId": row["groupId"], "proofId": row["proofId"], "payloadHash": row["payloadHash"]}
}
func groupExact(l *nativeIdentityLease, row map[string]any) (map[string]any, map[string]any, error) {
	p, e := identitygroups.ParseIntent([]byte(text(row["payloadJson"])))
	if e != nil {
		return nil, nil, connectionFailure("identity_group_original_changed")
	}
	proof, e := identitygroups.ParseProof([]byte(text(row["proofJson"])))
	if e != nil {
		return nil, nil, connectionFailure("identity_group_original_changed")
	}
	if p["endpoint"] != l.scope.Endpoint || proof["endpoint"] != l.scope.Endpoint || proof["subjectId"] != l.scope.Owner || p["operationId"] != row["operationId"] || p["groupId"] != row["groupId"] || proof["operationId"] != p["operationId"] || proof["groupId"] != p["groupId"] || proof["id"] != row["proofId"] || proof["payloadHash"] != row["payloadHash"] || groupInt(proof["expiresAt"]) != groupInt(p["expiresAt"]) || identity.Digest([]byte(text(row["payloadJson"]))) != row["payloadHash"] {
		return nil, nil, connectionFailure("identity_group_original_changed")
	}
	return p, proof, nil
}
func groupFind(ctx context.Context, l *nativeIdentityLease, id string, archive bool) (map[string]any, error) {
	j, e := l.read(ctx, groupJournalKey(l))
	if e != nil {
		return nil, e
	}
	j, e = groupJournal(j)
	if e != nil {
		return nil, e
	}
	rows := uploadRows(j["pending"])
	if archive {
		rows = append(append([]any{}, rows...), uploadRows(j["originals"])...)
	}
	for _, v := range rows {
		r := uploadObject(v)
		if r["proofId"] == id {
			return r, nil
		}
	}
	return nil, connectionFailure("identity_group_local_operation_unavailable")
}
func groupReplace(ctx context.Context, l *nativeIdentityLease, row, change map[string]any) (map[string]any, error) {
	var saved map[string]any
	e := l.update(ctx, groupJournalKey(l), func(v map[string]any) (map[string]any, error) {
		j, e := groupJournal(v)
		if e != nil {
			return nil, e
		}
		found := false
		rows := []any{}
		for _, v := range uploadRows(j["pending"]) {
			old := uploadObject(v)
			if old["proofId"] == row["proofId"] {
				if !connectionEqual(old, row) {
					return nil, connectionFailure("identity_group_operation_changed")
				}
				if old["state"] == "stopped-local" && change["state"] != "stopped-local" {
					return nil, connectionFailure("identity_group_local_retry_stopped")
				}
				saved = identityClone(row)
				for k, v := range change {
					saved[k] = v
				}
				saved["journalRevision"] = groupInt(row["journalRevision"]) + 1
				rows = append(rows, saved)
				found = true
			} else {
				rows = append(rows, old)
			}
		}
		if !found {
			return nil, connectionFailure("identity_group_operation_changed")
		}
		j["pending"] = rows
		return j, nil
	})
	return saved, e
}
func groupClosed(state string) bool {
	return isOne(state, "committed", "declined", "cancelled", "conflict", "expired")
}
func groupStatus(l *nativeIdentityLease, row, result map[string]any) (map[string]any, error) {
	if result["operationId"] != row["operationId"] || result["state"] != "absent" && (result["groupId"] != row["groupId"] || result["payloadHash"] != row["payloadHash"]) {
		return nil, connectionFailure("identity_group_receipt_mismatch")
	}
	own := false
	if ids, ok := result["acknowledgedProofIds"].([]any); ok {
		for _, id := range ids {
			own = own || id == row["proofId"]
		}
	} else {
		for _, v := range uploadRows(result["approvals"]) {
			a := uploadObject(v)
			own = own || a["id"] == row["proofId"] && a["subjectId"] == l.scope.Owner
		}
	}
	out := identityClone(result)
	out["locator"] = groupLocator(l, row)
	out["operationState"] = result["state"]
	out["ownApprovalAcknowledged"] = own
	out["operationClosed"] = groupClosed(text(result["state"]))
	out["serverCancellationConfirmed"] = result["state"] == "cancelled"
	return out, nil
}
func groupSettle(ctx context.Context, l *nativeIdentityLease, row, status map[string]any) (map[string]any, error) {
	if status["ownApprovalAcknowledged"] != true && status["operationClosed"] != true {
		return status, nil
	}
	e := l.update(ctx, groupJournalKey(l), func(v map[string]any) (map[string]any, error) {
		j, e := groupJournal(v)
		if e != nil {
			return nil, e
		}
		var found map[string]any
		for _, v := range uploadRows(j["pending"]) {
			r := uploadObject(v)
			if connectionEqual(groupLocator(l, r), groupLocator(l, row)) {
				found = r
				break
			}
		}
		if found == nil {
			return j, nil
		}
		original := identityClone(found)
		original["receipt"] = status
		if found["state"] != "stopped-local" {
			if status["ownApprovalAcknowledged"] == true {
				original["state"] = "acknowledged"
			} else {
				original["state"] = "operation-closed"
			}
		}
		id := text(row["proofId"])
		j["pending"] = groupRowsExcept(uploadRows(j["pending"]), id)
		j["originals"] = append([]any{original}, groupRowsExcept(uploadRows(j["originals"]), id)...)
		receipt := groupLocator(l, row)
		receipt["result"] = status
		receipts := append([]any{receipt}, groupRowsExcept(uploadRows(j["receipts"]), id)...)
		j["receipts"] = receipts[:min(len(receipts), 50)]
		return j, nil
	})
	return status, e
}
func groupReconcile(ctx context.Context, l *nativeIdentityLease, row map[string]any) (map[string]any, error) {
	if _, _, e := groupExact(l, row); e != nil {
		return nil, e
	}
	receipt, e := l.call(ctx, "/v2/identity-groups/receipt", map[string]any{"operationId": row["operationId"], "payloadHash": row["payloadHash"]}, false)
	if e != nil {
		return nil, e
	}
	status, e := groupStatus(l, row, receipt)
	if e != nil {
		return nil, e
	}
	return groupSettle(ctx, l, row, status)
}
func groupBusinessRejected(e error) bool {
	var h *ConnectionHTTPError
	if !errors.As(e, &h) || h.Outcome != "rejected" || h.Status < 400 || h.Status >= 500 || isOneInt(h.Status, 401, 408, 429) {
		return false
	}
	return !isOne(h.Code, "unauthorized", "binding_revoked", "binding_unavailable", "invalid_session", "session_expired", "access_denied", "connection_required", "browser_origin_not_enabled", "browser_preflight_denied", "identity_group_control_changed", "identity_control_stale")
}
func isOneInt(v int, all ...int) bool {
	for _, n := range all {
		if n == v {
			return true
		}
	}
	return false
}
func groupSend(ctx context.Context, l *nativeIdentityLease, row map[string]any) (map[string]any, error) {
	if _, _, e := groupExact(l, row); e != nil {
		return nil, e
	}
	row, e := groupReplace(ctx, l, row, map[string]any{"attempted": true})
	if e != nil {
		return nil, e
	}
	result, e := l.call(ctx, "/v2/identity-groups/submit", map[string]any{"payloadJson": row["payloadJson"], "proofJson": row["proofJson"], "signature": row["signature"]}, false)
	if e != nil {
		if groupBusinessRejected(e) {
			var h *ConnectionHTTPError
			_ = errors.As(e, &h)
			_, save := groupReplace(ctx, l, row, map[string]any{"blockedReason": "business-declined", "businessFailure": map[string]any{"code": h.Code, "status": h.Status}})
			if save != nil {
				return nil, save
			}
		}
		return nil, e
	}
	status, e := groupStatus(l, row, result)
	if e != nil {
		return nil, e
	}
	if status["ownApprovalAcknowledged"] != true && status["operationClosed"] != true {
		return nil, connectionFailure("identity_group_receipt_mismatch")
	}
	return groupSettle(ctx, l, row, status)
}

func groupInt(v any) int64 {
	switch n := v.(type) {
	case json.Number:
		f, _ := n.Float64()
		return int64(f)
	case float64:
		return int64(n)
	case int64:
		return n
	case int:
		return int64(n)
	default:
		return 0
	}
}
