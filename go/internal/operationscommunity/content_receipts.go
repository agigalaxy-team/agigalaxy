package operationscommunity

import (
	"context"
	"github.com/agigalaxy-team/agigalaxy/go/internal/identity"
	"github.com/agigalaxy-team/agigalaxy/go/internal/postgres"
	"github.com/jackc/pgx/v5"
)

func (s *Service) ContentCommandResult(ctx context.Context, a Actor, family, kind, id, operation string) (Object, error) {
	if !validID(operation) || !has([]string{"content", "batch", "tag"}, family) || family == "content" && (!has([]string{"post", "reply"}, kind) || !validID(id)) {
		return nil, fail("invalid_operations_command_receipt", 400)
	}
	action := "community-content-read"
	if family == "tag" {
		action = "community-tags-query"
	}
	return postgres.InTx(ctx, s.Pool, func(tx pgx.Tx) (Object, error) {
		current, e := s.domain().Operation(ctx, tx, a, action, Object{})
		if e != nil {
			return nil, e
		}
		if s.domain().IsDuty(current) || s.domain().IsExecution(current) {
			return nil, fail("business_admin_denied", 403)
		}
		r, missing, e := s.domain().OperationRecordWithin(ctx, tx, operation)
		if e != nil {
			return nil, fail("operations_command_receipt_unavailable", 503)
		}
		state := "not-recorded"
		if missing {
			state = "unknown"
		}
		var result, name any
		if r != nil {
			if str(r, "operator_id") != a.ID {
				return nil, fail("operations_command_receipt_not_found", 404)
			}
			state = "unknown"
			selection, original := obj(r, "selection"), obj(r, "result")
			action := str(r, "action")
			valid := str(r, "actor_kind") == "business-operator" && str(selection, "operationId") == operation && str(original, "operationId") == operation && iso(original["recordedAt"]) != nil
			out := Object{}
			if valid {
				switch action {
				case "community-content-curation":
					valid = family == "content" && str(selection, "kind") == kind && str(selection, "id") == id && str(original, "kind") == kind && str(original, "id") == id && num(original, "sourceVersion") == num(selection, "expectedVersion") && num(original, "revision") == num(selection, "expectedRevision")+1
					valid = valid && integer(original["sourceVersion"], 0, 9007199254740991) && integer(original["revision"], 1, 9007199254740991) && integer(selection["expectedVersion"], 0, 9007199254740991) && integer(selection["expectedRevision"], 0, 9007199254740991)
					for _, k := range []string{"kind", "id", "revision", "sourceVersion"} {
						out[k] = original[k]
					}
				case "community-content-visibility":
					valid = family == "content" && str(selection, "targetKind") == kind && str(selection, "id") == id && str(original, "kind") == kind && str(original, "id") == id && compatibleVisibility(obj(original, "visibility"), selection, operation)
					for _, k := range []string{"kind", "id", "visibility"} {
						out[k] = original[k]
					}
					out["visibility"] = receiptVisibility(obj(original, "visibility"))
				case "community-tag-create", "community-tag-update":
					tag := obj(original, "tag")
					_, enabledOK := tag["enabled"].(bool)
					valid = family == "tag" && validID(str(tag, "id")) && (selection["id"] == nil || str(selection, "id") == str(tag, "id")) && integer(tag["version"], 1, 9007199254740991) && enabledOK && num(tag, "version") == num(selection, "expectedVersion")+1 && (selection["enabled"] == nil || selection["enabled"] == tag["enabled"])
					out["tag"] = Object{"id": tag["id"], "version": tag["version"], "enabled": tag["enabled"]}
				case "community-content-batch-visibility":
					valid = family == "batch"
					input, _ := selection["items"].([]any)
					items, _ := original["items"].([]any)
					counts := obj(original, "counts")
					valid = valid && len(items) > 0 && len(items) <= 25 && len(items) == len(input) && num(counts, "applied")+num(counts, "rejected") == int64(len(items))
					valid = valid && integer(counts["applied"], 0, 9007199254740991) && integer(counts["rejected"], 0, 9007199254740991)
					projected := []Object{}
					applied := 0
					if valid {
						for i, v := range items {
							item := obj(Object{"v": v}, "v")
							wanted := obj(Object{"v": input[i]}, "v")
							status := str(item, "status")
							if !has([]string{"post", "reply"}, str(item, "kind")) || !validID(str(item, "id")) || str(item, "kind") != str(wanted, "kind") || str(item, "id") != str(wanted, "id") || !has([]string{"applied", "rejected"}, status) {
								valid = false
								break
							}
							value := Object{"kind": item["kind"], "id": item["id"], "status": status, "code": nil}
							if status == "applied" {
								applied++
								command := copyObject(wanted)
								command["kind"], command["until"] = selection["kind"], selection["until"]
								if !compatibleVisibility(obj(item, "visibility"), command, operation) {
									valid = false
									break
								}
								value["visibility"] = receiptVisibility(obj(item, "visibility"))
							} else if has([]string{"operations_source_changed", "operations_visibility_changed", "operations_source_unavailable", "operations_hide_expiry", "operations_permission_denied", "business_admin_denied", "not_found"}, str(item, "code")) {
								value["code"] = item["code"]
							}
							projected = append(projected, value)
						}
					}
					valid = valid && int64(applied) == num(counts, "applied")
					out["items"], out["counts"] = projected, Object{"applied": counts["applied"], "rejected": counts["rejected"]}
				default:
					valid = false
				}
			}
			if valid {
				raw, e := identity.Canonical(Object{"action": action, "selection": selection})
				if e != nil {
					return nil, e
				}
				out["recordedAt"], out["intentHash"] = original["recordedAt"], digest(string(raw))
				name, result, state = action, out, "recorded"
			}
		}
		if _, e = s.domain().Operation(ctx, tx, current, action, Object{}); e != nil {
			return nil, e
		}
		return Object{"state": state, "operationId": operation, "kind": name, "result": result, "checkedAt": s.now(), "readExpiresAt": s.now() + 30, "metadataOnly": true}, nil
	})
}
func compatibleVisibility(v, selection Object, operation string) bool {
	hide := str(selection, "kind") == "hide"
	var until any
	if hide {
		until = iso(stamp(num(selection, "until")))
	}
	_, hiddenOK := v["hidden"].(bool)
	return integer(v["version"], 1, 9007199254740991) && integer(selection["expectedRevision"], 0, 9007199254740991) && hiddenOK && num(v, "version") == num(selection, "expectedRevision")+1 && str(v, "operationId") == operation && yes(v, "hidden") == hide && v["until"] == until
}
func receiptVisibility(v Object) Object {
	return Object{"version": v["version"], "hidden": v["hidden"], "until": v["until"], "operationId": v["operationId"]}
}
