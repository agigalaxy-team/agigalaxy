package moderation

import (
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"testing"
)

func TestOriginalModerationSchemaAndSurvivingVerifierFacts(t *testing.T) {
	root, _ := filepath.Abs(filepath.Join("..", "..", ".."))
	cmd := exec.Command("node", filepath.Join(root, "scripts", "go", "protocol-codec-fixture.mjs"), "moderation-codec")
	cmd.Dir = root
	cmd.Env = append(os.Environ(), "GALAXY_GO_TEST_DATABASE_URL=postgres://127.0.0.1/galaxy_go_test_moderation_schema")
	raw, e := cmd.Output()
	if e != nil {
		t.Fatal(e)
	}
	var f Object
	if e = json.Unmarshal(raw, &f); e != nil {
		t.Fatal(e)
	}
	normalized := func(v any) any { var out any; json.Unmarshal(encode(v), &out); return out }
	for _, v := range objectsOf(f["cases"]) {
		got, e := ParsePayload(encode(v["input"]), truth(v, "report"))
		if (e == nil) != truth(v, "accepted") {
			t.Fatal("original schema acceptance", e)
		}
		if e == nil && !reflect.DeepEqual(normalized(got), v["normalized"]) {
			t.Fatal("original schema projection/defaults", normalized(got), v["normalized"])
		}
	}
	for _, v := range objectsOf(f["projections"]) {
		rows := objectsOf(v["rows"])
		for _, r := range rows {
			r["parsedPayload"] = r["payload"]
		}
		got := ProjectVerifiers(rows)
		if !reflect.DeepEqual(normalized(got), v["members"]) {
			t.Fatal("surviving verifier facts changed", normalized(got), v["members"])
		}
	}
}
