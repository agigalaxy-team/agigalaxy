// Package credentials consumes fixed external issuer keys and signed status
// sources. It never issues Galaxy credentials or promotes imported claims into
// verified account references, identity, qualifications or account authority.
package credentials

import (
	"context"
	"encoding/json"
	"errors"
	"reflect"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

type VerifiedAccount struct{ Issuer, Subject string }

// PrincipalReader can add only server-verified references, never a submitted VC
// claim or an account/header value. The primary principal always comes from PG.
type PrincipalReader func(context.Context, pgx.Tx, string, string) ([]VerifiedAccount, error)
type Service struct {
	Endpoint        string
	config          Configuration
	clock           func() time.Time
	fetch           StatusFetcher
	principalReader PrincipalReader
	mu              sync.Mutex
	statuses        map[string]statusProof
	loading         map[string]*statusFlight
	failures        map[string]int64
}

func New(endpoint string, config Configuration, now func() time.Time, fetch StatusFetcher, principal PrincipalReader) (*Service, error) {
	if config.Version == 0 && config.Issuers == nil {
		config = Configuration{Version: 1, Issuers: []Issuer{}}
	}
	raw, e := json.Marshal(config)
	if e != nil {
		return nil, configError()
	}
	config, e = ParseConfiguration(raw)
	if e != nil {
		return nil, e
	}
	if endpoint == "" {
		return nil, configError()
	}
	if now == nil {
		now = time.Now
	}
	if fetch == nil {
		fetch = FetchPublicStatus
	}
	return &Service{Endpoint: endpoint, config: config, clock: now, fetch: fetch, principalReader: principal, statuses: map[string]statusProof{}, loading: map[string]*statusFlight{}, failures: map[string]int64{}}, nil
}
func (s *Service) now() time.Time { return s.clock().UTC().Truncate(time.Millisecond) }
func (s *Service) issuerURI(uri string) *Issuer {
	for n := range s.config.Issuers {
		if s.config.Issuers[n].Issuer == uri {
			return &s.config.Issuers[n]
		}
	}
	return nil
}
func (s *Service) issuerID(id string) *Issuer {
	for n := range s.config.Issuers {
		if s.config.Issuers[n].ID == id {
			return &s.config.Issuers[n]
		}
	}
	return nil
}

var uuidPattern = regexp.MustCompile(`(?i)^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`)
var jwsPattern = regexp.MustCompile(`^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$`)

func invalid() error { return fault.New("invalid_external_credential_input", 400) }

type principal struct {
	account, uri string
	references   []VerifiedAccount
}

func (s *Service) principal(ctx context.Context, tx pgx.Tx, id string) (principal, error) {
	var p principal
	if !uuidPattern.MatchString(id) {
		return p, fault.New("official_account_login_required", 401)
	}
	var issuer, subject string
	e := tx.QueryRow(ctx, "SELECT issuer,external_subject FROM community_accounts WHERE id=$1 AND endpoint=$2", id, s.Endpoint).Scan(&issuer, &subject)
	if errors.Is(e, pgx.ErrNoRows) {
		return p, fault.New("official_account_login_required", 401)
	}
	if e != nil {
		return p, e
	}
	p = principal{id, s.Endpoint + "/v1/account/public/" + id, []VerifiedAccount{{issuer, subject}}}
	if s.principalReader != nil {
		additional, e := s.principalReader(ctx, tx, id, s.Endpoint)
		if e != nil {
			return p, e
		}
		p.references = append(p.references, additional...)
	}
	return p, nil
}

type row struct {
	id, account, issuerID, issuerURI, issuerName string
	jws                                          *string
	metadata, revocation                         Object
	imported, checked                            time.Time
	withdrawn                                    *time.Time
}

const columns = `id::text,account_id::text,issuer_id,issuer_uri,issuer_name,credential_jws,metadata,revocation,imported_at,checked_at,withdrawn_at`

func scan(rowValue pgx.Row) (r row, e error) {
	e = rowValue.Scan(&r.id, &r.account, &r.issuerID, &r.issuerURI, &r.issuerName, &r.jws, &r.metadata, &r.revocation, &r.imported, &r.checked, &r.withdrawn)
	return
}
func (s *Service) own(ctx context.Context, tx pgx.Tx, account, id string, lock bool) (row, error) {
	if !uuidPattern.MatchString(id) {
		return row{}, invalid()
	}
	query := "SELECT " + columns + " FROM account_external_credentials_v1 WHERE id=$1 AND account_id=$2"
	if lock {
		query += " FOR UPDATE"
	}
	r, e := scan(tx.QueryRow(ctx, query, id, account))
	if errors.Is(e, pgx.ErrNoRows) {
		return r, fault.New("not_found", 404)
	}
	return r, e
}
func (s *Service) binding(m Object, p principal, i *Issuer) Object {
	id := m["subjectId"]
	if id == p.uri {
		return Object{"id": id, "binding": "bound", "basis": "official-account-uri"}
	}
	if strings.HasPrefix(str(id), s.Endpoint+"/v1/account/public/") {
		return Object{"id": id, "binding": "mismatch", "basis": nil}
	}
	if i != nil && i.SubjectBinding != nil {
		found := false
		for _, reference := range p.references {
			if reference.Issuer == i.SubjectBinding.AccountIssuer {
				found = true
				if reference.Subject == id {
					return Object{"id": id, "binding": "bound", "basis": "verified-external-account"}
				}
			}
		}
		if found && id != nil && id != "" {
			return Object{"id": id, "binding": "mismatch", "basis": nil}
		}
	}
	return Object{"id": id, "binding": "unconfirmed", "basis": nil}
}
func (s *Service) statusWithin(r row, i *Issuer) Object {
	saved := r.revocation
	validUntil, valid := timestamp(saved["validUntil"])
	issuedAt, issued := timestamp(saved["issuedAt"])
	keyMatches := false
	if i != nil {
		for _, key := range i.Keys {
			if reflect.DeepEqual(normalized(key), normalized(saved["signingKey"])) {
				keyMatches = true
			}
		}
	}
	if i == nil || i.Revocation == nil || saved["source"] != i.Revocation.URL || !valid || !validUntil.After(s.now()) || !issued || !issuedAt.Add(time.Duration(i.Revocation.MaxAgeSeconds)*time.Second).After(s.now()) || !keyMatches {
		var source any
		if i != nil && i.Revocation != nil {
			source = i.Revocation.URL
		}
		return Object{"state": "unknown", "source": source, "checkedAt": saved["checkedAt"], "validUntil": saved["validUntil"], "reason": "status-not-current", "lastKnownState": saved["state"]}
	}
	out := Object{}
	for k, v := range saved {
		if k != "signingKey" {
			out[k] = v
		}
	}
	return out
}
func normalized(v any) any {
	b, _ := json.Marshal(v)
	var out any
	_ = json.Unmarshal(b, &out)
	return out
}
func (s *Service) validity(m Object) string {
	if t, ok := timestamp(m["validFrom"]); ok && t.After(s.now()) {
		return "not-yet-valid"
	}
	if t, ok := timestamp(m["expiresAt"]); ok && !t.After(s.now()) {
		return "expired"
	}
	if m["validFrom"] != nil && m["validFrom"] != "" || m["issuedAt"] != nil && m["issuedAt"] != "" {
		return "valid"
	}
	return "unknown"
}
func claimAt(vc Object, path string) any {
	var value any = vc
	for _, part := range strings.Split(strings.TrimPrefix(path, "/"), "/") {
		part = strings.ReplaceAll(strings.ReplaceAll(part, "~1", "/"), "~0", "~")
		switch current := value.(type) {
		case map[string]any:
			var ok bool
			value, ok = current[part]
			if !ok {
				return nil
			}
		case []any:
			n, e := strconv.Atoi(part)
			if e != nil || n < 0 || n >= len(current) {
				return nil
			}
			value = current[n]
		default:
			return nil
		}
	}
	return value
}
func (s *Service) conditionIDs(m Object, i *Issuer) []string {
	out := []string{}
	if i == nil {
		return out
	}
	types, _ := m["types"].([]any)
	for _, condition := range i.Conditions {
		matches := false
		for _, t := range types {
			if t == condition.Type {
				matches = true
			}
		}
		if matches && condition.Claim != nil {
			matches = reflect.DeepEqual(normalized(claimAt(object(m["vc"]), condition.Claim.Path)), normalized(condition.Claim.Equals))
		}
		if matches {
			out = append(out, condition.ID)
		}
	}
	return out
}
func (s *Service) view(r row, p principal) (Object, error) {
	metadata := r.metadata
	signature := "valid"
	issuer := s.issuerID(r.issuerID)
	if issuer == nil || issuer.Issuer != r.issuerURI {
		signature = "issuer-unconfigured"
	} else if r.jws != nil {
		verified, e := s.Verify(*r.jws)
		if e != nil {
			signature = "invalid"
		} else {
			metadata = verified
		}
	}
	subject := s.binding(metadata, p, issuer)
	validity := s.validity(metadata)
	revocation := s.statusWithin(r, issuer)
	conditions := []string{}
	if r.withdrawn == nil && signature == "valid" && subject["binding"] == "bound" && validity == "valid" && revocation["state"] == "not-revoked" {
		conditions = s.conditionIDs(metadata, issuer)
	}
	name := any(r.issuerName)
	if issuer != nil {
		name = issuer.Name
	}
	var withdrawn any
	if r.withdrawn != nil {
		withdrawn = iso(*r.withdrawn)
	}
	checked := iso(r.checked)
	if r.jws != nil {
		checked = iso(s.now())
	}
	return Object{"id": r.id, "title": metadata["title"], "issuer": Object{"id": r.issuerID, "name": name, "uri": r.issuerURI}, "subject": subject, "types": metadata["types"], "scope": metadata["scope"], "issuedAt": metadata["issuedAt"], "validFrom": metadata["validFrom"], "expiresAt": metadata["expiresAt"], "importedAt": iso(r.imported), "checkedAt": iso(r.checked), "withdrawnAt": withdrawn, "source": Object{"format": metadata["format"], "credentialId": metadata["credentialId"], "issuer": r.issuerURI, "checkedAt": iso(r.checked)}, "signature": Object{"state": signature, "algorithm": metadata["algorithm"], "kid": metadata["kid"], "checkedAt": checked}, "validity": Object{"state": validity}, "revocation": revocation, "eligibility": Object{"conditionIds": conditions, "usable": len(conditions) > 0}, "galaxyIssued": false}, nil
}
func parsePage(raw []byte, public bool) (*string, int, error) {
	var fields Object
	if protocol.Decode(raw, &fields) != nil || fields == nil {
		return nil, 0, invalid()
	}
	after := (*string)(nil)
	limit := 20
	for key, value := range fields {
		switch key {
		case "after":
			text, ok := value.(string)
			if !ok || !uuidPattern.MatchString(text) {
				return nil, 0, invalid()
			}
			after = &text
		case "limit":
			if !public {
				return nil, 0, invalid()
			}
			b, _ := json.Marshal(value)
			var n float64
			if json.Unmarshal(b, &n) != nil || n != float64(int(n)) || n < 1 || n > 50 {
				return nil, 0, invalid()
			}
			limit = int(n)
		default:
			return nil, 0, invalid()
		}
	}
	return after, limit, nil
}
func (s *Service) PublicForAccountWithin(ctx context.Context, tx pgx.Tx, account string, raw []byte) (Object, error) {
	if !uuidPattern.MatchString(account) {
		return nil, invalid()
	}
	after, limit, e := parsePage(raw, true)
	if e != nil {
		return nil, e
	}
	var enabled bool
	e = tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM official_account_profiles_v1 p JOIN community_accounts a ON a.id=p.account_id WHERE p.account_id=$1 AND a.endpoint=$2 AND p.query_enabled=true AND p.query_external_credentials=true)`, account, s.Endpoint).Scan(&enabled)
	if e != nil {
		return nil, e
	}
	if !enabled {
		return nil, fault.New("not_found", 404)
	}
	p, e := s.principal(ctx, tx, account)
	if e != nil {
		return nil, e
	}
	refs := []Object{}
	for _, i := range s.config.Issuers {
		if i.SubjectBinding != nil {
			for _, ref := range p.references {
				if ref.Issuer == i.SubjectBinding.AccountIssuer {
					refs = append(refs, Object{"issuerId": i.ID, "subjectId": ref.Subject})
				}
			}
		}
	}
	references, _ := json.Marshal(refs)
	rows, e := tx.Query(ctx, `SELECT `+columns+` FROM account_external_credentials_v1 c WHERE account_id=$1 AND withdrawn_at IS NULL AND ($2::uuid IS NULL OR id>$2) AND (metadata->>'subjectId'=$3 OR EXISTS(SELECT 1 FROM jsonb_array_elements($4::jsonb) reference WHERE reference->>'issuerId'=c.issuer_id AND reference->>'subjectId'=c.metadata->>'subjectId')) ORDER BY id LIMIT $5`, account, after, p.uri, references, limit+1)
	if e != nil {
		return nil, e
	}
	selected := []row{}
	for rows.Next() {
		r, e := scan(rows)
		if e != nil {
			rows.Close()
			return nil, e
		}
		selected = append(selected, r)
	}
	rows.Close()
	if e = rows.Err(); e != nil {
		return nil, e
	}
	var next any
	if len(selected) > limit {
		next = selected[limit-1].id
		selected = selected[:limit]
	}
	items := []Object{}
	for _, r := range selected {
		current, e := s.view(r, p)
		if e != nil {
			return nil, e
		}
		if current["subject"].(Object)["binding"] != "bound" {
			continue
		}
		out := Object{}
		for _, key := range []string{"id", "title", "issuer", "subject", "types", "scope", "issuedAt", "validFrom", "expiresAt", "importedAt", "checkedAt", "source", "signature", "validity", "revocation", "galaxyIssued"} {
			out[key] = current[key]
		}
		items = append(items, out)
	}
	return Object{"accountId": account, "items": items, "nextAfter": next, "checkedAt": s.now().Unix()}, nil
}
func (s *Service) GetWithin(ctx context.Context, tx pgx.Tx, account, id string) (Object, error) {
	r, e := s.own(ctx, tx, account, id, false)
	if e != nil {
		return nil, e
	}
	p, e := s.principal(ctx, tx, account)
	if e != nil {
		return nil, e
	}
	v, e := s.view(r, p)
	var claims any
	if r.withdrawn == nil {
		claims = r.metadata["vc"]
	}
	return Object{"credential": v, "issuerClaims": claims, "rawMaterialReturned": false}, e
}
func (s *Service) ListWithin(ctx context.Context, tx pgx.Tx, account string, raw []byte) (Object, error) {
	after, _, e := parsePage(raw, false)
	if e != nil {
		return nil, e
	}
	p, e := s.principal(ctx, tx, account)
	if e != nil {
		return nil, e
	}
	var at *time.Time
	var cursor *string
	if after != nil {
		r, e := s.own(ctx, tx, account, *after, false)
		if e != nil {
			if fault.Code(e) == "not_found" {
				return nil, fault.New("invalid_external_credential_cursor", 400)
			}
			return nil, e
		}
		at = &r.imported
		cursor = &r.id
	}
	rows, e := tx.Query(ctx, "SELECT "+columns+" FROM account_external_credentials_v1 WHERE account_id=$1 AND ($2::timestamptz IS NULL OR (imported_at,id)<($2::timestamptz,$3::uuid)) ORDER BY imported_at DESC,id DESC LIMIT 51", account, at, cursor)
	if e != nil {
		return nil, e
	}
	selected := []row{}
	for rows.Next() {
		r, e := scan(rows)
		if e != nil {
			rows.Close()
			return nil, e
		}
		selected = append(selected, r)
	}
	rows.Close()
	if e = rows.Err(); e != nil {
		return nil, e
	}
	var next any
	if len(selected) > 50 {
		next = selected[49].id
		selected = selected[:50]
	}
	items := []Object{}
	for _, r := range selected {
		v, e := s.view(r, p)
		if e != nil {
			return nil, e
		}
		items = append(items, v)
	}
	out := s.Capabilities()
	out["items"] = items
	out["nextAfter"] = next
	return out, nil
}
func (s *Service) Capabilities() Object {
	issuers := []Object{}
	for _, i := range s.config.Issuers {
		conditions := []Object{}
		if i.Revocation != nil {
			for _, c := range i.Conditions {
				conditions = append(conditions, Object{"id": c.ID, "label": c.Label})
			}
		}
		issuers = append(issuers, Object{"id": i.ID, "name": i.Name, "issuer": i.Issuer, "formats": i.Formats, "conditions": conditions})
	}
	return Object{"available": len(s.config.Issuers) > 0, "issuers": issuers}
}
func (s *Service) ImportWithin(ctx context.Context, tx pgx.Tx, account string, raw []byte) (Object, error) {
	var x struct {
		Credential string `json:"credential"`
	}
	if protocol.Decode(raw, &x) != nil || len(x.Credential) < 16 || len(x.Credential) > 174764 || !jwsPattern.MatchString(x.Credential) {
		return nil, invalid()
	}
	if len(s.config.Issuers) == 0 {
		return nil, fault.New("external_credentials_unavailable", 503)
	}
	m, e := s.Verify(x.Credential)
	if e != nil {
		return nil, e
	}
	revocation := s.revocation(ctx, m, false)
	p, e := s.principal(ctx, tx, account)
	if e != nil {
		return nil, e
	}
	var current string
	e = tx.QueryRow(ctx, "SELECT id::text FROM community_accounts WHERE id=$1 AND endpoint=$2 FOR UPDATE", account, s.Endpoint).Scan(&current)
	if e != nil {
		return nil, e
	}
	r, e := scan(tx.QueryRow(ctx, "SELECT "+columns+" FROM account_external_credentials_v1 WHERE account_id=$1 AND credential_jws=$2 AND withdrawn_at IS NULL", account, x.Credential))
	if e == nil {
		return s.view(r, p)
	}
	if !errors.Is(e, pgx.ErrNoRows) {
		return nil, e
	}
	var count int
	if e = tx.QueryRow(ctx, "SELECT count(*) FROM account_external_credentials_v1 WHERE account_id=$1 AND withdrawn_at IS NULL", account).Scan(&count); e != nil {
		return nil, e
	}
	if count >= 200 {
		return nil, fault.New("external_credential_storage_limit", 409)
	}
	metadata, _ := json.Marshal(m)
	status, _ := json.Marshal(revocation)
	r, e = scan(tx.QueryRow(ctx, `INSERT INTO account_external_credentials_v1(id,account_id,issuer_id,issuer_uri,issuer_name,credential_jws,metadata,revocation,imported_at,checked_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$9) RETURNING `+columns, uuid.NewString(), account, m["issuerId"], m["issuer"], m["issuerName"], x.Credential, metadata, status, s.now()))
	if e != nil {
		return nil, e
	}
	return s.view(r, p)
}
