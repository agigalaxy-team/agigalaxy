package operationscommunity

import (
	"context"
	"github.com/agigalaxy-team/agigalaxy/go/internal/businessadmin"
	"github.com/agigalaxy-team/agigalaxy/go/internal/identity"
	"github.com/jackc/pgx/v5"
)

// OriginalAIReceiptWithin projects only the validated original AI visibility
// receipt after current human authorization; it cannot execute a command.
func (s *Service) OriginalAIReceiptWithin(ctx context.Context, tx pgx.Tx, human Actor, src businessadmin.OriginalAIReceiptSource) (Object, error) {
	d := s.domain()
	if human.AIProof != nil || d.IsDuty(human) || d.IsExecution(human) {
		return nil, fail("business_admin_denied", 403)
	}
	current, e := d.Operation(ctx, tx, human, "community-content-read", Object{})
	if e != nil {
		return nil, e
	}
	if e = d.Principal(ctx, tx, current); e != nil {
		return nil, e
	}
	out := Object{"state": "unknown", "operationId": src.OperationID, "metadataOnly": true}
	row, state, e := d.OriginalAIRecordWithin(ctx, tx, src)
	if e != nil {
		return nil, e
	}
	if state == "mismatch" {
		return nil, fail("not_found", 404)
	}
	out["state"] = state
	if state == "recorded" {
		id, kind, action := str(src.Request, "targetId"), str(src.Request, "targetKind"), str(src.Request, "action")
		if src.Request["kind"] != "content-visibility" || !validID(id) || !has([]string{"post", "reply"}, kind) || !has([]string{"hide", "restore"}, action) || (src.Command["operationId"] != nil && src.Command["operationId"] != src.OperationID) || src.Command["kind"] != action {
			return nil, fail("not_found", 404)
		}
		for _, key := range []string{"reason", "until"} {
			want, present := src.Request[key]
			got, exists := src.Command[key]
			x, err1 := identity.Canonical([]any{want})
			y, err2 := identity.Canonical([]any{got})
			if present != exists || err1 != nil || err2 != nil || string(x) != string(y) {
				return nil, fail("not_found", 404)
			}
		}
		input := copyObject(src.Command)
		input["operationId"] = src.OperationID
		command, err := parseContentWrite(input, "visibility")
		if err != nil {
			return nil, fail("not_found", 404)
		}
		expected := copyObject(command)
		delete(expected, "reason")
		expected["targetKind"], expected["id"], expected["resourceId"], expected["reasonDigest"] = kind, id, id, digest(str(command, "reason"))
		selection, result := obj(row, "selection"), obj(row, "result")
		x, err1 := identity.Canonical(expected)
		y, err2 := identity.Canonical(selection)
		if err1 != nil || err2 != nil || string(x) != string(y) || row["action"] != "community-content-visibility" || result["operationId"] != src.OperationID || result["kind"] != kind || result["id"] != id || iso(result["recordedAt"]) == nil || !compatibleVisibility(obj(result, "visibility"), selection, src.OperationID) {
			return nil, fail("not_found", 404)
		}
		out = Object{"state": "recorded", "operationId": src.OperationID, "action": "content." + action, "targetType": "content-" + kind, "targetId": id, "version": obj(result, "visibility")["version"], "recordedAt": result["recordedAt"], "metadataOnly": true}
	}
	current, e = d.Operation(ctx, tx, current, "community-content-read", Object{})
	if e != nil {
		return nil, e
	}
	if e = d.Principal(ctx, tx, current); e != nil {
		return nil, e
	}
	return out, nil
}
