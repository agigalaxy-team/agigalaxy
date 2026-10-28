// Package subjectlifecycle owns the original ID takeout tickets and signed
// deletion request ledger. It never treats an account link as deletion authority.
package subjectlifecycle

import (
	"bytes"
	"context"
	_ "embed"
	"encoding/json"
	"errors"
	"strconv"
	"time"

	"github.com/agigalaxy-team/agigalaxy/go/internal/deviceauth"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/postgres"
	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
	"github.com/agigalaxy-team/agigalaxy/go/internal/resourcebudget"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

type Object = map[string]any
type Actor struct {
	deviceauth.Actor
	HTTPRequestID *string
}
type source struct {
	From, Owner, Fields, Key, Cutoff string
	Transform                        bool
}

// catalogData is a fixed extraction of the original export-datasets.mjs and
// lifecycle-export-v2.mjs projection catalog; requests never supply SQL.
//
//go:embed catalog.json
var catalogData []byte
var catalog struct {
	Datasets   []string
	ViewScopes map[string]string
	Sources    map[string]source
}

var viewKinds []string

func init() {
	if e := json.Unmarshal(catalogData, &catalog); e != nil {
		panic(e)
	}
	var raw map[string]json.RawMessage
	_ = json.Unmarshal(catalogData, &raw)
	d := json.NewDecoder(bytes.NewReader(raw["viewScopes"]))
	_, _ = d.Token()
	for d.More() {
		key, _ := d.Token()
		viewKinds = append(viewKinds, key.(string))
		var ignored any
		_ = d.Decode(&ignored)
	}
}

type View struct {
	Kind      string  `json:"kind"`
	ID        string  `json:"id"`
	VersionID *string `json:"versionId,omitempty"`
	Version   *int64  `json:"version,omitempty"`
	TaskID    *string `json:"taskId,omitempty"`
}
type ViewReader func(context.Context, pgx.Tx, Actor, View, string) (any, error)
type Transformer func(context.Context, pgx.Tx, Actor, Object, int64) (Object, error)
type MaterialReader func(context.Context, pgx.Tx, Actor, string) (Object, error)
type Service struct {
	Pool     *pgxpool.Pool
	Endpoint string
	Devices  *deviceauth.Service
	Budget   *resourcebudget.Policy
	Now      func() time.Time
	Views    map[string]ViewReader
	// Context owns an inspect/export audit that consumes this transaction's
	// original export authorization; no substitute credential is constructed.
	ContextView      func(context.Context, pgx.Tx, Actor, View, deviceauth.ControlAuthorization, string) (any, error)
	Transforms       map[string]Transformer
	OwnerReaders     map[string]OwnerReader
	OutcomeMaterials MaterialReader
	AssertDownload   func() error
	DownloadDeadline func() int64
	ServiceStatus    func() any
}

func (s *Service) now() int64 {
	if s.Now != nil {
		return s.Now().Unix()
	}
	return time.Now().Unix()
}
func (s *Service) download() error {
	if s.AssertDownload != nil {
		return s.AssertDownload()
	}
	return nil
}
func (s *Service) authorize(ctx context.Context, tx pgx.Tx, a Actor, scope string) (deviceauth.ControlAuthorization, error) {
	if s == nil || s.Devices == nil || s.Endpoint == "" || s.Devices.Endpoint != s.Endpoint {
		return deviceauth.ControlAuthorization{}, fault.New("subject_lifecycle_unavailable", 503)
	}
	return s.Devices.CurrentControlWithin(ctx, tx, a.Actor, scope)
}
func (s *Service) run(ctx context.Context, a Actor, scope string, write bool, fn func(pgx.Tx, deviceauth.ControlAuthorization) (any, error)) (any, error) {
	if s == nil || s.Pool == nil {
		return nil, fault.New("subject_lifecycle_unavailable", 503)
	}
	return postgres.InTx(ctx, s.Pool, func(tx pgx.Tx) (any, error) {
		if write {
			if e := resourcebudget.LockSubjectResourceBudget(ctx, tx, a.SubjectID); e != nil {
				return nil, e
			}
		}
		auth, e := s.authorize(ctx, tx, a, scope)
		if e != nil {
			return nil, e
		}
		var before resourcebudget.Usage
		if write {
			before, e = resourcebudget.SubjectResourceUsage(ctx, tx, a.SubjectID, s.now())
			if e != nil {
				return nil, e
			}
		}
		out, e := fn(tx, auth)
		if e != nil {
			return nil, e
		}
		if write {
			after, e := resourcebudget.SubjectResourceUsage(ctx, tx, a.SubjectID, s.now())
			if e != nil {
				return nil, e
			}
			policy := resourcebudget.DefaultPolicy()
			if s.Budget != nil {
				policy = *s.Budget
			}
			if e = resourcebudget.EnforceResourceGrowth(before, after, policy); e != nil {
				return nil, e
			}
		}
		return out, nil
	})
}
func audit(ctx context.Context, tx pgx.Tx, a Actor, auth deviceauth.ControlAuthorization, action, id, scope string) error {
	scopes, _ := json.Marshal(auth.CredentialScopes)
	tag, e := tx.Exec(ctx, `INSERT INTO audit_events(actor,action,object_id,request_id,outcome,context_version,client_id,audience,scope,binding_id,http_request_id,idempotency_key,binding_scopes,credential_scopes,caller_binding_id,caller_client_id,caller_audience,caller_binding_scopes) SELECT $1,$2,$3::text,$3::text,'accepted',1,ch.payload->>'installationId',b.audience,$4,b.id,$5::uuid,$3::text,b.scopes,$6::jsonb,b.id,ch.payload->>'installationId',b.audience,b.scopes FROM bindings b JOIN binding_challenges ch ON ch.id=b.challenge_id WHERE b.id=$7::uuid AND b.subject_id=$1 AND b.scopes ? $4`, a.SubjectID, action, id, scope, a.HTTPRequestID, scopes, a.BindingID)
	if e != nil {
		return e
	}
	if tag.RowsAffected() != 1 {
		return fault.New("audit_context_unavailable", 503)
	}
	return nil
}
func rows(ctx context.Context, tx pgx.Tx, sql string, args ...any) ([]Object, error) {
	r, e := tx.Query(ctx, sql, args...)
	if e != nil {
		return nil, e
	}
	defer r.Close()
	out := []Object{}
	for r.Next() {
		values, e := r.Values()
		if e != nil {
			return nil, e
		}
		m := Object{}
		for i, f := range r.FieldDescriptions() {
			value := values[i]
			if f.DataTypeOID == 18 && value != nil {
				if b, ok := value.(uint8); ok {
					value = string([]byte{b})
				}
			}
			if f.DataTypeOID == 20 && value != nil {
				if n, ok := value.(int64); ok {
					value = strconv.FormatInt(n, 10)
				}
			}
			m[f.Name] = normalize(value)
		}
		out = append(out, m)
	}
	return out, r.Err()
}
func one(ctx context.Context, tx pgx.Tx, sql string, args ...any) (Object, error) {
	r, e := rows(ctx, tx, sql, args...)
	if e != nil {
		return nil, e
	}
	if len(r) == 0 {
		return nil, pgx.ErrNoRows
	}
	return r[0], nil
}
func normalize(v any) any {
	switch x := v.(type) {
	case [16]byte:
		return uuid.UUID(x).String()
	case time.Time:
		return x.UTC().Format("2006-01-02T15:04:05.000Z")
	case map[string]any:
		for k, v := range x {
			x[k] = normalize(v)
		}
	case []any:
		for k, v := range x {
			x[k] = normalize(v)
		}
	}
	return v
}
func text(v any) string {
	if v == nil {
		return ""
	}
	s, _ := v.(string)
	return s
}
func integer(v any) int64 {
	switch n := v.(type) {
	case int64:
		return n
	case int32:
		return int64(n)
	case int:
		return int64(n)
	case float64:
		return int64(n)
	case string:
		i, _ := strconv.ParseInt(n, 10, 64)
		return i
	case json.Number:
		i, _ := n.Int64()
		return i
	}
	return 0
}
func stamp(v any) time.Time {
	if t, ok := v.(time.Time); ok {
		return t
	}
	t, _ := time.Parse(time.RFC3339Nano, text(v))
	return t
}
func encoded(v any) ([]byte, error) {
	b, e := protocol.Encode(v)
	if e != nil {
		return nil, e
	}
	out := make([]byte, 0, len(b))
	// JSON.stringify emits literal line separators. Skip already escaped
	// backslash pairs so a user's literal \u2028 text is never rewritten.
	for i := 0; i < len(b); {
		if b[i] == '\\' && i+1 < len(b) {
			if i+6 <= len(b) && b[i+1] == 'u' && (string(b[i+2:i+6]) == "2028" || string(b[i+2:i+6]) == "2029") {
				if b[i+5] == '8' {
					out = append(out, []byte("\u2028")...)
				} else {
					out = append(out, []byte("\u2029")...)
				}
				i += 6
				continue
			}
			out = append(out, b[i], b[i+1])
			i += 2
			continue
		}
		out = append(out, b[i])
		i++
	}
	return out, nil
}

func unavailable() error { return fault.New("export_source_unavailable", 503) }
func notfound(e error) error {
	if errors.Is(e, pgx.ErrNoRows) {
		return fault.New("not_found", 404)
	}
	return e
}
