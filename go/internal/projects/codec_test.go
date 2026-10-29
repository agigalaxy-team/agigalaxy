package projects

import (
	"encoding/json"
	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"testing"
)

func TestOriginalProjectDocumentLengthAndFunctionOrder(t *testing.T) {
	root, _ := filepath.Abs(filepath.Join("..", "..", ".."))
	cmd := exec.Command("node", filepath.Join(root, "scripts", "go", "protocol-codec-fixture.mjs"), "project-codec")
	cmd.Dir = root
	cmd.Env = append(os.Environ(), "GALAXY_GO_TEST_DATABASE_URL=postgres://127.0.0.1/galaxy_go_test_project_codec")
	raw, e := cmd.Output()
	if e != nil {
		if ee, ok := e.(*exec.ExitError); ok {
			t.Fatalf("original project codec: %s", ee.Stderr)
		}
		t.Fatal(e)
	}
	var fixture Object
	if e = json.Unmarshal(raw, &fixture); e != nil {
		t.Fatal(e)
	}
	for _, value := range fixture["cases"].([]any) {
		v := value.(map[string]any)
		event, e := ParseEvent([]byte(str(v, "raw")))
		if (e == nil) != truth(v, "accepted") {
			t.Fatalf("explicit UTF16 extension key limit: %v", e)
		}
		if e != nil {
			continue
		}
		b, e := documentBytes(obj(event, "document"), event, str(v, "raw"))
		if e != nil || int64(protocol.TextLength(string(b))) != num(v, "length") {
			t.Fatalf("original JSON.stringify length: %d want%d err%v", protocol.TextLength(string(b)), num(v, "length"), e)
		}
	}
	got := NormalizeFunctions(wishStrings(fixture["tags"]))
	if !reflect.DeepEqual(got, wishStrings(fixture["normalized"])) {
		t.Fatal("original UTF16 function ordering", got, fixture["normalized"])
	}
}
