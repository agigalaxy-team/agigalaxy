package opportunities

import (
	"encoding/base64"
	"encoding/json"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
	"time"
)

func TestOriginalTemporaryCursorProtocol(t *testing.T) {
	root, _ := filepath.Abs(filepath.Join("..", "..", ".."))
	cmd := exec.Command("node", filepath.Join(root, "scripts", "go", "protocol-codec-fixture.mjs"), "recruitment-codec")
	cmd.Dir = root
	cmd.Env = append(os.Environ(), "GALAXY_GO_TEST_DATABASE_URL=postgres://127.0.0.1/galaxy_go_test_opportunity_codec")
	raw, e := cmd.Output()
	if e != nil {
		t.Fatal(e)
	}
	var f Object
	if e = json.Unmarshal(raw, &f); e != nil {
		t.Fatal(e)
	}
	x := obj(f, "cursor")
	value := obj(x, "value")
	key, e := base64.RawURLEncoding.DecodeString(str(x, "key"))
	if e != nil {
		t.Fatal(e)
	}
	now := int64(2000000000)
	s := &Service{Now: func() time.Time { return time.Unix(now, 0) }}
	s.cursorOnce.Do(func() { s.cursorKey = key })
	got, e := s.OpenCursor(str(x, "token"), str(value, "queryHash"), str(value, "viewerId"))
	if e != nil || str(got, "startAfter") != str(value, "startAfter") {
		t.Fatal("original AES-GCM IV/tag/body format", e)
	}
	token, e := s.SealCursor(Object{"v": 2, "queryHash": value["queryHash"], "viewerId": value["viewerId"], "startAfter": value["startAfter"]})
	if e != nil {
		t.Fatal(e)
	}
	if _, e = s.OpenCursor(token, str(value, "queryHash"), str(value, "viewerId")); e != nil {
		t.Fatal(e)
	}
	for _, q := range []struct{ token, hash, viewer string }{{token, "wrong", str(value, "viewerId")}, {token, str(value, "queryHash"), "other"}, {token + "=", str(value, "queryHash"), str(value, "viewerId")}} {
		if _, e = s.OpenCursor(q.token, q.hash, q.viewer); fault.Code(e) != "discovery_cursor_unavailable_restart" {
			t.Fatal("cursor scope/canonical base64", e)
		}
	}
	now += 900
	if _, e = s.OpenCursor(token, str(value, "queryHash"), str(value, "viewerId")); fault.Code(e) != "discovery_cursor_unavailable_restart" {
		t.Fatal("cursor exact expiry", e)
	}
	restarted := &Service{}
	if _, e = restarted.OpenCursor(token, str(value, "queryHash"), str(value, "viewerId")); fault.Code(e) != "discovery_cursor_unavailable_restart" {
		t.Fatal("temporary key persisted across service", e)
	}
}
