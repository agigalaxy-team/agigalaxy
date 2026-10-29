package discovery

import (
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
)

// These fixed synthetic expectations retain the existing protected engine
// wire formats. They never execute a retired server/client implementation.
func loadWireFixture(t *testing.T, name string, target any) {
	t.Helper()
	raw, err := os.ReadFile("testdata/" + name + ".json")
	if err != nil {
		t.Fatal(err)
	}
	if err = json.Unmarshal(raw, target); err != nil {
		t.Fatal(err)
	}
}

func currentContractNode(t *testing.T, script string, args ...string) []byte {
	t.Helper()
	root, err := filepath.Abs("../../..")
	if err != nil {
		t.Fatal(err)
	}
	cmd := exec.Command("node", append([]string{"--input-type=module", "-e", script}, args...)...)
	cmd.Dir = root
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("current shared contract: %v %s", err, out)
	}
	return out
}
