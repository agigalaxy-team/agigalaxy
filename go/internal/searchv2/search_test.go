package searchv2

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/json"
	"github.com/agigalaxy-team/agigalaxy/go/internal/cases"
	"github.com/agigalaxy-team/agigalaxy/go/internal/civ2"
	"github.com/agigalaxy-team/agigalaxy/go/internal/deviceauth"
	"github.com/agigalaxy-team/agigalaxy/go/internal/evidence"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/historyv2"
	"github.com/agigalaxy-team/agigalaxy/go/internal/identity"
	"github.com/agigalaxy-team/agigalaxy/go/internal/profiles"
	"github.com/agigalaxy-team/agigalaxy/go/internal/testsupport"
	"github.com/agigalaxy-team/agigalaxy/go/internal/verificationrecords"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"testing"
	"time"
)

func node(t *testing.T, dsn, domain, mode, path string, input any) Object {
	t.Helper()
	root, _ := filepath.Abs("../../..")
	cmd := exec.Command("node", filepath.Join(root, "go/internal", domain, "testdata/interop.mjs"), mode, path)
	cmd.Dir = root
	cmd.Env = append(os.Environ(), "GALAXY_GO_TEST_DATABASE_URL="+dsn)
	cmd.Stdin = bytes.NewReader(encode(input))
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	raw, e := cmd.Output()
	if e != nil {
		t.Fatalf("original Search %s/%s %v %s", domain, mode, e, stderr.String())
	}
	var out Object
	for _, line := range bytes.Split(raw, []byte("\n")) {
		if json.Unmarshal(line, &out) == nil && out != nil {
			return out
		}
	}
	t.Fatal("fixture result")
	return nil
}
func same(t *testing.T, a, b any) {
	t.Helper()
	var x, y any
	_ = json.Unmarshal(encode(a), &x)
	_ = json.Unmarshal(encode(b), &y)
	if !reflect.DeepEqual(x, y) {
		t.Fatalf("Go=%s\nJS=%s", encode(a), encode(b))
	}
}
func TestOriginalSearchV2CurrentHistoryAndProofSources(t *testing.T) {
	for _, domain := range []string{"historyv2", "civ2"} {
		t.Run(domain, func(t *testing.T) {
			owner, dsn := testsupport.PostgreSQL(t)
			ctx := context.Background()
			basename := "history-fixture.json"
			if domain == "civ2" {
				basename = "ci-fixture.json"
			}
			path := filepath.Join(t.TempDir(), basename)
			pub, key, _ := ed25519.GenerateKey(rand.Reader)
			pem, _ := identity.PublicPEM(pub)
			node(t, dsn, domain, "setup", path, Object{"publicKey": pem})
			raw, _ := os.ReadFile(path)
			var f struct {
				Endpoint string
				Clock    int64
				Owner    struct{ Subject, Token string }
				Cases    []struct {
					Root                         Object
					HiddenGrant, CorrectionGrant Object
				}
				Pins        []json.RawMessage
				SeedID      string
				RevokeGrant Object
			}
			if e := json.Unmarshal(raw, &f); e != nil {
				t.Fatal(e)
			}
			config := owner.Config()
			config.AfterConnect = func(ctx context.Context, c *pgx.Conn) error { _, e := c.Exec(ctx, "SET ROLE galaxy_api"); return e }
			pool, e := pgxpool.NewWithConfig(ctx, config)
			if e != nil {
				t.Fatal(e)
			}
			defer pool.Close()
			now := func() time.Time { return time.Unix(f.Clock, 0) }
			devices := &deviceauth.Service{Pool: pool, Endpoint: f.Endpoint, Now: now}
			cs := &cases.Service{Pool: pool, Endpoint: f.Endpoint, Devices: devices, Now: now}
			rs := &verificationrecords.Service{Pool: pool, Endpoint: f.Endpoint, Devices: devices, Cases: cs, Now: now}
			proofs := &evidence.ProofService{Evidence: &evidence.Service{Pool: pool, Endpoint: f.Endpoint, Devices: devices, Now: now}, CaseContext: cs.ProofCaseContextWithin}
			hs := &historyv2.Service{Pool: pool, Endpoint: f.Endpoint, Devices: devices, Cases: cs, Records: rs, Proofs: proofs, Profiles: &profiles.Service{Pool: pool, Endpoint: f.Endpoint, Devices: devices, Now: now}, Now: now}
			pins := map[string]deviceauth.Pin{}
			for _, entry := range f.Pins {
				var pair []json.RawMessage
				_ = json.Unmarshal(entry, &pair)
				var id string
				_ = json.Unmarshal(pair[0], &id)
				var p struct {
					PublicKeyPem        string
					NotBefore, NotAfter int64
					Revoked             bool
				}
				_ = json.Unmarshal(pair[1], &p)
				pins[id] = deviceauth.Pin{PublicKeyPEM: p.PublicKeyPem, NotBefore: p.NotBefore, NotAfter: p.NotAfter, Revoked: p.Revoked}
			}
			ci := &civ2.Service{Pool: pool, Endpoint: f.Endpoint, Devices: devices, Records: rs, Now: now, Signer: &deviceauth.SessionKeyring{Endpoint: f.Endpoint, KID: "go-fixture", Key: key, Pins: func() map[string]deviceauth.Pin { return pins }}}
			s := &Service{Pool: pool, Devices: devices, History: hs, CI: ci, Now: now}
			scope := "history"
			if domain == "civ2" {
				scope = "proof"
			}
			actor, e := devices.Authenticate(ctx, f.Owner.Token, scope)
			if e != nil {
				t.Fatal(e)
			}
			compare := func(queries []Object) []Object {
				t.Helper()
				want := list(node(t, dsn, "searchv2", "read", path, queries)["results"])
				out := []Object{}
				for i, q := range queries {
					var a *deviceauth.Actor
					if q["actor"] == true {
						a = &actor
					}
					var got Object
					var e error
					if q["kind"] == "reference" {
						got, e = s.Reference(ctx, a, encode(q["input"]))
					} else {
						got, e = s.Query(ctx, a, encode(q["input"]))
					}
					expected := obj(want[i])
					if e != nil {
						if fault.Code(e) != expected["error"] || float64(fault.Status(e)) != expected["status"] {
							t.Fatalf("query%d Go=%v JS=%v", i, e, expected)
						}
						out = append(out, nil)
						continue
					}
					if expected["error"] != nil {
						t.Fatalf("query%d unexpected success JS=%v", i, expected)
					}
					same(t, got, expected["value"])
					out = append(out, got)
				}
				return out
			}
			kind := "history"
			if domain == "civ2" {
				kind = "proof"
			}
			input := Object{"type": kind, "query": Object{"limit": 1}}
			pages := compare([]Object{{"kind": "query", "input": input}, {"kind": "query", "input": input, "actor": true}})
			page := pages[0]
			if len(list(page["items"])) == 0 {
				t.Fatal("expected real visible source")
			}
			first := obj(list(page["items"])[0])
			ref := Object{"search": input, "ref": first["ref"]}
			compare([]Object{{"kind": "reference", "input": ref}})
			if domain == "historyv2" {
				compare([]Object{{"kind": "query", "input": Object{"type": "case", "query": Object{"query": "facts", "limit": 20}}}, {"kind": "query", "input": Object{"type": "history", "query": Object{"subjectId": f.Owner.Subject, "limit": 2}}}})
				if next := page["nextCursor"]; next != nil {
					compare([]Object{{"kind": "query", "input": Object{"type": "history", "query": Object{"limit": 1, "after": next}}}})
				}
				if _, e = cs.SubmitV2(ctx, actor, encode(f.Cases[0].HiddenGrant), ""); e != nil {
					t.Fatal(e)
				}
				compare([]Object{{"kind": "query", "input": input}, {"kind": "reference", "input": ref}})
				if _, e = cs.SubmitV2(ctx, actor, encode(f.Cases[0].CorrectionGrant), ""); e != nil {
					t.Fatal(e)
				}
				compare([]Object{{"kind": "query", "input": input}, {"kind": "reference", "input": ref}})
			} else {
				compare([]Object{{"kind": "query", "input": Object{"type": "proof", "query": Object{"query": "fixture success", "conclusion": "success"}}}})
				if _, e = rs.Submit(ctx, actor, encode(f.RevokeGrant), ""); e != nil {
					t.Fatal(e)
				}
				compare([]Object{{"kind": "query", "input": input}, {"kind": "reference", "input": ref}})
			}
			h := Handler{Service: s, Devices: devices}
			r := httptest.NewRequest("POST", "/v2/search/query", bytes.NewReader(encode(input)))
			r.Header.Set("Content-Type", "application/json")
			r.Header.Set("Authorization", "Bearer "+f.Owner.Token)
			w := httptest.NewRecorder()
			h.ServeHTTP(w, r)
			if w.Code != 200 {
				t.Fatalf("HTTP %d %s", w.Code, w.Body.String())
			}
			if _, e = s.Query(ctx, nil, encode(Object{"type": "capsule", "query": Object{}})); fault.Status(e) != 503 {
				t.Fatalf("missing real capsule consumer=%v", e)
			}
		})
	}
}
