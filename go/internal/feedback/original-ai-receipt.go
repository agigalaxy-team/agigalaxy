package feedback

import (
	"context"
	"encoding/json"
	"reflect"

	"github.com/agigalaxy-team/agigalaxy/go/internal/businessadmin"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/identity"
	"github.com/agigalaxy-team/agigalaxy/go/internal/operationspermissions"
	"github.com/jackc/pgx/v5"
)

// OriginalAIReceiptWithin reads only the audit belonging to the original
// frozen AI operation, under the current human's feedback read authority.
func (o *Operations) OriginalAIReceiptWithin(ctx context.Context, tx pgx.Tx, human operationspermissions.Actor, src businessadmin.OriginalAIReceiptSource) (Object, error) {
	if o == nil || o.Domain == nil || o.Service == nil || o.Service.Endpoint != o.Domain.Endpoint || human.AIProof != nil || o.Domain.IsDuty(human) || o.Domain.IsExecution(human) {
		return nil, fault.New("business_admin_denied", 403)
	}
	fresh, e := o.Domain.Fresh(ctx, tx, human, "feedback.read")
	if e != nil {
		return nil, e
	}
	if e = o.Domain.Principal(ctx, tx, fresh); e != nil {
		return nil, e
	}
	out := Object{"state": "unknown", "operationId": src.OperationID, "metadataOnly": true}
	row, state, e := o.Domain.OriginalAIRecordWithin(ctx, tx, src)
	if e != nil {
		return nil, e
	}
	if state == "mismatch" {
		return nil, fault.New("not_found", 404)
	}
	out["state"] = state
	if state == "recorded" {
		id, _ := src.Request["targetId"].(string)
		if src.Request["kind"] != "feedback-update" || !uuidPattern.MatchString(id) || (src.Command["operationId"] != nil && src.Command["operationId"] != src.OperationID) {
			return nil, fault.New("not_found", 404)
		}
		for _, key := range []string{"category", "module", "state", "note"} {
			want, present := src.Request[key]
			got, exists := src.Command[key]
			x, err1 := identity.Canonical([]any{want})
			y, err2 := identity.Canonical([]any{got})
			if present != exists || err1 != nil || err2 != nil || string(x) != string(y) {
				return nil, fault.New("not_found", 404)
			}
		}
		input := Object{}
		for k, v := range src.Command {
			input[k] = v
		}
		input["operationId"] = src.OperationID
		raw, err := json.Marshal(input)
		if err != nil {
			return nil, fault.New("not_found", 404)
		}
		command, err := ParseUpdate(raw)
		if err != nil {
			return nil, fault.New("not_found", 404)
		}
		normalized, err := json.Marshal(command)
		if err != nil {
			return nil, err
		}
		expected := Object{}
		if json.Unmarshal(normalized, &expected) != nil {
			return nil, fault.New("not_found", 404)
		}
		delete(expected, "note")
		expected["id"], expected["resourceId"], expected["noteHash"] = id, id, nil
		if command.Note != nil {
			expected["noteHash"] = identity.Digest([]byte(*command.Note))
		}
		selection, _ := row["selection"].(map[string]any)
		result, _ := row["result"].(map[string]any)
		if row["action"] != "feedback-update" || !reflect.DeepEqual(selection, expected) || !validReceipt(selection, result, id, src.OperationID) {
			return nil, fault.New("not_found", 404)
		}
		out = Object{"state": "recorded", "operationId": src.OperationID, "action": "feedback.update", "targetType": "feedback", "targetId": id, "version": result["revision"], "recordedAt": result["recordedAt"], "metadataOnly": true}
	}
	fresh, e = o.Domain.Fresh(ctx, tx, fresh, "feedback.read")
	if e != nil {
		return nil, e
	}
	if e = o.Domain.Principal(ctx, tx, fresh); e != nil {
		return nil, e
	}
	return out, nil
}
