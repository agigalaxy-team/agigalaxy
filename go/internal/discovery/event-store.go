package discovery

import (
	"context"
	"time"
)

func eventIntent(value Object) Object {
	out := merge(Object{}, value)
	delete(out, "occurredAt")
	delete(out, "transport")
	return out
}
func (s *Store) Record(ctx context.Context, event Object) (Object, error) {
	tx, e := s.Pool.Begin(ctx)
	if e != nil {
		return nil, e
	}
	defer tx.Rollback(context.Background())
	if event["accountId"] != nil {
		var exists bool
		if e = tx.QueryRow(ctx, "SELECT EXISTS(SELECT 1 FROM community_accounts WHERE id=$1 AND endpoint=$2)", event["accountId"], s.Endpoint).Scan(&exists); e != nil {
			return nil, e
		}
		if !exists {
			return nil, qualityFailure("discovery_identity_required", 401)
		}
	}
	prior, e := rowObject(ctx, tx, "SELECT payload FROM discovery_usage_events_v1 WHERE endpoint=$1 AND id=$2", s.Endpoint, event["eventId"])
	if e != nil {
		return nil, e
	}
	replayed := prior != nil
	if !replayed {
		tag, e := tx.Exec(ctx, `INSERT INTO discovery_usage_events_v1(endpoint,id,account_id,visitor_id,profile_id,name,purpose,payload,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT DO NOTHING`, s.Endpoint, event["eventId"], event["accountId"], event["visitorId"], event["profileId"], event["name"], event["purpose"], jsonString(event), s.now())
		if e != nil {
			return nil, e
		}
		if tag.RowsAffected() == 0 {
			prior, e = rowObject(ctx, tx, "SELECT payload FROM discovery_usage_events_v1 WHERE endpoint=$1 AND id=$2", s.Endpoint, event["eventId"])
			if e != nil {
				return nil, e
			}
			replayed = true
		}
	}
	if replayed {
		if prior == nil || !sameValue(eventIntent(prior), eventIntent(event)) {
			return nil, qualityFailure("discovery_event_conflict")
		}
		return Object{"accepted": true, "replayed": true, "eventId": event["eventId"]}, tx.Commit(ctx)
	}
	targets := []string{"openpanel"}
	if str(event, "recommendationPurpose") == "public-community-recommendation" && event["itemKey"] != nil {
		targets = append(targets, "gorse")
	}
	for _, target := range targets {
		if _, e = tx.Exec(ctx, "INSERT INTO discovery_delivery_outbox_v1(endpoint,event_id,target) VALUES($1,$2,$3)", s.Endpoint, event["eventId"], target); e != nil {
			return nil, e
		}
	}
	if event["itemKey"] != nil && str(event, "name") == "not-interested" {
		at, e := time.Parse(time.RFC3339Nano, str(event, "occurredAt"))
		if e != nil {
			return nil, invalid()
		}
		if _, e = tx.Exec(ctx, `INSERT INTO discovery_feedback_v1(endpoint,profile_id,item_key,negative,updated_at) VALUES($1,$2,$3,true,$4) ON CONFLICT(endpoint,profile_id,item_key) DO UPDATE SET negative=true,updated_at=excluded.updated_at`, s.Endpoint, event["profileId"], event["itemKey"], at); e != nil {
			return nil, e
		}
	}
	return Object{"accepted": true, "replayed": false, "eventId": event["eventId"]}, tx.Commit(ctx)
}
func (s *Store) Excluded(ctx context.Context, profile string) (map[string]bool, error) {
	rows, e := s.Pool.Query(ctx, "SELECT item_key FROM discovery_feedback_v1 WHERE endpoint=$1 AND profile_id=$2 AND negative", s.Endpoint, profile)
	if e != nil {
		return nil, e
	}
	defer rows.Close()
	out := map[string]bool{}
	for rows.Next() {
		var key string
		if e = rows.Scan(&key); e != nil {
			return nil, e
		}
		out[key] = true
	}
	return out, rows.Err()
}
