package managementaccounts

import (
	"github.com/google/uuid"
	"strings"
	"testing"
)

func TestOriginalManagementSchemasAndTargetVersions(t *testing.T) {
	create := Object{"operationId": uuid.NewString(), "username": " new.user ", "temporaryPassword": strings.Repeat("😀", 4096), "firstName": strings.Repeat("😀", 100)}
	command := Object{"operationId": uuid.NewString(), "expectedVersion": strings.Repeat("a", 64), "kind": "profile-update", "firstName": " changed ", "reason": " original "}
	assignment := Object{"operationId": uuid.NewString(), "expectedVersion": 0, "roleId": uuid.NewString(), "enabled": true}
	lists := []any{Object{}, Object{"page": 1000000, "pageSize": 100, "query": strings.Repeat("😀", 200), "enabled": "true", "aiDomain": "overview"}, Object{"page": "1"}, Object{"pageSize": 30}, Object{"enabled": true}, Object{"sort": "created-desc"}, Object{"unexpected": true}}
	histories := []any{Object{}, Object{"after": "9223372036854775807", "limit": 100}, Object{"after": "9223372036854775808"}, Object{"after": "01"}, Object{"limit": 0}}
	creates := []any{create}
	for _, patch := range []Object{{"username": "bad/name"}, {"temporaryPassword": strings.Repeat("😀", 4097)}, {"firstName": strings.Repeat("😀", 101)}, {"roleIds": []any{assignment["roleId"], assignment["roleId"]}}, {"unexpected": true}, {"note": nil}} {
		o := cloneObject(create)
		for k, v := range patch {
			o[k] = v
		}
		creates = append(creates, o)
	}
	commands := []any{command}
	for _, patch := range []Object{{"kind": "profile-update", "firstName": nil}, {"kind": "login-disable", "firstName": "bad"}, {"expectedVersion": strings.Repeat("A", 64)}, {"kind": "password-reset", "temporaryPassword": "real"}, {"kind": "email-change", "newEmail": "valid@example.invalid"}, {"kind": "email-change", "newEmail": "bad..value@example.invalid"}, {"kind": "admission-change", "action": "promote"}} {
		o := cloneObject(command)
		delete(o, "firstName")
		for k, v := range patch {
			o[k] = v
		}
		commands = append(commands, o)
	}
	assignments := []any{assignment}
	o := cloneObject(assignment)
	o["expectedVersion"] = -1
	assignments = append(assignments, o)
	o = cloneObject(assignment)
	o["id"] = nil
	assignments = append(assignments, o)
	user := &User{Issuer: "https://management.example.invalid/realms/management", ExternalSubject: "id", Username: "original", FirstName: "😀", LastName: "", RequiredActions: []string{}, Admission: "reader", Enabled: true}
	versions := []any{Object{"user": user, "meta": Object{}}, Object{"user": nil, "meta": Object{"version": 7, "login_blocked": true, "deleted_at": "2025-01-02T03:04:05.123456Z"}}}
	original := oracle(t, "", "schema", Object{"create": creates, "command": commands, "list": lists, "history": histories, "assignment": assignments, "versions": versions})
	for _, pair := range []struct {
		kind  string
		items []any
		parse func(Object) (Object, error)
	}{{"create", creates, ParseCreate}, {"command", commands, ParseCommand}, {"list", lists, ParseList}, {"history", histories, ParseHistory}, {"assignment", assignments, ParseAssignment}} {
		rows := original[pair.kind].([]any)
		for i, v := range pair.items {
			parsed, e := pair.parse(v.(map[string]any))
			if e != nil {
				parsed = nil
			}
			eq(t, pair.kind, parsed, rows[i])
		}
	}
	for i, v := range versions {
		o := v.(map[string]any)
		u, _ := o["user"].(*User)
		hash, e := TargetVersion(u, o["meta"].(map[string]any))
		if e != nil || hash != original["versions"].([]any)[i] {
			t.Fatalf("target version %d %s %v", i, hash, e)
		}
	}
	if _, ok := Intent(create)["temporaryPassword"]; ok {
		t.Fatal("temporary password retained in intent")
	}
}
