// Package community implements the existing forum ledgers. HTTP credentials
// are supplied by the trusted portal adapter and rechecked in each transaction.
package community

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"time"

	"github.com/agigalaxy-team/agigalaxy/go/internal/accountlinks"
	"github.com/agigalaxy-team/agigalaxy/go/internal/deviceauth"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/identity"
	"github.com/agigalaxy-team/agigalaxy/go/internal/postgres"
	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
	"github.com/agigalaxy-team/agigalaxy/go/internal/resourcebudget"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

type Object = map[string]any
type Authorization interface {
	Account(context.Context, pgx.Tx, string, string) error
}

// Conditions is the existing Honor/external-credential service port. Missing
// services cannot satisfy a condition or accept new conditional publications.
type Conditions interface {
	Validate(context.Context, pgx.Tx, Object) error
	Matches(context.Context, pgx.Tx, string, Object) (bool, error)
}
type Attachments interface {
	Bind(context.Context, pgx.Tx, string, Object) error
	Metadata(context.Context, pgx.Tx, any) ([]Object, error)
}
type BusinessRules interface {
	Enforce(context.Context, pgx.Tx, string, string, string, Object) error
}

// Governance can supply an existing trusted domain adapter; absent an adapter,
// the service evaluates the original restriction and consent ledgers itself.
type Governance interface {
	Hidden(context.Context, pgx.Tx, Object) (bool, error)
}
type IdentityProvider struct{ Issuer, ClientID string }
type Service struct {
	Pool                       *pgxpool.Pool
	Endpoint                   string
	Authority                  Authorization
	Conditions                 Conditions
	Attachments                Attachments
	Rules                      BusinessRules
	Governance                 Governance
	ModeratorIDs               []string
	IdentityProviders          []IdentityProvider
	DeviceAuth                 *deviceauth.Service
	AccountLinks               *accountlinks.Service
	Resources                  *resourcebudget.Service
	OperationsHandling         bool
	actor                      *identityActor
	workerPublicRead           bool
	ignoreOperationsVisibility bool
	Policy                     Object
	policyState                *forumPolicyState
	PromotionDays              int
	RequestID                  string
	Now                        func() time.Time
}

