package accountsocial

import (
	"context"
	"encoding/json"
	"math"
	"time"

	"github.com/agigalaxy-team/agigalaxy/go/internal/deviceauth"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
	"github.com/jackc/pgx/v5"
)

func unavailable(reason string) Object { return Object{"state": "unavailable", "reason": reason} }
func temporary() Object {
	return Object{"state": "temporarily-unavailable", "reason": "source-check-failed"}
}
func sourceFailure(e error) Object {
	switch fault.Status(e) {
	case 401, 403, 404, 409, 410:
		return unavailable("source-not-readable")
	}
	return temporary()
}
func text(v any, max int) string {
	s, _ := v.(string)
	r := []rune(s)
	if len(r) > max {
		r = r[:max]
	}
	return string(r)
}
func numeric(v any) float64 {
	switch n := v.(type) {
	case int:
		return float64(n)
	case int64:
		return float64(n)
	case float64:
		return n
	case json.Number:
		f, e := n.Float64()
		if e == nil {
			return f
		}
	}
	return math.NaN()
}
func scoped(a Actor, scope string) Actor {
	for _, v := range a.Device.Scopes {
		if v == scope {
			return a
		}
	}
	return Actor{}
}
func (s *Service) deadline(ctx context.Context, tx pgx.Tx, ids []string, until float64) (float64, error) {
	rr, e := tx.Query(ctx, `SELECT c.expires_at,b.expires_at FROM consents c JOIN bindings b ON b.id=c.binding_id WHERE c.id=ANY($1::uuid[])`, ids)
	if e != nil {
		return 0, e
	}
	defer rr.Close()
	for rr.Next() {
		var c, b time.Time
		if e = rr.Scan(&c, &b); e != nil {
			return 0, e
		}
		until = math.Min(until, math.Min(float64(c.UnixMilli())/1000, float64(b.UnixMilli())/1000))
	}
	return until, rr.Err()
}
func (s *Service) source(ctx context.Context, tx pgx.Tx, a Actor, r Reference) Object {
	now := float64(s.now().Unix())
	until := now + 15
	var title, summary any
	var view Object
	var e error
	switch r.Kind {
	case "forum-post":
		if s.Forum == nil {
			return temporary()
		}
		var device *deviceauth.Actor
		if !a.Official && a.Device.SubjectID != "" {
			device = &a.Device
		}
		view, e = s.Forum.ReadBookmarkWithin(ctx, tx, a.AccountID, a.Authority, device, r.PostID)
		if e != nil {
			return sourceFailure(e)
		}
		if view["availability"] != "available" {
			reason := "source-not-readable"
			if view["availability"] == "expired" {
				reason = "source-expired"
			}
			if view["availability"] == "withdrawn" {
				reason = "source-withdrawn"
			}
			return unavailable(reason)
		}
		payload := object(view, "payload")
		title = payload["title"]
		summary = payload["body"]
		until = math.Min(until, numeric(view["publishedUntil"]))
	case "capsule":
		if s.Capsules == nil {
			return temporary()
		}
		view, e = s.Capsules(ctx, tx, scoped(a, "capsules"), r)
		if e != nil {
			return sourceFailure(e)
		}
		version := object(view, "version")
		if version == nil {
			return unavailable("source-not-readable")
		}
		title = version["title"]
		summary = version["problemPattern"]
		rr, e := tx.Query(ctx, `SELECT consent_id::text FROM capsule_events WHERE id=$1 AND capsule_id=$2`, r.VersionID, r.CapsuleID)
		if e != nil {
			return sourceFailure(e)
		}
		ids := []string{}
		for rr.Next() {
			var id string
			if e = rr.Scan(&id); e != nil {
				rr.Close()
				return sourceFailure(e)
			}
			ids = append(ids, id)
		}
		e = rr.Err()
		rr.Close()
		if e != nil {
			return sourceFailure(e)
		}
		until, e = s.deadline(ctx, tx, ids, until)
		if e != nil {
			return sourceFailure(e)
		}
	case "project":
		if s.Projects == nil {
			return temporary()
		}
		view, e = s.Projects(ctx, tx, scoped(a, "history"), r)
		if e != nil {
			return sourceFailure(e)
		}
		doc := object(view, "document")
		if doc == nil {
			return unavailable("source-not-readable")
		}
		title = doc["title"]
		summary = doc["summary"]
		src := object(view, "source")
		ids := []string{str(src, "policyEventId")}
		var fields []Object
		if e := protocol.Decode(encode(src["fieldSources"]), &fields); e != nil || fields == nil {
			return temporary()
		}
		for _, field := range fields {
			if one(field["field"], "title", "summary") {
				ids = append(ids, str(field, "operationId"))
			}
		}
		rr, e := tx.Query(ctx, `SELECT consent_id::text FROM project_events_v2 WHERE operation_id=ANY($1::uuid[])`, ids)
		if e != nil {
			return sourceFailure(e)
		}
		consents := []string{}
		for rr.Next() {
			var id string
			if e = rr.Scan(&id); e != nil {
				rr.Close()
				return sourceFailure(e)
			}
			consents = append(consents, id)
		}
		e = rr.Err()
		rr.Close()
		if e != nil {
			return sourceFailure(e)
		}
		until, e = s.deadline(ctx, tx, consents, until)
		if e != nil {
			return sourceFailure(e)
		}
	case "person":
		if s.Profiles == nil {
			return temporary()
		}
		var exists bool
		if e = tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM subjects WHERE id=$1)`, r.SubjectID).Scan(&exists); e != nil {
			return sourceFailure(e)
		}
		if !exists {
			return unavailable("source-not-readable")
		}
		view, e = s.Profiles(ctx, tx, scoped(a, "history"), r)
		if e != nil {
			return sourceFailure(e)
		}
		if view["selfDeclaredSource"] == nil || view["selfDeclaredSource"] == false {
			return unavailable("source-not-readable")
		}
		declared := object(view, "selfDeclared")
		title = declared["displayName"]
		if title == nil || title == "" {
			title = "尚未填写称呼的个人资料"
		}
		summary = declared["about"]
		if expiry := numeric(view["selfDeclaredReadExpiresAt"]); !math.IsNaN(expiry) && expiry != 0 {
			until = math.Min(until, expiry)
		}
	case "chat-message":
		if s.Chat == nil {
			return temporary()
		}
		view, e = s.Chat(ctx, tx, a, r)
		if e != nil {
			return sourceFailure(e)
		}
		if view["state"] != "available" {
			if view["state"] == "temporarily-unavailable" {
				return temporary()
			}
			reason := str(view, "reason")
			if !one(reason, "source-expired", "source-withdrawn") {
				reason = "source-not-readable"
			}
			return unavailable(reason)
		}
		until = math.Min(until, numeric(view["availableUntil"]))
		if math.IsNaN(until) || math.IsInf(until, 0) || until <= now {
			return unavailable("source-expired")
		}
		out := Object{"state": "available", "title": text(view["title"], 200), "summary": text(view["summary"], 360), "path": r.Path(), "availableUntil": int64(math.Floor(until))}
		revision := numeric(view["revision"])
		if !math.IsNaN(revision) && revision > 0 && math.Trunc(revision) == revision {
			out["revision"] = int64(revision)
		}
		for _, key := range []string{"authorAccountId", "authorId"} {
			if v, ok := view[key]; ok {
				out[key] = v
			}
		}
		return out
	default:
		return unavailable("source-not-readable")
	}
	if math.IsNaN(until) || math.IsInf(until, 0) {
		return temporary()
	}
	if until <= now {
		return unavailable("source-expired")
	}
	return Object{"state": "available", "title": text(title, 200), "summary": text(summary, 360), "path": r.Path(), "availableUntil": until}
}
