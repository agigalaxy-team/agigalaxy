// Package registeredusers keeps the website registration observation separate
// from business-account formation and from management-realm identities.
package registeredusers

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"time"

	"github.com/agigalaxy-team/agigalaxy/go/internal/accounts"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/identity"
	p "github.com/agigalaxy-team/agigalaxy/go/internal/operationspermissions"
	"github.com/agigalaxy-team/agigalaxy/go/internal/postgres"
	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

type Object = map[string]any
type Actor = p.Actor
type User struct {
	Issuer            string   `json:"issuer"`
	ExternalSubject   string   `json:"externalSubject"`
	Email             *string  `json:"email"`
	EmailVerified     bool     `json:"emailVerified"`
	Enabled           bool     `json:"enabled"`
	RegisteredAt      *string  `json:"registeredAt"`
	DisplayName       *string  `json:"displayName"`
	ServiceAccount    bool     `json:"serviceAccount"`
	Federated         bool     `json:"federated"`
	Local             bool     `json:"local"`
	RequiredActions   []string `json:"requiredActions"`
	ManagementAllowed bool     `json:"managementAllowed"`
}
type Page struct {
	Items    []User
	RawCount int64
}
type DirectoryReader interface {
	Issuer() string
	Count(context.Context) (int64, error)
	Page(context.Context, int64, int) (Page, error)
	Get(context.Context, string, string) (*User, error)
}
type NativeDirectory interface {
	DirectoryReader
	ManagementConfigured() bool
	Management(context.Context, string, string) (Object, error)
	RegistrationEvidence(context.Context, string, string) (Object, error)
	SessionSummary(context.Context, string, string) (Object, error)
	SetEnabled(context.Context, string, string, bool, func() error) (Object, error)
	Logout(context.Context, string, string, func() error) (Object, error)
	ResetLink(context.Context, string, string, func() error) (Object, error)
}
type Portal interface {
	Summary(context.Context, string, string) (Object, error)
	Revoke(context.Context, string, string, *string) (Object, error)
}
type Directory struct {
	Pool     *pgxpool.Pool
	Endpoint string
	Reader   DirectoryReader
	Accounts *accounts.Service
	Now      func() time.Time
}
type Service struct {
	Pool      *pgxpool.Pool
	Endpoint  string
	Authority p.Authority
	Directory NativeDirectory
	Portal    Portal
	Accounts  *accounts.Service
	Now       func() time.Time
}
type Querier interface {
	QueryRow(context.Context, string, ...any) pgx.Row
}

func now(f func() time.Time) time.Time {
	if f != nil {
		return f().UTC()
	}
	return time.Now().UTC()
}
func (s *Directory) now() time.Time { return now(s.Now) }
func (s *Service) now() time.Time   { return now(s.Now) }
func (s *Service) index() *Directory {
	return &Directory{Pool: s.Pool, Endpoint: s.Endpoint, Reader: s.Directory, Accounts: s.Accounts, Now: s.Now}
}
func (s *Service) stamp(o Object) Object {
	o["checkedAt"] = s.now().Unix()
	o["readExpiresAt"] = s.now().Unix() + 30
	o["metadataOnly"] = true
	return o
}
func within(ctx context.Context, pool *pgxpool.Pool, f func(pgx.Tx) error) error {
	_, e := postgres.InTx(ctx, pool, func(tx pgx.Tx) (bool, error) { return true, f(tx) })
	return e
}
func readObject(ctx context.Context, q Querier, sql string, args ...any) (Object, error) {
	var raw []byte
	if e := q.QueryRow(ctx, sql, args...).Scan(&raw); e != nil {
		return nil, e
	}
	var o Object
	e := json.Unmarshal(raw, &o)
	return o, e
}
func optionalObject(ctx context.Context, q Querier, sql string, args ...any) (Object, error) {
	o, e := readObject(ctx, q, sql, args...)
	if errors.Is(e, pgx.ErrNoRows) {
		return nil, nil
	}
	return o, e
}
func str(v any) string { s, _ := v.(string); return s }
func obj(v any) Object { o, _ := v.(map[string]any); return o }
func integer(v any) int64 {
	switch n := v.(type) {
	case int:
		return int64(n)
	case int64:
		return n
	case float64:
		return int64(n)
	case json.Number:
		f, _ := n.Float64()
		return int64(f)
	}
	return 0
}
func stamp(t time.Time) string { return t.UTC().Format("2006-01-02T15:04:05.000Z") }
func nullableStamp(v any) any {
	if v == nil {
		return nil
	}
	if t, ok := v.(time.Time); ok {
		return stamp(t)
	}
	if t, e := time.Parse(time.RFC3339Nano, str(v)); e == nil {
		return stamp(t)
	}
	return nil
}
func invalid() error                     { return fault.New("invalid_registered_users_request", 400) }
func fail(code string, status int) error { return fault.New(code, status) }
func has(a []string, s string) bool {
	for _, v := range a {
		if v == s {
			return true
		}
	}
	return false
}
func TargetVersion(row Object, u *User) (string, error) {
	var identityPart any
	if u != nil {
		p := protocol.NewOrderedObject()
		p.Set("enabled", u.Enabled)
		p.Set("email", u.Email)
		p.Set("emailVerified", u.EmailVerified)
		p.Set("registeredAt", u.RegisteredAt)
		p.Set("serviceAccount", u.ServiceAccount)
		identityPart = p
	}
	b, e := protocol.EncodeJS([]any{row["registration_id"], row["issuer"], row["external_subject"], identityPart, row["account_id"], row["profile_account_id"], row["profile_revision"], row["display_name"], row["reserved_account_id"], row["reserved_uid"], row["preset_revision"]})
	if e != nil {
		return "", e
	}
	return identity.Digest(b), nil
}
func changed() error { return fail("registered_directory_source_changed", 503) }
func safeDirectoryError(e error) string {
	code := fault.Code(e)
	if has([]string{"registered_identity_read_forbidden", "registered_identity_client_unavailable", "registered_identity_response_invalid", "registered_directory_source_changed"}, code) {
		return code
	}
	return "registered_identity_unavailable"
}

func trim(s string) string {
	return strings.Trim(s, "\u0009\u000a\u000b\u000c\u000d\u0020\u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff")
}
