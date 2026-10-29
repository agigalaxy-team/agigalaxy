// Package operationsai holds the current independent AI business-role half of
// authorization. It never initializes identities or authenticates a request.
package operationsai

import (
	"context"
	"encoding/json"
	"sort"

	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/jackc/pgx/v5"
)

type Object = map[string]any
type Service struct {
	Endpoint     string
	HandlerReady func(string) bool
}
type Authorization struct {
	AccountID            string        `json:"accountId"`
	Domain               string        `json:"domain"`
	Enabled              bool          `json:"enabled"`
	AuthorizationVersion int64         `json:"authorizationVersion"`
	Permissions          []string      `json:"permissions"`
	RoleVersions         []RoleVersion `json:"roleVersions"`
}
type RoleVersion struct {
	AssignmentID      string `json:"assignmentId"`
	AssignmentVersion int64  `json:"assignmentVersion"`
	RoleID            string `json:"roleId"`
	RoleVersion       int64  `json:"roleVersion"`
}

var Domains = []string{"overview", "governance", "messaging", "discovery", "maintenance"}

func contains(a []string, v string) bool {
	for _, x := range a {
		if x == v {
			return true
		}
	}
	return false
}
func obj(v any) Object { o, _ := v.(map[string]any); return o }
func arr(v any) []any  { a, _ := v.([]any); return a }
func str(v any) string { s, _ := v.(string); return s }
func stringsOf(v any) []string {
	a := []string{}
	for _, v := range arr(v) {
		a = append(a, str(v))
	}
	return a
}
func array(v []string) []any {
	a := []any{}
	for _, v := range v {
		a = append(a, v)
	}
	return a
}

// The generated action contract is immutable program data, not current grants.
// Compile it once; never decode the whole contract for each role permission.
var actionCatalog = func() Object {
	var value Object
	if err := json.Unmarshal([]byte(actionJSON), &value); err != nil {
		panic(err)
	}
	return value
}()
var actionDefinitions = func() map[string]Object {
	out := map[string]Object{}
	for _, value := range arr(actionCatalog["actions"]) {
		entry := obj(value)
		out[str(entry["permission"])] = entry
	}
	return out
}()

func catalog() Object        { return actionCatalog }
func Known(code string) bool { return actionDefinitions[code] != nil }

