package registeredusers_test

import (
	"encoding/json"
	r "github.com/agigalaxy-team/agigalaxy/go/internal/registeredusers"
	"os"
	"reflect"
	"sort"
	"strings"
	"testing"
)

func TestRegisteredSchemaAndTargetHashOriginalBytes(t *testing.T) {
	id := "11111111-1111-4111-8111-111111111111"
	base := object{"operationId": id, "kind": "profile-preset", "expectedVersion": strings.Repeat("a", 64), "expectedPresetRevision": 0, "basis": "  原依据  ", "reason": " 原理由 ", "displayName": strings.Repeat("😀", 120), "bio": strings.Repeat("🚀", 500), "avatarKey": nil}
	commands := []object{base}
	for k, v := range map[string]any{"displayName": strings.Repeat("😀", 121), "bio": strings.Repeat("🚀", 501), "avatarKey": "remote-url", "expectedPresetRevision": nil} {
		copy := object{}
		for a, b := range base {
			copy[a] = b
		}
		copy[k] = v
		commands = append(commands, copy)
	}
	sort.Slice(commands, func(i, j int) bool { return encode(commands[i]) < encode(commands[j]) })
	lists := []object{{}, {"query": " 原始😀 ", "pageSize": 50}, {"query": strings.Repeat("😀", 320)}, {"query": strings.Repeat("😀", 321)}, {"registeredFrom": "2026-10-28T10:00:00+08:00", "registeredTo": "2026-10-28T11:00:00+08:00"}, {"registeredFrom": "2026-10-28T11:00:00+08:00", "registeredTo": "2026-10-28T10:00:00+08:00"}, {"source": "all", "extra": true}, {"pageSize": 21}}
	history := []object{{}, {"after": "9999999999999999999", "limit": 100}, {"after": "0"}, {"limit": 0}}
	email := "原始@example.invalid"
	at := "2023-11-14T22:13:20.000Z"
	user := &r.User{Enabled: true, Email: &email, EmailVerified: true, RegisteredAt: &at}
	row := object{"registration_id": id, "issuer": "https://website.example.invalid/realms/website", "external_subject": "原始😀", "preset_revision": 0}
	raw, e := os.ReadFile("testdata/registered-schema.json")
	if e != nil {
		t.Fatal(e)
	}
	var expected object
	if json.Unmarshal(raw, &expected) != nil {
		t.Fatal("invalid source schema")
	}
	actual := object{}
	for _, spec := range []struct {
		k     string
		rows  []object
		parse func(object) (object, error)
	}{{"list", lists, r.ParseList}, {"command", commands, r.ParseCommand}, {"history", history, r.ParseHistory}} {
		out := []any{}
		for _, v := range spec.rows {
			o, e := spec.parse(v)
			if e != nil {
				out = append(out, nil)
			} else {
				out = append(out, o)
			}
		}
		actual[spec.k] = out
	}
	hashes := []string{}
	for _, u := range []*r.User{user, nil} {
		v, e := r.TargetVersion(row, u)
		if e != nil {
			t.Fatal(e)
		}
		hashes = append(hashes, v)
	}
	actual["versions"] = hashes
	var normalized any
	json.Unmarshal([]byte(encode(actual)), &normalized)
	if !reflect.DeepEqual(normalized, expected) {
		t.Fatalf("schema/hash difference\nGo%s\nJS%s", encode(actual), encode(expected))
	}
}
