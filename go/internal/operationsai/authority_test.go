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