// Return an owned value: callers cannot change the compiled contract or another
// request's capability projection through a returned map or nested slice.
func copyDefinition(value any) any {
	switch item := value.(type) {
	case map[string]any:
		out := Object{}
		for key, child := range item {
			out[key] = copyDefinition(child)
		}
		return out
	case []any:
		out := make([]any, len(item))
		for index, child := range item {
			out[index] = copyDefinition(child)
		}
		return out
	default:
		return value
	}
}
func Definition(code string) Object {
	if entry := actionDefinitions[code]; entry != nil {
		return obj(copyDefinition(entry))
	}
	return nil
}
func Autonomous(code string) bool { return contains(stringsOf(catalog()["autonomous"]), code) }
func Projection(permission string, permissions []string, handlerReady *bool, humanConditions []string) Object {
	entry := actionDefinitions[permission]
	permissionAllowed := entry != nil && contains(permissions, permission)
	humanOnly := entry["humanOnly"] == true
	humanRequired := entry == nil || humanOnly || len(humanConditions) > 0
	ready := entry["handlerImplemented"] == true
	if handlerReady != nil {
		ready = entry != nil && (entry["query"] == true || entry["handler"] != nil) && *handlerReady
	}
	reasons := []string{}
	if !permissionAllowed {
		reasons = append(reasons, "permission-missing")
	}
	if humanRequired {
		reasons = append(reasons, "human-decision-required")
	}
	if !ready {
		reasons = append(reasons, "handler-not-connected")
	}
	conditions := []string{}
	if humanOnly {
		conditions = append(conditions, "human-only")
	}
	conditions = append(conditions, humanConditions...)
	return Object{"permission": permission, "permissionAllowed": permissionAllowed, "humanRequired": humanRequired, "humanConditions": array(conditions), "conditions": array(stringsOf(entry["conditions"])), "handlerReady": ready, "ready": permissionAllowed && !humanRequired && ready, "reasons": array(reasons)}
}
func Capabilities(_ string, permissions []string) Object {
	cat := catalog()
	query, autonomous, kinds := []string{}, []string{}, []string{}
	for _, p := range stringsOf(cat["query"]) {
		if contains(permissions, p) {
			query = append(query, p)
		}
	}
	for _, p := range stringsOf(cat["autonomous"]) {
		if contains(permissions, p) {
			autonomous = append(autonomous, p)
		}
	}
	for _, v := range arr(cat["preparation"]) {
		p := obj(v)
		if !contains(permissions, str(p["read"])) {
			continue
		}
		for _, a := range stringsOf(p["actions"]) {
			if contains(permissions, a) {
				kinds = append(kinds, str(p["kind"]))
				break
			}
		}
	}
	actions := []any{}
	seen := map[string]bool{}
	for _, p := range permissions {
		if !seen[p] {
			actions = append(actions, Projection(p, permissions, nil, nil))
			seen[p] = true
		}
	}
	return Object{"queryPermissions": array(query), "preparableKinds": array(kinds), "autonomousPermissions": array(autonomous), "actions": actions}
}
func (s *Service) AuthorizationWithin(ctx context.Context, tx pgx.Tx, domain string, accountID *string) (Authorization, error) {
	var out Authorization
	if !contains(Domains, domain) {
		return out, fault.New("invalid_operations_ai_work_request", 400)
	}
	if _, e := tx.Exec(ctx, "SELECT pg_advisory_xact_lock_shared(hashtextextended($1,734912410))", s.Endpoint); e != nil {
		return out, e
	}
	e := tx.QueryRow(ctx, "SELECT id::text,enabled,authorization_version FROM operations_ai_work_accounts_v1 WHERE endpoint=$1 AND domain=$2", s.Endpoint, domain).Scan(&out.AccountID, &out.Enabled, &out.AuthorizationVersion)
	if e == pgx.ErrNoRows || e == nil && accountID != nil && out.AccountID != *accountID {
		return out, fault.New("operations_ai_work_not_initialized", 409)
	}
	if e != nil {
		return out, e
	}
	out.Domain = domain
	out.Permissions = []string{}
	out.RoleVersions = []RoleVersion{}
	rows, e := tx.Query(ctx, `SELECT a.id::text,a.version,a.role_id::text,r.version,r.permissions FROM operations_ai_work_assignments_v1 a JOIN operations_business_roles_v1 r ON r.endpoint=a.endpoint AND r.id=a.role_id WHERE a.endpoint=$1 AND a.ai_account_id=$2 AND a.enabled AND r.enabled ORDER BY a.id`, s.Endpoint, out.AccountID)
	if e != nil {
		return out, e
	}
	defer rows.Close()
	seen := map[string]bool{}
	for rows.Next() {
		var r RoleVersion
		var permissions []string
		if e = rows.Scan(&r.AssignmentID, &r.AssignmentVersion, &r.RoleID, &r.RoleVersion, &permissions); e != nil {
			return out, e
		}
		out.RoleVersions = append(out.RoleVersions, r)
		for _, p := range permissions {
			if Known(p) && !seen[p] {
				out.Permissions = append(out.Permissions, p)
				seen[p] = true
			}
		}
	}
	sort.Strings(out.Permissions)
	return out, rows.Err()
}
func (s *Service) ExecutionRoleWithin(ctx context.Context, tx pgx.Tx, domain, id string, actions []string) (Authorization, error) {
	current, e := s.AuthorizationWithin(ctx, tx, domain, &id)
	if e != nil {
		return current, e
	}
	if !current.Enabled {
		return current, fault.New("operations_ai_work_permission_denied", 403)
	}
	for _, a := range actions {
		if !contains(current.Permissions, a) || !Autonomous(a) {
			return current, fault.New("operations_ai_work_permission_denied", 403)
		}
	}
	return current, nil
}
func (s *Service) AssertRoleWithin(ctx context.Context, tx pgx.Tx, domain, action, purpose string) (Authorization, error) {
	current, e := s.AuthorizationWithin(ctx, tx, domain, nil)
	if e != nil {
		return current, e
	}
	if !current.Enabled {
		return current, fault.New("operations_ai_work_disabled", 403)
	}
	caps := Capabilities(domain, current.Permissions)
	usable := purpose == "query" && contains(stringsOf(caps["queryPermissions"]), action) || purpose == "execution" && contains(stringsOf(caps["autonomousPermissions"]), action)
	if purpose == "prepare" {
		for _, v := range arr(catalog()["preparation"]) {
			p := obj(v)
			if contains(stringsOf(caps["preparableKinds"]), str(p["kind"])) && (p["read"] == action || contains(stringsOf(p["actions"]), action)) {
				usable = true
				break
			}
		}
	}
	if !contains(current.Permissions, action) || !usable {
		return current, fault.New("operations_ai_work_permission_denied", 403)
	}
	return current, nil
}

// WorkPermissions is the original purpose projection of a current position's
// own roles, before intersection with the independently authenticated human.
func WorkPermissions(purpose string, permissions []string) []string {
	if purpose == "conversation" {
		return []string{}
	}
	selectAllowed := func(key string) []string {
		out := []string{}
		for _, permission := range stringsOf(catalog()[key]) {
			if contains(permissions, permission) {
				out = append(out, permission)
			}
		}
		return out
	}
	switch purpose {
	case "query":
		return selectAllowed("query")
	case "execution":
		return selectAllowed("autonomous")
	case "prepare":
		out := selectAllowed("query")
		add := func(permission string) {
			if contains(permissions, permission) && !contains(out, permission) {
				out = append(out, permission)
			}
		}
		add("chat-reports.materials.read")
		for _, value := range arr(catalog()["preparation"]) {
			entry := obj(value)
			if !contains(permissions, str(entry["read"])) {
				continue
			}
			actions := stringsOf(entry["actions"])
			eligible := false
			for _, action := range actions {
				if contains(permissions, action) {
					eligible = true
					break
				}
			}
			if eligible {
				add(str(entry["read"]))
				for _, action := range actions {
					add(action)
				}
			}
		}
		return out
	}
	return nil
}
