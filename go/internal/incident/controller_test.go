package incident

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
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
func TestIncidentPolicyGatesAndTransitions(t *testing.T) {
	p := sample()
	now := p.UpdatedAt
	resolved := p
	resolved.State, resolved.Recovery = "resolved", &Recovery{now - 1, strings.Repeat("a", 64)}
	recovering := p
	recovering.State = "recovery"
	policies := []*Policy{nil, &p, &recovering, &resolved}
	id := "abcdefab-1234-4234-8234-123456789abc"
	routes := []struct {
		method, path   string
		duringIncident bool
	}{
		{"GET", "/v1/service-status", true},
		{"GET", "/v1/policy", true},
		{"POST", "/v1/identity/revoke", true},
		{"POST", "/v1/consents/" + id + "/revoke", true},
		{"GET", "/v2/identity/GUID" + strings.Repeat("A", 28) + "/control", true},
		{"GET", "/v1/bindings/" + id, true},
		{"POST", "/v2/identity/control/cancel", true},
		{"POST", "/v2/chat/rooms/" + id + "/leave", true},
		{"POST", "/v2/chat/rooms/" + id + "/messages/" + id + "/hide", true},
		{"POST", "/v2/community/posts/publish", false},
		{"POST", "/v2/receipt-status/query", false},
		{"POST", "/v2/tasks/" + id + "/owner-control/prepare", false},
		{"POST", "/v1/consents/" + strings.ToUpper(id) + "/revoke", false},
		{"GET", "/v1/service-status/extra", false},
		{"POST", "/v1/identity/revoke/extra", false},
		{"OPTIONS", "/v1/service-status", false},
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
	for i, policy := range policies {
		c, e := New(policy, Options{p.Endpoint, func() time.Time { return time.Unix(now, 0) }})
		if e != nil {
			t.Fatal(e)
		}
		accepted := i == 0 || i == 3
		snapshot := c.Snapshot()
		if c.CanProcessEvidence() != accepted || snapshot.BusinessWritesAccepted != accepted || snapshot.SharingAccepted != accepted || snapshot.NotificationDelivery != "public-status-pull" || snapshot.CheckedAt != now || snapshot.Version != 1 {
			t.Fatalf("policy %d snapshot %+v", i, snapshot)
		}
		if policy == nil {
			if snapshot.State != "normal" || snapshot.ID != nil || snapshot.Revision != nil || snapshot.UpdatedAt != nil || snapshot.PublicMessage != nil {
				t.Fatal("normal snapshot", snapshot)
			}
		} else {
			if snapshot.State != policy.State || snapshot.ID == nil || *snapshot.ID != p.ID || snapshot.Revision == nil || *snapshot.Revision != 1 || snapshot.UpdatedAt == nil || *snapshot.UpdatedAt != now || snapshot.PublicMessage == nil || *snapshot.PublicMessage != "Synthetic incident." {
				t.Fatal("incident snapshot", snapshot)
			}
		}
		for _, route := range routes {
			err := c.AssertRoute(route.method, route.path)
			if accepted || route.duringIncident {
				if err != nil {
					t.Fatalf("allowed %s %s state %d: %v", route.method, route.path, i, err)
				}
			} else if fault.Code(err) != "service_incident_contained" || fault.Status(err) != 503 {
				t.Fatalf("write gate %s %s state %d: %v", route.method, route.path, i, err)
			}
		}
	}

	for i, v := range invalid {
		raw, _ := json.Marshal(v)
		file := filepath.Join(t.TempDir(), "incident.json")
		os.WriteFile(file, raw, 0600)
		_, e := Load(file, Options{p.Endpoint, func() time.Time { return time.Unix(now, 0) }})
		if e == nil {
			t.Fatalf("invalid policy %d accepted %v", i, e)
		}
	}
	outcomes := []string{"", "", "Incident recovery history missing", "Active incident cannot be removed", "", "", "", "Active incident cannot be replaced", "", "Active incident cannot be replaced", "Incident revision conflict", "Incident revision conflict", "Incident revision conflict"}
	for i, pair := range transitions {
		e := AssertTransition(pair[0], pair[1])
		got := ""
		if e != nil {
			got = e.Error()
		}
		want := outcomes[i]
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
	t.Logf("incident gates: %d routes x %d states, %d invalid policies, %d history transitions", len(routes), len(policies), len(invalid), len(transitions))
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
