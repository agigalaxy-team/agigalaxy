package operationsai

import (
	"encoding/json"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"github.com/agigalaxy-team/agigalaxy/go/internal/identity"
)

func TestGeneratedCurrentAIActionCapabilitiesOriginalParity(t *testing.T) {
	inputs := [][]string{{}, {"feedback.update", "feedback.read", "ai.roles.create", "ai.roles.read", "ai.prompts.update", "ai.prompts.read"}, {"content.hide", "permissions.roles.write", "models.configure", "accounts.restriction.apply", "jobs.retry", "jobs.read"}}
	root, _ := filepath.Abs(filepath.Join("..", "..", ".."))
	b, _ := json.Marshal(map[string]any{"capabilities": inputs})
	cmd := exec.Command("node", filepath.Join(root, "scripts/go/operations-permissions-interop.mjs"), "oracle")
	cmd.Dir = root
	cmd.Stdin = strings.NewReader(string(b))
	out, e := cmd.CombinedOutput()
	if e != nil {
		t.Fatalf("original %v %s", e, out)
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
