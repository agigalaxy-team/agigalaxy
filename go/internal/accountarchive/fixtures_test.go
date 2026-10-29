package accountarchive

import (
	"context"
	"encoding/json"
	"os"
	"testing"
	"time"

	"github.com/agigalaxy-team/agigalaxy/go/internal/accountlinks"
	"github.com/agigalaxy-team/agigalaxy/go/internal/accounts"
	"github.com/agigalaxy-team/agigalaxy/go/internal/databaseschema"
	"github.com/agigalaxy-team/agigalaxy/go/internal/deviceauth"
	"github.com/agigalaxy-team/agigalaxy/go/internal/identity"
	"github.com/agigalaxy-team/agigalaxy/go/internal/postgres"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// These identifiers and public key belong only to the fixed, synthetic legacy
// format fixture. Its bearer is a public all-zero test marker; no private key,
// user credential or user database is read.
type archiveFixtureData struct {
	Endpoint, Issuer, AccountID, AccountUID, SubjectID, PublicKey string
	ChallengeID, BindingID, Token, Link                           string
	Put, Archive, JSReceipt                                       Object
}

func archiveFixture(t *testing.T) archiveFixtureData {
	t.Helper()
	raw, err := os.ReadFile("testdata/archive-fixture.json")
	if err != nil {
		t.Fatal(err)
	}
	var fixture archiveFixtureData
	if err = json.Unmarshal(raw, &fixture); err != nil {
		t.Fatal(err)
	}
	return fixture
}

func archiveGolden(t *testing.T, name string) Object {
	t.Helper()
	raw, err := os.ReadFile("testdata/" + name + ".json")
	if err != nil {
		t.Fatal(err)
	}
	var out Object
	if err = json.Unmarshal(raw, &out); err != nil {
		t.Fatal(err)
	}
	return out
}

func setupArchive(t *testing.T, pool *pgxpool.Pool) archiveFixtureData {
	t.Helper()
	f := archiveFixture(t)
	ctx := context.Background()
	if _, err := databaseschema.Migrate(ctx, pool, []string{"api"}); err != nil {
		t.Fatal(err)
	}
	now := time.Unix(2000000000, 0)
	run := func(sql string, args ...any) {
		t.Helper()
		if _, err := pool.Exec(ctx, sql, args...); err != nil {
			t.Fatal(err)
		}
	}
	run(`INSERT INTO subjects(id,public_key,genesis_proof) VALUES($1,$2,'{}')`, f.SubjectID, f.PublicKey)
	run(`INSERT INTO binding_challenges(id,subject_id,payload,token_hash,expires_at) VALUES($1,$2,$3,$4,'2099-01-01')`, f.ChallengeID, f.SubjectID, Object{"installationId": "archive-fixture"}, identity.Digest([]byte("challenge")))
	run(`INSERT INTO bindings(id,subject_id,challenge_id,request_hash,audience,scopes,receipt,expires_at) VALUES($1,$2,$3,'controlled',$4,'["binding"]','controlled','2099-01-01')`, f.BindingID, f.SubjectID, f.ChallengeID, f.Endpoint)
	run(`INSERT INTO access_credentials(token_hash,binding_id,scopes,expires_at) VALUES($1,$2,'["binding"]','2099-01-01')`, identity.Digest([]byte(f.Token)), f.BindingID)
	profile := &accounts.Service{Endpoint: f.Endpoint, Now: func() time.Time { return now }, GenerateID: func() string { return f.AccountID }, GenerateUID: func() (string, error) { return f.AccountUID, nil }}
	if _, err := postgres.InTx(ctx, pool, func(tx pgx.Tx) (bool, error) {
		account, err := profile.EnsureAccountWithin(ctx, tx, accounts.VerifiedIdentity{Issuer: f.Issuer, ExternalSubject: "controlled-archive-account", VerificationMethod: "email", VerifiedAt: now})
		if err != nil {
			return false, err
		}
		subjectType := "person"
		_, err = profile.EnsureProfileWithin(ctx, tx, account.ID, &subjectType)
		return err == nil, err
	}); err != nil {
		t.Fatal(err)
	}
	run(`INSERT INTO external_identity_links(id,subject_id,binding_id,endpoint,provider_id,issuer,external_subject,client_id,payload_text,payload_hash,signature) VALUES($1,$2,$3,$4,'fixture',$5,'controlled-archive-account','archive-fixture','{}',$6,'controlled')`, f.Link, f.SubjectID, f.BindingID, f.Endpoint, f.Issuer, identity.Digest([]byte("{}")))
	run(`INSERT INTO community_account_links(identity_link_id,account_id,subject_id,created_at) VALUES($1,$2,$3,$4)`, f.Link, f.AccountID, f.SubjectID, now)
	devices := &deviceauth.Service{Pool: pool, Endpoint: f.Endpoint, Now: func() time.Time { return now }}
	registry := &accountlinks.Service{Pool: pool, Endpoint: f.Endpoint, Devices: devices, Providers: []accountlinks.Provider{{Issuer: f.Issuer, ClientID: "archive-fixture"}}}
	service := &Service{Pool: pool, Endpoint: f.Endpoint, Devices: devices, Registry: registry, Profiles: profile, Now: func() time.Time { return now }}
	device, err := devices.Authenticate(ctx, f.Token, "binding")
	if err != nil {
		t.Fatal(err)
	}
	actor := Actor{Device: device, AccountID: f.AccountID}
	receipt, err := service.Work(ctx, actor, "put", encoded(f.Put))
	if err != nil {
		t.Fatal(err)
	}
	same(t, receipt, f.JSReceipt)
	if _, err = service.Archive(ctx, actor, "create", encoded(f.Archive)); err != nil {
		t.Fatal(err)
	}
	if _, err = service.Archive(ctx, actor, "chunk", encoded(Object{"id": f.Archive["id"], "sequence": 0, "content": "original JS chunk"})); err != nil {
		t.Fatal(err)
	}
	return f
}
