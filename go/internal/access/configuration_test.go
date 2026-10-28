package access

import (
	"context"
	"encoding/json"
	"os/exec"
	"path/filepath"
	"testing"
)

func TestOriginalConfigurationScopeBytesArePreserved(t *testing.T) {
	root, _ := filepath.Abs(filepath.Join("..", "..", ".."))
	cmd := exec.Command("node", filepath.Join(root, "scripts", "go", "access-fixture.mjs"), t.TempDir())
	cmd.Dir = root
	out, e := cmd.Output()
	if e != nil {
		t.Fatalf("scope fixture: %v", e)
	}
	var original struct{ Endpoint, AccountFile, OperationsFile, IdentityFile, AccountScope, OperatorConfiguration, RootID string }
	if e = json.Unmarshal(out, &original); e != nil {
		t.Fatal(e)
	}
	g, e := Load(context.Background(), nil, original.Endpoint, original.AccountFile, original.OperationsFile, original.IdentityFile)
	if e != nil {
		t.Fatal(e)
	}
	if g.Config.AccountScope != original.AccountScope || g.Config.OperatorConfiguration != original.OperatorConfiguration || g.Config.Root.OperatorID != original.RootID {
		t.Fatal("configuration changed existing account/operator session scope")
	}
	if g.Config.AccountIssuer == g.Config.OperatorIssuer {
		t.Fatal("management and public account authentication collapsed")
	}
}
