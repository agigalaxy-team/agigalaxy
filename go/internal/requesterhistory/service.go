// Package requesterhistory owns the retained facts-v2 requester projection.
package requesterhistory

import (
	"context"
	"encoding/json"
	"errors"
	"github.com/agigalaxy-team/agigalaxy/go/internal/contributions"
	"github.com/agigalaxy-team/agigalaxy/go/internal/deviceauth"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/identity"
	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"time"
)

type Object = map[string]any
type Service struct {
	Pool     *pgxpool.Pool
	Endpoint string
	Devices  *deviceauth.Service
	Sharing  *contributions.Service
	Now      func() time.Time
}

func fail(code string, status int) error { return fault.New(code, status) }
func object(v any) Object                { o, _ := v.(map[string]any); return o }
func text(v any) string                  { s, _ := v.(string); return s }
func str(o Object, key string) string    { return text(o[key]) }
func number(v any) int64 {
	switch v := v.(type) {
	case float64:
		return int64(v)
	case int:
		return int64(v)
	case int64:
		return v
	}
	return 0
}
func array(v any) []any { a, _ := v.([]any); return a }
func absent(e error) bool {
	var f *fault.Error
	return errors.As(e, &f) && (f.Status == 403 || f.Status == 404 || f.Status == 409 || f.Status == 422)
}
func (s *Service) now() int64 {
	if s.Now != nil {
		return s.Now().Unix()
	}
	return time.Now().Unix()
}
func row(ctx context.Context, tx pgx.Tx, sql string, args ...any) (Object, error) {
	var v Object
	e := tx.QueryRow(ctx, sql, args...).Scan(&v)
	if e == pgx.ErrNoRows {
		return nil, nil
	}
	return v, e
}
func rows(ctx context.Context, tx pgx.Tx, sql string, args ...any) ([]Object, error) {
	r, e := tx.Query(ctx, sql, args...)
	if e != nil {
		return nil, e
	}
	defer r.Close()
	out := []Object{}
	for r.Next() {
		var v Object
		if e = r.Scan(&v); e != nil {
			return nil, e
		}
		out = append(out, v)
	}
	return out, r.Err()
}
func (s *Service) run(ctx context.Context, a *deviceauth.Actor, fn func(pgx.Tx) (Object, error)) (Object, error) {
	if s == nil || s.Pool == nil || s.Sharing == nil {
		return nil, fail("requester_history_unavailable", 503)
	}
	tx, e := s.Pool.Begin(ctx)
	if e != nil {
		return nil, e
	}
	defer func() {
		cleanup, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = tx.Rollback(cleanup)
	}()
	if a != nil {
		if s.Devices == nil {
			return nil, fail("requester_history_authority_unavailable", 503)
		}
		if e = s.Devices.AuthorizeWithin(ctx, tx, *a, "assistance"); e != nil {
			return nil, e
		}
	}
	v, e := fn(tx)
	if e != nil {
		return nil, e
	}
	if e = tx.Commit(ctx); e != nil {
		return nil, e
	}
	return v, nil
}

type allowedEvent struct {
	Row, Event Object
	Permission contributions.Permission
}

var factKinds = map[string]bool{"participation-proposed": true, "confirm": true, "propose-scope": true, "confirm-scope": true, "decline-scope": true, "deliver": true, "accept": true, "cancel": true, "close": true, "withdraw": true, "dispute": true, "propose-resolution": true, "confirm-resolution": true, "requester-feedback": true}

