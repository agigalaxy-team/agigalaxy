package accounts

import (
	"context"
	"encoding/json"
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

func encode(t *testing.T, v any) []byte {
	t.Helper()
	b, e := json.Marshal(v)
	if e != nil {
		t.Fatal(e)
	}
	return b
}
func normalized(t *testing.T, v any) any {
	t.Helper()
	var out any
	if e := json.Unmarshal(encode(t, v), &out); e != nil {
		t.Fatal(e)
	}
	return out
}
func expectCode(t *testing.T, e error, want string) {
	t.Helper()
	if fault.Code(e) != want {
		t.Fatalf("want %s: %v", want, e)
	}
}
func apiPool(t *testing.T, dsn string) *pgxpool.Pool {
	t.Helper()
	config, e := pgxpool.ParseConfig(dsn)
	if e != nil {
		t.Fatal(e)
	}
	config.AfterConnect = func(ctx context.Context, conn *pgx.Conn) error {
		_, e := conn.Exec(ctx, "SET ROLE galaxy_api")
		return e
	}
	pool, e := pgxpool.NewWithConfig(context.Background(), config)
	if e != nil {
		t.Fatal(e)
	}
	t.Cleanup(pool.Close)
	return pool
}

func TestAccountsOriginalJSGoJSAndRegistrationSeparation(t *testing.T) {
	owner, dsn := testsupport.PostgreSQL(t)
	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	defer cancel()
	initializeAccounts(t, owner)
	pool := apiPool(t, dsn)
	now := time.Unix(2000000000, 0)
	s := &Service{Endpoint: fixtureEndpoint, Now: func() time.Time { return now }}
	account0 := createTestAccount(t, pool, s, "existing-go")
	existing := account0.ID
	var e error
	initial := Object{"expectedRevision": 0, "displayName": "原JavaScript资料", "avatarKey": "book", "bio": "原简介", "publicQuery": Object{"enabled": false, "scope": "profile", "showLinkedIds": true}, "archiveRetentionDays": nil}
	if _, e := postgres.InTx(ctx, pool, func(tx pgx.Tx) (Object, error) { return s.UpdateSettingsWithin(ctx, tx, existing, encode(t, initial)) }); e != nil {
		t.Fatal(e)
	}
	if _, e := owner.Exec(ctx, `INSERT INTO private_conversation_archives_v1(id,account_id,title,selection,created_at,updated_at) VALUES('11111111-1111-4111-8111-111111111111',$1,'controlled empty metadata','{"workspaceId":null,"sessionIds":["fixture-only"]}'::jsonb,$2,$2)`, existing, now); e != nil {
		t.Fatal(e)
	}
	if _, e := owner.Exec(ctx, `INSERT INTO operations_operator_principals_v1(operator_id,endpoint,issuer,external_subject,display_name,created_at,updated_at) VALUES('accounts-operator',$1,$2,'accounts-operator','controlled operator',$3,$3)`, fixtureEndpoint, fixtureIssuer, now); e != nil {
		t.Fatal(e)
	}
	update := Object{"expectedRevision": 1, "displayName": nil, "bio": "  Go修改的简介  ", "publicQuery": Object{"enabled": false, "scope": "profile-and-public-posts"}, "archiveRetentionDays": 14}
	if _, e = postgres.InTx(ctx, pool, func(tx pgx.Tx) (Object, error) { return s.UpdateSettingsWithin(ctx, tx, existing, encode(t, update)) }); e != nil {
		t.Fatal(e)
	}
	got, e := postgres.InTx(ctx, pool, func(tx pgx.Tx) (Object, error) { return s.SettingsWithin(ctx, tx, existing) })
	if e != nil || got["bio"] != "Go修改的简介" || got["revision"] != int64(2) {
		t.Fatalf("updated settings: %v %v", got, e)
	}
	if got["avatarKey"].(*string) == nil || *got["avatarKey"].(*string) != "book" || got["publicQuery"].(Object)["showLinkedIds"] != true {
		t.Fatal("omitted normal fields were overwritten")
	}
	var archiveCorrect bool
	if e = owner.QueryRow(ctx, "SELECT expires_at=created_at+interval '14 days' FROM private_conversation_archives_v1 WHERE id='11111111-1111-4111-8111-111111111111'").Scan(&archiveCorrect); e != nil || !archiveCorrect {
		t.Fatalf("retention lost original creation time %v", e)
	}
	change := Object{"expectedRevision": 2, "subjectType": "organization", "reason": "本人说明主体类型发生更正", "basis": "现有组织运营主体的真实声明", "preserveHistory": true}
	if _, e = postgres.InTx(ctx, pool, func(tx pgx.Tx) (Object, error) {
		return s.ChangeTypeWithin(ctx, tx, existing, encode(t, change), TypeSource{Kind: "account-owner", AccountID: existing}, nil)
	}); e != nil {
		t.Fatal(e)
	}
	secondChange := Object{"expectedRevision": 3, "subjectType": "agent", "reason": "本人提供下一次真实类型更正", "basis": "受控检查不代表能力认证", "preserveHistory": true}
	if _, e = postgres.InTx(ctx, pool, func(tx pgx.Tx) (Object, error) {
		return s.ChangeTypeWithin(ctx, tx, existing, encode(t, secondChange), TypeSource{Kind: "account-owner", AccountID: existing}, nil)
	}); e != nil {
		t.Fatal(e)
	}
	got, e = postgres.InTx(ctx, pool, func(tx pgx.Tx) (Object, error) { return s.SettingsWithin(ctx, tx, existing) })
	if e != nil || got["subjectType"].(*string) == nil || *got["subjectType"].(*string) != "agent" || len(got["typeHistory"].([]Object)) != 2 {
		t.Fatalf("type history: %v %v", got, e)
	}
	change["expectedRevision"] = 4
	change["subjectType"] = "person"
	calls := 0
	result, e := postgres.InTx(ctx, pool, func(tx pgx.Tx) (Object, error) {
		return s.ChangeTypeWithin(ctx, tx, existing, encode(t, change), TypeSource{Kind: "business-operator", OperatorID: "accounts-operator", Endpoint: s.Endpoint}, func(_ context.Context, _ pgx.Tx, id, permission string) error {
			calls++
			if id != "accounts-operator" || permission != "accounts.type.change" {
				return fault.New("business_admin_denied", 403)
			}
			return nil
		})
	})
	if e != nil || calls != 1 || result["permissionsChanged"] != false || result["basisKind"] != "operator-recorded-statement" {
		t.Fatalf("operator type authority %v %v", result, e)
	}
	var actor, operator string
	if e = owner.QueryRow(ctx, "SELECT actor_kind,operator_id FROM official_account_type_history_v1 WHERE account_id=$1 AND revision=5", existing).Scan(&actor, &operator); e != nil || actor != "business-operator" || operator != "accounts-operator" {
		t.Fatalf("history author lost %s %s %v", actor, operator, e)
	}
	// A reservation is never a verified/community account or a profile.
	reserved, e := postgres.InTx(ctx, pool, func(tx pgx.Tx) (Registration, error) {
		return s.ReserveWithin(ctx, tx, Identity{"https://login.example.invalid", "go-reservation"})
	})
	if e != nil {
		t.Fatal(e)
	}
	var accounts, profiles int
	_ = owner.QueryRow(ctx, "SELECT count(*) FROM community_accounts WHERE id=$1", reserved.AccountID).Scan(&accounts)
	_ = owner.QueryRow(ctx, "SELECT count(*) FROM official_account_profiles_v1 WHERE account_id=$1", reserved.AccountID).Scan(&profiles)
	if accounts != 0 || profiles != 0 {
		t.Fatal("registration reservation fabricated a business account")
	}
	// Existing registration presentation is a compatibility fixture, not a new
	// preset API or a production profile fill. Only the first true insert adopts.
	if _, e = owner.Exec(ctx, "UPDATE official_account_registrations_v1 SET display_name='existing presentation',avatar_key='leaf',bio='existing bio',preset_revision=1 WHERE account_id=$1", reserved.AccountID); e != nil {
		t.Fatal(e)
	}
	account, e := postgres.InTx(ctx, pool, func(tx pgx.Tx) (Account, error) {
		return s.EnsureAccountWithin(ctx, tx, VerifiedIdentity{Issuer: reserved.Issuer, ExternalSubject: reserved.ExternalSubject, VerificationMethod: "external-account", VerifiedAt: now})
	})
	if e != nil || !account.Created || account.ID != reserved.AccountID || account.UID != reserved.UID {
		t.Fatalf("verified creation replaced reservation %v %v", account, e)
	}
	person := "person"
	profile, e := postgres.InTx(ctx, pool, func(tx pgx.Tx) (Profile, error) { return s.EnsureProfileWithin(ctx, tx, account.ID, &person) })
	if e != nil || profile.DisplayName == nil || *profile.DisplayName != "existing presentation" || profile.Bio != "existing bio" {
		t.Fatalf("first-profile compatibility %v %v", profile, e)
	}
	var adopted *time.Time
	var presetName *string
	if e = owner.QueryRow(ctx, "SELECT adopted_at,display_name FROM official_account_registrations_v1 WHERE account_id=$1", account.ID).Scan(&adopted, &presetName); e != nil || adopted == nil || presetName != nil {
		t.Fatalf("preset not consumed once %v", e)
	}
	now = now.Add(time.Minute)
	same, e := postgres.InTx(ctx, pool, func(tx pgx.Tx) (Account, error) {
		return s.EnsureAccountWithin(ctx, tx, VerifiedIdentity{Issuer: reserved.Issuer, ExternalSubject: reserved.ExternalSubject, VerificationMethod: "email", VerifiedAt: now})
	})
	if e != nil || same.Created || same.ID != account.ID || same.UID != account.UID {
		t.Fatalf("normal verified refresh changed identity %v %v", same, e)
	}
	if _, e = owner.Exec(ctx, "DELETE FROM official_account_profiles_v1 WHERE account_id=$1", account.ID); e != nil {
		t.Fatal(e)
	}
	profile, e = postgres.InTx(ctx, pool, func(tx pgx.Tx) (Profile, error) { return s.EnsureProfileWithin(ctx, tx, account.ID, nil) })
	if e != nil || profile.DisplayName == nil || *profile.DisplayName != account.UID || profile.Bio != "" || profile.SubjectType != nil {
		t.Fatalf("consumed presentation restored after deletion %v %v", profile, e)
	}
	if _, e = owner.Exec(ctx, "UPDATE official_account_registrations_v1 SET uid='GAAAAAAAAAA0' WHERE account_id=$1", account.ID); e == nil {
		t.Fatal("original immutable registration constraint bypassed")
	}
	// Concurrent normal reservations use one exact immutable identity.
	var wg sync.WaitGroup
	ids := make(chan string, 4)
	errs := make(chan error, 4)
	for i := 0; i < 4; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			r, e := postgres.InTx(ctx, pool, func(tx pgx.Tx) (Registration, error) {
				return s.ReserveWithin(ctx, tx, Identity{reserved.Issuer, "concurrent-go"})
			})
			ids <- r.AccountID
			errs <- e
		}()
	}
	wg.Wait()
	close(ids)
	close(errs)
	for e := range errs {
		if e != nil {
			t.Fatal(e)
		}
	}
	var first string
	for id := range ids {
		if first == "" {
			first = id
		}
		if id != first {
			t.Fatal("concurrent registration identity split")
		}
	}
	// Real collisions remain bounded and do not overwrite any prior locator.
	collision := *s
	collision.GenerateUID = func() (string, error) { return account.UID, nil }
	_, e = postgres.InTx(ctx, pool, func(tx pgx.Tx) (Registration, error) {
		return collision.ReserveWithin(ctx, tx, Identity{reserved.Issuer, "collision-go"})
	})
	expectCode(t, e, "official_account_unavailable")
}

