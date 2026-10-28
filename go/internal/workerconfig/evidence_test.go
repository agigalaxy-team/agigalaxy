package workerconfig

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
)

func TestOriginalEvidencePauseSemanticsAndStrictPolicyFiles(t *testing.T) {
	stamp := int64(2000000000)
	now := func() time.Time { return time.Unix(stamp, 0) }
	endpoint := "https://events.invalid"
	retirement := map[string]any{"version": 1, "id": "retirement-1", "endpoint": endpoint, "operator": "维护人员", "reason": "明确退役安排", "announcedAt": int64(2000000010), "stopWritesAt": int64(2000000020), "takeoutUntil": int64(2000000030), "statusUntil": int64(2000000040), "contactUrl": "https://events.invalid/contact", "deletionPolicyUrl": "https://events.invalid/deletion"}
	incident := map[string]any{"version": 1, "id": "incident-1", "revision": 1, "endpoint": endpoint, "state": "contained", "updatedAt": int64(1999999990), "publicMessage": "调查中"}
	write := func(name string, value any) string {
		t.Helper()
		b, e := json.Marshal(value)
		if e != nil {
			t.Fatal(e)
		}
		path := filepath.Join(t.TempDir(), name)
		if e = os.WriteFile(path, b, 0600); e != nil {
			t.Fatal(e)
		}
		return path
	}
	path := write("retirement.json", retirement)
	for _, test := range []struct {
		at      int64
		allowed bool
	}{{2000000000, true}, {2000000010, true}, {2000000019, true}, {2000000020, false}, {2000000030, false}, {2000000040, false}} {
		stamp = test.at
		gate, e := loadEvidenceGate(endpoint, path, "", now)
		if e != nil {
			t.Fatal(e)
		}
		allowed, e := gate(context.Background())
		if e != nil || allowed != test.allowed {
			t.Fatalf("retirement at %d: %v %v", stamp, allowed, e)
		}
	}
	stamp = 2000000000
	for _, state := range []string{"contained", "recovery", "resolved"} {
		incident["state"] = state
		if state == "resolved" {
			incident["recovery"] = map[string]any{"checkedAt": 1999999980, "evidenceSha256": strings.Repeat("a", 64)}
		}
		gate, e := loadEvidenceGate(endpoint, "", write("incident.json", incident), now)
		if e != nil {
			t.Fatal(e)
		}
		allowed, e := gate(context.Background())
		if e != nil || allowed != (state == "resolved") {
			t.Fatalf("incident %s: %v %v", state, allowed, e)
		}
	}
	gate, e := loadEvidenceGate(endpoint, "", "", now)
	if e != nil {
		t.Fatal(e)
	}
	if allowed, e := gate(context.Background()); e != nil || !allowed {
		t.Fatal("original explicitly absent policy default changed")
	}
	copyMap := func(original map[string]any) map[string]any {
		out := map[string]any{}
		for k, v := range original {
			out[k] = v
		}
		return out
	}
	invalid := []map[string]any{}
	for _, key := range []string{"announcedAt", "operator", "contactUrl"} {
		v := copyMap(retirement)
		delete(v, key)
		invalid = append(invalid, v)
	}
	v := copyMap(retirement)
	v["announcedAt"] = nil
	invalid = append(invalid, v)
	v = copyMap(retirement)
	v["endpoint"] = "https://other.invalid"
	invalid = append(invalid, v)
	v = copyMap(retirement)
	v["stopWritesAt"] = int64(2000000030)
	invalid = append(invalid, v)
	v = copyMap(retirement)
	v["enabled"] = true
	invalid = append(invalid, v)
	for _, value := range invalid {
		gate, e := loadEvidenceGate(endpoint, write("invalid.json", value), "", now)
		if e == nil {
			t.Fatalf("invalid policy accepted: %v", value)
		}
		if allowed, _ := gate(context.Background()); allowed {
			t.Fatal("unknown evidence allowed scans")
		}
	}
	for _, recovery := range []any{nil, map[string]any{"evidenceSha256": strings.Repeat("a", 64)}, map[string]any{"checkedAt": 2000000001, "evidenceSha256": strings.Repeat("a", 64)}} {
		v := copyMap(incident)
		v["recovery"] = recovery
		gate, e := loadEvidenceGate(endpoint, "", write("bad-incident.json", v), now)
		if e == nil {
			t.Fatal("unverified recovery accepted")
		}
		if allowed, _ := gate(context.Background()); allowed {
			t.Fatal("unverified recovery enabled scans")
		}
	}
	if _, e := loadEvidenceGate(endpoint, "relative.json", "", now); fault.Status(e) != 400 {
		t.Fatal("relative policy path accepted")
	}
}

func TestPolicyOriginMatchesURLCanonicalOrigin(t *testing.T) {
	for _, value := range []string{"https://events.invalid:443", "https://events.invalid:0443", "https://EVENTS.invalid", "https://events.invalid:", "https://events.invalid?", "https://events.invalid/"} {
		if publicURL(value, true) {
			t.Fatalf("noncanonical endpoint accepted: %s", value)
		}
	}
	if !publicURL("https://events.invalid:8443", true) {
		t.Fatal("canonical nondefault port denied")
	}
}
