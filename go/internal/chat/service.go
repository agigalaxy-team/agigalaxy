// Package chat owns the existing Galaxy room/message authority. Prosody keeps
// delivery and archive bodies; the Galaxy database keeps original metadata,
// membership, decisions, visibility, cursors and accepted-operation receipts.
package chat

import (
	"context"
	"encoding/json"
	"errors"
	"github.com/agigalaxy-team/agigalaxy/go/internal/accountlinks"
	"github.com/agigalaxy-team/agigalaxy/go/internal/businessrules"
	"github.com/agigalaxy-team/agigalaxy/go/internal/deviceauth"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/identity"
	"github.com/agigalaxy-team/agigalaxy/go/internal/postgres"
	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
	"github.com/agigalaxy-team/agigalaxy/go/internal/resourcebudget"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"regexp"
	"strings"
	"time"
)

type Object = map[string]any
type Authorization interface {
	Account(context.Context, pgx.Tx, string, string) error
}
type Actor struct {
	AccountID string
	Device    *deviceauth.Actor
	Authority Authorization
	RequestID string
}
type Transport interface {
	Available() bool
	Command(context.Context, string, Object) (Object, error)
}
type Service struct {
	Pool            *pgxpool.Pool
	Endpoint        string
	Devices         *deviceauth.Service
	Links           *accountlinks.Service
	Resources       *resourcebudget.Service
	Rules           *businessrules.Service
	Transport       Transport
	Attachments     *AttachmentService
	CommunityPolicy Object
	TaskReference   func(context.Context, pgx.Tx, Actor, string) error
	Now             func() time.Time
}

func (s *Service) now() time.Time {
	if s.Now != nil {
		return s.Now().UTC().Truncate(time.Second)
	}
	return time.Now().UTC().Truncate(time.Second)
}
func stamp(t time.Time) string { return t.UTC().Format("2006-01-02T15:04:05.000Z") }
func iso(v any) any {
	if v == nil {
		return nil
	}
	t, _ := time.Parse(time.RFC3339Nano, asString(v))
	return stamp(t)
}
func sec(v any) int64    { t, _ := time.Parse(time.RFC3339Nano, asString(v)); return t.Unix() }
func millis(v any) int64 { t, _ := time.Parse(time.RFC3339Nano, asString(v)); return t.UnixMilli() }
func fail(code string, status ...int) error {
	n := 409
	if len(status) > 0 {
		n = status[0]
	}
	return fault.New(code, n)
}
func str(o Object, k string) string { s, _ := o[k].(string); return s }
func asString(v any) string         { s, _ := v.(string); return s }
func obj(o Object, k string) Object { v, _ := o[k].(map[string]any); return v }
func num(o Object, k string) int64 {
	switch v := o[k].(type) {
	case float64:
		return int64(v)
	case int64:
		return v
	case int:
		return int64(v)
	case json.Number:
		n, _ := v.Int64()
		return n
	}
	return 0
}
func truth(o Object, k string) bool { b, _ := o[k].(bool); return b }
func null(s string) any {
	if s == "" {
		return nil
	}
	return s
}
func encode(v any) []byte    { b, _ := protocol.Encode(v); return b }
func canonical(v any) string { b, _ := identity.Canonical(v); return identity.Digest(b) }

var uuidPattern = regexp.MustCompile(`(?i)^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`)
var subjectPattern = regexp.MustCompile(`^GUID[A-Z0-9]{28}$`)
var accountPattern = regexp.MustCompile(`^account:([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$`)

