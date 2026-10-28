package deviceauth

import (
	"encoding/json"
	"github.com/google/uuid"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

func TestOriginalConsentSchemaCodepointBounds(t *testing.T) {
	values := []ConsentIntent{}
	base := ConsentIntent{Version: 1, ID: uuid.NewString(), SubjectID: "GUID" + strings.Repeat("0", 28), BindingID: uuid.NewString(), Endpoint: "https://device.example.invalid", ObjectID: "original", Action: "history.query", Purpose: "operational", Recipient: "original", Fields: []string{"title"}, Visibility: "Private", Viewers: []string{}, PayloadHash: strings.Repeat("a", 64), PolicyVersion: "0.1", IssuedAt: 2000000000, ExpiresAt: 2000000600}
	for _, n := range []int{0, 65, 128, 129} {
		v := base
		v.ObjectID = strings.Repeat("😀", n)
		values = append(values, v)
	}
	for _, n := range []int{0, 121, 240, 241} {
		v := base
		v.Recipient = strings.Repeat("😀", n)
		values = append(values, v)
	}
	b, _ := json.Marshal(values)
	root, _ := filepath.Abs(filepath.Join("..", "..", ".."))
	cmd := exec.Command("node", filepath.Join(root, "scripts/go/device-auth-interop.mjs"), "consent-schema")
	cmd.Dir = root
	cmd.Stdin = strings.NewReader(string(b))
	out, e := cmd.CombinedOutput()
	if e != nil {
		t.Fatalf("source consent schema %v %s", e, out)
	}
	var expected []bool
	if json.Unmarshal(out, &expected) != nil || len(expected) != len(values) {
		t.Fatal("invalid source schema result")
	}
	for i, v := range values {
		raw, _ := json.Marshal(v)
		parsed, e := parseConsent(raw)
		if (e == nil) != expected[i] {
			t.Fatalf("case%d acceptance %v source%t", i, e, expected[i])
		}
		if e == nil && (parsed.ObjectID != v.ObjectID || parsed.Recipient != v.Recipient) {
			t.Fatal("intent strings changed while checking schema")
		}
	}
}
