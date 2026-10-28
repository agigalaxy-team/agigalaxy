package feedback

import (
	"context"
	"encoding/json"
	"errors"
	"reflect"
	"time"

	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/identity"
	"github.com/agigalaxy-team/agigalaxy/go/internal/postgres"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

func (s *Service) read(ctx context.Context, operator, action string, selection Object, fn func(pgx.Tx, Operator) (Object, error)) (Object, error) {
	return postgres.InTx(ctx, s.Pool, func(tx pgx.Tx) (Object, error) {
		a, e := s.operator(ctx, tx, operator, "feedback.read")
		if e != nil {
			return nil, e
		}
		out, e := fn(tx, a)
		if e != nil {
			return nil, e
		}
		var count any
		if items, ok := out["items"].([]Object); ok {
			count = len(items)
		}
		if e = s.record(ctx, tx, a, action, "", selection, Object{"count": count}); e != nil {
			return nil, e
		}
		return out, nil
	})
}
func (s *Service) Update(ctx context.Context, operator, id string, raw []byte) (Object, error) {
	if !uuidPattern.MatchString(id) {
		return nil, invalid()
	}
	x, e := ParseUpdate(raw)
	if e != nil {
		return nil, e
	}
	var selection Object
	b, _ := json.Marshal(x)
	_ = json.Unmarshal(b, &selection)
	delete(selection, "note")
	selection["id"] = id
	selection["resourceId"] = id
	selection["noteHash"] = nil
	if x.Note != nil {
		selection["noteHash"] = identity.Digest([]byte(*x.Note))
	}
	result, e := postgres.InTx(ctx, s.Pool, func(tx pgx.Tx) (Object, error) {
		a, e := s.operator(ctx, tx, operator, "feedback.update")
		if e != nil {
			return nil, e
		}
		if a.RequestID == "" {
			a.RequestID = s.RequestID
		}
		if _, e = tx.Exec(ctx, "SELECT pg_advisory_xact_lock(hashtextextended($1,734912391))", s.Endpoint+":operations:"+x.OperationID); e != nil {
			return nil, e
		}
		var priorActor, action string
		var oldSelection, oldResult []byte
		e = tx.QueryRow(ctx, "SELECT operator_id,action,selection,result FROM business_admin_audit_v1 WHERE endpoint=$1 AND operation_id=$2", s.Endpoint, x.OperationID).Scan(&priorActor, &action, &oldSelection, &oldResult)
		if e == nil {
			var previous Object
			if json.Unmarshal(oldSelection, &previous) != nil {
				return nil, fault.New("feedback_operation_unavailable", 503)
			}
			if priorActor != a.ID || action != "feedback-update" || !reflect.DeepEqual(previous, selection) {
				return nil, fault.New("business_admin_operation_conflict", 409)
			}
			var r Object
			if json.Unmarshal(oldResult, &r) != nil {
				return nil, fault.New("feedback_operation_unavailable", 503)
			}
			r["replayed"] = true
			return r, nil
		}
		if !errors.Is(e, pgx.ErrNoRows) {
			return nil, e
		}
		r, e := s.head(ctx, tx, id, true)
		if e != nil {
			return nil, e
		}
		if r.revision != x.ExpectedRevision {
			return nil, fault.New("feedback_revision_conflict", 409)
		}
		category, module, state := r.category, r.module, r.state
		if len(x.Category) > 0 {
			category = nil
			if e = json.Unmarshal(x.Category, &category); e != nil {
				return nil, invalid()
			}
		}
		if x.Module != nil {
			module = *x.Module
		}
		if x.State != nil {
			state = *x.State
		}
		if x.Note == nil && reflect.DeepEqual(category, r.category) && module == r.module && state == r.state {
			return nil, fault.New("feedback_no_change", 409)
		}
		now := s.now()
		revision := r.revision + 1
		_, e = tx.Exec(ctx, `UPDATE operations_feedback_v1 SET category=$3,module=$4,state=$5,revision=$6,updated_at=$7 WHERE id=$1 AND endpoint=$2`, id, s.Endpoint, category, module, state, revision, now)
		if e != nil {
			return nil, e
		}
		_, e = tx.Exec(ctx, `INSERT INTO operations_feedback_events_v1(id,feedback_id,endpoint,kind,operator_id,operation_id,revision,category,module,state,note,http_request_id,created_at)
		 VALUES($1,$2,$3,'updated',$4,$5,$6,$7,$8,$9,$10,$11,$12)`, uuid.NewString(), id, s.Endpoint, a.ID, x.OperationID, revision, category, module, state, x.Note, nullable(a.RequestID), now)
		if e != nil {
			return nil, e
		}
		result := Object{"feedbackId": id, "revision": revision, "operationId": x.OperationID, "recordedAt": iso(now)}
		if e = s.record(ctx, tx, a, "feedback-update", x.OperationID, selection, result); e != nil {
			return nil, e
		}
		return result, nil
	})
	if e != nil {
		return nil, e
	}
	out, e := s.Get(ctx, operator, id, "")
	if e != nil {
		return nil, e
	}
	out["operationId"] = x.OperationID
	out["replayed"] = result["replayed"] == true
	return out, nil
}
func (s *Service) Operation(ctx context.Context, operator, id, op string) (Object, error) {
	if !uuidPattern.MatchString(id) || !uuidPattern.MatchString(op) {
		return nil, invalid()
	}
	return postgres.InTx(ctx, s.Pool, func(tx pgx.Tx) (Object, error) {
		a, e := s.operator(ctx, tx, operator, "feedback.read")
		if e != nil {
			return nil, e
		}
		now := s.now().Unix()
		out := Object{"state": "not-recorded", "operationId": op, "feedbackId": id, "checkedAt": now, "readExpiresAt": now + 30, "metadataOnly": true, "action": nil, "selection": nil, "result": nil, "recordedAt": nil}
		var who, action string
		var sb, rb []byte
		e = tx.QueryRow(ctx, "SELECT operator_id,action,selection,result FROM business_admin_audit_v1 WHERE endpoint=$1 AND operation_id=$2", s.Endpoint, op).Scan(&who, &action, &sb, &rb)
		if errors.Is(e, pgx.ErrNoRows) {
			_, e = s.operator(ctx, tx, operator, "feedback.read")
			return out, e
		}
		if e != nil {
			return nil, e
		}
		var selection, result Object
		if json.Unmarshal(sb, &selection) != nil || json.Unmarshal(rb, &result) != nil {
			return nil, fault.New("feedback_operation_unavailable", 503)
		}
		if who != a.ID || action != "feedback-update" || selection["id"] != id || selection["resourceId"] != id {
			return nil, fault.New("not_found", 404)
		}
		if !validReceipt(selection, result, id, op) {
			return nil, fault.New("feedback_operation_unavailable", 503)
		}
		delete(selection, "id")
		delete(selection, "resourceId")
		delete(selection, "operationId")
		out["state"] = "recorded"
		out["action"] = action
		out["selection"] = selection
		out["result"] = result
		out["recordedAt"] = result["recordedAt"]
		_, e = s.operator(ctx, tx, operator, "feedback.read")
		return out, e
	})
}
func validReceipt(selection, result Object, id, op string) bool {
	// Decode through the same strict command contract; never disclose legacy,
	// malformed or unrelated audit JSON as a private feedback receipt.
	copy := Object{}
	for k, v := range selection {
		if k != "id" && k != "resourceId" && k != "noteHash" {
			copy[k] = v
		}
	}
	noteHash, ok := selection["noteHash"]
	if !ok {
		return false
	}
	if noteHash != nil {
		h, ok := noteHash.(string)
		if !ok || !hashPattern.MatchString(h) {
			return false
		}
		copy["note"] = "receipt-only"
	}
	b, e := json.Marshal(copy)
	if e != nil {
		return false
	}
	x, e := ParseUpdate(b)
	if e != nil {
		return false
	}
	allowed := map[string]bool{"id": true, "resourceId": true, "operationId": true, "expectedRevision": true, "noteHash": true, "category": true, "module": true, "state": true}
	for k := range selection {
		if !allowed[k] {
			return false
		}
	}
	if len(result) != 4 || result["feedbackId"] != id || result["operationId"] != op || x.OperationID != op {
		return false
	}
	revision, ok := result["revision"].(float64)
	if !ok || revision != float64(x.ExpectedRevision+1) {
		return false
	}
	at, ok := result["recordedAt"].(string)
	if !ok {
		return false
	}
	_, e = time.Parse(time.RFC3339Nano, at)
	return e == nil
}
