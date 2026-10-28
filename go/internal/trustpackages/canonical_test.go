package trustpackages

import (
	"encoding/json"
	"github.com/agigalaxy-team/agigalaxy/go/internal/jstext"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
)

func TestOriginalTrustCanonical(t *testing.T) {
	raw := []byte(`[{"claim":"\ud800"},{"text":"\ue000","🚀":1,"😀":2,"2":3,"10":4},{"n":-0},{"n":1e30},null,"abc",42]`)
	values, e := jstext.DecodeJSON(raw)
	if e != nil {
		t.Fatal(e)
	}
	file := filepath.Join(t.TempDir(), "canonical.json")
	if e = os.WriteFile(file, raw, 0600); e != nil {
		t.Fatal(e)
	}
	root, _ := filepath.Abs("../../..")
	cmd := exec.Command("node", filepath.Join(root, "scripts/go/trust-package-interop.mjs"), "canonical", file)
	cmd.Dir = root
	b, e := cmd.CombinedOutput()
	if e != nil {
		t.Fatalf("original canonical %v %s", e, b)
	}
	var expected []struct {
		Accepted bool
		Value    string
	}
	if e = json.Unmarshal(b, &expected); e != nil {
		t.Fatal(e)
	}
	for i, v := range array(values) {
		actual, e := canonical(v)
		if (e == nil) != expected[i].Accepted || e == nil && actual != expected[i].Value {
			t.Fatalf("canonical %d Go=%q original=%q error=%v", i, actual, expected[i].Value, e)
		}
	}
}