func (s *Service) now() time.Time {
	if s.Now != nil {
		return s.Now().UTC().Truncate(time.Millisecond)
	}
	return time.Now().UTC().Truncate(time.Millisecond)
}
func (s *Service) clock() int64 { return s.now().Unix() }
func (s *Service) readShare(clause string) string {
	if s.workerPublicRead {
		return ""
	}
	return clause
}
func stamp(t time.Time) string        { return t.UTC().Format("2006-01-02T15:04:05.000Z") }
func invalid() error                  { return fault.New("invalid_forum_request", 400) }
func fail(c string, status int) error { return fault.New(c, status) }
func validID(v string) bool {
	u, e := uuid.Parse(v)
	return e == nil && strings.EqualFold(u.String(), v) && u.Version() >= 1 && u.Version() <= 8 && u.Variant() == uuid.RFC4122
}
func str(o Object, k string) string { v, _ := o[k].(string); return v }
func obj(o Object, k string) Object { v, _ := o[k].(map[string]any); return v }
func num(o Object, k string) int64 {
	switch v := o[k].(type) {
	case int:
		return int64(v)
	case int64:
		return v
	case float64:
		return int64(v)
	case json.Number:
		n, _ := v.Int64()
		return n
	}
	return 0
}
func truth(o Object, k string) bool { v, _ := o[k].(bool); return v }
func null(v string) any {
	if v == "" {
		return nil
	}
	return v
}
func encode(v any) []byte { b, _ := protocol.Encode(v); return b }
func clone(v Object) Object {
	out := Object{}
	for k, x := range v {
		out[k] = x
	}
	return out
}
func seconds(v any) int64   { t, _ := time.Parse(time.RFC3339Nano, asString(v)); return t.Unix() }
func asString(v any) string { s, _ := v.(string); return s }
func (s *Service) run(ctx context.Context, account string, fn func(pgx.Tx) (Object, error)) (Object, error) {
	return s.runOptions(ctx, account, false, false, fn)
}
func (s *Service) runWrite(ctx context.Context, account string, control bool, fn func(pgx.Tx) (Object, error)) (Object, error) {
	return s.runOptions(ctx, account, true, control, fn)
}
func (s *Service) runOptions(ctx context.Context, account string, write, control bool, fn func(pgx.Tx) (Object, error)) (Object, error) {
	return postgres.InTx(ctx, s.Pool, func(tx pgx.Tx) (Object, error) {
		if s.actor != nil {
			if s.DeviceAuth == nil {
				return nil, fail("forum_identity_authorization_unavailable", 503)
			}
			authorize := func(ctx context.Context, tx pgx.Tx) error {
				scope := s.actor.scope
				if scope == "" {
					scope = "assistance"
				}
				if e := s.DeviceAuth.AuthorizeWithin(ctx, tx, s.actor.actor, scope); e != nil {
					return e
				}
				if account != "" {
					if _, e := s.resolveIdentityAccount(ctx, tx, account, false); e != nil {
						return e
					}
				}
				return nil
			}
			if write && s.Resources != nil {
				value, e := s.Resources.ResourceWrite(ctx, tx, resourcebudget.Actor{SubjectID: s.actor.actor.SubjectID}, authorize, func(_ context.Context, tx pgx.Tx) (any, error) { return fn(tx) }, resourcebudget.Options{Control: control})
				if e != nil {
					return nil, e
				}
				return value.(map[string]any), nil
			}
			if e := authorize(ctx, tx); e != nil {
				return nil, e
			}
			return fn(tx)
		}
		if account != "" {
			if e := s.authorize(ctx, tx, account); e != nil {
				return nil, e
			}
		}
		return fn(tx)
	})
}
func (s *Service) authorize(ctx context.Context, tx pgx.Tx, account string) error {
	if !validID(account) {
		return fail("official_account_login_required", 401)
	}
	if s.Authority == nil {
		return fail("official_account_unavailable", 503)
	}
	return s.Authority.Account(ctx, tx, s.Endpoint, account)
}
func row(ctx context.Context, tx pgx.Tx, sql string, args ...any) (Object, error) {
	var raw []byte
	e := tx.QueryRow(ctx, sql, args...).Scan(&raw)
	if errors.Is(e, pgx.ErrNoRows) {
		return nil, nil
	}
	if e != nil {
		return nil, e
	}
	var o Object
	e = json.Unmarshal(raw, &o)
	return o, e
}
func rows(ctx context.Context, tx pgx.Tx, sql string, args ...any) ([]Object, error) {
	r, e := tx.Query(ctx, sql, args...)
	if e != nil {
		return nil, e
	}
	defer r.Close()
	out := []Object{}
	for r.Next() {
		var raw []byte
		if e = r.Scan(&raw); e != nil {
			return nil, e
		}
		var o Object
		if e = json.Unmarshal(raw, &o); e != nil {
			return nil, e
		}
		out = append(out, o)
	}
	return out, r.Err()
}
func (s *Service) head(ctx context.Context, tx pgx.Tx, id string, lock bool) (Object, error) {
	q := "SELECT to_jsonb(p) FROM forum_posts_v1 p WHERE id=$1"
	if lock {
		q += " FOR UPDATE"
	}
	return row(ctx, tx, q, id)
}
func (s *Service) version(ctx context.Context, tx pgx.Tx, post, id string) (Object, error) {
	return row(ctx, tx, `SELECT to_jsonb(v)||jsonb_build_object('payload_text',e.payload_text,'event_erased',e.erased_at,'post_state',p.state,'head_version',p.head_version,'current_version_id',p.current_version_id,'post_created_at',p.created_at,'post_updated_at',p.updated_at) FROM forum_versions_v1 v JOIN forum_posts_v1 p ON p.id=v.post_id LEFT JOIN forum_events_v1 e ON e.id=v.publication_event_id WHERE v.id=$1 AND v.post_id=$2`, id, post)
}
func (s *Service) reply(ctx context.Context, tx pgx.Tx, id string) (Object, error) {
	return row(ctx, tx, `SELECT to_jsonb(r)||jsonb_build_object('payload_text',e.payload_text,'event_erased',e.erased_at) FROM forum_replies_v1 r LEFT JOIN forum_events_v1 e ON e.id=r.publication_event_id WHERE r.id=$1`, id)
}
func defaultPolicy() Object {
	return Object{"version": "forum-quota/1", "new": Object{"post": 3, "version": 6, "reply": 30, "report": 5}, "normal": Object{"post": 12, "version": 24, "reply": 120, "report": 20}, "maxPermissionSeconds": 2592000, "maxGovernanceHideSeconds": 86400, "accountForumMaxBytes": 2097152, "maxTitleCodePoints": 160, "maxBodyCodePoints": 8000, "maxReplyCodePoints": 2000, "maxReportCodePoints": 1600, "maxLinks": 8, "maxLinkCodePoints": 2048, "maxPayloadBytes": 49152, "maxAppeals": 3, "maxReportEvents": 100, "dailyUsageDays": 30, "auditDays": 180}
}
func (s *Service) policy() Object {
	if s.policyState != nil {
		if current := s.policyState.current.Load(); current != nil {
			return current.policy
		}
	}
	if s.Policy != nil {
		return s.Policy
	}
	return defaultPolicy()
}

// policyHash preserves the original Zod schema's property order, unlike sorted
// canonical JSON used for locator IDs.
func (s *Service) policyHash() string {
	if s.policyState != nil {
		if current := s.policyState.current.Load(); current != nil {
			return current.hash
		}
	}
	p := s.policy()
	keys := []string{"version", "new", "normal", "maxPermissionSeconds", "maxGovernanceHideSeconds", "accountForumMaxBytes", "maxTitleCodePoints", "maxBodyCodePoints", "maxReplyCodePoints", "maxReportCodePoints", "maxLinks", "maxLinkCodePoints", "maxPayloadBytes", "maxAppeals", "maxReportEvents", "dailyUsageDays", "auditDays"}
	b := []byte{'{'}
	for i, k := range keys {
		if i > 0 {
			b = append(b, ',')
		}
		b = append(b, encode(k)...)
		b = append(b, ':')
		if k == "new" || k == "normal" {
			b = append(b, '{')
			for j, c := range []string{"post", "version", "reply", "report"} {
				if j > 0 {
					b = append(b, ',')
				}
				b = append(b, encode(c)...)
				b = append(b, ':')
				b = append(b, encode(obj(p, k)[c])...)
			}
			b = append(b, '}')
		} else {
			b = append(b, encode(p[k])...)
		}
	}
	b = append(b, '}')
	return identity.Digest(b)
}
