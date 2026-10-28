package profiles_test

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/agigalaxy-team/agigalaxy/go/internal/accountsocial"
	"github.com/agigalaxy-team/agigalaxy/go/internal/deviceauth"
	"github.com/agigalaxy-team/agigalaxy/go/internal/identity"
	"github.com/agigalaxy-team/agigalaxy/go/internal/postgres"
	"github.com/agigalaxy-team/agigalaxy/go/internal/profiles"
	"github.com/agigalaxy-team/agigalaxy/go/internal/testsupport"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

type Object = map[string]any

func encode(v any) []byte { b, _ := json.Marshal(v); return b }
func normal(v any) any    { var o any; _ = json.Unmarshal(encode(v), &o); return o }
func same(t *testing.T, a, b any) {
	t.Helper()
	if !reflect.DeepEqual(normal(a), normal(b)) {
		t.Fatalf("profile JS/Go mismatch\nGo=%s\nJS=%s", encode(a), encode(b))
	}
}
func node(t *testing.T, dsn, mode, path string, at int64, stdin []byte) Object {
	t.Helper()
	root, _ := filepath.Abs(filepath.Join("..", "..", ".."))
	cmd := exec.Command("node", filepath.Join(root, "go/internal/profiles/testdata/interop.mjs"), mode, path, strconv.FormatInt(at, 10))
	cmd.Dir = root
	cmd.Env = append(os.Environ(), "GALAXY_GO_TEST_DATABASE_URL="+dsn)
	cmd.Stdin = bytes.NewReader(stdin)
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	out, e := cmd.Output()
	if e != nil {
		t.Fatalf("original profile %s %v %s", mode, e, stderr.String())
	}
	lines := bytes.Split(bytes.TrimSpace(out), []byte("\n"))
	for i := len(lines) - 1; i >= 0; i-- {
		var o Object
		if json.Unmarshal(lines[i], &o) == nil && o != nil {
			return o
		}
	}
	t.Fatal("invalid profile fixture result")
	return nil
}

type actorFixture struct{ Subject, Token, Binding, DeviceID string }

