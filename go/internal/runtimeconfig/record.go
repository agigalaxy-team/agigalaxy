// Package runtimeconfig records the original append-only runtime observations.
// It does not authorize configuration changes or manufacture unloaded values.
package runtimeconfig

import (
	"context"
	"errors"
	"strconv"
	"time"

	"github.com/agigalaxy-team/agigalaxy/go/internal/identity"
	"github.com/agigalaxy-team/agigalaxy/go/internal/incident"
	"github.com/agigalaxy-team/agigalaxy/go/internal/postgres"
	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

func canonical(v any) ([]byte, error) {
	b, e := identity.Canonical([]any{v})
	if e != nil {
		return nil, e
	}
	return b[1 : len(b)-1], nil
}
func jsonText(v any) string { b, _ := protocol.Encode(v); return string(b) }

type Options struct{ Now func() time.Time }
type Event struct {
	Sequence    string `json:"sequence"`
	ID          string `json:"id"`
	Endpoint    string `json:"endpoint"`
	Component   string `json:"component"`
	CommandHash string `json:"command_hash"`
	Payload     Object `json:"payload"`
	EventHash   string `json:"event_hash"`
	CreatedAt   string `json:"created_at"`
}

const eventColumns = "sequence::text,id::text,endpoint,component,command_hash,payload,event_hash,created_at"

func scan(row pgx.Row) (Event, error) {
	var v Event
	var at time.Time
	e := row.Scan(&v.Sequence, &v.ID, &v.Endpoint, &v.Component, &v.CommandHash, &v.Payload, &v.EventHash, &at)
	v.CreatedAt = at.UTC().Format("2006-01-02T15:04:05.000Z")
	return v, e
}
func VerifyEvent(row Event) error {
	p := row.Payload
	parsed, e := command(Object{"id": p["id"], "endpoint": p["endpoint"], "component": p["component"], "operatorRef": p["operatorRef"], "snapshot": p["snapshot"]})
	if e != nil {
		return e
	}
	if row.ID != p["id"] || row.Endpoint != p["endpoint"] || row.Component != p["component"] || row.CommandHash != hash(parsed) || p["commandHash"] != row.CommandHash || p["configurationHash"] != hash(p["snapshot"]) || row.EventHash != hash(p) {
		return mismatch("Runtime configuration event mismatch")
	}
	return nil
}
func Record(ctx context.Context, pool *pgxpool.Pool, input Object, o Options) (Event, error) {
	raw := object(clone(input))
	if raw["id"] == nil {
		raw["id"] = uuid.NewString()
	}
	prepared, rules, e := prepareRegistries(raw)
	if e != nil {
		return Event{}, e
	}
	cmd, e := command(prepared)
	if e != nil {
		return Event{}, e
	}
	commandHash := hash(cmd)
	return postgres.InTx(ctx, pool, func(tx pgx.Tx) (Event, error) {
		if _, e := tx.Exec(ctx, "SELECT pg_advisory_xact_lock(734912308)"); e != nil {
			return Event{}, e
		}
		prior, e := scan(tx.QueryRow(ctx, "SELECT "+eventColumns+" FROM runtime_config_events WHERE id=$1", cmd["id"]))
		if e == nil {
			if prior.CommandHash != commandHash {
				return Event{}, mismatch("Runtime configuration operation conflict")
			}
			return prior, nil
		}
		if !errors.Is(e, pgx.ErrNoRows) {
			return Event{}, e
		}
		previous, e := scan(tx.QueryRow(ctx, "SELECT "+eventColumns+" FROM runtime_config_events WHERE endpoint=$1 AND component=$2 ORDER BY sequence DESC LIMIT 1", cmd["endpoint"], cmd["component"]))
		if e != nil && !errors.Is(e, pgx.ErrNoRows) {
			return Event{}, e
		}
		before := Object(nil)
		if e == nil {
			if e = VerifyEvent(previous); e != nil {
				return Event{}, e
			}
			before = object(previous.Payload["snapshot"])
		}
		snapshot := object(cmd["snapshot"])
		for _, entry := range []struct{ Key, Message string }{{"honorRegistry", "Honor registry cannot silently become memory-only"}, {"qualificationRegistry", "Qualification registry cannot silently become memory-only"}, {"experienceReviewerRegistry", "Experience registry cannot silently become memory-only"}} {
			if before[entry.Key] != nil && snapshot[entry.Key] == nil {
				return Event{}, mismatch(entry.Message)
			}
		}
		if registry := object(snapshot["qualificationRegistry"]); registry != nil {
			if e = assertQualificationVersions(ctx, tx, str(cmd["endpoint"]), registry); e != nil {
				return Event{}, e
			}
		}
		if e = incident.AssertTransition(transition(before["incident"]), transition(snapshot["incident"])); e != nil {
			return Event{}, e
		}
		oldGov, newGov := object(before["governance"]), object(snapshot["governance"])
		oldReview, newReview := object(oldGov["review"]), object(newGov["review"])
		if oldReview != nil && newReview == nil {
			return Event{}, mismatch("Reviewed governance cannot silently become unsigned")
		}
		if newReview != nil {
			if newReview["endpoint"] != cmd["endpoint"] || newReview["configurationSha256"] != newGov["configurationSha256"] {
				return Event{}, mismatch("Governance review observation mismatch")
			}
			if oldReview != nil && oldReview["changeId"] == newReview["changeId"] {
				if !equal(oldReview, newReview) || oldGov["configurationSha256"] != newGov["configurationSha256"] {
					return Event{}, mismatch("Governance change ID conflict")
				}
			} else if num(newReview["revision"]) != num(oldReview["revision"])+1 || !equal(newReview["previousConfigurationSha256"], oldGov["configurationSha256"]) {
				return Event{}, mismatch("Governance revision or previous configuration mismatch")
			}
		}
		at := time.Now().Unix()
		if o.Now != nil {
			at = o.Now().Unix()
		}
		if !integer(at, 0) {
			return Event{}, invalid()
		}
		payload := object(clone(cmd))
		var previousHash any
		if previous.ID != "" {
			previousHash = previous.EventHash
		}
		payload["commandHash"] = commandHash
		payload["observedAt"] = at
		payload["previousHash"] = previousHash
		payload["configurationHash"] = hash(snapshot)
		payload["changes"] = difference(before, snapshot)
		payload["attribution"] = "runtime-provided-operator-reference"
		payload["outcome"] = "loaded-before-serving"
		row, e := scan(tx.QueryRow(ctx, "INSERT INTO runtime_config_events(id,endpoint,component,command_hash,payload,event_hash) VALUES($1,$2,$3,$4,$5::jsonb,$6) RETURNING "+eventColumns, cmd["id"], cmd["endpoint"], cmd["component"], commandHash, jsonText(payload), hash(payload)))
		if e != nil {
			return Event{}, e
		}
		if e = storeHonorVersions(ctx, tx, str(cmd["endpoint"]), row.ID, rules); e != nil {
			return Event{}, e
		}
		_, e = tx.Exec(ctx, `INSERT INTO audit_events(actor,action,object_id,request_id,outcome,client_id,audience,scope,idempotency_key)
 VALUES($1,'runtime.config.observe',$2,$2,'loaded-before-serving',$3,$4,'operations/config',$2)`, "operator:"+str(cmd["operatorRef"]), row.ID, cmd["component"], cmd["endpoint"])
		return row, e
	})
}
func transition(v any) *incident.Transition {
	if v == nil {
		return nil
	}
	o := object(v)
	return &incident.Transition{ID: str(o["id"]), Revision: num(o["revision"]), State: str(o["state"]), UpdatedAt: num(o["updatedAt"]), SHA256: str(o["sha256"])}
}

// ExportPage retains the original archive cursor and chain checks. The page is
// hash-addressed, explicitly not independently signed, and audited atomically.
func ExportPage(ctx context.Context, pool *pgxpool.Pool, input Object) (Object, error) {
	endpoint, component, operator := str(input["endpoint"]), str(input["component"]), "unattributed-runtime"
	if v, ok := input["operatorRef"]; ok {
		operator = str(v)
	}
	after, limit := int64(0), int64(100)
	if v, ok := input["after"]; ok {
		if !integer(v, 0) {
			return nil, invalid()
		}
		after = num(v)
	}
	if v, ok := input["limit"]; ok {
		if !integer(v, 1) || num(v) > 1000 {
			return nil, invalid()
		}
		limit = num(v)
	}
	if !origin(endpoint) || (component != "api" && component != "worker") || !ref.MatchString(operator) {
		return nil, invalid()
	}
	return postgres.InTx(ctx, pool, func(tx pgx.Tx) (Object, error) {
		rows, e := tx.Query(ctx, "SELECT "+eventColumns+" FROM runtime_config_events WHERE endpoint=$1 AND component=$2 AND sequence>$3 ORDER BY sequence LIMIT $4", endpoint, component, after, limit+1)
		if e != nil {
			return nil, e
		}
		events := []Event{}
		for rows.Next() {
			v, e := scan(rows)
			if e != nil {
				rows.Close()
				return nil, e
			}
			events = append(events, v)
		}
		e = rows.Err()
		rows.Close()
		if e != nil {
			return nil, e
		}
		more := int64(len(events)) > limit
		if more {
			events = events[:limit]
		}
		for _, v := range events {
			if e = VerifyEvent(v); e != nil {
				return nil, e
			}
		}
		var anchor Event
		if after != 0 {
			anchor, e = scan(tx.QueryRow(ctx, "SELECT "+eventColumns+" FROM runtime_config_events WHERE endpoint=$1 AND component=$2 AND sequence=$3", endpoint, component, after))
			if errors.Is(e, pgx.ErrNoRows) {
				return nil, mismatch("Runtime configuration archive cursor unavailable")
			}
			if e != nil {
				return nil, e
			}
			if e = VerifyEvent(anchor); e != nil {
				return nil, e
			}
		}
		var previousHash, lastHash any
		next := after
		if len(events) > 0 {
			expected := any(nil)
			if anchor.ID != "" {
				expected = anchor.EventHash
			}
			if !equal(events[0].Payload["previousHash"], expected) {
				return nil, mismatch("Runtime configuration archive anchor mismatch")
			}
			for i := 1; i < len(events); i++ {
				if events[i].Payload["previousHash"] != events[i-1].EventHash {
					return nil, mismatch("Runtime configuration chain mismatch")
				}
			}
			previousHash = events[0].Payload["previousHash"]
			lastHash = events[len(events)-1].EventHash
			next, _ = strconv.ParseInt(events[len(events)-1].Sequence, 10, 64)
		}
		archiveID := uuid.NewString()
		page := Object{"version": 1, "archiveId": archiveID, "operatorRef": operator, "endpoint": endpoint, "component": component, "after": after, "events": events, "hasMore": more, "nextCursor": next, "previousHash": previousHash, "lastHash": lastHash, "independentlySigned": false}
		sum := hash(page)
		_, e = tx.Exec(ctx, `INSERT INTO audit_events(actor,action,object_id,request_id,outcome,client_id,audience,scope,idempotency_key)
 VALUES($1,'runtime.config.export',$2,$3,'archive-prepared',$4,$5,'operations/config',$3)`, "operator:"+operator, sum, archiveID, component, endpoint)
		if e != nil {
			return nil, e
		}
		page["sha256"] = sum
		return page, nil
	})
}
