// Package managementaccounts owns the existing management identity observations
// and durable account commands. Observations never establish current authority.
package managementaccounts

import (
	"context"
	"encoding/json"
	"errors"
	"time"

	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/identity"
	"github.com/agigalaxy-team/agigalaxy/go/internal/postgres"
	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

type Object = map[string]any

// User is the original native management-directory projection, in its original
// member order. TargetVersion hashes this projection, not a sorted JSON map.
type User struct {
	Issuer          string   `json:"issuer"`
	ExternalSubject string   `json:"externalSubject"`
	Username        string   `json:"username"`
	FirstName       string   `json:"firstName"`
	LastName        string   `json:"lastName"`
	Email           *string  `json:"email"`
	EmailVerified   bool     `json:"emailVerified"`
	Enabled         bool     `json:"enabled"`
	CreatedAt       *string  `json:"createdAt"`
	Admission       string   `json:"admission"`
	RequiredActions []string `json:"requiredActions"`
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
type Directory struct {
	Pool     *pgxpool.Pool
	Endpoint string
	Reader   DirectoryReader
	Now      func() time.Time
}

func (s *Directory) now() time.Time {
	if s.Now != nil {
		return s.Now()
	}
	return time.Now()
}

type Querier interface {
	QueryRow(context.Context, string, ...any) pgx.Row
}

func within(ctx context.Context, pool *pgxpool.Pool, run func(pgx.Tx) error) error {
	_, e := postgres.InTx(ctx, pool, func(tx pgx.Tx) (bool, error) { return true, run(tx) })
	return e
}

func readObject(ctx context.Context, q Querier, sql string, args ...any) (Object, error) {
	var b []byte
	if e := q.QueryRow(ctx, sql, args...).Scan(&b); e != nil {
		return nil, e
	}
	var o Object
	e := json.Unmarshal(b, &o)
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
func integer(v any) int64 {
	switch n := v.(type) {
	case float64:
		return int64(n)
	case int:
		return int64(n)
	case int64:
		return n
	case json.Number:
		i, _ := n.Int64()
		return i
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
	t, e := time.Parse(time.RFC3339Nano, str(v))
	if e != nil {
		return nil
	}
	return stamp(t)
}
func ID(issuer, subject string) string { return identity.Digest([]byte(issuer + "\x00" + subject)) }
func TargetVersion(user *User, meta Object) (string, error) {
	m := protocol.NewOrderedObject()
	version := meta["version"]
	if version == nil {
		version = 0
	}
	blocked := meta["login_blocked"]
	if blocked == nil {
		blocked = false
	}
	m.Set("version", version)
	m.Set("loginBlocked", blocked)
	m.Set("deletedAt", nullableStamp(meta["deleted_at"]))
	b, e := protocol.EncodeJS([]any{user, m})
	if e != nil {
		return "", e
	}
	return identity.Digest(b), nil
}

var safeCodes = map[string]bool{}

func init() {
	for _, c := range []string{"management_identity_unavailable", "management_identity_read_forbidden", "management_identity_client_unavailable", "management_identity_response_invalid", "management_identity_target_changed", "management_identity_not_found", "management_writer_not_configured", "management_identity_write_forbidden", "management_identity_write_failed", "management_identity_submission_unknown", "management_password_policy_rejected", "management_username_conflict", "management_root_protected", "management_root_only", "management_self_protected", "management_sessions_unavailable", "management_directory_source_changed", "management_command_unavailable", "management_email_verification_not_configured", "operations_permission_denied", "business_admin_denied", "operations_authorization_unavailable"} {
		safeCodes[c] = true
	}
}
func safeCode(e error) string {
	c := fault.Code(e)
	if safeCodes[c] {
		return c
	}
	return "management_command_unavailable"
}
func changed() error { return fault.New("management_directory_source_changed", 503) }
