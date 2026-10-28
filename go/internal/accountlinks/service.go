// Package accountlinks owns the existing controlled-ID/account association.
// An association supplies an eligible target, never a new Galaxy API grant.
package accountlinks

import (
	"context"
	"crypto/sha256"
	"encoding/binary"
	"errors"
	"sort"
	"strings"
	"time"

	"github.com/agigalaxy-team/agigalaxy/go/internal/accounts"
	"github.com/agigalaxy-team/agigalaxy/go/internal/deviceauth"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

type Object = map[string]any
type Provider struct{ Issuer, ClientID string }
type Service struct {
	Pool             *pgxpool.Pool
	Endpoint         string
	Devices          *deviceauth.Service
	Accounts         *accounts.Service
	Providers        []Provider
	CurrentProviders func() []Provider
	Scope            string
	Now              func() time.Time
}

func (s *Service) ForScope(scope string) *Service { copy := *s; copy.Scope = scope; return &copy }
func (s *Service) now() time.Time {
	if s.Now != nil {
		return s.Now().UTC().Truncate(time.Second)
	}
	return time.Now().UTC().Truncate(time.Second)
}
func (s *Service) providers() []Provider {
	if s.CurrentProviders != nil {
		return s.CurrentProviders()
	}
	return s.Providers
}
func (s *Service) allows(issuer, client string) bool {
	for _, p := range s.providers() {
		if p.Issuer == issuer && p.ClientID == client {
			return true
		}
	}
	return false
}
func (s *Service) authorize(ctx context.Context, tx pgx.Tx, actor deviceauth.Actor) error {
	if s == nil || s.Devices == nil || s.Endpoint == "" || s.Devices.Endpoint != s.Endpoint {
		return fault.New("account_authority_unavailable", 503)
	}
	scope := s.Scope
	if scope == "" {
		scope = "binding"
	}
	return s.Devices.AuthorizeWithin(ctx, tx, actor, scope)
}

// MappingLockKeys matches the original JSON.stringify+SHA256 physical keys.
func MappingLockKeys(endpoint string, subjects []string) ([]int32, error) {
	if endpoint == "" {
		return nil, fault.New("chat_control_relationship_unavailable", 503)
	}
	seen := map[int32]bool{}
	for _, id := range subjects {
		if id == "" {
			return nil, fault.New("chat_control_relationship_unavailable", 503)
		}
		b, e := protocol.Encode([]string{"galaxy-controller-mapping/v1", endpoint, id})
		if e != nil {
			return nil, e
		}
		digest := sha256.Sum256(b)
		seen[int32(binary.BigEndian.Uint32(digest[:4]))] = true
	}
	keys := []int32{}
	for key := range seen {
		keys = append(keys, key)
	}
	sort.Slice(keys, func(i, j int) bool { return keys[i] < keys[j] })
	return keys, nil
}
func LockMappingsWithin(ctx context.Context, tx pgx.Tx, endpoint string, subjects []string, exclusive bool) error {
	keys, e := MappingLockKeys(endpoint, subjects)
	if e != nil {
		return e
	}
	fn := "pg_advisory_xact_lock_shared"
	if exclusive {
		fn = "pg_advisory_xact_lock"
	}
	for _, key := range keys {
		if _, e := tx.Exec(ctx, "SELECT "+fn+"($1,$2)", int32(0x47434d31), key); e != nil {
			return e
		}
	}
	return nil
}
func (s *Service) AvailableWithin(ctx context.Context, tx pgx.Tx, actor deviceauth.Actor) ([]Object, error) {
	if e := s.authorize(ctx, tx, actor); e != nil {
		return nil, e
	}
	return s.availableSubjectWithin(ctx, tx, actor.SubjectID)
}
func (s *Service) availableSubjectWithin(ctx context.Context, tx pgx.Tx, subject string) ([]Object, error) {
	if e := LockMappingsWithin(ctx, tx, s.Endpoint, []string{subject}, false); e != nil {
		return nil, e
	}
	rows, e := tx.Query(ctx, `SELECT to_jsonb(a)||jsonb_build_object('display_name',p.display_name,'avatar_key',p.avatar_key,'subject_type',p.subject_type,'client_id',l.client_id) FROM community_accounts a JOIN community_account_links g ON g.account_id=a.id JOIN external_identity_links l ON l.id=g.identity_link_id LEFT JOIN official_account_profiles_v1 p ON p.account_id=a.id WHERE g.subject_id=$1 AND l.revoked_at IS NULL AND a.endpoint=$2 ORDER BY a.created_at,a.id`, subject, s.Endpoint)
	if e != nil {
		return nil, e
	}
	defer rows.Close()
	out := []Object{}
	index := map[string]int{}
	for rows.Next() {
		var row Object
		if e = rows.Scan(&row); e != nil {
			return nil, e
		}
		issuer, _ := row["issuer"].(string)
		client, _ := row["client_id"].(string)
		if !s.allows(issuer, client) {
			continue
		}
		id, _ := row["id"].(string)
		if i, exists := index[id]; exists {
			out[i] = row
		} else {
			index[id] = len(out)
			out = append(out, row)
		}
	}
	return out, rows.Err()
}
func (s *Service) ResolveWithin(ctx context.Context, tx pgx.Tx, actor deviceauth.Actor, selected string, lock bool) (Object, error) {
	rows, e := s.AvailableWithin(ctx, tx, actor)
	if e != nil {
		return nil, e
	}
	return selectWithin(ctx, tx, rows, selected, lock)
}
func selectWithin(ctx context.Context, tx pgx.Tx, rows []Object, selected string, lock bool) (Object, error) {
	if selected == "" && len(rows) > 1 {
		return nil, fault.New("account_selection_required", 409)
	}
	var found Object
	for _, row := range rows {
		if selected == "" || row["id"] == selected {
			found = row
			break
		}
	}
	if found == nil {
		if selected != "" {
			return nil, fault.New("account_target_unavailable", 403)
		}
		return nil, fault.New("account_verification_required", 403)
	}
	if lock {
		var current Object
		e := tx.QueryRow(ctx, "SELECT to_jsonb(a) FROM community_accounts a WHERE id=$1 FOR UPDATE", found["id"]).Scan(&current)
		if errors.Is(e, pgx.ErrNoRows) {
			return nil, fault.New("account_target_unavailable", 403)
		}
		if e != nil {
			return nil, e
		}
		for k, v := range current {
			found[k] = v
		}
	}
	return found, nil
}

type PortalAuthorization interface {
	Account(context.Context, pgx.Tx, string, string) error
}

func (s *Service) AvailablePortalWithin(ctx context.Context, tx pgx.Tx, authorization PortalAuthorization, endpoint, account string) ([]Object, error) {
	if endpoint != s.Endpoint || !validUUID(account) {
		return nil, fault.New("access_denied", 401)
	}
	if authorization == nil {
		return nil, fault.New("official_account_unavailable", 503)
	}
	if e := authorization.Account(ctx, tx, s.Endpoint, account); e != nil {
		return nil, e
	}
	rows, e := tx.Query(ctx, `SELECT to_jsonb(a)||jsonb_build_object('display_name',p.display_name,'avatar_key',p.avatar_key,'subject_type',p.subject_type) FROM community_accounts a LEFT JOIN official_account_profiles_v1 p ON p.account_id=a.id WHERE a.id=$1 AND a.endpoint=$2`, account, s.Endpoint)
	if e != nil {
		return nil, e
	}
	defer rows.Close()
	out := []Object{}
	for rows.Next() {
		var row Object
		if e = rows.Scan(&row); e != nil {
			return nil, e
		}
		out = append(out, row)
	}
	return out, rows.Err()
}
func (s *Service) ResolvePortalWithin(ctx context.Context, tx pgx.Tx, authorization PortalAuthorization, endpoint, account, selected string, lock bool) (Object, error) {
	rows, e := s.AvailablePortalWithin(ctx, tx, authorization, endpoint, account)
	if e != nil {
		return nil, e
	}
	if selected != "" && selected != account {
		return nil, fault.New("official_account_changed", 409)
	}
	if selected == "" {
		selected = account
	}
	return selectWithin(ctx, tx, rows, selected, lock)
}
func View(row Object, current string) Object {
	id, _ := row["id"].(string)
	return Object{"id": id, "accountId": id, "uid": row["uid"], "displayName": row["display_name"], "avatarKey": row["avatar_key"], "subjectType": row["subject_type"], "endpoint": row["endpoint"], "current": id == current}
}
func validUUID(value string) bool {
	v, e := uuid.Parse(value)
	return e == nil && strings.EqualFold(v.String(), value)
}

type VerifiedLink struct {
	SubjectID, LinkID, Endpoint, Issuer, ExternalSubject, VerificationMethod string
	VerifiedAt                                                               int64
}

// LinkVerifiedWithin is called only after verified OIDC and the existing
// identity-link signature have been verified in the same caller transaction.
func (s *Service) LinkVerifiedWithin(ctx context.Context, tx pgx.Tx, input VerifiedLink) (Object, error) {
	if input.SubjectID == "" || protocol.TextLength(input.SubjectID) > 128 || !validUUID(input.LinkID) || input.Endpoint != s.Endpoint || input.Issuer == "" || input.ExternalSubject == "" || protocol.TextLength(input.ExternalSubject) > 255 || input.VerifiedAt < 0 || input.VerifiedAt > s.now().Unix() || (input.VerificationMethod != "email" && input.VerificationMethod != "external-account") {
		return nil, fault.New("invalid_account_verification", 400)
	}
	if e := LockMappingsWithin(ctx, tx, s.Endpoint, []string{input.SubjectID}, true); e != nil {
		return nil, e
	}
	var issuer, client string
	e := tx.QueryRow(ctx, `SELECT issuer,client_id FROM external_identity_links WHERE id=$1 AND subject_id=$2 AND endpoint=$3 AND issuer=$4 AND external_subject=$5 AND revoked_at IS NULL`, input.LinkID, input.SubjectID, s.Endpoint, input.Issuer, input.ExternalSubject).Scan(&issuer, &client)
	if errors.Is(e, pgx.ErrNoRows) {
		return nil, fault.New("identity_provider_unavailable", 409)
	}
	if e != nil {
		return nil, e
	}
	if !s.allows(issuer, client) {
		return nil, fault.New("identity_provider_unavailable", 409)
	}
	data := s.Accounts
	if data == nil {
		data = &accounts.Service{Endpoint: s.Endpoint, Now: s.Now}
	}
	if data.Endpoint != s.Endpoint {
		return nil, fault.New("official_account_unavailable", 503)
	}
	account, e := data.EnsureAccountWithin(ctx, tx, accounts.VerifiedIdentity{Issuer: input.Issuer, ExternalSubject: input.ExternalSubject, VerificationMethod: input.VerificationMethod, VerifiedAt: time.Unix(input.VerifiedAt, 0)})
	if e != nil {
		return nil, e
	}
	if _, e = data.EnsureProfileWithin(ctx, tx, account.ID, nil); e != nil {
		return nil, e
	}
	_, e = tx.Exec(ctx, "INSERT INTO community_account_links(identity_link_id,account_id,subject_id,created_at) VALUES($1,$2,$3,$4) ON CONFLICT(identity_link_id) DO NOTHING", input.LinkID, account.ID, input.SubjectID, s.now())
	return Object{"accountId": account.ID, "accountVerified": true, "galaxyAuthorization": false}, e
}

type Interaction struct{ SubjectID, CounterpartyID, SourceID, SourceKind string }

// RecordInteractionWithin is an internal accepted-source hook, not an HTTP
// upgrade or caller-reported interaction. It preserves the existing receipt.
func (s *Service) RecordInteractionWithin(ctx context.Context, tx pgx.Tx, input Interaction) error {
	if input.SubjectID == input.CounterpartyID || !validUUID(input.SourceID) || (input.SourceKind != "accepted-participation" && input.SourceKind != "accepted-delivery" && input.SourceKind != "moderator-confirmed-interaction") {
		return nil
	}
	available, e := s.availableSubjectWithin(ctx, tx, input.SubjectID)
	if e != nil {
		return e
	}
	account, e := selectWithin(ctx, tx, available, "", false)
	if fault.Code(e) == "account_verification_required" || fault.Code(e) == "account_selection_required" {
		return nil
	}
	if e != nil {
		return e
	}
	var own bool
	if e = tx.QueryRow(ctx, "SELECT EXISTS(SELECT 1 FROM community_account_links WHERE account_id=$1 AND subject_id=$2)", account["id"], input.CounterpartyID).Scan(&own); e != nil || own {
		return e
	}
	_, e = tx.Exec(ctx, "INSERT INTO community_interactions(account_id,source_id,source_kind,counterparty_id,created_at) VALUES($1,$2,$3,$4,$5) ON CONFLICT(account_id,source_id) DO NOTHING", account["id"], input.SourceID, input.SourceKind, input.CounterpartyID, s.now())
	return e
}
func encode(v any) []byte            { b, _ := protocol.Encode(v); return b }
func decode(raw []byte, v any) error { return protocol.Decode(raw, v) }
