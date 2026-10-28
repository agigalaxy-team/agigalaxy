package requesterhistory

import (
	"context"
	"github.com/agigalaxy-team/agigalaxy/go/internal/deviceauth"
	"github.com/jackc/pgx/v5"
	"math"
	"regexp"
	"time"
)

var subjectPattern = regexp.MustCompile(`^GUID[0-9A-Z]{28}$`)
var uuidPattern = regexp.MustCompile(`^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$`)

func parse(input Object, facts bool) (Object, error) {
	q := Object{"limit": 8}
	for k, v := range input {
		switch k {
		case "subjectId":
			if facts || !subjectPattern.MatchString(text(v)) {
				return nil, fail("invalid_requester_history_query", 400)
			}
		case "rootEventId":
			if !facts || !uuidPattern.MatchString(text(v)) {
				return nil, fail("invalid_requester_history_query", 400)
			}
		case "after":
			if !uuidPattern.MatchString(text(v)) {
				return nil, fail("invalid_requester_history_query", 400)
			}
		case "limit":
			var n float64
			switch v := v.(type) {
			case int:
				n = float64(v)
			case float64:
				n = v
			default:
				return nil, fail("invalid_requester_history_query", 400)
			}
			if n < 1 || n > 20 || math.Trunc(n) != n {
				return nil, fail("invalid_requester_history_query", 400)
			}
		default:
			return nil, fail("invalid_requester_history_query", 400)
		}
		q[k] = v
	}
	if facts && q["rootEventId"] == nil {
		return nil, fail("invalid_requester_history_query", 400)
	}
	return q, nil
}
func (s *Service) candidates(ctx context.Context, tx pgx.Tx, a *deviceauth.Actor, subject string, root, after any, limit int) ([]Object, error) {
	var viewer any
	if a != nil {
		viewer = a.SubjectID
	}
	return rows(ctx, tx, `SELECT jsonb_build_object('id',t.id,'root_event_id',t.root_event_id) FROM task_requests t
 JOIN task_events e ON e.id=t.root_event_id AND e.task_id=t.id
 JOIN consents c ON c.id=e.consent_id AND c.subject_id=e.subject_id
 JOIN bindings b ON b.id=c.binding_id
 WHERE t.requester_id=$1 AND ($4::uuid IS NULL OR t.root_event_id=$4)
 AND ($5::uuid IS NULL OR t.root_event_id>$5) AND octet_length(e.payload_text)>0
 AND c.revoked_at IS NULL AND b.revoked_at IS NULL AND c.expires_at>$3 AND b.expires_at>$3
 AND c.intent->>'action'='assistance.publish' AND c.intent->>'objectId'=e.id::text
 AND c.intent->>'recipient'=$6 AND c.intent->>'payloadHash'=e.payload_hash
 AND NOT EXISTS(SELECT 1 FROM deletion_requests d WHERE d.subject_id=e.subject_id
 AND d.state IN ('requested','review-needed','approved','partial','primary-erased'))
 AND (e.subject_id=$2 OR (c.intent->>'visibility'='Public' AND c.intent->>'purpose'='public-profile')
 OR (c.intent->>'visibility'='Private' AND c.intent->'viewers' ? $2)
 OR EXISTS(SELECT 1 FROM contribution_publications p
 JOIN consents pc ON pc.id=p.consent_id AND pc.subject_id=p.subject_id
 JOIN bindings pb ON pb.id=pc.binding_id
 WHERE p.subject_id=e.subject_id AND p.revoked_at IS NULL AND octet_length(p.payload_text)>0
 AND p.source_refs @> jsonb_build_array(jsonb_build_object('kind','task-event','id',e.id,'eventVersion',1,'payloadHash',e.payload_hash))
 AND pc.revoked_at IS NULL AND pb.revoked_at IS NULL AND pc.expires_at>$3 AND pb.expires_at>$3
 AND pc.intent->>'action'='contribution.publish' AND pc.intent->>'objectId'=p.id::text
 AND pc.intent->>'recipient'=$6 AND pc.intent->>'payloadHash'=p.payload_hash
 AND pc.intent->>'visibility'='Public' AND pc.intent->>'purpose'='public-profile'))
 ORDER BY t.root_event_id LIMIT $7`, subject, viewer, time.Unix(s.now(), 0).UTC(), root, after, s.Endpoint, limit)
}
func (s *Service) Query(ctx context.Context, a *deviceauth.Actor, input Object) (Object, error) {
	q, e := parse(input, false)
	if e != nil {
		return nil, e
	}
	subject := str(q, "subjectId")
	if subject == "" && a != nil {
		subject = a.SubjectID
	}
	if subject == "" {
		return nil, fail("requester_subject_required", 400)
	}
	return s.run(ctx, a, func(tx pgx.Tx) (Object, error) {
		if q["after"] != nil {
			prior, e := s.candidates(ctx, tx, a, subject, q["after"], nil, 1)
			if e != nil {
				return nil, e
			}
			if len(prior) == 0 {
				return nil, fail("requester_history_cursor_unavailable", 409)
			}
			if _, e = s.ProjectWithin(ctx, tx, a, str(prior[0], "id")); e != nil {
				if !absent(e) {
					return nil, e
				}
				return nil, fail("requester_history_cursor_unavailable", 409)
			}
		}
		visible := []any{}
		var after any = q["after"]
		limit := int(number(q["limit"]))
		for len(visible) <= limit {
			candidates, e := s.candidates(ctx, tx, a, subject, nil, after, 100)
			if e != nil {
				return nil, e
			}
			for _, r := range candidates {
				p, e := s.ProjectWithin(ctx, tx, a, str(r, "id"))
				if e != nil {
					if absent(e) {
						continue
					}
					return nil, e
				}
				facts := array(p["facts"])
				preview := facts[:min(len(facts), 8)]
				p["facts"] = preview
				p["nextFactsAfter"] = nil
				if len(facts) > len(preview) {
					p["nextFactsAfter"] = object(object(preview[len(preview)-1])["source"])["id"]
				}
				visible = append(visible, p)
				if len(visible) > limit {
					break
				}
			}
			if len(visible) > limit || len(candidates) < 100 {
				break
			}
			after = candidates[len(candidates)-1]["root_event_id"]
		}
		items := visible[:min(len(visible), limit)]
		var next any
		if len(visible) > limit {
			next = object(object(items[len(items)-1])["source"])["id"]
		}
		acceptances, cancellations, disputes := int64(0), int64(0), int64(0)
		for _, v := range items {
			c := object(object(v)["counts"])
			acceptances += number(c["acceptances"])
			cancellations += number(c["cancellations"])
			disputes += number(c["disputes"])
		}
		return Object{"schemaVersion": 2, "subjectId": subject, "items": items, "nextAfter": next, "coverage": "current-visible-page; cursor-from-visible-root-only", "counts": Object{"requests": len(items), "acceptances": acceptances, "cancellations": cancellations, "disputes": disputes}, "globalScore": nil}, nil
	})
}
func (s *Service) Facts(ctx context.Context, a *deviceauth.Actor, input Object) (Object, error) {
	q, e := parse(input, true)
	if e != nil {
		return nil, e
	}
	return s.run(ctx, a, func(tx pgx.Tx) (Object, error) {
		root, e := row(ctx, tx, "SELECT to_jsonb(e) FROM task_events e WHERE id=$1", q["rootEventId"])
		if e != nil {
			return nil, e
		}
		if root == nil || root["kind"] != "task-created" {
			return nil, fail("requester_history_unavailable", 404)
		}
		p, e := s.ProjectWithin(ctx, tx, a, str(root, "task_id"))
		if e != nil {
			return nil, e
		}
		facts := array(p["facts"])
		start := 0
		if q["after"] != nil {
			for i, v := range facts {
				if object(object(v)["source"])["id"] == q["after"] {
					start = i + 1
					break
				}
			}
			if start == 0 {
				return nil, fail("requester_history_cursor_unavailable", 409)
			}
		}
		limit := int(number(q["limit"]))
		page := facts[start:min(len(facts), start+limit)]
		p["facts"] = page
		p["nextAfter"] = nil
		if start+len(page) < len(facts) {
			p["nextAfter"] = object(object(page[len(page)-1])["source"])["id"]
		}
		p["coverage"] = "current permitted request sources; no original-text grant"
		return p, nil
	})
}
