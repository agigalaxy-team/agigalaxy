// Package operationspermissions owns versioned business-role commands and
// projections. Management identity and current authority remain in access.
package operationspermissions

import (
	"context"
	"encoding/json"
	"math"
	"net/http"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/identity"
	"github.com/agigalaxy-team/agigalaxy/go/internal/operationsai"
	"github.com/agigalaxy-team/agigalaxy/go/internal/postgres"
	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

type Object = map[string]any
type Actor struct {
	ID, Role, Version, Endpoint string
	Permissions                 []string
	RequestID                   *string
	Proof                       any
	AIProof                     any
	ManagementEligibility       string
}
type Authority interface {
	AuthorizeOperations(*http.Request, bool, string) (Actor, error)
	RequireWithin(context.Context, pgx.Tx, Actor, string) (Actor, error)
	EffectiveWithin(context.Context, pgx.Tx, Actor) (Actor, error)
	PersonWithin(context.Context, pgx.Tx, string, bool) (Actor, error)
}
type StoredPersonAuthority interface {
	PersonWithin(context.Context, pgx.Tx, string, bool) (Actor, error)
}

type Service struct {
	Pool            *pgxpool.Pool
	Endpoint        string
	Authority       Authority
	StoredAuthority StoredPersonAuthority
	Now             func() time.Time
	AIWork          *operationsai.Service
	RuntimeStatus   func(context.Context) (Object, error)
	Duty            DutyAuthority
}

func (s *Service) now() int64 {
	if s.Now != nil {
		return s.Now().Unix()
	}
	return time.Now().Unix()
}
func fail(code string, status int) error { return fault.New(code, status) }
func invalid() error                     { return fail("invalid_operations_permissions_request", 400) }
func obj(v any) Object                   { o, _ := v.(map[string]any); return o }
func arr(v any) []any                    { a, _ := v.([]any); return a }
func str(v any) string                   { s, _ := v.(string); return s }
func num(v any) int64 {
	switch n := v.(type) {
	case int:
		return int64(n)
	case int64:
		return n
	case float64:
		return int64(n)
	case json.Number:
		i, _ := n.Int64()
		return i
	}
	return 0
}
func intOK(v any, min int64) bool {
	switch n := v.(type) {
	case int:
		return int64(n) >= min && int64(n) <= 9007199254740991
	case int64:
		return n >= min && n <= 9007199254740991
	case float64:
		return !math.IsNaN(n) && !math.IsInf(n, 0) && n == math.Trunc(n) && n >= float64(min) && n <= 9007199254740991
	}
	return false
}
func contains(a []string, v string) bool {
	for _, x := range a {
		if x == v {
			return true
		}
	}
	return false
}
func stringsOf(v any) []string {
	a := []string{}
	for _, x := range arr(v) {
		a = append(a, str(x))
	}
	return a
}
func arrayOf(v []string) []any {
	a := []any{}
	for _, x := range v {
		a = append(a, x)
	}
	return a
}
func clone(v any) any       { b, _ := protocol.Encode(v); var o any; json.Unmarshal(b, &o); return o }
func jsonText(v any) string { b, _ := protocol.Encode(v); return string(b) }
func same(a, b any) bool {
	x, e := identity.Canonical([]any{a})
	y, f := identity.Canonical([]any{b})
	return e == nil && f == nil && string(x) == string(y)
}
func exact(o Object, required, optional []string) bool {
	if o == nil {
		return false
	}
	for _, k := range required {
		if _, ok := o[k]; !ok {
			return false
		}
	}
	for k := range o {
		if !contains(required, k) && !contains(optional, k) {
			return false
		}
	}
	return true
}
func trim(s string) string {
	return strings.Trim(s, "\u0009\u000a\u000b\u000c\u000d\u0020\u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff")
}
func text(v any, min, max int, controls bool) (string, bool) {
	s, ok := v.(string)
	s = trim(s)
	if !ok || utf8.RuneCountInString(s) < min || utf8.RuneCountInString(s) > max {
		return "", false
	}
	if controls {
		for _, c := range s {
			if unicode.Is(unicode.Cc, c) {
				return "", false
			}
		}
	}
	return s, true
}

var uuidPattern = regexp.MustCompile(`(?i)^(?:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$`)
var receiptUUID = regexp.MustCompile(`(?i)^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`)
var afterPattern = regexp.MustCompile(`^[1-9][0-9]{0,18}$`)

func validUUID(v any) bool { return uuidPattern.MatchString(str(v)) }
func catalogItems() []any  { var a []any; json.Unmarshal([]byte(catalogJSON), &a); return a }
func known(code string) bool {
	return staticCatalog.known[code]
}
func permissionList(v any) bool {
	a, ok := v.([]any)
	if !ok || len(a) > staticCatalog.count {
		return false
	}
	seen := map[string]bool{}
	for _, v := range a {
		s, ok := v.(string)
		if !ok || !known(s) || seen[s] {
			return false
		}
		seen[s] = true
	}
	return true
}
func parseCommand(kind string, input Object) (Object, error) {
	x := obj(clone(input))
	required := []string{"operationId", "expectedVersion", "enabled"}
	optional := []string{"id"}
	switch kind {
	case "role-save":
		required = append(required, "name", "description", "permissions")
		optional = append(optional, "subjectScope")
	case "assignment-save":
		required = append(required, "operatorId", "roleId")
	default:
		return nil, invalid()
	}
	if !exact(x, required, optional) || !validUUID(x["operationId"]) || !intOK(x["expectedVersion"], 0) {
		return nil, invalid()
	}
	if _, ok := x["enabled"].(bool); !ok {
		return nil, invalid()
	}
	if v, ok := x["id"]; ok && !validUUID(v) {
		return nil, invalid()
	}
	if kind == "role-save" {
		name, ok := text(x["name"], 1, 120, true)
		if !ok {
			return nil, invalid()
		}
		description, ok := text(x["description"], 0, 1000, true)
		if !ok || !permissionList(x["permissions"]) {
			return nil, invalid()
		}
		x["name"], x["description"] = name, description
		if v, ok := x["subjectScope"]; ok && v != "shared" && v != "ai-only" {
			return nil, invalid()
		}
	} else {
		if utf8.RuneCountInString(str(x["operatorId"])) < 1 || utf8.RuneCountInString(str(x["operatorId"])) > 1024 || !validUUID(x["roleId"]) {
			return nil, invalid()
		}
	}
	return x, nil
}
func stamp(v any) string {
	switch x := v.(type) {
	case time.Time:
		return x.UTC().Format("2006-01-02T15:04:05.000Z")
	case string:
		t, e := time.Parse(time.RFC3339Nano, x)
		if e == nil {
			return stamp(t)
		}
	}
	return ""
}
func roleView(r Object) Object {
	scope := r["subject_scope"]
	if scope == nil {
		scope = "shared"
	}
	ids := r["managed_ai_account_ids"]
	if ids == nil {
		ids = []any{}
	}
	return Object{"id": r["id"], "name": r["name"], "description": r["description"], "enabled": r["enabled"], "version": r["version"], "permissions": r["permissions"], "subjectScope": scope, "managedAiAccountIds": ids, "createdByAiAccountId": r["created_by_ai_account_id"], "updatedByAiAccountId": r["updated_by_ai_account_id"], "createdAt": stamp(r["created_at"]), "updatedAt": stamp(r["updated_at"])}
}
func assignmentView(r Object) Object {
	return Object{"id": r["id"], "operatorId": r["operator_id"], "roleId": r["role_id"], "enabled": r["enabled"], "version": r["version"], "createdAt": stamp(r["created_at"]), "updatedAt": stamp(r["updated_at"])}
}
func one(ctx context.Context, tx pgx.Tx, q string, args ...any) (Object, error) {
	var o Object
	e := tx.QueryRow(ctx, q, args...).Scan(&o)
	return o, e
}
func many(ctx context.Context, tx pgx.Tx, q string, args ...any) ([]any, error) {
	rows, e := tx.Query(ctx, q, args...)
	if e != nil {
		return nil, e
	}
	defer rows.Close()
	out := []any{}
	for rows.Next() {
		var o Object
		if e = rows.Scan(&o); e != nil {
			return nil, e
		}
		out = append(out, o)
	}
	return out, rows.Err()
}
func exists(ctx context.Context, tx pgx.Tx, q string, args ...any) (bool, error) {
	var b bool
	e := tx.QueryRow(ctx, q, args...).Scan(&b)
	return b, e
}
func metadata(actor Actor, now int64) Object {
	return Object{"checkedAt": now, "readExpiresAt": now + 30, "metadataOnly": true, "permissions": Object{"canManageRoles": contains(actor.Permissions, "permissions.roles.write"), "canManageAssignments": contains(actor.Permissions, "permissions.assignments.write"), "canManageAutomation": contains(actor.Permissions, "permissions.automation.write")}}
}
func (s *Service) read(ctx context.Context, actor Actor, fn func(pgx.Tx, Actor) (Object, error)) (Object, error) {
	if s.Authority == nil {
		return nil, fail("operations_authorization_unavailable", 503)
	}
	return postgres.InTx(ctx, s.Pool, func(tx pgx.Tx) (Object, error) {
		a, e := s.require(ctx, tx, actor, "permissions.read")
		if e != nil {
			return nil, e
		}
		out, e := fn(tx, a)
		if e != nil {
			return nil, e
		}
		for k, v := range metadata(a, s.now()) {
			out[k] = v
		}
		return out, nil
	})
}
func codesChanged(before, after any) Object {
	a, b := stringsOf(before), stringsOf(after)
	added, removed := []string{}, []string{}
	for _, x := range b {
		if !contains(a, x) {
			added = append(added, x)
		}
	}
	for _, x := range a {
		if !contains(b, x) {
			removed = append(removed, x)
		}
	}
	sort.Strings(added)
	sort.Strings(removed)
	return Object{"added": arrayOf(added), "removed": arrayOf(removed)}
}
func sameSet(a, b any) bool {
	x, y := stringsOf(a), stringsOf(b)
	sort.Strings(x)
	sort.Strings(y)
	return same(x, y)
}
func parseHistory(input Object) (Object, error) {
	x := obj(clone(input))
	if !exact(x, nil, []string{"after", "resourceId", "targetOperatorId", "limit"}) {
		return nil, invalid()
	}
	if v, ok := x["after"]; ok {
		if !afterPattern.MatchString(str(v)) {
			return nil, invalid()
		}
		if _, e := strconv.ParseInt(str(v), 10, 64); e != nil {
			return nil, invalid()
		}
	}
	if v, ok := x["resourceId"]; ok && !validUUID(v) {
		return nil, invalid()
	}
	if v, ok := x["targetOperatorId"]; ok && (utf8.RuneCountInString(str(v)) < 1 || utf8.RuneCountInString(str(v)) > 1024) {
		return nil, invalid()
	}
	if v, ok := x["limit"]; ok {
		if !intOK(v, 1) || num(v) > 100 {
			return nil, invalid()
		}
	} else {
		x["limit"] = 30
	}
	return x, nil
}

func (s *Service) require(ctx context.Context, tx pgx.Tx, actor Actor, action string) (Actor, error) {
	if actor.Endpoint != s.Endpoint || actor.ID == "" || protocol.TextLength(actor.ID) > 1024 {
		return Actor{}, fail("business_admin_denied", 403)
	}
	if actor.AIProof != nil {
		return s.requireHumanAI(ctx, tx, actor, action)
	}
	if _, ok := actor.Proof.(*storedHumanProof); ok {
		fresh, e := s.storedHuman(ctx, tx, actor)
		if e != nil {
			return Actor{}, e
		}
		if !known(action) {
			return Actor{}, fail("operations_permission_unknown", 403)
		}
		if !contains(fresh.Permissions, action) {
			return Actor{}, fail("operations_permission_denied", 403)
		}
		return fresh, nil
	}
	if s.Authority == nil {
		return Actor{}, fail("operations_authorization_unavailable", 503)
	}
	fresh, e := s.Authority.RequireWithin(ctx, tx, actor, action)
	if e != nil {
		return fresh, e
	}
	if fresh.ID != actor.ID || fresh.Endpoint != s.Endpoint {
		return Actor{}, fail("business_admin_denied", 403)
	}
	return fresh, nil
}

// javascriptNumber retains Number()/z.coerce.number() semantics at the original
// HTTP pagination boundaries; command counters remain strictly typed.
func javascriptNumber(v any) (float64, error) {
	switch n := v.(type) {
	case nil:
		return 0, nil
	case bool:
		if n {
			return 1, nil
		}
		return 0, nil
	case float64:
		return n, nil
	case int:
		return float64(n), nil
	case int64:
		return float64(n), nil
	case string:
		value := trim(n)
		if value == "" {
			return 0, nil
		}
		if len(value) > 2 && value[0] == '0' {
			base := 0
			switch value[1] {
			case 'x', 'X':
				base = 16
			case 'b', 'B':
				base = 2
			case 'o', 'O':
				base = 8
			}
			if base != 0 {
				i, e := strconv.ParseUint(value[2:], base, 64)
				return float64(i), e
			}
		}
		return strconv.ParseFloat(value, 64)
	case []any:
		parts := []string{}
		for _, item := range n {
			if item == nil {
				parts = append(parts, "")
			} else if a, ok := item.([]any); ok {
				b, e := javascriptArrayString(a)
				if e != nil {
					return 0, e
				}
				parts = append(parts, b)
			} else if str, ok := item.(string); ok {
				parts = append(parts, str)
			} else {
				parts = append(parts, jsonText(item))
			}
		}
		return javascriptNumber(strings.Join(parts, ","))
	}
	return 0, invalid()
}
func javascriptArrayString(a []any) (string, error) {
	parts := []string{}
	for _, v := range a {
		switch x := v.(type) {
		case nil:
			parts = append(parts, "")
		case string:
			parts = append(parts, x)
		case []any:
			s, e := javascriptArrayString(x)
			if e != nil {
				return "", e
			}
			parts = append(parts, s)
		default:
			parts = append(parts, jsonText(v))
		}
	}
	return strings.Join(parts, ","), nil
}
func parseAIHistory(input Object) (Object, error) {
	x := obj(clone(input))
	if !exact(x, nil, []string{"after", "limit"}) {
		return nil, aiInvalid()
	}
	if v, ok := x["limit"]; ok {
		n, e := javascriptNumber(v)
		if e != nil {
			return nil, aiInvalid()
		}
		x["limit"] = n
	}
	out, e := parseHistory(x)
	if e != nil {
		return nil, aiInvalid()
	}
	return out, nil
}
