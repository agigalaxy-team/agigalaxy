package recruitment

import (
	"encoding/json"
	"github.com/agigalaxy-team/agigalaxy/go/internal/opportunities"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"testing"
)

func TestOriginalRecruitmentAstralAndSharedMatch(t *testing.T) {
	root, _ := filepath.Abs(filepath.Join("..", "..", ".."))
	cmd := exec.Command("node", filepath.Join(root, "scripts", "go", "chat-interop.mjs"), "recruitment-codec")
	cmd.Dir = root
	cmd.Env = append(os.Environ(), "GALAXY_GO_TEST_DATABASE_URL=postgres://127.0.0.1/galaxy_go_test_recruitment_codec")
	raw, e := cmd.Output()
	if e != nil {
		t.Fatal(e)
	}
	var f Object
	if e = json.Unmarshal(raw, &f); e != nil {
		t.Fatal(e)
	}
	normalize := func(v any) any { var out any; json.Unmarshal(encode(v), &out); return out }
	for _, v := range f["cases"].([]any) {
		x := v.(map[string]any)
		got, e := ParseEvent(encode(x["input"]))
		if (e == nil) != truth(x, "accepted") {
			t.Fatal("original astral schema decision", e)
		}
		if e == nil && !reflect.DeepEqual(normalize(got), x["normalized"]) {
			t.Fatal("original schema defaults/trim differ")
		}
	}
	match := opportunities.Match(obj(f, "source"), obj(f, "candidate"), obj(f, "left"), obj(f, "right"))
	if !reflect.DeepEqual(normalize(match), f["match"]) {
		t.Fatal("original matcher projection", normalize(match), f["match"])
	}
	for _, v := range f["refs"].([]any) {
		x := v.(map[string]any)
		if opportunities.OpportunityID(obj(x, "ref")) != x["id"] {
			t.Fatal("original ref property order hash")
		}
	}
}