func source(v Object) Object {
	return Object{"kind": "task-event", "id": v["id"], "eventVersion": 1, "payloadHash": v["payload_hash"]}
}
func (s *Service) ProjectWithin(ctx context.Context, tx pgx.Tx, a *deviceauth.Actor, id string) (Object, error) {
	task, e := row(ctx, tx, "SELECT to_jsonb(t) FROM task_requests t WHERE id=$1 FOR SHARE", id)
	if e != nil {
		return nil, e
	}
	state := object(task["snapshot"])
	if task == nil || state["contentDeleted"] == true {
		return nil, fail("requester_history_unavailable", 404)
	}
	root, e := row(ctx, tx, "SELECT to_jsonb(e) FROM task_events e WHERE id=$1", task["root_event_id"])
	if e != nil {
		return nil, e
	}
	rootPermission, e := s.Sharing.AuthorizeWithin(ctx, tx, a, "task-event", root, "requester-history")
	if e != nil {
		return nil, e
	}
	events, e := rows(ctx, tx, "SELECT to_jsonb(e) FROM task_events e WHERE task_id=$1 ORDER BY version", id)
	if e != nil {
		return nil, e
	}
	allowed := []allowedEvent{}
	for _, v := range events {
		if v["id"] == task["root_event_id"] {
			continue
		}
		p, e := s.Sharing.AuthorizeWithin(ctx, tx, a, "task-event", v, "requester-history")
		if e != nil {
			if absent(e) {
				continue
			}
			return nil, e
		}
		for _, value := range array(state["events"]) {
			ev := object(value)
			if object(ev["event"])["eventId"] == v["id"] {
				allowed = append(allowed, allowedEvent{v, ev, p})
				break
			}
		}
	}
	facts := []any{}
	acceptances, cancellations, disputes, feedbackCount := 0, 0, 0, 0
	var offer, response *allowedEvent
	intervals := []any{}
	for i := range allowed {
		item := &allowed[i]
		kind := str(item.Row, "kind")
		if kind == "accept" {
			acceptances++
			var payload Object
			if e = json.Unmarshal([]byte(str(item.Row, "payload_text")), &payload); e != nil {
				return nil, e
			}
			event := object(payload["event"])
			if event == nil {
				event = payload
			}
			for _, delivery := range allowed {
				if delivery.Row["id"] == event["deliveryId"] {
					intervals = append(intervals, Object{"seconds": number(item.Event["at"]) - number(delivery.Event["at"]), "deliverySourceId": delivery.Row["id"], "acceptanceSourceId": item.Row["id"]})
					break
				}
			}
		}
		if kind == "cancel" {
			cancellations++
		}
		if kind == "dispute" {
			disputes++
		}
		if offer == nil && kind == "apply" {
			offer = item
		}
		if !factKinds[kind] {
			continue
		}
		feedbackState := ""
		if kind == "requester-feedback" {
			p, e := row(ctx, tx, "SELECT to_jsonb(p) FROM task_participations p WHERE id=$1 FOR SHARE", item.Row["participation_id"])
			if e != nil {
				return nil, e
			}
			if p == nil || object(p["snapshot"])["contentDeleted"] == true {
				continue
			}
			feedbackState = "superseded"
			if object(object(p["snapshot"])["feedback"])["eventId"] == item.Row["id"] {
				feedbackState = "current"
				feedbackCount++
			}
		}
		projection, e := s.Sharing.ProjectWithin(ctx, tx, a, item.Row, item.Permission.Fields, item.Permission)
		if e != nil {
			return nil, e
		}
		authority := "signed-participant-event"
		if kind == "requester-feedback" {
			authority = "provider-reported"
		}
		fact := Object{"source": source(item.Row), "projection": projection, "publicationIds": item.Permission.PublicationIDs, "authority": authority, "independentQualityRating": false}
		if feedbackState != "" {
			fact["feedbackState"] = feedbackState
		}
		facts = append(facts, fact)
	}
	if offer != nil {
		for i := range allowed {
			item := &allowed[i]
			kind := str(item.Row, "kind")
			if item.Row["subject_id"] == task["requester_id"] && number(item.Event["at"]) >= number(offer.Event["at"]) && (kind == "participation-proposed" || kind == "cancel" || kind == "propose-scope") {
				response = item
				break
			}
		}
	}
	var seconds, responseSources any
	if response != nil {
		seconds = number(response.Event["at"]) - number(offer.Event["at"])
		responseSources = Object{"offerSourceId": offer.Row["id"], "responseSourceId": response.Row["id"]}
	}
	projection, e := s.Sharing.ProjectWithin(ctx, tx, a, root, rootPermission.Fields, rootPermission)
	if e != nil {
		return nil, e
	}
	raw, _ := protocol.EncodeJS([]any{s.Endpoint, "requester-history", id})
	return Object{"schemaVersion": 2, "id": identity.Digest(raw), "requesterId": task["requester_id"], "source": source(root), "projection": projection, "facts": facts, "counts": Object{"acceptances": acceptances, "cancellations": cancellations, "disputes": disputes, "currentFeedback": feedbackCount}, "responseSeconds": seconds, "responseSources": responseSources, "acceptanceIntervals": intervals, "responseBasis": "first visible application and later visible requester response; missing is unknown, not unresponsive", "countsMeaning": "currently authorized events in this request; repeat acceptance is not a second request", "settlementCoverage": "not-recorded-by-this-source-profile", "globalScore": nil, "independentQualityRating": false, "maliciousnessConclusion": nil}, nil
}
