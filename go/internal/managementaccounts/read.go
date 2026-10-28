package managementaccounts

import (
	"context"
	"encoding/json"
	"fmt"
	"sort"
	"strings"
	"time"
	"unicode"

	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	perms "github.com/agigalaxy-team/agigalaxy/go/internal/operationspermissions"
	"github.com/agigalaxy-team/agigalaxy/go/internal/postgres"
	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

type Actor = perms.Actor
type Root struct{ OperatorID, Endpoint, Issuer, ExternalSubject string }
type Principal struct{ OperatorID, Issuer, ExternalSubject string }
type Sessions interface {
	Summary(context.Context, Principal) (Object, error)
	Revoke(context.Context, Principal) (Object, error)
	Invalidate(context.Context, Principal) error
}
type NativeDirectory interface {
	DirectoryReader
	ManagementConfigured() bool
	EmailChangeConfigured() bool
	EmailChangeAvailability(context.Context) bool
	Sessions(context.Context, string, string) (Object, error)
	Create(context.Context, Object, func() error) (Object, error)
	Profile(context.Context, string, string, Object, func() error) (Object, error)
	SetEnabled(context.Context, string, string, bool, func() error) (Object, error)
	ResetPassword(context.Context, string, string, string, func() error) (Object, error)
	Logout(context.Context, string, string, func() error) (Object, error)
	Remove(context.Context, string, string, func() error) (Object, error)
	Admission(context.Context, string, string, string, func() error) (Object, error)
	RequestEmailChange(context.Context, string, string, string, string, func() error) (Object, error)
}
type Service struct {
	Pool        *pgxpool.Pool
	Endpoint    string
	Authority   perms.Authority
	Permissions *perms.Service
	Directory   NativeDirectory
	Root        *Root
	Sessions    Sessions
	Now         func() time.Time
}

func (s *Service) now() time.Time {
	if s.Now != nil {
		return s.Now()
	}
	return time.Now()
}
func (s *Service) index() *Directory {
	return &Directory{Pool: s.Pool, Endpoint: s.Endpoint, Reader: s.Directory, Now: s.Now}
}
func (s *Service) stamp(out Object) Object {
	n := s.now().Unix()
	out["checkedAt"] = n
	out["readExpiresAt"] = n + 30
	out["metadataOnly"] = true
	return out
}
func (s *Service) actor(ctx context.Context, q pgx.Tx, a Actor, action string) (Actor, error) {
	if r := s.Root; r != nil && (r.Endpoint != s.Endpoint || !subjectPattern.MatchString(r.ExternalSubject) || r.OperatorID != ID(r.Issuer, r.ExternalSubject) || s.Directory != nil && r.Issuer != s.Directory.Issuer()) {
		return Actor{}, nativeError("operations_authorization_unavailable")
	}
	if s.Authority == nil || a.AIProof != nil {
		return Actor{}, fault.New("business_admin_denied", 403)
	}
	return s.Authority.RequireWithin(ctx, q, a, action)
}
func (s *Service) read(ctx context.Context, a Actor, run func(pgx.Tx, Actor) (Object, error)) (Object, error) {
	return postgres.InTx(ctx, s.Pool, func(tx pgx.Tx) (Object, error) {
		fresh, e := s.actor(ctx, tx, a, "management.accounts.read")
		if e != nil {
			return nil, e
		}
		out, e := run(tx, fresh)
		if e != nil {
			return nil, e
		}
		if _, e = s.actor(ctx, tx, fresh, "management.accounts.read"); e != nil {
			return nil, e
		}
		return s.stamp(out), nil
	})
}
func many(ctx context.Context, q interface {
	Query(context.Context, string, ...any) (pgx.Rows, error)
}, sql string, args ...any) ([]Object, error) {
	rows, e := q.Query(ctx, sql, args...)
	if e != nil {
		return nil, e
	}
	defer rows.Close()
	out := []Object{}
	for rows.Next() {
		var b []byte
		if e := rows.Scan(&b); e != nil {
			return nil, e
		}
		var o Object
		if e := json.Unmarshal(b, &o); e != nil {
			return nil, e
		}
		out = append(out, o)
	}
	return out, rows.Err()
}
func (s *Service) rootTarget(issuer, subject string) bool {
	return s.Root != nil && s.Root.Endpoint == s.Endpoint && s.Root.Issuer == issuer && s.Root.ExternalSubject == subject && s.Root.OperatorID == ID(issuer, subject)
}
func (s *Service) rootActor(a Actor) bool {
	return s.Root != nil && a.Role == "administrator" && a.ID == s.Root.OperatorID
}
func has(a Actor, code string) bool { return includes(a.Permissions, code) }
func stringList(v any) []string {
	switch a := v.(type) {
	case []string:
		return append([]string{}, a...)
	case []any:
		out := []string{}
		for _, v := range a {
			out = append(out, str(v))
		}
		return out
	}
	return []string{}
}
func knownPermissions(v any) []string {
	codes := perms.PermissionCodes()
	out := []string{}
	for _, v := range stringList(v) {
		if includes(codes, v) {
			out = append(out, v)
		}
	}
	return out
}
func (s *Service) roleFacts(ctx context.Context, tx pgx.Tx, id string) ([]Object, error) {
	rows, e := many(ctx, tx, `SELECT to_jsonb(t) FROM(SELECT a.id AS assignment_id,a.version AS assignment_version,a.enabled AS assignment_enabled,r.id,r.name,r.description,r.version,r.enabled,r.permissions FROM operations_role_assignments_v1 a JOIN operations_business_roles_v1 r ON r.endpoint=a.endpoint AND r.id=a.role_id WHERE a.endpoint=$1 AND a.operator_id=$2 ORDER BY r.name,r.id)t`, s.Endpoint, id)
	if e != nil {
		return nil, e
	}
	out := []Object{}
	for _, r := range rows {
		out = append(out, Object{"id": r["id"], "name": r["name"], "description": r["description"], "version": r["version"], "enabled": r["enabled"], "permissions": knownPermissions(r["permissions"]), "assignmentId": r["assignment_id"], "assignmentVersion": r["assignment_version"], "assignmentEnabled": r["assignment_enabled"]})
	}
	return out, nil
}
func (s *Service) roleCatalog(ctx context.Context, tx pgx.Tx, a Actor) ([]Object, error) {
	rows, e := many(ctx, tx, `SELECT to_jsonb(t) FROM(SELECT id,name,description,enabled,version,permissions FROM operations_business_roles_v1 WHERE endpoint=$1 ORDER BY name,id)t`, s.Endpoint)
	if e != nil {
		return nil, e
	}
	for _, r := range rows {
		allowed := r["enabled"] == true && has(a, "permissions.assignments.write")
		for _, code := range stringList(r["permissions"]) {
			allowed = allowed && has(a, code)
		}
		r["permissions"] = knownPermissions(r["permissions"])
		r["canAssign"] = allowed
	}
	return rows, nil
}
func (s *Service) effective(user *User, meta Object, roles []Object) Object {
	eligible := user != nil && user.Enabled && user.Admission != "none" && meta["login_blocked"] != true && meta["deleted_at"] == nil
	sources := []Object{}
	codes := []string{}
	if eligible {
		if s.rootTarget(user.Issuer, user.ExternalSubject) {
			sources = append(sources, Object{"kind": "preconfigured-root", "roleId": nil, "label": "预配置根管理员", "permissions": perms.PermissionCodes()})
		} else {
			for _, r := range roles {
				if r["enabled"] != true || r["assignmentEnabled"] != true {
					continue
				}
				p := []string{}
				for _, c := range stringList(r["permissions"]) {
					if user.Admission == "administrator" || !perms.RequiresManagementMaintainer(c) {
						p = append(p, c)
					}
				}
				sources = append(sources, Object{"kind": "business-role", "roleId": r["id"], "label": r["name"], "permissions": p})
			}
		}
	}
	for _, r := range sources {
		for _, c := range stringList(r["permissions"]) {
			if !includes(codes, c) {
				codes = append(codes, c)
			}
		}
	}
	sort.Strings(codes)
	state := "not-eligible"
	if eligible {
		state = "available"
	}
	return Object{"state": state, "permissions": codes, "sources": sources}
}
func aiUse(effective Object, root bool) Object {
	domains := []string{}
	for _, d := range []string{"overview", "governance", "messaging", "discovery", "maintenance"} {
		if includes(stringList(effective["permissions"]), "ai.use."+d) {
			domains = append(domains, d)
		}
	}
	source := "business-roles"
	if root {
		source = "preconfigured-root"
	}
	return Object{"domains": domains, "source": source}
}
func rowUser(row Object) *User {
	u := &User{Issuer: str(row["issuer"]), ExternalSubject: str(row["external_subject"]), Username: str(row["username"]), FirstName: str(row["first_name"]), LastName: str(row["last_name"]), Enabled: row["enabled"] == true, EmailVerified: row["email_verified"] == true, Admission: str(row["admission"]), RequiredActions: stringList(row["required_actions"])}
	if u.Admission == "" {
		u.Admission = "none"
	}
	if v, ok := row["email"].(string); ok {
		u.Email = &v
	}
	v := row["native_created_at"]
	if v == nil {
		v = row["created_at"]
	}
	if x, ok := nullableStamp(v).(string); ok {
		u.CreatedAt = &x
	}
	return u
}
func display(u *User) string {
	first, last := trim(u.FirstName), trim(u.LastName)
	han := func(s string) bool {
		if s == "" {
			return false
		}
		for _, r := range s {
			if !unicode.Is(unicode.Han, r) {
				return false
			}
		}
		return true
	}
	if han(first) && han(last) {
		return last + first
	}
	parts := []string{}
	for _, v := range []string{u.FirstName, u.LastName} {
		if trim(v) != "" {
			parts = append(parts, v)
		}
	}
	v := trim(strings.Join(parts, " "))
	if v != "" {
		return v
	}
	if u.Username != "" {
		return u.Username
	}
	return "管理账户"
}
func (s *Service) item(row Object, user *User, roles []Object) Object {
	if user == nil {
		user = rowUser(row)
	}
	root := s.rootTarget(user.Issuer, user.ExternalSubject)
	effective := s.effective(user, row, roles)
	id := row["operator_id"]
	if id == nil {
		id = ID(user.Issuer, user.ExternalSubject)
	}
	var username any
	if user.Username != "" {
		username = user.Username
	}
	life := "present"
	if row["deleted_at"] != nil {
		life = "deleted"
	}
	blocked := row["login_blocked"] == true
	return Object{"operatorId": id, "displayName": display(user), "username": username, "email": user.Email, "emailVerified": user.EmailVerified, "enabled": user.Enabled && !blocked && row["deleted_at"] == nil, "nativeEnabled": user.Enabled, "loginBlocked": blocked, "createdAt": user.CreatedAt, "admission": user.Admission, "rootAdministrator": root, "lifecycle": life, "deletedAt": nullableStamp(row["deleted_at"]), "businessRoles": roles, "aiUse": aiUse(effective, root)}
}
func (s *Service) capabilities(a Actor, user *User, meta Object, emailAvailable bool) Object {
	current := user != nil && meta["deleted_at"] == nil
	root, self := false, false
	if user != nil {
		root = s.rootTarget(user.Issuer, user.ExternalSubject)
		self = a.ID == ID(user.Issuer, user.ExternalSubject)
	}
	writer := s.Directory != nil && s.Directory.ManagementConfigured()
	allowed := current && s.Root != nil && (!root || self && s.rootActor(a))
	out := Object{}
	for k, c := range map[string]string{"canEditProfile": "management.accounts.profile.write", "canDisableLogin": "management.accounts.login.disable", "canRestoreLogin": "management.accounts.login.restore", "canResetPassword": "management.accounts.password.reset", "canRevokeSessions": "management.accounts.sessions.revoke", "canDelete": "management.accounts.delete", "canAssignRoles": "permissions.assignments.write", "canChangeEmail": "management.accounts.profile.write"} {
		out[k] = allowed && has(a, c)
	}
	and := func(k string, yes bool) { out[k] = out[k] == true && yes }
	and("canEditProfile", writer)
	and("canResetPassword", writer)
	and("canDisableLogin", writer && !root && !self && user != nil && user.Enabled && meta["login_blocked"] != true)
	and("canRestoreLogin", writer && !root && user != nil && (!user.Enabled || meta["login_blocked"] == true))
	and("canDelete", writer && !root && !self)
	and("canAssignRoles", !root && user != nil && user.Admission != "none" && user.Enabled && meta["login_blocked"] != true)
	and("canRevokeSessions", writer && s.Sessions != nil)
	and("canChangeEmail", writer && emailAvailable)
	out["canChangeAdmission"] = allowed && writer && !root && s.rootActor(a)
	return out
}
func (s *Service) List(ctx context.Context, a Actor, input Object) (Object, error) {
	x, e := ParseList(input)
	if e != nil {
		return nil, e
	}
	return s.read(ctx, a, func(tx pgx.Tx, a Actor) (Object, error) {
		source, e := s.index().Source(ctx, tx)
		if e != nil {
			return nil, e
		}
		roles, e := s.roleCatalog(ctx, tx, a)
		if e != nil {
			return nil, e
		}
		pagination := Object{"page": x["page"], "pageSize": x["pageSize"], "total": nil, "matchingTotal": nil, "totalPages": nil}
		out := Object{"items": []Object{}, "source": source, "pagination": pagination, "capabilities": Object{"canCreate": s.Root != nil && s.Directory != nil && s.Directory.ManagementConfigured() && has(a, "management.accounts.create")}, "roles": roles}
		if source["generationId"] == nil {
			return out, nil
		}
		values := []any{s.Endpoint, source["generationId"]}
		arg := func(v any) string { values = append(values, v); return fmt.Sprintf("$%d", len(values)) }
		where := []string{}
		joins := ` FROM operations_management_entries_v1 e LEFT JOIN operations_management_accounts_v1 m ON m.endpoint=$1 AND m.operator_id=e.operator_id WHERE e.generation_id=$2 AND m.deleted_at IS NULL`
		if q := str(x["query"]); q != "" {
			v := arg(q)
			where = append(where, `(e.username ILIKE '%'||`+v+`||'%' OR concat_ws(' ',e.first_name,e.last_name) ILIKE '%'||`+v+`||'%' OR e.email ILIKE '%'||`+v+`||'%')`)
		}
		if v, ok := x["enabled"]; ok {
			where = append(where, `(e.enabled AND NOT COALESCE(m.login_blocked,false))=`+arg(v == "true"))
		}
		if v, ok := x["roleId"]; ok {
			where = append(where, `EXISTS(SELECT 1 FROM operations_role_assignments_v1 a JOIN operations_business_roles_v1 r ON r.id=a.role_id AND r.endpoint=a.endpoint WHERE a.endpoint=$1 AND a.operator_id=e.operator_id AND a.enabled AND r.enabled AND r.id=`+arg(v)+`)`)
		}
		if v, ok := x["aiDomain"]; ok {
			code := arg("ai.use." + str(v))
			root := ""
			if s.Root != nil {
				root = s.Root.OperatorID
			}
			rootArg := arg(root)
			where = append(where, `e.enabled AND NOT COALESCE(m.login_blocked,false) AND e.admission<>'none' AND (e.operator_id=`+rootArg+` OR EXISTS(SELECT 1 FROM operations_role_assignments_v1 a JOIN operations_business_roles_v1 r ON r.id=a.role_id AND r.endpoint=a.endpoint WHERE a.endpoint=$1 AND a.operator_id=e.operator_id AND a.enabled AND r.enabled AND `+code+`=ANY(r.permissions)))`)
		}
		filtered := ""
		if len(where) > 0 {
			filtered = " AND " + strings.Join(where, " AND ")
		}
		var total, matching int64
		if e := tx.QueryRow(ctx, "SELECT count(*)"+joins, values[:2]...).Scan(&total); e != nil {
			return nil, e
		}
		if e := tx.QueryRow(ctx, "SELECT count(*)"+joins+filtered, values...).Scan(&matching); e != nil {
			return nil, e
		}
		size := integer(x["pageSize"])
		limit, offset := arg(size), arg((integer(x["page"])-1)*size)
		order := `lower(concat_ws(' ',NULLIF(e.first_name,''),NULLIF(e.last_name,''),e.username)) ASC`
		if x["sort"] != "name-asc" {
			direction := "DESC"
			if x["sort"] == "created-asc" {
				direction = "ASC"
			}
			order = "e.created_at " + direction + " NULLS LAST"
		}
		rows, e := many(ctx, tx, "SELECT to_jsonb(t) FROM(SELECT e.*,m.version,m.login_blocked,m.deleted_at"+joins+filtered+" ORDER BY "+order+",e.operator_id LIMIT "+limit+" OFFSET "+offset+")t", values...)
		if e != nil {
			return nil, e
		}
		items := []Object{}
		for _, r := range rows {
			roles, e := s.roleFacts(ctx, tx, str(r["operator_id"]))
			if e != nil {
				return nil, e
			}
			items = append(items, s.item(r, nil, roles))
		}
		pagination["total"], pagination["matchingTotal"], pagination["totalPages"] = total, matching, (matching+size-1)/size
		out["items"] = items
		return out, nil
	})
}
func (s *Service) targetWithin(ctx context.Context, q Querier, id string) (Object, error) {
	if !operatorPattern.MatchString(id) {
		return nil, invalid()
	}
	r, e := optionalObject(ctx, q, `SELECT to_jsonb(t) FROM(SELECT COALESCE(e.operator_id,m.operator_id,p.operator_id) AS operator_id,COALESCE(e.issuer,m.issuer,p.issuer) AS issuer,COALESCE(e.external_subject,m.external_subject,p.external_subject) AS external_subject,e.username,e.first_name,e.last_name,e.email,e.email_verified,e.enabled,e.admission,e.required_actions,e.created_at AS native_created_at,m.version,m.note,m.login_blocked,m.deleted_at,p.display_name AS principal_display_name FROM operations_operator_principals_v1 p FULL JOIN operations_management_accounts_v1 m ON m.operator_id=p.operator_id AND m.endpoint=p.endpoint FULL JOIN operations_management_entries_v1 e ON e.operator_id=COALESCE(p.operator_id,m.operator_id) AND e.generation_id=(SELECT generation_id FROM operations_management_directory_v1 WHERE endpoint=$1) WHERE COALESCE(p.endpoint,m.endpoint,$1)=$1 AND COALESCE(e.operator_id,m.operator_id,p.operator_id)=$2)t`, s.Endpoint, id)
	if e != nil {
		return nil, e
	}
	if r == nil || s.Directory != nil && r["issuer"] != s.Directory.Issuer() {
		return nil, fault.New("management_identity_not_found", 404)
	}
	return r, nil
}
func (s *Service) native(ctx context.Context, r Object) (string, *User) {
	if s.Directory == nil {
		return "not-configured", nil
	}
	u, e := s.Directory.Get(ctx, str(r["issuer"]), str(r["external_subject"]))
	if e != nil || u != nil && (u.Issuer != r["issuer"] || u.ExternalSubject != r["external_subject"]) {
		return "unavailable", nil
	}
	if u == nil {
		return "not-found", nil
	}
	return "available", u
}

var phaseKinds = []string{"native-account", "native-admission", "local-principal", "business-assignments", "native-sessions", "portal-sessions", "email-verification"}

func safeResult(v any) Object {
	o, _ := v.(map[string]any)
	rows, _ := o["phases"].([]any)
	phases := []Object{}
	for _, v := range rows {
		r, _ := v.(map[string]any)
		if !includes(phaseKinds, str(r["kind"])) || !includes([]string{"accepted", "confirmed", "submitted", "failed", "unknown"}, str(r["state"])) {
			continue
		}
		var code any
		if safeCodes[str(r["code"])] {
			code = r["code"]
		}
		p := Object{"kind": r["kind"], "state": r["state"], "code": code}
		if whole(r["revokedSessions"], 0, 9007199254740991) {
			p["revokedSessions"] = r["revokedSessions"]
		}
		if r["inflightBlocked"] == true {
			p["inflightBlocked"] = true
		}
		phases = append(phases, p)
	}
	var revision any
	if whole(o["revision"], 1, 9007199254740991) {
		revision = o["revision"]
	}
	return Object{"phases": phases, "revision": revision}
}
func receipt(r Object, replayed bool) Object {
	return Object{"operationId": r["operation_id"], "targetOperatorId": r["target_operator_id"], "kind": r["kind"], "state": r["state"], "result": safeResult(r["result"]), "recordedAt": nullableStamp(r["created_at"]), "replayed": replayed}
}
func (s *Service) historyWithin(ctx context.Context, tx pgx.Tx, id string, input Object) (Object, error) {
	x, e := ParseHistory(input)
	if e != nil {
		return nil, e
	}
	rows, e := many(ctx, tx, `SELECT to_jsonb(t) FROM(SELECT c.*,c.sequence::text AS sequence_text,p.display_name AS operator_display_name FROM operations_management_commands_v1 c LEFT JOIN operations_operator_principals_v1 p ON p.endpoint=c.endpoint AND p.operator_id=c.operator_id WHERE c.endpoint=$1 AND c.target_operator_id=$2 AND ($3::bigint IS NULL OR c.sequence<$3) ORDER BY c.sequence DESC LIMIT $4)t`, s.Endpoint, id, x["after"], integer(x["limit"])+1)
	if e != nil {
		return nil, e
	}
	items := []Object{}
	limit := int(integer(x["limit"]))
	var next any
	for i, r := range rows {
		if i >= limit {
			next = rows[limit-1]["sequence_text"]
			break
		}
		o := receipt(r, false)
		o["sequence"] = r["sequence_text"]
		o["operatorId"] = r["operator_id"]
		o["operatorDisplayName"] = nil
		if s, ok := r["operator_display_name"].(string); ok && protocol.TextLength(s) <= 240 {
			o["operatorDisplayName"] = s
		}
		o["reason"] = nil
		input, _ := r["input"].(map[string]any)
		if s, ok := input["reason"].(string); ok && protocol.TextLength(s) <= 1000 {
			o["reason"] = s
		}
		o["updatedAt"] = nullableStamp(r["updated_at"])
		items = append(items, o)
	}
	return Object{"items": items, "nextAfter": next}, nil
}
func (s *Service) History(ctx context.Context, a Actor, id string, input Object) (Object, error) {
	return s.read(ctx, a, func(tx pgx.Tx, _ Actor) (Object, error) {
		if _, e := s.targetWithin(ctx, tx, id); e != nil {
			return nil, e
		}
		return s.historyWithin(ctx, tx, id, input)
	})
}
func (s *Service) Operation(ctx context.Context, a Actor, id string) (Object, error) {
	if !uuidPattern.MatchString(id) {
		return nil, invalid()
	}
	return s.read(ctx, a, func(tx pgx.Tx, a Actor) (Object, error) {
		r, e := optionalObject(ctx, tx, `SELECT to_jsonb(c) FROM operations_management_commands_v1 c WHERE endpoint=$1 AND operation_id=$2`, s.Endpoint, id)
		if e != nil {
			return nil, e
		}
		if r == nil {
			return Object{"state": "not-recorded", "operationId": id, "targetOperatorId": nil, "kind": nil, "result": nil, "recordedAt": nil, "replayed": false}, nil
		}
		if r["operator_id"] != a.ID {
			return nil, fault.New("management_operation_not_found", 404)
		}
		return receipt(r, true), nil
	})
}
func (s *Service) Detail(ctx context.Context, a Actor, id string) (Object, error) {
	initial, e := postgres.InTx(ctx, s.Pool, func(tx pgx.Tx) (Actor, error) { return s.actor(ctx, tx, a, "management.accounts.read") })
	if e != nil {
		return nil, e
	}
	row, e := s.targetWithin(ctx, s.Pool, id)
	if e != nil {
		return nil, e
	}
	state, user := s.native(ctx, row)
	sessions := Object{"sso": Object{"state": "unavailable", "activeCount": nil, "scope": "keycloak-management-sso"}, "portal": Object{"state": "unavailable", "activeCount": nil, "scope": "management-portal"}}
	if user != nil {
		if v, e := s.Directory.Sessions(ctx, user.Issuer, user.ExternalSubject); e == nil {
			sessions["sso"] = v
		}
		if s.Sessions != nil {
			if v, e := s.Sessions.Summary(ctx, Principal{id, user.Issuer, user.ExternalSubject}); e == nil && whole(v["activeCount"], 0, 9007199254740991) {
				sessions["portal"] = Object{"state": "available", "activeCount": v["activeCount"], "scope": "management-portal"}
			}
		}
	}
	emailAvailable := user != nil && s.Directory.EmailChangeAvailability(ctx)
	return s.read(ctx, initial, func(tx pgx.Tx, a Actor) (Object, error) {
		r, e := s.targetWithin(ctx, tx, id)
		if e != nil {
			return nil, e
		}
		roles, e := s.roleFacts(ctx, tx, id)
		if e != nil {
			return nil, e
		}
		effective := s.effective(user, r, roles)
		item := s.item(r, user, roles)
		identity := Object{"state": state, "issuer": r["issuer"], "externalSubject": r["external_subject"], "firstName": nil, "lastName": nil, "requiredActions": []string{}}
		if user != nil {
			identity["firstName"], identity["lastName"], identity["requiredActions"] = user.FirstName, user.LastName, user.RequiredActions
		} else {
			fallback := &User{Issuer: str(r["issuer"]), ExternalSubject: str(r["external_subject"]), Username: str(r["username"]), CreatedAt: rowUser(r).CreatedAt, RequiredActions: []string{}}
			if fallback.Username == "" {
				fallback.Username = str(r["principal_display_name"])
			}
			item = s.item(r, fallback, roles)
			for _, k := range []string{"emailVerified", "enabled", "nativeEnabled", "admission"} {
				item[k] = nil
			}
		}
		version, e := TargetVersion(user, r)
		if e != nil {
			return nil, e
		}
		catalog, e := s.roleCatalog(ctx, tx, a)
		if e != nil {
			return nil, e
		}
		history, e := s.historyWithin(ctx, tx, id, Object{})
		if e != nil {
			return nil, e
		}
		revision := r["version"]
		if revision == nil {
			revision = 0
		}
		note := r["note"]
		if note == nil {
			note = ""
		}
		root := user != nil && s.rootTarget(user.Issuer, user.ExternalSubject)
		return Object{"item": item, "identity": identity, "profile": Object{"note": note, "revision": revision}, "targetVersion": version, "versionBasis": "observed-current-source", "effective": effective, "aiUse": aiUse(effective, root), "roles": catalog, "capabilities": s.capabilities(a, user, r, emailAvailable), "security": Object{"identityManagement": map[bool]string{true: "configured", false: "not-configured"}[s.Directory != nil && s.Directory.ManagementConfigured()], "sessions": sessions}, "history": history}, nil
	})
}
