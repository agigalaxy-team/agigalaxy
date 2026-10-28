package incident

import (
	"context"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"regexp"
	"strings"
	"testing"
	"time"

	"github.com/agigalaxy-team/agigalaxy/go/internal/deviceauth"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/testsupport"
)

func sample() Policy {
	return Policy{1, "isolated-incident", 1, "https://incident.example.invalid", "contained", 2000000000, "  Synthetic incident.  ", nil}
}
func TestOriginalIncidentParity(t *testing.T) {
	root, _ := filepath.Abs(filepath.Join("..", "..", ".."))
	p := sample()
	now := p.UpdatedAt
	resolved := p
	resolved.State = "resolved"
	resolved.Recovery = &Recovery{now - 1, strings.Repeat("a", 64)}
	recovering := p
	recovering.State = "recovery"
	policies := []*Policy{nil, &p, &recovering, &resolved}
	routes := []map[string]string{}
	paths := map[string]bool{}
	for _, file := range []string{"operations/service-access-v2.mjs", "operations/incident.mjs"} {
		raw, e := os.ReadFile(filepath.Join(root, "packages/galaxy-official/src", file))
		if e != nil {
			t.Fatal(e)
		}
		for _, m := range regexp.MustCompile(`'(/[a-zA-Z0-9/._-]+)'`).FindAllStringSubmatch(string(raw), -1) {
			paths[m[1]] = true
		}
	}
	uuid := "abcdefab-1234-4234-8234-123456789abc"
	guid := "GUID" + strings.Repeat("A", 28)
	for _, path := range []string{"/v2/identity/" + guid + "/control", "/v1/bindings/" + uuid, "/v1/consents/" + uuid + "/revoke", "/v1/consents/" + strings.ToUpper(uuid) + "/revoke", "/v2/chat/rooms/" + uuid + "/leave", "/v2/chat/rooms/" + uuid + "/messages/" + uuid + "/hide", "/v2/chat/rooms/" + uuid + "/read", "/v2/tasks/" + uuid + "/owner-control/prepare", "/v2/receipt-status/query", "/v2/identity/control/challenges", "/v2/identity/control/commit", "/v2/community/posts/publish", "/v1/service-status/extra", "/v1/identity/revoke/extra", "/healthz", "/readyz"} {
		paths[path] = true
	}
	for path := range paths {
		for _, method := range []string{"GET", "POST", "OPTIONS", "DELETE"} {
			routes = append(routes, map[string]string{"method": method, "path": path})
		}
	}
	data, _ := json.Marshal(p)
	var base map[string]any
	json.Unmarshal(data, &base)
	invalid := []map[string]any{}
	for _, key := range []string{"version", "id", "revision", "endpoint", "state", "updatedAt", "publicMessage"} {
		copy := map[string]any{}
		for k, v := range base {
			copy[k] = v
		}
		delete(copy, key)
		invalid = append(invalid, copy)
	}
	for _, patch := range []map[string]any{{"state": "new"}, {"state": "resolved"}, {"revision": 0}, {"updatedAt": -1}, {"endpoint": "https://incident.example.invalid/"}, {"publicMessage": " "}, {"recovery": map[string]any{"checkedAt": now, "evidenceSha256": "ABC"}}, {"extra": true}, {"Version": 1}} {
		copy := map[string]any{}
		for k, v := range base {
			copy[k] = v
		}
		for k, v := range patch {
			copy[k] = v
		}
		invalid = append(invalid, copy)
	}
	a := &Transition{"incident", 1, "contained", now, "abc"}
	r := &Transition{"incident", 2, "resolved", now + 1, "def"}
	transitions := [][2]*Transition{{nil, nil}, {nil, a}, {nil, r}, {a, nil}, {r, nil}, {a, a}, {a, r}, {a, {"other", 1, "contained", now, "new"}}, {r, {"other", 1, "contained", now, "new"}}, {r, {"other", 1, "resolved", now, "new"}}, {a, {"incident", 3, "contained", now, "new"}}, {a, {"incident", 2, "recovery", now - 1, "new"}}, {a, {"incident", 1, "recovery", now, "changed"}}}
	input, _ := json.Marshal(map[string]any{"endpoint": p.Endpoint, "now": now, "policies": policies, "routes": routes, "invalidPolicies": invalid, "transitions": transitions})
	cmd := exec.Command("node", filepath.Join(root, "scripts/go/incident-interop.mjs"))
	cmd.Dir = root
	cmd.Stdin = strings.NewReader(string(input))
	out, e := cmd.CombinedOutput()
	if e != nil {
		t.Fatalf("original oracle %v %s", e, out)
	}
	var oracle struct {
		Observations []struct {
			Snapshot           Snapshot
			Policy             *Policy
			CanProcessEvidence bool
			Routes             []*string
		}
		Validations []bool
		Transitions []*string
	}
	if e = json.Unmarshal(out, &oracle); e != nil {
		t.Fatal(e)
	}
	for i, policy := range policies {
		c, e := New(policy, Options{p.Endpoint, func() time.Time { return time.Unix(now, 0) }})
		if e != nil {
			t.Fatal(e)
		}
		o := oracle.Observations[i]
		if !reflect.DeepEqual(c.Snapshot(), o.Snapshot) || !reflect.DeepEqual(c.Policy(), o.Policy) || c.CanProcessEvidence() != o.CanProcessEvidence {
			t.Fatalf("policy %d projection mismatch", i)
		}
		for j, route := range routes {
			err := c.AssertRoute(route["method"], route["path"])
			want := ""
			if o.Routes[j] != nil {
				want = *o.Routes[j]
			}
			got := ""
			if err != nil {
				got = fault.Code(err)
			}
			if got != want {
				t.Fatalf("route %v state %d got %s want %s", route, i, got, want)
			}
		}
	}
	for i, v := range invalid {
		raw, _ := json.Marshal(v)
		file := filepath.Join(t.TempDir(), "incident.json")
		os.WriteFile(file, raw, 0600)
		_, e := Load(file, Options{p.Endpoint, func() time.Time { return time.Unix(now, 0) }})
		if (e == nil) != oracle.Validations[i] {
			t.Fatalf("invalid policy %d parity %v", i, e)
		}
	}
	for i, pair := range transitions {
		e := AssertTransition(pair[0], pair[1])
		got := ""
		if e != nil {
			got = e.Error()
		}
		want := ""
		if oracle.Transitions[i] != nil {
			want = *oracle.Transitions[i]
		}
		if got != want {
			t.Fatalf("transition %d got %s want %s", i, got, want)
		}
	}
	c, _ := New(&p, Options{p.Endpoint, func() time.Time { return time.Unix(now, 0) }})
	copy := c.Policy()
	copy.State = "resolved"
	if c.CanProcessEvidence() {
		t.Fatal("policy clone mutated controller")
	}
	if _, e := New(&p, Options{p.Endpoint, func() time.Time { return time.Unix(now-1, 0) }}); e == nil {
		t.Fatal("future policy accepted")
	}
	if _, e := New(&p, Options{"https://other.invalid", func() time.Time { return time.Unix(now, 0) }}); e == nil {
		t.Fatal("wrong endpoint accepted")
	}
	t.Logf("original incident parity: %d routes x %d states, %d invalid policies, %d history transitions", len(routes), len(policies), len(invalid), len(transitions))
}
func TestIncidentBindingGateIsolatedPostgreSQL(t *testing.T) {
	pool, _ := testsupport.PostgreSQL(t)
	ctx := context.Background()
	if _, e := pool.Exec(ctx, "CREATE TABLE subjects(id text PRIMARY KEY); INSERT INTO subjects VALUES ('existing')"); e != nil {
		t.Fatal(e)
	}
	p := sample()
	c, e := New(&p, Options{p.Endpoint, func() time.Time { return time.Unix(p.UpdatedAt, 0) }})
	if e != nil {
		t.Fatal(e)
	}
	if e = c.AssertBindingSubject(ctx, pool, "existing"); e != nil {
		t.Fatal(e)
	}
	if e = c.AssertBindingSubject(ctx, pool, "new"); fault.Code(e) != "service_enrollment_stopped" || fault.Status(e) != 503 {
		t.Fatalf("enrollment gate %v", e)
	}
	called := false
	svc := &deviceauth.Service{BindingGate: func(context.Context, deviceauth.SQLReader, string) error {
		called = true
		return fault.New("existing_gate", 403)
	}}
	c.BindDevice(svc)
	if e = svc.BindingGate(ctx, pool, "existing"); fault.Code(e) != "existing_gate" || !called {
		t.Fatalf("previous gate lost %v", e)
	}
	called = false
	if e = svc.BindingGate(ctx, pool, "new"); fault.Code(e) != "service_enrollment_stopped" || called {
		t.Fatalf("new subject passed %v", e)
	}
	if e = svc.ConsentPolicy(ctx, deviceauth.ConsentIntent{}, deviceauth.Actor{}); fault.Code(e) != "service_incident_contained" {
		t.Fatalf("consent gate %v", e)
	}
}
func TestIncidentConfigurationSemantics(t *testing.T) {
	endpoint := "https://incident.example.invalid"
	o := Options{endpoint, func() time.Time { return time.Unix(2000000000, 0) }}
	raw := `{"version":1e0,"id":"incident","revision":1.0,"endpoint":"https://incident.example.invalid","state":"contained","updatedAt":2e9,"publicMessage":"\ufeff Message \ufeff"}`
	path := filepath.Join(t.TempDir(), "incident.json")
	os.WriteFile(path, []byte(raw), 0600)
	c, e := Load(path, o)
	if e != nil || c.Policy().PublicMessage != "Message" || c.Policy().Recovery != nil {
		t.Fatalf("numeric/trim/default semantics %v %v", c, e)
	}
	if _, e = Load("relative.json", o); e == nil {
		t.Fatal("relative policy accepted")
	}
	if c, e = Load("", o); e != nil || !c.CanProcessEvidence() {
		t.Fatalf("unconfigured policy %v", e)
	}
}
