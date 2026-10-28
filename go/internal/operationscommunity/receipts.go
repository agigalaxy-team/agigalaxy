package operationscommunity

import (
	"context"
	"github.com/agigalaxy-team/agigalaxy/go/internal/identity"
	"github.com/agigalaxy-team/agigalaxy/go/internal/postgres"
	"github.com/jackc/pgx/v5"
)

// CommandResult only projects the original committed operation metadata. It
// does not reconstruct an acknowledgement from today's mutable source view.
func (s *Service) CommandResult(ctx context.Context, a Actor, family, id, operation string) (Object, error) {
	if !validID(id) || !validID(operation) || !has([]string{"section", "case"}, family) {
		return nil, fail("invalid_operations_command_receipt", 400)
	}
	action := "community-section-read"
	if family == "case" {
		action = "community-report-read"
	}
	return postgres.InTx(ctx, s.Pool, func(tx pgx.Tx) (Object, error) {
		current, e := s.domain().Operation(ctx, tx, a, action, Object{"id": id})
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
		var kind, result any
		if r != nil {
			if str(r, "operator_id") != a.ID {
				return nil, fail("operations_command_receipt_not_found", 404)
			}
			state = "unknown"
			selection, original := obj(r, "selection"), obj(r, "result")
			name := str(r, "action")
			valid := str(r, "actor_kind") == "business-operator" && str(selection, "id") == id && str(selection, "operationId") == operation && str(original, "operationId") == operation && iso(original["recordedAt"]) != nil
			out := Object{}
			if valid {
				switch name {
				case "community-section-classify":
					valid = family == "section" && str(original, "sectionId") == id && num(original, "version") == num(selection, "expectedVersion")+1 && original["category"] == selection["category"] && has(categories, str(original, "category"))
					for _, k := range []string{"sectionId", "version", "category"} {
						out[k] = original[k]
					}
				case "community-section-visibility":
					v := obj(original, "visibility")
					hide := str(selection, "kind") == "hide"
					var until any
					if hide {
						until = iso(stamp(num(selection, "until")))
					}
					valid = family == "section" && str(obj(original, "target"), "id") == id && str(obj(original, "target"), "kind") == "forum-section" && num(original, "sourceVersion") == num(selection, "expectedVersion") && num(v, "version") == num(selection, "expectedVisibilityVersion")+1 && str(v, "operationId") == operation && yes(v, "hidden") == hide && v["until"] == until && original["sourcePermissionChanged"] == false
					for _, k := range []string{"target", "sourceVersion", "visibility", "sourcePermissionChanged"} {
						out[k] = original[k]
					}
					out["target"] = Object{"kind": obj(original, "target")["kind"], "id": obj(original, "target")["id"]}
					out["visibility"] = receiptVisibility(v)
				case "community-report-resolve":
					expected := str(selection, "restrictionAction")
					if expected == "" {
						expected = "keep"
						if selection["hideUntil"] != nil {
							expected = "hide"
						}
					}
					valid = family == "case" && str(original, "reportId") == id && num(original, "version") == num(selection, "expectedVersion")+1 && str(original, "state") == "resolved" && original["resolution"] == selection["resolution"] && str(original, "restrictionAction") == expected
					if expected == "release" {
						valid = valid && original["effectUntil"] == nil && original["restrictionEventId"] == nil
					}
					if expected == "hide" {
						valid = valid && original["effectUntil"] == iso(stamp(num(selection, "hideUntil"))) && original["restrictionEventId"] == operation
					}
					for _, k := range []string{"reportId", "version", "state", "resolution", "restrictionAction", "restrictionEventId", "effectUntil"} {
						out[k] = original[k]
					}
				default:
					valid = false
				}
			}
			if valid {
				raw, e := identity.Canonical(Object{"action": name, "selection": selection})
				if e != nil {
					return nil, e
				}
				out["recordedAt"], out["intentHash"] = original["recordedAt"], digest(string(raw))
				kind, result, state = name, out, "recorded"
			}
		}
		if _, e = s.domain().Operation(ctx, tx, current, action, Object{"id": id}); e != nil {
			return nil, e
		}
		return Object{"state": state, "operationId": operation, "kind": kind, "result": result, "checkedAt": s.now(), "readExpiresAt": s.now() + 30, "metadataOnly": true}, nil
	})
}
