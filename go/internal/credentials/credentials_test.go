package credentials

import (
	"context"
	"encoding/json"
	"errors"
	"net/netip"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/postgres"
	"github.com/agigalaxy-team/agigalaxy/go/internal/testsupport"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

type signedFixture struct {
	Endpoint      string
	Configuration Configuration
	Account       struct {
		ID string `json:"id"`
	}
	OwnedID   string
	Tokens    map[string]string
	Documents map[string]Object
	Checks    map[string]struct {
		Metadata Object
		Error    string
	}
}

func fixtureNode(t *testing.T, dsn, mode, path string, at int64) Object {
	t.Helper()
	root, e := filepath.Abs(filepath.Join("..", "..", ".."))
	if e != nil {
		t.Fatal(e)
	}
	cmd := exec.Command("node", filepath.Join(root, "go", "internal", "credentials", "testdata", "interop.mjs"), mode, path, strconv.FormatInt(at, 10))
	cmd.Dir = root
	cmd.Env = append(os.Environ(), "GALAXY_GO_TEST_DATABASE_URL="+dsn)
	out, e := cmd.Output()
	if e != nil {
		detail := ""
		if exit, ok := e.(*exec.ExitError); ok {
			detail = string(exit.Stderr)
		}
		t.Fatalf("original credential fixture failed: %v %s", e, detail)
	}
	var result Object
	if json.Unmarshal(out, &result) != nil {
		t.Fatal("invalid original credential fixture output")
	}
	return result
}
func encoded(t *testing.T, v any) []byte {
	t.Helper()
	b, e := json.Marshal(v)
	if e != nil {
		t.Fatal(e)
	}
	return b
}
func expect(t *testing.T, e error, code string) {
	t.Helper()
	if fault.Code(e) != code {
		t.Fatalf("want %s: %v", code, e)
	}
}
func TestOriginalSignedCredentialVerificationAndPGViews(t *testing.T) {
	owner, dsn := testsupport.PostgreSQL(t)
	ctx, cancel := context.WithTimeout(context.Background(), 100*time.Second)
	defer cancel()
	path := filepath.Join(t.TempDir(), "credential-fixture.json")
	setup := fixtureNode(t, dsn, "setup", path, 2000000000)
	raw, e := os.ReadFile(path)
	if e != nil {
		t.Fatal(e)
	}
	var f signedFixture
	if json.Unmarshal(raw, &f) != nil {
		t.Fatal("invalid signed fixture")
	}
	now := time.Unix(2000000000, 0)
	var mu sync.Mutex
	fetches := 0
	unavailable := false
	document := "current"
	fetch := func(_ context.Context, address string) (Object, error) {
		mu.Lock()
		defer mu.Unlock()
		fetches++
		if address != "https://credential-source.example.invalid/status" {
			t.Fatal("submitted data selected a network destination")
		}
		if unavailable {
			return nil, errors.New("controlled offline status source")
		}
		return f.Documents[document], nil
	}
	service, e := New(f.Endpoint, f.Configuration, func() time.Time { return now }, fetch, nil)
	if e != nil {
		t.Fatal(e)
	}
	// Real Node signatures exercise every configured algorithm and both VC
	// formats, including negative tokens; no synthetic successful verification.
	for name, token := range f.Tokens {
		t.Run(name, func(t *testing.T) {
			metadata, e := service.Verify(token)
			expected := f.Checks[name]
			if expected.Error != "" {
				expect(t, e, expected.Error)
			} else if e != nil || !reflect.DeepEqual(normalized(metadata), expected.Metadata) {
				t.Fatalf("original signed metadata differs for %s: %v", name, e)
			}
		})
	}
	config, e := pgxpool.ParseConfig(dsn)
	if e != nil {
		t.Fatal(e)
	}
	config.AfterConnect = func(ctx context.Context, conn *pgx.Conn) error {
		_, e := conn.Exec(ctx, "SET ROLE galaxy_api")
		return e
	}
	pool, e := pgxpool.NewWithConfig(ctx, config)
	if e != nil {
		t.Fatal(e)
	}
	defer pool.Close()
	account := f.Account.ID
	get, e := postgres.InTx(ctx, pool, func(tx pgx.Tx) (Object, error) { return service.GetWithin(ctx, tx, account, f.OwnedID) })
	if e != nil || !reflect.DeepEqual(normalized(get["credential"]), setup["owned"]) {
		t.Fatalf("JS→Go credential view differs: %v", e)
	}
	if fetches != 0 {
		t.Fatal("read-only projection fetched an issuer")
	}
	eligible, e := postgres.InTx(ctx, pool, func(tx pgx.Tx) (bool, error) {
		return service.HasConditionWithin(ctx, tx, account, "source", "publish")
	})
	if e != nil || !eligible {
		t.Fatalf("verified bound current condition %v %v", eligible, e)
	}
	replay, e := postgres.InTx(ctx, pool, func(tx pgx.Tx) (Object, error) {
		return service.ImportWithin(ctx, tx, account, encoded(t, Object{"credential": f.Tokens["owned"]}))
	})
	if e != nil || replay["id"] != f.OwnedID {
		t.Fatalf("original JWS replay replaced ID %v", e)
	}
	var vc2ID string
	for _, name := range []string{"expired", "foreign", "otherAccount", "external", "vc2"} {
		imported, importErr := postgres.InTx(ctx, pool, func(tx pgx.Tx) (Object, error) {
			return service.ImportWithin(ctx, tx, account, encoded(t, Object{"credential": f.Tokens[name]}))
		})
		if importErr != nil {
			t.Fatalf("Go import %s: %v", name, importErr)
		}
		if name == "vc2" {
			vc2ID = imported["id"].(string)
		}
	}
	// Stored metadata is not proof of validity. Damage only the original JWS
	// signature while leaving its formerly valid SQL metadata intact.
	parts := strings.Split(f.Tokens["vc2"], ".")
	replacement := "A"
	if strings.HasPrefix(parts[2], replacement) {
		replacement = "B"
	}
	parts[2] = replacement + parts[2][1:]
	if _, e = owner.Exec(ctx, "UPDATE account_external_credentials_v1 SET credential_jws=$2 WHERE id=$1", vc2ID, strings.Join(parts, ".")); e != nil {
		t.Fatal(e)
	}
	invalidView, e := postgres.InTx(ctx, pool, func(tx pgx.Tx) (Object, error) { return service.GetWithin(ctx, tx, account, vc2ID) })
	if e != nil || invalidView["credential"].(Object)["signature"].(Object)["state"] != "invalid" || invalidView["credential"].(Object)["eligibility"].(Object)["usable"] != false {
		t.Fatal("stored metadata faked successful verification")
	}
	if _, e = owner.Exec(ctx, "UPDATE official_account_profiles_v1 SET query_enabled=true,query_external_credentials=true WHERE account_id=$1", account); e != nil {
		t.Fatal(e)
	}
	page, e := postgres.InTx(ctx, pool, func(tx pgx.Tx) (Object, error) {
		return service.PublicForAccountWithin(ctx, tx, account, []byte(`{"limit":50}`))
	})
	if e != nil {
		t.Fatal(e)
	}
	reference := fixtureNode(t, dsn, "read", path, now.Unix())
	if !reflect.DeepEqual(normalized(page), reference["public"]) {
		t.Fatalf("Go→JS public credential metadata differs")
	}
	listed, e := postgres.InTx(ctx, pool, func(tx pgx.Tx) (Object, error) { return service.ListWithin(ctx, tx, account, []byte(`{}`)) })
	if e != nil || !reflect.DeepEqual(normalized(listed), reference["list"]) {
		t.Fatalf("Go→JS owner list differs %v", e)
	}
	items := page["items"].([]Object)
	if len(items) != 4 {
		t.Fatalf("foreign holder material became public: %d items", len(items))
	}
	serialized := string(encoded(t, page))
	for _, hidden := range []string{"credential_jws", "issuerClaims", "privateStatement", "Controlled private issuer claim", `"vc"`, `"eligibility"`, `"signingKey"`} {
		if strings.Contains(serialized, hidden) {
			t.Fatalf("private credential field exposed: %s", hidden)
		}
	}
	// Cursor remains a position among selected source rows, independently of
	// how many current bindings survive projection filtering.
	seen := map[string]bool{}
	cursor := ""
	for {
		request := Object{"limit": 1}
		if cursor != "" {
			request["after"] = cursor
		}
		part, e := postgres.InTx(ctx, pool, func(tx pgx.Tx) (Object, error) {
			return service.PublicForAccountWithin(ctx, tx, account, encoded(t, request))
		})
		if e != nil {
			t.Fatal(e)
		}
		for _, item := range part["items"].([]Object) {
			id := item["id"].(string)
			if seen[id] {
				t.Fatal("duplicate public cursor item")
			}
			seen[id] = true
		}
		if part["nextAfter"] == nil {
			break
		}
		cursor = part["nextAfter"].(string)
	}
	if len(seen) != 4 {
		t.Fatalf("public keyset pagination lost items: %d", len(seen))
	}
	now = now.Add(301 * time.Second)
	stale, e := postgres.InTx(ctx, pool, func(tx pgx.Tx) (Object, error) { return service.GetWithin(ctx, tx, account, f.OwnedID) })
	if e != nil || stale["credential"].(Object)["revocation"].(Object)["state"] != "unknown" {
		t.Fatalf("stale proof falsely current %v", e)
	}
	eligible, e = postgres.InTx(ctx, pool, func(tx pgx.Tx) (bool, error) {
		return service.HasConditionWithin(ctx, tx, account, "source", "publish")
	})
	if e != nil || eligible {
		t.Fatal("stale proof granted condition")
	}
	document = "revoked"
	rechecked, e := postgres.InTx(ctx, pool, func(tx pgx.Tx) (Object, error) { return service.RecheckWithin(ctx, tx, account, f.OwnedID) })
	if e != nil || rechecked["revocation"].(Object)["state"] != "revoked" {
		t.Fatalf("signed revocation not applied %v", e)
	}
	reference = fixtureNode(t, dsn, "read", path, now.Unix())
	get, e = postgres.InTx(ctx, pool, func(tx pgx.Tx) (Object, error) { return service.GetWithin(ctx, tx, account, f.OwnedID) })
	if e != nil || !reflect.DeepEqual(normalized(get), reference["owned"]) {
		t.Fatalf("Go signed recheck→JS differs %v", e)
	}
	unavailable = true
	rechecked, e = postgres.InTx(ctx, pool, func(tx pgx.Tx) (Object, error) { return service.RecheckWithin(ctx, tx, account, f.OwnedID) })
	if e != nil || rechecked["revocation"].(Object)["state"] != "unknown" {
		t.Fatal("offline issuer was treated as not-revoked")
	}
	if _, e = postgres.InTx(ctx, pool, func(tx pgx.Tx) (Object, error) { return service.WithdrawWithin(ctx, tx, account, f.OwnedID) }); e != nil {
		t.Fatal(e)
	}
	withdrawn, e := postgres.InTx(ctx, pool, func(tx pgx.Tx) (Object, error) { return service.GetWithin(ctx, tx, account, f.OwnedID) })
	if e != nil || withdrawn["issuerClaims"] != nil {
		t.Fatalf("withdrawal retained owner raw claims %v", e)
	}
	var stored *string
	var hasVC bool
	if e = owner.QueryRow(ctx, "SELECT credential_jws,metadata?'vc' FROM account_external_credentials_v1 WHERE id=$1", f.OwnedID).Scan(&stored, &hasVC); e != nil || stored != nil || hasVC {
		t.Fatalf("withdrawal did not erase JWS/VC %v", e)
	}
	if _, e = owner.Exec(ctx, "UPDATE official_account_profiles_v1 SET query_external_credentials=false WHERE account_id=$1", account); e != nil {
		t.Fatal(e)
	}
	_, e = postgres.InTx(ctx, pool, func(tx pgx.Tx) (Object, error) { return service.PublicForAccountWithin(ctx, tx, account, []byte(`{}`)) })
	expect(t, e, "not_found")
}
func TestCredentialConfigAndNetworkBoundary(t *testing.T) {
	file := filepath.Join(t.TempDir(), "issuer-config.json")
	if e := os.WriteFile(file, []byte(`{"version":1,"issuers":[]}`), 0600); e != nil {
		t.Fatal(e)
	}
	if c, e := LoadConfiguration(file); e != nil || c.Version != 1 || len(c.Issuers) != 0 {
		t.Fatal("explicit public issuer config not loaded", e)
	}
	if _, e := LoadConfiguration("relative.json"); e == nil {
		t.Fatal("relative issuer config accepted")
	}
	if c, e := LoadConfiguration(""); e != nil || len(c.Issuers) != 0 {
		t.Fatal("missing path discovered or activated issuers")
	}
	for _, address := range []string{"http://issuer.example/status", "https://127.0.0.1/status", "https://[::1]/status", "https://169.254.169.254/status", "https://host.local/status", "https://issuer.example:8443/status", "https://issuer.example/status?url=other", "https://u:p@issuer.example/status"} {
		if publicURL(address) {
			t.Fatalf("unsafe fixed endpoint accepted %s", address)
		}
	}
	if !publicURL("https://issuer.example.invalid/status") {
		t.Fatal("fixed public HTTPS endpoint rejected")
	}
	for _, raw := range []string{`{"version":1,"issuers":null}`, `{"version":1,"issuers":[],"unknown":true}`} {
		if _, e := ParseConfiguration([]byte(raw)); e == nil {
			t.Fatal("invalid issuer configuration accepted")
		}
	}
	badNumeric := `{"version":1,"issuers":[{"id":"s","name":"s","issuer":"https://issuer.example.invalid","keys":[{"kty":"OKP","kid":"k"}],"conditions":[{"id":"c","label":"c","type":"c","claim":{"path":"/credentialSubject/value","equals":1e999}}]}]}`
	if _, e := ParseConfiguration([]byte(badNumeric)); e == nil {
		t.Fatal("nonfinite condition value could equate to a missing claim")
	}
}

func TestOriginalDateAndPublicAddressClassification(t *testing.T) {
	root, e := filepath.Abs(filepath.Join("..", "..", ".."))
	if e != nil {
		t.Fatal(e)
	}
	dates := []string{"2023-02-29T00:00:00Z", "2023-02-31T00:00:00Z", "2023-04-31T24:00:00Z", "2023-01-00T00:00:00Z", "9999-12-31T24:00:00Z", "0000-01-01T00:00:00+01:00"}
	addresses := []string{"8.8.8.8", "127.0.0.1", "10.1.2.3", "192.175.48.1", "192.31.196.1", "192.52.193.1", "192.88.99.1", "2606:4700:4700::1111", "::2", "::ffff:8.8.8.8", "64:ff9b::808:808", "2001:3::1", "2620:4f:8000::1", "3fff::1", "5f00::1"}
	input := encoded(t, Object{"dates": dates, "addresses": addresses})
	script := `import {isPublicAddress} from './packages/galaxy-official/src/infrastructure/public-fetch.mjs';let raw='';for await(const b of process.stdin)raw+=b;const x=JSON.parse(raw);console.log(JSON.stringify({dates:x.dates.map(s=>{const t=Date.parse(s);return Number.isFinite(t)?new Date(Math.floor(t/1000)*1000).toISOString():null}),addresses:x.addresses.map(isPublicAddress)}))`
	cmd := exec.Command("node", "--input-type=module", "-e", script)
	cmd.Dir = root
	cmd.Stdin = strings.NewReader(string(input))
	out, e := cmd.Output()
	if e != nil {
		t.Fatal("original scalar classification failed", e)
	}
	var expected struct {
		Dates     []*string
		Addresses []bool
	}
	if json.Unmarshal(out, &expected) != nil {
		t.Fatal("invalid original scalar output")
	}
	for index, value := range dates {
		seconds, e := dateField(Object{"value": value}, "value")
		if expected.Dates[index] == nil {
			if e == nil {
				t.Fatalf("invalid original ISO date accepted %s", value)
			}
		} else if e != nil || seconds == nil || iso(time.Unix(*seconds, 0)) != *expected.Dates[index] {
			t.Fatalf("original date normalization differs %s %v", value, e)
		}
	}
	for index, value := range addresses {
		if publicAddress(netip.MustParseAddr(value)) != expected.Addresses[index] {
			t.Fatalf("original public address classification differs %s", value)
		}
	}
}