func TestAccountExactFieldValidation(t *testing.T) {
	valid := Object{"expectedRevision": 0, "displayName": nil, "publicQuery": Object{"enabled": false, "scope": "profile"}, "archiveRetentionDays": nil}
	if _, e := parseSettings(encode(t, valid)); e != nil {
		t.Fatal(e)
	}
	for _, field := range []string{"model", "organizationName", "subjectType", "profileRevision"} {
		bad := Object{}
		for k, v := range valid {
			bad[k] = v
		}
		bad[field] = "not-a-settings-field"
		_, e := parseSettings(encode(t, bad))
		expectCode(t, e, "invalid_account_data")
	}
	for _, field := range []string{"expectedRevision", "displayName", "publicQuery", "archiveRetentionDays"} {
		bad := Object{}
		for k, v := range valid {
			if k != field {
				bad[k] = v
			}
		}
		_, e := parseSettings(encode(t, bad))
		expectCode(t, e, "invalid_account_data")
	}
	bad := Object{}
	for k, v := range valid {
		bad[k] = v
	}
	bad["bio"] = nil
	_, e := parseSettings(encode(t, bad))
	expectCode(t, e, "invalid_account_data")
	bad["bio"] = strings.Repeat("界", 501)
	_, e = parseSettings(encode(t, bad))
	expectCode(t, e, "invalid_account_data")
	for i := 0; i < 8; i++ {
		uid, e := GenerateUID()
		if e != nil || !UIDPattern.MatchString(uid) {
			t.Fatalf("UID format %s %v", uid, e)
		}
	}
}
