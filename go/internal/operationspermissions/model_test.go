package operationspermissions

import (
	"encoding/json"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"github.com/google/uuid"
)

func TestOriginalPermissionSchemasAndUntrustedHistoryProjection(t *testing.T) {
	role := Object{"operationId": uuid.NewString(), "expectedVersion": 0, "name": "  Role  ", "description": "  Original description  ", "enabled": true, "permissions": []any{"feedback.read"}}
	roles := []any{role}
	for _, patch := range []Object{{"subjectScope": "ai-only"}, {"name": "internal\ncontrol"}, {"description": "\u0085internal\u0085"}, {"permissions": []any{"feedback.read", "feedback.read"}}, {"permissions": []any{"invented.execute"}}, {"subjectScope": "human-only"}, {"expectedVersion": -1}, {"expectedVersion": 9007199254740992.0}, {"id": nil}, {"unexpected": "private"}, {"name": strings.Repeat("界", 121)}} {
		copy := obj(clone(role))
		for k, v := range patch {
			copy[k] = v
		}
		roles = append(roles, copy)
	}
	assignment := Object{"operationId": uuid.NewString(), "expectedVersion": 0, "operatorId": "not-a-cookie-id", "roleId": uuid.NewString(), "enabled": true}
	assignments := []any{assignment}
	for _, patch := range []Object{{"operatorId": ""}, {"roleId": "arbitrary"}, {"enabled": nil}, {"operatorId": strings.Repeat("x", 1025)}} {
		copy := obj(clone(assignment))
		for k, v := range patch {
			copy[k] = v
		}
		assignments = append(assignments, copy)
	}
	delta := Object{"kind": "role-save", "delta": Object{"kind": "role", "permissions": Object{"added": []any{"feedback.read"}, "removed": []any{}, "untrusted": "secret"}, "enabled": Object{"before": nil, "after": true}, "untrusted": "secret"}}
	assignmentDelta := Object{"kind": "assignment-save", "assignment_operator_id": "real", "assignment_role_id": assignment["roleId"], "delta": Object{"kind": "assignment", "operatorId": "forged", "roleId": assignment["roleId"], "enabled": Object{"before": true, "after": false}}}
	automationDelta := Object{"kind": "automation-save", "delta": Object{"kind": "automation", "permissions": Object{"added": []any{}, "removed": []any{}}, "enabled": Object{"before": true, "after": false}, "scope": Object{"before": []any{}, "after": []any{assignment["roleId"]}}, "mode": Object{"before": "automatic", "after": "assisted"}, "executorKind": Object{"before": "program", "after": "ai"}}}
	deltas := []any{delta, assignmentDelta, automationDelta, Object{"kind": "role-save", "delta": Object{"kind": "role", "permissions": Object{"added": []any{"invented.execute"}, "removed": []any{}}, "enabled": Object{"before": nil, "after": true}}}}
	histories := []any{Object{}, Object{"after": "9223372036854775807", "limit": 100}, Object{"after": "9223372036854775808"}, Object{"after": "01"}, Object{"after": 1}, Object{"targetOperatorId": "real"}, Object{"limit": 0}, Object{"limit": 101}, Object{"privateField": "secret"}}
	root, _ := filepath.Abs(filepath.Join("..", "..", ".."))
	cmd := exec.Command("node", filepath.Join(root, "scripts/go/operations-permissions-interop.mjs"), "oracle")
	cmd.Dir = root
	cmd.Stdin = strings.NewReader(jsonText(Object{"roles": roles, "assignments": assignments, "deltas": deltas, "histories": histories}))
	out, e := cmd.CombinedOutput()
	if e != nil {
		t.Fatalf("oracle %v %s", e, out)
	}
	var oracle Object
	if json.Unmarshal(out, &oracle) != nil {
		t.Fatal("oracle JSON invalid")
	}
	for _, pair := range []struct {
		kind            string
		input, expected []any
	}{{"role-save", roles, arr(oracle["role"])}, {"assignment-save", assignments, arr(oracle["assignments"])}} {
		for i, v := range pair.input {
			got, e := parseCommand(pair.kind, obj(v))
			want := pair.expected[i]
			if want == nil {
				if e == nil {
					t.Fatalf("%s invalid input %d accepted", pair.kind, i)
				}
			} else if e != nil || !same(got, want) {
				t.Fatalf("%s input %d mismatch %v", pair.kind, i, e)
			}
		}
	}
	for i, v := range deltas {
		if !same(safeDelta(obj(v)), arr(oracle["deltas"])[i]) {
			t.Fatalf("history delta %d differs", i)
		}
	}
	for i, v := range histories {
		got, e := parseHistory(obj(v))
		want := arr(oracle["histories"])[i]
		if want == nil {
			if e == nil {
				t.Fatalf("history input %d accepted", i)
			}
		} else if e != nil || !same(got, want) {
			t.Fatalf("history input %d mismatch %v", i, e)
		}
	}
	if !same(catalogItems(), oracle["catalog"]) {
		t.Fatal("generated catalog metadata differs from source")
	}
	t.Logf("original schemas: %d role + %d assignment + %d history selections; %d untrusted delta projections", len(roles), len(assignments), len(histories), len(deltas))
}
func TestOriginalAIHistoryNumericCoercion(t *testing.T) {
	inputs := []any{Object{}, Object{"limit": "0x10"}, Object{"limit": " 30 "}, Object{"limit": "\ufeff1\ufeff"}, Object{"limit": true}, Object{"limit": []any{1}}, Object{"limit": nil}, Object{"limit": "1e2"}, Object{"limit": "0b10"}, Object{"limit": "0o10"}, Object{"limit": "1.5"}, Object{"after": "9223372036854775807", "limit": 100}, Object{"after": "9223372036854775808"}}
	root, _ := filepath.Abs(filepath.Join("..", "..", ".."))
	cmd := exec.Command("node", filepath.Join(root, "scripts/go/operations-permissions-interop.mjs"), "oracle")
	cmd.Dir = root
	cmd.Stdin = strings.NewReader(jsonText(Object{"aiHistories": inputs}))
	out, e := cmd.CombinedOutput()
	if e != nil {
		t.Fatalf("oracle %v", e)
	}
	var result Object
	if json.Unmarshal(out, &result) != nil {
		t.Fatal("invalid oracle")
	}
	for i, v := range inputs {
		got, e := parseAIHistory(obj(v))
		want := arr(result["aiHistories"])[i]
		if want == nil {
			if e == nil {
				t.Fatalf("coerce %d invalid accepted", i)
			}
		} else if e != nil || !same(got, want) {
			t.Fatalf("coerce %d differs %v", i, e)
		}
	}
}
func TestOriginalZodCodepointBoundsRemainSeparateFromJSLength(t *testing.T) {
	role := Object{"operationId": uuid.NewString(), "expectedVersion": 0, "name": strings.Repeat("😀", 120), "description": strings.Repeat("😀", 1000), "enabled": true, "permissions": []any{}}
	over := obj(clone(role))
	over["name"] = strings.Repeat("😀", 121)
	assignment := Object{"operationId": uuid.NewString(), "expectedVersion": 0, "operatorId": strings.Repeat("😀", 1024), "roleId": uuid.NewString(), "enabled": true}
	prompt := Object{"operationId": uuid.NewString(), "aiAccountId": uuid.NewString(), "expectedRevision": 1, "expectedPromptVersion": 1, "prompt": strings.Repeat("😀", 16000)}
	overPrompt := obj(clone(prompt))
	overPrompt["prompt"] = strings.Repeat("😀", 16001)
	input := Object{"roles": []any{role, over}, "assignments": []any{assignment}, "promptWrites": []any{prompt, overPrompt}, "histories": []any{Object{"targetOperatorId": strings.Repeat("😀", 1024)}}}
	root, _ := filepath.Abs(filepath.Join("..", "..", ".."))
	cmd := exec.Command("node", filepath.Join(root, "scripts/go/operations-permissions-interop.mjs"), "oracle")
	cmd.Dir = root
	cmd.Stdin = strings.NewReader(jsonText(input))
	out, e := cmd.CombinedOutput()
	if e != nil {
		t.Fatalf("original codepoint oracle %v", e)
	}
	var result Object
	if json.Unmarshal(out, &result) != nil {
		t.Fatal("invalid oracle")
	}
	for i, v := range arr(input["roles"]) {
		got, e := parseCommand("role-save", obj(v))
		want := arr(result["role"])[i]
		if want == nil {
			if e == nil {
				t.Fatal("over codepoint role accepted")
			}
		} else if e != nil || !same(got, want) {
			t.Fatal("valid codepoint role rejected")
		}
	}
	got, e := parseCommand("assignment-save", assignment)
	if e != nil || !same(got, arr(result["assignments"])[0]) {
		t.Fatal("assignment schema used JS length instead of codepoints")
	}
	for i, v := range arr(input["promptWrites"]) {
		got, e := parsePrompt(obj(v), true)
		want := arr(result["promptWrites"])[i]
		if want == nil {
			if e == nil {
				t.Fatalf("over codepoint prompt accepted at %d len=%d issues=%v", i, len(str(obj(v)["prompt"])), result["promptIssues"])
			}
		} else if e != nil || !same(got, want) {
			t.Fatal("valid codepoint prompt rejected")
		}
	}
	history, e := parseHistory(obj(arr(input["histories"])[0]))
	if e != nil || !same(history, arr(result["histories"])[0]) {
		t.Fatal("history schema used JS length")
	}
	if actionLabel(strings.Repeat("😀", 120), "fallback") != strings.Repeat("😀", 90) {
		t.Fatal("explicit JS.slice180 no longer counts UTF16 units")
	}
}
