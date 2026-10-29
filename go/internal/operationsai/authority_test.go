package operationsai

import (
	"encoding/json"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"github.com/agigalaxy-team/agigalaxy/go/internal/identity"
)

func TestGeneratedAIActionCapabilitiesMatchSharedContract(t *testing.T) {
	inputs := [][]string{{}, {"feedback.update", "feedback.read", "ai.roles.create", "ai.roles.read", "ai.prompts.update", "ai.prompts.read"}, {"content.hide", "permissions.roles.write", "models.configure", "accounts.restriction.apply", "jobs.retry", "jobs.read"}}
	root, _ := filepath.Abs(filepath.Join("..", "..", ".."))
	b, _ := json.Marshal(map[string]any{"capabilities": inputs})
	cmd := exec.Command("node", "--input-type=module", "-e", `import {aiWorkCapabilities} from "./packages/galaxy-contracts/src/operations-ai-work-capabilities.mjs";let data="";for await(const chunk of process.stdin)data+=chunk;const input=JSON.parse(data);console.log(JSON.stringify({capabilities:input.capabilities.map(p=>aiWorkCapabilities("overview",p))}));`)
	cmd.Dir = root
	cmd.Stdin = strings.NewReader(string(b))
	out, e := cmd.CombinedOutput()
	if e != nil {
		t.Fatalf("shared contract %v %s", e, out)
	}
	var oracle Object
	if json.Unmarshal(out, &oracle) != nil {
		t.Fatal("invalid oracle")
	}
	for i, p := range inputs {
		got := Capabilities("overview", p)
		a, _ := identity.Canonical(got)
		b, _ := identity.Canonical(arr(oracle["capabilities"])[i])
		if string(a) != string(b) {
			t.Fatalf("capabilities %d differ", i)
		}
	}
}

// This is the CPU-only portion performed after loading an AI role from SQL.
func BenchmarkAIReadPermissionProjection(b *testing.B) {
	permissions := []string{}
	for _, item := range arr(catalog()["actions"]) {
		permissions = append(permissions, str(obj(item)["permission"]))
	}
	b.ReportAllocs()
	b.ResetTimer()
	for b.Loop() {
		current := []string{}
		for _, permission := range permissions {
			if Known(permission) {
				current = append(current, permission)
			}
		}
		_ = WorkPermissions("query", current)
	}
}

func TestDefinitionReturnsIndependentContractValues(t *testing.T) {
	first := Definition("accounts.restriction.apply")
	first["humanOnly"] = true
	obj(first["handler"])["service"] = "changed"
	arr(first["conditions"])[0] = "changed"
	next := Definition("accounts.restriction.apply")
	if next["humanOnly"] != false || obj(next["handler"])["service"] != "accounts" || arr(next["conditions"])[0] != "ordinary" {
		t.Fatal("definition mutation escaped into shared contract")
	}
	if Known("not-a-permission") || Definition("not-a-permission") != nil {
		t.Fatal("unknown permission admitted")
	}
}
func TestWorkPermissionsMatchCapabilityProjection(t *testing.T) {
	all := []string{}
	for _, item := range arr(catalog()["actions"]) {
		all = append(all, str(obj(item)["permission"]))
	}
	for _, permissions := range [][]string{{}, all, {"content.read", "content.hide", "feedback.read"}, {"feedback.update"}} {
		capabilities := Capabilities("", permissions)
		for _, purpose := range []string{"query", "execution", "prepare", "conversation"} {
			expected := []string{}
			add := func(permission string) {
				if contains(permissions, permission) && !contains(expected, permission) {
					expected = append(expected, permission)
				}
			}
			switch purpose {
			case "query":
				expected = stringsOf(capabilities["queryPermissions"])
			case "execution":
				expected = stringsOf(capabilities["autonomousPermissions"])
			case "prepare":
				for _, p := range stringsOf(capabilities["queryPermissions"]) {
					add(p)
				}
				add("chat-reports.materials.read")
				for _, v := range arr(catalog()["preparation"]) {
					entry := obj(v)
					if contains(stringsOf(capabilities["preparableKinds"]), str(entry["kind"])) {
						add(str(entry["read"]))
						for _, p := range stringsOf(entry["actions"]) {
							add(p)
						}
					}
				}
			}
			a, _ := json.Marshal(expected)
			b, _ := json.Marshal(WorkPermissions(purpose, permissions))
			if string(a) != string(b) {
				t.Fatalf("purpose %s changed: %s != %s", purpose, a, b)
			}
		}
	}
}