func validID(v string) bool { return uuidPattern.MatchString(v) }
func actorRef(a Actor) (string, error) {
	if a.Device != nil {
		if !subjectPattern.MatchString(a.Device.SubjectID) {
			return "", fail("access_denied", 401)
		}
		return a.Device.SubjectID, nil
	}
	ref := "account:" + a.AccountID
	if !accountPattern.MatchString(ref) {
		return "", fail("access_denied", 401)
	}
	return ref, nil
}
func actorView(ref string) Object {
	if m := accountPattern.FindStringSubmatch(ref); m != nil {
		return Object{"kind": "official-account", "actorRef": ref, "accountId": m[1], "galaxySubjectId": nil}
	}
	return Object{"kind": "identity", "actorRef": ref, "accountId": nil, "galaxySubjectId": ref}
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
	var out Object
	e = json.Unmarshal(raw, &out)
	return out, e
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
func (s *Service) account(ctx context.Context, tx pgx.Tx, a Actor, lock bool) (Object, error) {
	if s.Links == nil {
		return nil, fail("chat_account_adapter_unavailable", 503)
	}
	if a.Device != nil {
		return s.Links.ForScope("binding").ResolveWithin(ctx, tx, *a.Device, a.AccountID, lock)
	}
	return s.Links.ResolvePortalWithin(ctx, tx, a.Authority, s.Endpoint, a.AccountID, a.AccountID, lock)
}
func (s *Service) requireAccount(ctx context.Context, tx pgx.Tx, a Actor) (Object, error) {
	account, e := s.account(ctx, tx, a, false)
	if e != nil {
		return nil, e
	}
	if account["restricted_until"] != nil && sec(account["restricted_until"]) > s.now().Unix() {
		return nil, fail("community_restricted", 403)
	}
	return account, nil
}
func (s *Service) ensureParticipant(ctx context.Context, tx pgx.Tx, ref string) error {
	view := actorView(ref)
	if !subjectPattern.MatchString(ref) && !accountPattern.MatchString(ref) {
		return fail("invalid_chat_participant", 400)
	}
	var exists bool
	var e error
	if view["accountId"] != nil {
		e = tx.QueryRow(ctx, "SELECT EXISTS(SELECT 1 FROM community_accounts WHERE id=$1 AND endpoint=$2)", view["accountId"], s.Endpoint).Scan(&exists)
	} else {
		e = tx.QueryRow(ctx, "SELECT EXISTS(SELECT 1 FROM subjects WHERE id=$1)", ref).Scan(&exists)
	}
	if e != nil {
		return e
	}
	if !exists {
		return fail("chat_participant_unavailable", 404)
	}
	_, e = tx.Exec(ctx, "INSERT INTO chat_participants_v3(actor_ref,kind,subject_id,account_id) VALUES($1,$2,$3,$4) ON CONFLICT(actor_ref) DO NOTHING", ref, view["kind"], view["galaxySubjectId"], view["accountId"])
	return e
}
func (s *Service) run(ctx context.Context, a Actor, write, control bool, fn func(pgx.Tx) (Object, error)) (Object, error) {
	ref, e := actorRef(a)
	if e != nil {
		return nil, e
	}
	return postgres.InTx(ctx, s.Pool, func(tx pgx.Tx) (Object, error) {
		authorize := func(ctx context.Context, tx pgx.Tx) error {
			if a.Device != nil {
				if s.Devices == nil {
					return fail("chat_authority_unavailable", 503)
				}
				return s.Devices.AuthorizeWithin(ctx, tx, *a.Device, "binding")
			}
			if _, e := s.account(ctx, tx, a, false); e != nil {
				return e
			}
			return nil
		}
		operation := func(_ context.Context, tx pgx.Tx) (any, error) {
			if e := s.ensureParticipant(ctx, tx, ref); e != nil {
				return nil, e
			}
			return fn(tx)
		}
		if a.Device == nil {
			if e := authorize(ctx, tx); e != nil {
				return nil, e
			}
			if write && !control && s.Resources != nil {
				result, e := s.Resources.ResourceWrite(ctx, tx, resourcebudget.Actor{SubjectID: ref}, func(context.Context, pgx.Tx) error { return nil }, operation, resourcebudget.Options{})
				if e != nil {
					return nil, e
				}
				return result.(map[string]any), nil
			}
			result, e := operation(ctx, tx)
			if e != nil {
				return nil, e
			}
			return result.(map[string]any), nil
		}
		if write && s.Resources != nil {
			result, e := s.Resources.ResourceWrite(ctx, tx, resourcebudget.Actor{SubjectID: ref}, authorize, operation, resourcebudget.Options{Control: control})
			if e != nil {
				return nil, e
			}
			return result.(map[string]any), nil
		}
		if e := authorize(ctx, tx); e != nil {
			return nil, e
		}
		result, e := operation(ctx, tx)
		if e != nil {
			return nil, e
		}
		return result.(map[string]any), nil
	})
}
func (s *Service) command(ctx context.Context, action string, input Object) (Object, error) {
	if s.Transport == nil {
		return nil, fail("chat_transport_unavailable", 503)
	}
	return s.Transport.Command(ctx, action, input)
}
func has(values []string, value string) bool {
	for _, v := range values {
		if v == value {
			return true
		}
	}
	return false
}
func uniqueStrings(v any) []string {
	a, _ := v.([]any)
	out := []string{}
	for _, value := range a {
		if s, ok := value.(string); ok && !has(out, s) {
			out = append(out, s)
		}
	}
	return out
}
func initialRule() Object {
	return Object{"mode": "approval-required", "version": 1, "decisionId": nil, "requestHash": nil, "expiresAt": nil}
}
func roomRule(room Object, now int64) Object {
	rule := obj(room, "join_rule")
	if rule == nil {
		rule = initialRule()
	}
	out := Object{}
	for k, v := range rule {
		out[k] = v
	}
	expired := rule["expiresAt"] != nil && num(rule, "expiresAt") <= now
	out["active"] = !expired
	mode := str(rule, "mode")
	if expired {
		mode = "approval-required"
	}
	out["effectiveMode"] = mode
	return out
}
func ruleHash(rule Object) string {
	return canonical(Object{"mode": rule["mode"], "version": rule["version"], "decisionId": rule["decisionId"], "requestHash": rule["requestHash"], "expiresAt": rule["expiresAt"]})
}
func trim(s string) string {
	return strings.TrimFunc(s, func(r rune) bool {
		return r >= 9 && r <= 13 || r == 32 || r == 0xa0 || r == 0x1680 || r >= 0x2000 && r <= 0x200a || r == 0x2028 || r == 0x2029 || r == 0x202f || r == 0x205f || r == 0x3000 || r == 0xfeff
	})
}
