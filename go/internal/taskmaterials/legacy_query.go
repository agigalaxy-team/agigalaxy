package taskmaterials

import (
	"context"
	_ "embed"

	"github.com/agigalaxy-team/agigalaxy/go/internal/deviceauth"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
	"github.com/jackc/pgx/v5"
)

//go:embed legacy_query.sql
var legacyQuerySQL string

type legacyQuery struct {
	View, Query, RequesterID string
	After                    any
	Limit                    int64
}

func parseLegacyQuery(input Object) (legacyQuery, error) {
	q := legacyQuery{View: "open", Limit: 8}
	if !exactFields(input, nil, []string{"view", "query", "requesterId", "after", "limit"}) {
		return q, fail("invalid_assistance_query", 400)
	}
	if value, ok := input["view"]; ok {
		q.View = text(value)
	}
	if !contains([]string{"open", "requested", "participating", "requester-history"}, q.View) {
		return q, fail("invalid_assistance_query", 400)
	}
	if value, ok := input["query"]; ok {
		v, ok := value.(string)
		if !ok {
			return q, fail("invalid_assistance_query", 400)
		}
		q.Query = jsTrim(v)
		if protocol.TextLength(q.Query) > 200 {
			return q, fail("invalid_assistance_query", 400)
		}
	}
	if value, ok := input["requesterId"]; ok {
		if !subjectPattern.MatchString(text(value)) {
			return q, fail("invalid_assistance_query", 400)
		}
		q.RequesterID = text(value)
	}
	if value, ok := input["after"]; ok {
		if !validID(text(value)) {
			return q, fail("invalid_assistance_query", 400)
		}
		q.After = value
	}
	if value, ok := input["limit"]; ok {
		if !validInt(value, 1, 20) {
			return q, fail("invalid_assistance_query", 400)
		}
		q.Limit = num(value)
	}
	return q, nil
}
func (s *Service) LegacyGet(ctx context.Context, a Actor, id string) (any, error) {
	if !validID(id) {
		return nil, fail("not_found", 404)
	}
	return s.run(ctx, a, "assistance", false, false, func(tx pgx.Tx, _ deviceauth.ControlAuthorization) (any, error) {
		return s.LegacyReadWithin(ctx, tx, &a.Actor, id)
	})
}
func (s *Service) LegacyReceipt(ctx context.Context, a Actor, id, eventID, hash string) (any, error) {
	if !validID(id) || !validID(eventID) || !hashPattern.MatchString(hash) {
		return nil, fail("invalid_assistance_query", 400)
	}
	return s.run(ctx, a, "assistance", false, false, func(tx pgx.Tx, _ deviceauth.ControlAuthorization) (any, error) {
		event, e := row(ctx, tx, "SELECT to_jsonb(e) FROM assistance_events e WHERE id=$1", eventID)
		if e != nil {
			return nil, e
		}
		if event != nil && event["subject_id"] != a.SubjectID {
			return nil, fail("not_found", 404)
		}
		state := "absent"
		if event != nil {
			state = "conflict"
			if event["assistance_id"] == id && event["payload_hash"] == hash {
				state = "acknowledged"
			}
		}
		out := Object{"assistanceId": id, "eventId": eventID, "payloadHash": hash, "checkedAt": s.now(), "state": state, "authority": "accepted-event-only; no current access or capability conclusion"}
		if state == "acknowledged" {
			out["consentId"], out["version"] = event["consent_id"], event["version"]
		}
		return out, nil
	})
}
func (s *Service) legacyQueryWithin(ctx context.Context, tx pgx.Tx, a deviceauth.Actor, q legacyQuery) (Object, error) {
	requester := q.RequesterID
	if requester == "" {
		requester = a.SubjectID
	}
	candidates, e := rows(ctx, tx, "SELECT to_jsonb(c) FROM ("+legacyQuerySQL+")c", q.After, q.View, s.now(), a.SubjectID, q.Query, stamp(s.now()), q.Limit+1, requester)
	if e != nil {
		return nil, e
	}
	items := []any{}
	for _, candidate := range candidates {
		view, e := s.LegacyReadWithin(ctx, tx, &a, str(candidate, "id"))
		if e != nil {
			if !contains([]string{"not_found", "consent_required", "assistance_case_unavailable"}, fault.Code(e)) {
				return nil, e
			}
			continue
		}
		items = append(items, Object{"assistanceId": obj(view, "request")["id"], "requesterId": view["requesterId"], "request": view["request"], "state": view["state"], "version": view["version"], "view": view["view"], "capabilityVerified": false})
	}
	var next any
	if int64(len(items)) > q.Limit {
		next = items[q.Limit-1].(map[string]any)["assistanceId"]
	} else if int64(len(candidates)) == q.Limit+1 {
		next = candidates[len(candidates)-1]["id"]
	}
	return Object{"items": items[:min(len(items), int(q.Limit))], "nextAfter": next}, nil
}
func (s *Service) LegacyQuery(ctx context.Context, a Actor, input Object) (any, error) {
	q, e := parseLegacyQuery(input)
	if e != nil {
		return nil, e
	}
	return s.run(ctx, a, "assistance", false, false, func(tx pgx.Tx, _ deviceauth.ControlAuthorization) (any, error) {
		return s.legacyQueryWithin(ctx, tx, a.Actor, q)
	})
}

func (s *Service) LegacyQueryWithin(ctx context.Context, tx pgx.Tx, a deviceauth.Actor, input Object) (Object, error) {
	q, e := parseLegacyQuery(input)
	if e != nil {
		return nil, e
	}
	return s.legacyQueryWithin(ctx, tx, a, q)
}
