package managementaccounts

import (
	"strings"
	"testing"
)

func TestOriginalManagementSchemasAndTargetVersions(t *testing.T) {
	create := Object{"operationId": "954b628d-a8aa-4db1-91db-55294210fc2a", "username": " new.user ", "temporaryPassword": strings.Repeat("😀", 4096), "firstName": strings.Repeat("😀", 100)}
	command := Object{"operationId": "52cb4fdf-a62f-4f43-b294-34a5f222f2b1", "expectedVersion": strings.Repeat("a", 64), "kind": "profile-update", "firstName": " changed ", "reason": " original "}
	assignment := Object{"operationId": "c87ae0e4-f5d4-46e0-a0c9-ffbcd95b6792", "expectedVersion": 0, "roleId": "ded3f132-66ea-47a1-b559-ab234421060d", "enabled": true}
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
	var fixture struct {
		Input Object `json:"input"`
		Value Object `json:"value"`
	}
	fixtureJSON(t, "schema", &fixture)
	eq(t, "schema input", Object{"create": creates, "command": commands, "list": lists, "history": histories, "assignment": assignments, "versions": versions}, fixture.Input)
	original := fixture.Value
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