func TestOriginalSignedProfilesHTTPDurableSharingAndBookmarks(t *testing.T) {
	owner, dsn := testsupport.PostgreSQL(t)
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "profile-fixture.json")
	node(t, dsn, "setup", path, 2000000000, nil)
	raw, _ := os.ReadFile(path)
	var f struct {
		Endpoint                                                                                                                 string
		Clock                                                                                                                    int64
		Owner, Viewer, Durable, Legacy                                                                                           actorFixture
		Seed, SeedGrant, SeedReceipt, PrivateStatement, PrivateGrant, Finite, FiniteGrant, StaleGrant, DurableGrant, LegacyGrant Object
	}
	if json.Unmarshal(raw, &f) != nil {
		t.Fatal("fixture metadata")
	}
	now := time.Unix(f.Clock, 0)
	config := owner.Config()
	config.AfterConnect = func(ctx context.Context, c *pgx.Conn) error { _, e := c.Exec(ctx, "SET ROLE galaxy_api"); return e }
	pool, e := pgxpool.NewWithConfig(ctx, config)
	if e != nil {
		t.Fatal(e)
	}
	defer pool.Close()
	devices := &deviceauth.Service{Pool: pool, Endpoint: f.Endpoint, Now: func() time.Time { return now }}
	s := &profiles.Service{Pool: pool, Endpoint: f.Endpoint, Devices: devices, Now: func() time.Time { return now }}
	main, e := devices.Authenticate(ctx, f.Owner.Token, "history")
	if e != nil {
		t.Fatal(e)
	}
	viewer, e := devices.Authenticate(ctx, f.Viewer.Token, "history")
	if e != nil {
		t.Fatal(e)
	}
	read := func(a *deviceauth.Actor, subject string) Object {
		t.Helper()
		v, e := postgres.InTx(ctx, pool, func(tx pgx.Tx) (Object, error) { return s.ReadWithin(ctx, tx, a, subject) })
		if e != nil {
			t.Fatal(e)
		}
		return v
	}
	original := node(t, dsn, "views", path, f.Clock, nil)
	same(t, read(nil, f.Owner.Subject), original["public"])
	same(t, read(nil, f.Durable.Subject), original["durable"])
	handler := profiles.Handler{Service: s, Devices: devices}
	call := func(path string, input any, credential string, want int) Object {
		t.Helper()
		r := httptest.NewRequest("POST", path, bytes.NewReader(encode(input)))
		r.Header.Set("Content-Type", "application/json")
		if credential != "" {
			r.Header.Set("Authorization", "Bearer "+credential)
		}
		w := httptest.NewRecorder()
		handler.ServeHTTP(w, r)
		if w.Code != want {
			t.Fatalf("profile %s got %d want %d %s", path, w.Code, want, w.Body.String())
		}
		var o Object
		_ = json.Unmarshal(w.Body.Bytes(), &o)
		return o
	}
	same(t, call("/v1/profiles/statements", f.SeedGrant, f.Owner.Token, 200), f.SeedReceipt)
	var auditBefore int
	if e = owner.QueryRow(ctx, `SELECT count(*) FROM audit_events WHERE actor=$1 AND action='profile.publish'`, f.Owner.Subject).Scan(&auditBefore); e != nil || auditBefore != 1 {
		t.Fatal("replay duplicated original audit")
	}
	// Commit succeeds but its response is discarded. The original statement UUID
	// and raw payload digest establish the outcome without another publication.
	call("/v1/profiles/statements", f.PrivateGrant, f.Owner.Token, 200)
	privateID := f.PrivateStatement["id"].(string)
	hash := identity.Digest([]byte(f.PrivateGrant["payloadJson"].(string)))
	ack := call("/v1/profiles/statements/receipt", Object{"operationId": privateID, "payloadHash": hash}, f.Owner.Token, 200)
	if ack["state"] != "acknowledged" || ack["revision"] != float64(2) {
		t.Fatal("original profile receipt")
	}
	foreign := call("/v1/profiles/statements/receipt", Object{"operationId": privateID, "payloadHash": hash}, f.Viewer.Token, 200)
	if foreign["state"] != "absent" {
		t.Fatal("foreign receipt disclosed statement")
	}
	conflict := call("/v1/profiles/statements/receipt", Object{"operationId": privateID, "payloadHash": strings.Repeat("0", 64)}, f.Owner.Token, 200)
	if conflict["state"] != "conflict" {
		t.Fatal("hash conflict rewritten")
	}
	original = node(t, dsn, "views", path, f.Clock, nil)
	same(t, read(nil, f.Owner.Subject), original["public"])
	same(t, read(&viewer, f.Owner.Subject), original["selected"])
	call("/v1/profiles/statements", f.StaleGrant, f.Owner.Token, 409)
	// The account-social consumer reads the actual ID declaration owner service;
	// there is no substitute account profile or metadata-only source success.
	social := &accountsocial.Service{Pool: pool, Endpoint: f.Endpoint, Devices: devices, Profiles: accountsocial.ProfileSource(s), Now: func() time.Time { return now }}
	bookmark := Object{"operationId": uuid.NewString(), "reference": Object{"kind": "person", "subjectId": f.Owner.Subject}, "saved": true, "expectedRevision": 0}
	if _, e = social.Bookmark(ctx, accountsocial.Actor{Device: viewer}, false, "command", encode(bookmark)); e != nil {
		t.Fatal(e)
	}
	page, e := social.Bookmark(ctx, accountsocial.Actor{Device: viewer}, false, "query", []byte(`{}`))
	if e != nil {
		t.Fatal(e)
	}
	source := page["items"].([]Object)[0]["source"].(Object)
	if source["state"] != "available" || source["title"] != "Selected private ID" || source["availableUntil"] != float64(f.Clock+15) {
		t.Fatal("profile source consumer authority/deadline")
	}
	if _, e = devices.RevokeConsent(ctx, main, f.PrivateGrant["consentId"].(string), nil); e != nil {
		t.Fatal(e)
	}
	if len(read(&viewer, f.Owner.Subject)["selfDeclared"].(Object)) != 0 {
		t.Fatal("revoked source fell back to old public declaration")
	}
	current := call("/v1/profiles/current", Object{}, f.Owner.Token, 200)
	if current["readable"] != true || current["selfDeclared"].(Object)["displayName"] != "Selected private ID" || current["sharing"].(Object)["status"] != "revoked" {
		t.Fatal("current owner lost editable original")
	}
	page, e = social.Bookmark(ctx, accountsocial.Actor{Device: viewer}, false, "query", []byte(`{}`))
	if e != nil || page["items"].([]Object)[0]["source"].(Object)["state"] != "unavailable" {
		t.Fatal("bookmark revived withdrawn ID introduction")
	}
	call("/v1/profiles/statements", f.FiniteGrant, f.Owner.Token, 200)
	now = time.Unix(f.Clock+121, 0)
	if len(read(nil, f.Owner.Subject)["selfDeclared"].(Object)) != 0 {
		t.Fatal("finite replacement did not expire")
	}
	current = call("/v1/profiles/current", Object{}, f.Owner.Token, 200)
	if current["sharing"].(Object)["status"] != "expired" {
		t.Fatal("owner finite sharing state")
	}
	now = time.Unix(f.Clock, 0)
	// Natural authorization expiry does not revoke explicitly continuous sharing.
	if _, e = owner.Exec(ctx, `UPDATE bindings SET expires_at=$2 WHERE subject_id IN ($1,$3)`, f.Durable.Subject, now.Add(-time.Second), f.Legacy.Subject); e != nil {
		t.Fatal(e)
	}
	if _, e = owner.Exec(ctx, `UPDATE consents SET expires_at=$2 WHERE subject_id IN ($1,$3)`, f.Durable.Subject, now.Add(-time.Second), f.Legacy.Subject); e != nil {
		t.Fatal(e)
	}
	now = time.Unix(f.Clock+31*86400, 0)
	original = node(t, dsn, "sources", path, now.Unix(), nil)
	same(t, read(nil, f.Durable.Subject), original["durable"])
	same(t, read(nil, f.Legacy.Subject), original["legacy"])
	if len(read(nil, f.Durable.Subject)["selfDeclared"].(Object)) == 0 || len(read(nil, f.Legacy.Subject)["selfDeclared"].(Object)) != 0 {
		t.Fatal("durable/legacy expiry conflated")
	}
	// Even with matching signature_hash metadata, a damaged original Ed25519
	// envelope cannot establish durable public reading.
	var envelope string
	if e = owner.QueryRow(ctx, `SELECT signature_envelope FROM consents WHERE id=$1`, f.DurableGrant["consentId"]).Scan(&envelope); e != nil {
		t.Fatal(e)
	}
	parts := strings.Split(envelope, ".")
	sig, _ := base64.RawURLEncoding.DecodeString(parts[2])
	sig[0] ^= 1
	parts[2] = base64.RawURLEncoding.EncodeToString(sig)
	bad := strings.Join(parts, ".")
	if _, e = owner.Exec(ctx, `UPDATE consents SET signature_envelope=$2,signature_hash=$3 WHERE id=$1`, f.DurableGrant["consentId"], bad, identity.Digest([]byte(bad))); e != nil {
		t.Fatal(e)
	}
	if len(read(nil, f.Durable.Subject)["selfDeclared"].(Object)) != 0 {
		t.Fatal("metadata substituted for signature verification")
	}
	if _, e = owner.Exec(ctx, `UPDATE consents SET signature_envelope=$2,signature_hash=$3 WHERE id=$1`, f.DurableGrant["consentId"], envelope, identity.Digest([]byte(envelope))); e != nil {
		t.Fatal(e)
	}
	if len(read(nil, f.Durable.Subject)["selfDeclared"].(Object)) == 0 {
		t.Fatal("original valid signature did not restore the fixture")
	}
	if _, e = owner.Exec(ctx, `UPDATE device_authorizations SET scopes='["binding","history"]'::jsonb WHERE subject_id=$1 AND device_id=$2`, f.Durable.Subject, f.Durable.DeviceID); e != nil {
		t.Fatal(e)
	}
	if len(read(nil, f.Durable.Subject)["selfDeclared"].(Object)) != 0 {
		t.Fatal("removed source consent scope remained readable")
	}
	if _, e = owner.Exec(ctx, `UPDATE device_authorizations SET scopes='["manage-identity","binding","consent","history","data-export"]'::jsonb WHERE subject_id=$1 AND device_id=$2`, f.Durable.Subject, f.Durable.DeviceID); e != nil {
		t.Fatal(e)
	}
	if len(read(nil, f.Durable.Subject)["selfDeclared"].(Object)) == 0 {
		t.Fatal("original device scopes did not restore the fixture")
	}
	if _, e = owner.Exec(ctx, `UPDATE subject_control_heads SET epoch=2 WHERE subject_id=$1`, f.Durable.Subject); e != nil {
		t.Fatal(e)
	}
	if len(read(nil, f.Durable.Subject)["selfDeclared"].(Object)) != 0 {
		t.Fatal("old epoch kept declaration readable")
	}
	if _, e = owner.Exec(ctx, `UPDATE subject_control_heads SET epoch=1 WHERE subject_id=$1`, f.Durable.Subject); e != nil {
		t.Fatal(e)
	}
	if len(read(nil, f.Durable.Subject)["selfDeclared"].(Object)) == 0 {
		t.Fatal("original control epoch did not restore the fixture")
	}
	if _, e = owner.Exec(ctx, `UPDATE bindings SET revoked_at=$2 WHERE id=$1`, f.Durable.Binding, now); e != nil {
		t.Fatal(e)
	}
	if len(read(nil, f.Durable.Subject)["selfDeclared"].(Object)) != 0 {
		t.Fatal("explicit binding revoke ignored")
	}
	now = time.Unix(f.Clock, 0)
	// Lifecycle export retains the owner's exact original bytes and versions,
	// independent of current public sharing, then explicit ID erasure removes it.
	exported, e := postgres.InTx(ctx, pool, func(tx pgx.Tx) ([]Object, error) {
		return profiles.ExportSubjectWithin(ctx, tx, f.Owner.Subject, "", now.Add(24*time.Hour), 20)
	})
	if e != nil || len(exported) != 3 {
		t.Fatalf("profile own-data export %v", e)
	}
	if _, e = postgres.InTx(ctx, owner, func(tx pgx.Tx) (Object, error) { return profiles.DeleteSubjectWithin(ctx, tx, f.Owner.Subject, 20) }); e != nil {
		t.Fatal(e)
	}
	if len(read(nil, f.Owner.Subject)["selfDeclared"].(Object)) != 0 {
		t.Fatal("erased profile source still displayed")
	}
	call("/v1/profiles/statements", f.SeedGrant, "", 401)
	call("/v1/profiles/current", Object{"unexpected": true}, "", 400)
	r := httptest.NewRequest("GET", "/v1/profiles/"+f.Owner.Subject, nil)
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, r)
	if w.Code != 503 {
		t.Fatal("missing history consumer returned partial successful profile")
	}
}

