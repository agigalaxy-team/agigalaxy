package publicwrites

import (
	"context"
	"encoding/json"
	"errors"
	"math"
	"regexp"
	"strings"
	"time"

	"github.com/agigalaxy-team/agigalaxy/go/internal/accountlinks"
	"github.com/agigalaxy-team/agigalaxy/go/internal/deviceauth"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/postgres"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

type Actor struct {
	Device    *deviceauth.Actor
	AccountID string
	Authority accountlinks.PortalAuthorization
	Scope     string
}
type Operation struct{ Kind, OperationID, PayloadHash, TaskID, RoomID, ContactID, RecruitmentID, RecipientID string }
type Targets struct{ TaskID, RoomID, ContactID, RecipientID string }
type Service struct {
	Pool        *pgxpool.Pool
	Endpoint    string
	Links       *accountlinks.Service
	Policy      Object
	Now         func() time.Time
	policyState *policyState
}
type Error struct {
	Cause             error
	Quota             Object
	RetryAfterSeconds int64
	RestrictionReason any
}

func (e *Error) Error() string { return e.Cause.Error() }
func (e *Error) Unwrap() error { return e.Cause }
func Details(err error) Object {
	var e *Error
	if !errors.As(err, &e) {
		return nil
	}
	out := Object{}
	if e.Quota != nil {
		out["quota"] = e.Quota
	}
	if e.RetryAfterSeconds > 0 {
		out["retryAfterSeconds"] = e.RetryAfterSeconds
	}
	if e.RestrictionReason != nil {
		out["restrictionReason"] = e.RestrictionReason
	}
	return out
}
func (s *Service) now() time.Time {
	if s.Now != nil {
		return s.Now().UTC().Truncate(time.Second)
	}
	return time.Now().UTC().Truncate(time.Second)
}
func (s *Service) policy() (Object, error) {
	if s.policyState != nil {
		if p := s.policyState.current.Load(); p != nil {
			return p.value, nil
		}
	}
	p := s.Policy
	if p == nil {
		p = DefaultPolicy()
	}
	if e := ValidatePolicy(p); e != nil {
		return nil, e
	}
	return p, nil
}
func object(v any) Object { m, _ := v.(map[string]any); return m }
func text(v any) string   { s, _ := v.(string); return s }
func number(v any) int64 {
	switch n := v.(type) {
	case int:
		return int64(n)
	case int64:
		return n
	case float64:
		return int64(n)
	case json.Number:
		v, e := n.Int64()
		if e == nil {
			return v
		}
		f, e := n.Float64()
		if e == nil && f >= math.MinInt64 && f < math.MaxInt64 {
			return int64(f)
		}
		return 0
	}
	return 0
}
func date(v any) time.Time {
	if t, ok := v.(time.Time); ok {
		return t
	}
	t, _ := time.Parse(time.RFC3339Nano, text(v))
	return t
}
func iso(t time.Time) string { return t.UTC().Format("2006-01-02T15:04:05.000Z") }
func dbRow(ctx context.Context, tx pgx.Tx, sql string, args ...any) (Object, error) {
	var row Object
	e := tx.QueryRow(ctx, sql, args...).Scan(&row)
	if errors.Is(e, pgx.ErrNoRows) {
		return nil, nil
	}
	return row, e
}
func (s *Service) resolve(ctx context.Context, tx pgx.Tx, a Actor, lock bool) (Object, error) {
	if s == nil || s.Links == nil || s.Endpoint == "" || s.Links.Endpoint != s.Endpoint {
		return nil, fault.New("public_write_verification_unavailable", 503)
	}
	if a.Device != nil {
		scope := a.Scope
		if scope == "" {
			scope = "binding"
		}
		return s.Links.ForScope(scope).ResolveWithin(ctx, tx, *a.Device, a.AccountID, lock)
	}
	return s.Links.ResolvePortalWithin(ctx, tx, a.Authority, s.Endpoint, a.AccountID, a.AccountID, lock)
}
func (s *Service) QuotaWithin(ctx context.Context, tx pgx.Tx, account Object, category string) (Object, error) {
	if category != "task" && category != "comment" && category != "invitation" {
		return nil, fault.New("invalid_public_write", 400)
	}
	policy, e := s.policy()
	if e != nil {
		return nil, e
	}
	now := s.now()
	tier := text(account["tier_override"])
	if tier == "" {
		tier = "new"
		if !date(account["created_at"]).Add(time.Duration(number(policy["promotionDays"])) * 24 * time.Hour).After(now) {
			var interaction bool
			if e = tx.QueryRow(ctx, "SELECT EXISTS(SELECT 1 FROM community_interactions WHERE account_id=$1 AND invalidated_at IS NULL)", account["id"]).Scan(&interaction); e != nil {
				return nil, e
			}
			if interaction {
				tier = "normal"
			}
		}
	}
	limits := object(policy[tier])
	limit := number(limits[category])
	var used int64
	if e = tx.QueryRow(ctx, "SELECT coalesce((SELECT used FROM community_daily_usage WHERE account_id=$1 AND day=$2 AND category=$3),0)", account["id"], now.Format("2006-01-02"), category).Scan(&used); e != nil {
		return nil, e
	}
	if limit < 1 || limit > 9007199254740991 || used < 0 || used > 9007199254740991 {
		return nil, errors.New("invalid quota counter")
	}
	out := Object{"category": category, "limit": limit, "used": used, "remaining": max(int64(0), limit-used), "tier": tier, "resetAt": iso(time.Unix((now.Unix()/86400+1)*86400, 0)), "policyVersion": policy["version"]}
	if category == "task" {
		out["covers"] = []string{"task-publication", "recruitment-publication"}
	}
	return out, nil
}

var uuidPattern = regexp.MustCompile(`(?i)^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`)
var hashPattern = regexp.MustCompile(`^[a-f0-9]{64}$`)

func validUUID(id string) bool {
	return uuidPattern.MatchString(id) || id == "00000000-0000-0000-0000-000000000000" || strings.EqualFold(id, "ffffffff-ffff-ffff-ffff-ffffffffffff")
}
func validOperation(op Operation) bool {
	if op.Kind != "task" && op.Kind != "recruitment" && op.Kind != "comment" && op.Kind != "invitation" || !validUUID(op.OperationID) || !hashPattern.MatchString(op.PayloadHash) {
		return false
	}
	targets := 0
	for _, id := range []string{op.TaskID, op.RoomID, op.ContactID, op.RecruitmentID} {
		if id != "" {
			targets++
			if !validUUID(id) {
				return false
			}
		}
	}
	if targets > 1 || (op.Kind == "recruitment") != (op.RecruitmentID != "") || op.RecipientID != "" && !validText(op.RecipientID, 128) {
		return false
	}
	return op.Kind != "invitation" || op.RecipientID != "" && (op.TaskID != "" || op.RoomID != "" || op.ContactID != "")
}
func nullable(s string) any {
	if s == "" {
		return nil
	}
	return s
}
func (s *Service) ConsumeWithin(ctx context.Context, tx pgx.Tx, a Actor, op Operation) (Object, error) {
	if !validOperation(op) {
		return nil, fault.New("invalid_public_write", 400)
	}
	policy, e := s.policy()
	if e != nil {
		return nil, e
	}
	category := op.Kind
	if category == "recruitment" {
		category = "task"
	}
	actorRef := "account:" + a.AccountID
	kind := "official-account"
	var subject any
	if a.Device != nil {
		actorRef = a.Device.SubjectID
		kind = "identity"
		subject = a.Device.SubjectID
	}
	account, e := s.resolve(ctx, tx, a, true)
	if e != nil {
		return nil, e
	}
	prior, e := dbRow(ctx, tx, "SELECT to_jsonb(r) FROM community_write_receipts r WHERE account_id=$1 AND category=$2 AND operation_id=$3", account["id"], category, op.OperationID)
	if e != nil {
		return nil, e
	}
	if prior != nil {
		if prior["actor_ref"] != actorRef || prior["payload_hash"] != op.PayloadHash || prior["task_id"] != nullable(op.TaskID) || prior["room_id"] != nullable(op.RoomID) || prior["contact_id"] != nullable(op.ContactID) || prior["recruitment_id"] != nullable(op.RecruitmentID) || prior["recipient_id"] != nullable(op.RecipientID) {
			return nil, fault.New("public_write_conflict", 409)
		}
		return s.QuotaWithin(ctx, tx, account, category)
	}
	now := s.now()
	if account["restricted_until"] != nil && date(account["restricted_until"]).After(now) {
		return nil, &Error{Cause: fault.New("community_restricted", 403), RestrictionReason: account["restriction_reason"], RetryAfterSeconds: int64(math.Ceil(float64(date(account["restricted_until"]).UnixMilli())/1000 - float64(now.Unix())))}
	}
	if op.Kind == "invitation" {
		pending, e := dbRow(ctx, tx, "SELECT jsonb_build_object('created_at',created_at) FROM community_write_receipts WHERE account_id=$1 AND category='invitation' AND recipient_id=$2 AND responded_at IS NULL AND created_at>$3 ORDER BY created_at DESC LIMIT 1", account["id"], op.RecipientID, now.Add(-time.Duration(number(policy["invitationCooldownDays"]))*24*time.Hour))
		if e != nil {
			return nil, e
		}
		if pending != nil {
			return nil, &Error{Cause: fault.New("invitation_cooldown", 429), RetryAfterSeconds: int64(math.Ceil(float64(date(pending["created_at"]).UnixMilli())/1000 + float64(number(policy["invitationCooldownDays"])*86400) - float64(now.Unix())))}
		}
	}
	quota, e := s.QuotaWithin(ctx, tx, account, category)
	if e != nil {
		return nil, e
	}
	if number(quota["remaining"]) == 0 {
		return nil, &Error{Cause: fault.New("community_quota_exceeded", 429), Quota: quota, RetryAfterSeconds: date(quota["resetAt"]).Unix() - now.Unix()}
	}
	if _, e = tx.Exec(ctx, `INSERT INTO community_write_receipts(account_id,operation_id,category,subject_id,payload_hash,task_id,recipient_id,created_at,room_id,contact_id,recruitment_id,actor_ref,actor_kind) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`, account["id"], op.OperationID, category, subject, op.PayloadHash, nullable(op.TaskID), nullable(op.RecipientID), now, nullable(op.RoomID), nullable(op.ContactID), nullable(op.RecruitmentID), actorRef, kind); e != nil {
		return nil, e
	}
	if _, e = tx.Exec(ctx, `INSERT INTO community_daily_usage(account_id,day,category,used) VALUES($1,$2,$3,1) ON CONFLICT(account_id,day,category) DO UPDATE SET used=community_daily_usage.used+1`, account["id"], now.Format("2006-01-02"), category); e != nil {
		return nil, e
	}
	quota["used"] = number(quota["used"]) + 1
	quota["remaining"] = number(quota["remaining"]) - 1
	return quota, nil
}
func (s *Service) MarkInvitationRespondedWithin(ctx context.Context, tx pgx.Tx, target Targets) error {
	count := 0
	column, id := "task_id", target.TaskID
	for _, value := range []string{target.TaskID, target.RoomID, target.ContactID} {
		if value != "" {
			count++
		}
	}
	if count != 1 {
		return fault.New("invalid_public_write", 400)
	}
	if target.ContactID != "" {
		column, id = "contact_id", target.ContactID
	} else if target.RoomID != "" {
		column, id = "room_id", target.RoomID
	}
	_, e := tx.Exec(ctx, "UPDATE community_write_receipts SET responded_at=$3 WHERE "+column+"=$1 AND recipient_id=$2 AND category='invitation' AND responded_at IS NULL", id, target.RecipientID, s.now())
	return e
}

func (s *Service) StatusWithin(ctx context.Context, tx pgx.Tx, a Actor) (Object, error) {
	account, e := s.resolve(ctx, tx, a, false)
	if e != nil {
		if fault.Code(e) == "account_verification_required" {
			return Object{"accountVerified": false, "quotas": []Object{}, "reason": fault.Code(e)}, nil
		}
		return nil, e
	}
	quotas := []Object{}
	for _, kind := range []string{"task", "comment", "invitation"} {
		quota, e := s.QuotaWithin(ctx, tx, account, kind)
		if e != nil {
			return nil, e
		}
		quotas = append(quotas, quota)
	}
	var restriction any
	if account["restricted_until"] != nil && date(account["restricted_until"]).After(s.now()) {
		restriction = Object{"until": iso(date(account["restricted_until"])), "reason": account["restriction_reason"]}
	}
	return Object{"accountId": account["id"], "accountVerified": true, "restriction": restriction, "quotas": quotas}, nil
}
func (s *Service) Status(ctx context.Context, a Actor) (Object, error) {
	pool := s.Pool
	if pool == nil && s.Links != nil {
		pool = s.Links.Pool
	}
	if pool == nil {
		return nil, fault.New("public_write_verification_unavailable", 503)
	}
	return postgres.InTx(ctx, pool, func(tx pgx.Tx) (Object, error) { return s.StatusWithin(ctx, tx, a) })
}
