package targetgovernance

import (
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"testing"
)

func TestOriginalTargetSchemaVariantsAndAstral(t *testing.T) {
	root, _ := filepath.Abs(filepath.Join("..", "..", ".."))
	cmd := exec.Command("node", filepath.Join(root, "scripts", "go", "protocol-codec-fixture.mjs"), "target-codec")
	cmd.Dir = root
	cmd.Env = append(os.Environ(), "GALAXY_GO_TEST_DATABASE_URL=postgres://127.0.0.1/galaxy_go_test_target_schema")
	raw, e := cmd.Output()
	if e != nil {
		t.Fatal(e)
	}
	var f Object
	if e = json.Unmarshal(raw, &f); e != nil {
		t.Fatal(e)
	}
	for _, v := range f["cases"].([]any) {
		x := v.(map[string]any)
		got, e := ParsePayload(encode(x["input"]), truth(x, "report"))
		if (e == nil) != truth(x, "accepted") {
			t.Fatal("original schema acceptance", e)
		}
		if e == nil {
			var normalized any
			json.Unmarshal(encode(got), &normalized)
			if !reflect.DeepEqual(normalized, x["normalized"]) {
				t.Fatal("original normalized payload", normalized, x["normalized"])
			}
		}
	}
}