func TestOriginalProfileSchemaNormalization(t *testing.T) {
	path := filepath.Join(t.TempDir(), "profile-fixture.json")
	dsn := "postgres://unused@127.0.0.1:1/galaxy_go_test_schema"
	seed := Object{"id": uuid.NewString(), "expectedRevision": 0, "selfDeclared": Object{"displayName": "\ufeff  Declared name \ufeff", "about": "\t Original claim \n", "claimedCapabilities": []string{"  Unverified claim "}, "projects": []any{Object{"id": uuid.NewString(), "kind": "project", "title": " Plain project ", "summary": " Not discovered automatically "}}}, "sharing": Object{"visibility": "Public", "viewers": []string{}, "expiresAt": nil}}
	clone := func() Object { return normal(seed).(Object) }
	cases := []Object{seed}
	p := clone()
	p["selfDeclared"].(Object)["capabilityVerified"] = true
	cases = append(cases, p)
	p = clone()
	p["sharing"].(Object)["viewers"] = []string{"GUID" + strings.Repeat("A", 28)}
	cases = append(cases, p)
	p = clone()
	p["selfDeclared"].(Object)["projects"].([]any)[0].(Object)["discoverable"] = true
	cases = append(cases, p)
	p = clone()
	p["selfDeclared"].(Object)["projects"].([]any)[0].(Object)["sourceUrl"] = "https://source.example.invalid/project"
	cases = append(cases, p)
	expected := node(t, dsn, "schema", path, 0, encode(cases))["checks"].([]any)
	for i, input := range cases {
		parsed, e := profiles.ParseStatement(encode(input))
		want := expected[i].(Object)
		if (e == nil) != want["accepted"] {
			t.Fatalf("schema mismatch %d %v", i, e)
		}
		if e == nil {
			value := Object{"id": parsed.ID, "expectedRevision": parsed.ExpectedRevision, "selfDeclared": parsed.SelfDeclared}
			if parsed.Sharing != nil {
				value["sharing"] = parsed.Sharing
			}
			same(t, value, want["value"])
		}
	}
}
