package webevents

import (
	"context"
	"encoding/json"
	"slices"

	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/postgres"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// PublicRead invokes the real domain's current authorized projection reader.
// The locator and optional parent are derived only from the fixed producer,
// never browser input. A row version cannot renew binding/consent/read expiry.
type PublicRead func(context.Context, Principal, string, string) (map[string]any, error)
type PublicConsumers struct {
	Builder, BuilderManage, Information, Choice, ChoicePreferences   PublicRead
	CIProof, CIRequest, Capsule, ForumPost, ForumReply, ForumVersion PublicRead
	Chat, Task, PublicTask, Project                                  PublicRead
	Inbox                                                            func(context.Context, Principal, string) error
}
type PublicSources struct {
	Pool          *pgxpool.Pool
	Endpoint      string
	AccountWithin func(context.Context, pgx.Tx, Principal) (string, error)
	BindingWithin func(context.Context, pgx.Tx, Principal) error
	Consumers     PublicConsumers
}

func (s *PublicSources) AuthorizeSource(ctx context.Context, p Principal, e Event) (SourceDecision, error) {
	if s == nil || s.Pool == nil || s.Endpoint == "" {
		return Denied, fault.New("web_events_authority_unavailable", 503)
	}
	if p.Surface != "web" || p.Endpoint != s.Endpoint || !validSource(e) || e.Endpoint != "" && e.Endpoint != s.Endpoint {
		return Denied, nil
	}
	decision, err := s.source(ctx, p, e)
	if authorizationFailure(err) {
		if str(e.Ref, "_operation") == "DELETE" {
			return Reset, nil
		}
		return Denied, nil
	}
	if err != nil {
		return Denied, err
	}
	return decision, nil
}
func unavailable() (SourceDecision, error) {
	return Denied, fault.New("web_events_authority_unavailable", 503)
}
func read(ctx context.Context, fn PublicRead, p Principal, id, parent string) (map[string]any, error) {
	if fn == nil {
		return nil, fault.New("web_events_authority_unavailable", 503)
	}
	return fn(ctx, p, id, parent)
}
func anonymous(p Principal) Principal {
	p.Actor = nil
	p.Kind = "anonymous"
	p.Identity = "anonymous"
	p.AccountID = ""
	p.SubjectID = ""
	return p
}
func first(ref map[string]any, keys ...string) string {
	for _, key := range keys {
		if v := str(ref, key); v != "" {
			return v
		}
	}
	return ""
}
func (s *PublicSources) source(ctx context.Context, p Principal, e Event) (SourceDecision, error) {
	ref := e.Ref
	signed := p.Kind != "anonymous" && p.Kind != "official-account" && p.SubjectID != ""
	actor := p.Kind != "anonymous" && p.Actor != nil
	if e.Module == "site-content" {
		var id string
		var result map[string]any
		err := s.Pool.QueryRow(ctx, "SELECT id::text,result FROM site_publications_v1 WHERE endpoint=$1 AND state='published' AND published_at IS NOT NULL ORDER BY sequence DESC LIMIT 1", s.Endpoint).Scan(&id, &result)
		if err == pgx.ErrNoRows {
			return Denied, nil
		}
		if err != nil {
			return Denied, err
		}
		if id == str(ref, "id") && result["publicationId"] == id && !truthy(result["activationPending"]) {
			return Allowed, nil
		}
		return Denied, nil
	}
	if e.Module == "information" && catalog.Sources[e.SourceTable] != "information" && e.SourceTable != "information_watch_changes_v2" {
		e.Module = catalog.Sources[e.SourceTable]
		allowed, err := s.AuthorizeSource(ctx, p, e)
		if allowed != Denied {
			return Reset, err
		}
		return Denied, err
	}
	switch e.Module {
	case "builders":
		id := first(ref, "builder_id", "id")
		if e.SourceTable == "builder_probes" {
			var owner string
			err := s.Pool.QueryRow(ctx, "SELECT builder_id::text FROM builder_events WHERE id=$1", str(ref, "request_id")).Scan(&owner)
			if err == pgx.ErrNoRows {
				return Denied, nil
			}
			if err != nil {
				return Denied, err
			}
			id = owner
		}
		if id == "" {
			return Denied, nil
		}
		reader := p
		if p.Kind == "official-account" {
			reader = anonymous(p)
		}
		_, err := read(ctx, s.Consumers.Builder, reader, id, "")
		if err == nil {
			return Allowed, nil
		}
		if signed && authorizationFailure(err) {
			_, err = read(ctx, s.Consumers.BuilderManage, reader, id, "")
			if err == nil {
				return Reset, nil
			}
		}
		return Denied, err
	case "information":
		if !signed || str(ref, "subject_id") != p.SubjectID {
			return Denied, nil
		}
		_, err := read(ctx, s.Consumers.Information, p, first(ref, "watch_id", "id"), "")
		return Allowed, err
	case "choice-sync":
		if !signed || str(ref, "subject_id") != p.SubjectID {
			return Denied, nil
		}
		fn := s.Consumers.Choice
		id := str(ref, "snapshot_id")
		if e.SourceTable == "choice_snapshot_preferences" {
			fn = s.Consumers.ChoicePreferences
			id = ""
		}
		_, err := read(ctx, fn, p, id, "")
		return Allowed, err
	case "ci":
		if !signed {
			return Denied, nil
		}
		id := str(ref, "id")
		fn := s.Consumers.CIProof
		if e.SourceTable == "ci_proofs_v2" {
			if str(ref, "subject_id") != p.SubjectID {
				return Denied, nil
			}
		} else {
			fn = s.Consumers.CIRequest
			if e.SourceTable == "ci_observations_v2" {
				id = str(ref, "request_id")
			}
			var owner string
			err := s.Pool.QueryRow(ctx, "SELECT subject_id FROM ci_requests_v2 WHERE id=$1", id).Scan(&owner)
			if err == pgx.ErrNoRows {
				return Denied, nil
			}
			if err != nil {
				return Denied, err
			}
			if owner != p.SubjectID {
				return Denied, nil
			}
		}
		_, err := read(ctx, fn, p, id, "")
		return Allowed, err
	case "capsules":
		reader := p
		if p.Kind == "official-account" {
			reader = anonymous(p)
		}
		view, err := read(ctx, s.Consumers.Capsule, reader, first(ref, "capsule_id", "id"), "")
		if err != nil {
			return Denied, err
		}
		if truthy(view["version"]) {
			return Allowed, nil
		}
		return Reset, nil
	case "notifications":
		if !signed {
			return Denied, nil
		}
		if s.Consumers.Inbox == nil {
			return unavailable()
		}
		kinds := map[string]string{"chat_message_refs": "room-message", "chat_decisions": "room-invite", "task_events": "task-v2", "task_comment_events_v2": "task-comment", "capsule_events": "capsule", "incident_notices": "incident", "assistance_events": "assistance", "context_grants": "context", "context_acceptances": "context-accept", "comment_governance_events_v2": "comment-governance", "qualification_permission_request_events": "qualification-request", "information_watch_changes_v2": "information-change"}
		if kind := kinds[e.SourceTable]; kind != "" {
			err := s.Consumers.Inbox(ctx, p, kind+":"+first(ref, "message_id", "decision_id", "id"))
			return Reset, err
		}
		if str(ref, "subject_id") != p.SubjectID {
			return Denied, nil
		}
		return Reset, s.Consumers.Inbox(ctx, p, "")
	case "forum":
		var fn PublicRead
		id, parent := str(ref, "id"), ""
		switch e.SourceTable {
		case "forum_posts_v1":
			fn = s.Consumers.ForumPost
		case "forum_replies_v1":
			fn = s.Consumers.ForumReply
		case "forum_versions_v1":
			fn = s.Consumers.ForumVersion
			parent = str(ref, "post_id")
		default:
			return Denied, nil
		}
		view, err := read(ctx, fn, p, id, parent)
		if err != nil {
			return Denied, err
		}
		if view["availability"] == "available" {
			return Allowed, nil
		}
		return Reset, nil
	case "chat":
		if !actor || str(ref, "room_id") == "" {
			return Denied, nil
		}
		_, err := read(ctx, s.Consumers.Chat, p, str(ref, "room_id"), "")
		return Allowed, err
	case "tasks":
		id := first(ref, "task_id", "id")
		if id == "" {
			return Denied, nil
		}
		fn, reader := s.Consumers.PublicTask, anonymous(p)
		if signed {
			fn, reader = s.Consumers.Task, p
		}
		_, err := read(ctx, fn, reader, id, "")
		return Allowed, err
	case "projects":
		reader := p
		if p.Kind == "official-account" {
			reader = anonymous(p)
		}
		_, err := read(ctx, s.Consumers.Project, reader, first(ref, "project_id", "id"), "")
		return Allowed, err
	case "account", "account-work", "bookmarks", "follows":
		if !actor || p.AccountID == "" || s.AccountWithin == nil {
			return Denied, nil
		}
		return postgres.InTx(ctx, s.Pool, func(tx pgx.Tx) (SourceDecision, error) {
			current, err := s.AccountWithin(ctx, tx, p)
			if err != nil {
				return Denied, err
			}
			if current == "" || current != str(ref, "account_id") {
				return Denied, nil
			}
			var exists bool
			err = tx.QueryRow(ctx, "SELECT EXISTS(SELECT 1 FROM community_accounts WHERE id=$1 AND endpoint=$2)", current, s.Endpoint).Scan(&exists)
			if err != nil {
				return Denied, err
			}
			if exists {
				return Allowed, nil
			}
			return Denied, nil
		})
	case "contacts":
		if !actor || p.SubjectID == "" || !slices.Contains([]string{str(ref, "initiator_id"), str(ref, "recipient_id")}, p.SubjectID) {
			return Denied, nil
		}
		if s.BindingWithin == nil {
			return unavailable()
		}
		return postgres.InTx(ctx, s.Pool, func(tx pgx.Tx) (SourceDecision, error) { err := s.BindingWithin(ctx, tx, p); return Allowed, err })
	}
	return Denied, nil
}
func truthy(v any) bool {
	switch x := v.(type) {
	case nil:
		return false
	case bool:
		return x
	case string:
		return x != ""
	case int:
		return x != 0
	case int64:
		return x != 0
	case float64:
		return x != 0
	case json.Number:
		return x != "0" && x != "0.0"
	}
	return true
}
