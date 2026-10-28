package accounts

import (
	"context"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
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

func nodeAccounts(t *testing.T, dsn, script string, args ...string) Object {
	t.Helper()
	root, e := filepath.Abs(filepath.Join("..", "..", ".."))
	if e != nil {
		t.Fatal(e)
	}
	prefix := `import pg from './packages/galaxy-official/node_modules/pg/lib/index.js';import {migrate,transaction} from './packages/galaxy-official/src/infrastructure/database.mjs';import {reserveOfficialAccountWithin} from './packages/galaxy-official/src/accounts/registration.mjs';import {upsertOfficialAccountWithin,ensureOfficialAccountProfileWithin} from './packages/galaxy-official/src/accounts/uid.mjs';import {OfficialAccountData} from './packages/galaxy-official/src/accounts/data.mjs';const url=new URL(process.env.GALAXY_GO_TEST_DATABASE_URL);if(url.hostname!=='127.0.0.1'||!url.pathname.startsWith('/galaxy_go_test_'))throw Error('isolated db required');const db=new pg.Pool({connectionString:url.href});const endpoint='https://accounts.example.invalid',issuer='https://login.example.invalid',now=()=>2000000000;const data=new OfficialAccountData({db,endpoint,now});try{`
	cmd := exec.Command("node", append([]string{"--input-type=module", "-e", prefix + script + `}finally{await db.end()}`}, args...)...)
	cmd.Dir = root
	cmd.Env = append(os.Environ(), "GALAXY_GO_TEST_DATABASE_URL="+dsn)
	out, e := cmd.CombinedOutput()
	if e != nil {
		t.Fatalf("original account service %v %s", e, out)
	}
	var result Object
	if e = json.Unmarshal(out, &result); e != nil {
		t.Fatalf("original account output %v %s", e, out)
	}
	return result
}
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
	original := nodeAccounts(t, dsn, `await migrate(db,{roles:['api']});const account=await transaction(db,async tx=>{const a=await upsertOfficialAccountWithin(tx,{endpoint,issuer,externalSubject:'existing-js',verificationMethod:'email',verifiedAt:now()});await ensureOfficialAccountProfileWithin(tx,a.id,{subjectType:'person',now:now()});return a});const actor={kind:'official-account',endpoint,accountId:account.id};await data.updateSettings(actor,{expectedRevision:0,displayName:'原JavaScript资料',avatarKey:'book',bio:'原简介',publicQuery:{enabled:false,scope:'profile',showLinkedIds:true},archiveRetentionDays:null});await data.createArchive(actor,{id:'11111111-1111-4111-8111-111111111111',title:'controlled empty metadata',selection:{workspaceId:null,sessionIds:['fixture-only']},uploadLevel:'conversation-archive',includeFullConversation:true});await db.query("INSERT INTO operations_operator_principals_v1(operator_id,endpoint,issuer,external_subject,display_name,created_at,updated_at) VALUES('accounts-operator',$1,$2,'accounts-operator','controlled operator',$3,$3)",[endpoint,issuer,new Date(now()*1000)]);console.log(JSON.stringify({account,settings:await data.settings(actor)}));`)
	pool := apiPool(t, dsn)
	now := time.Unix(2000000000, 0)
	s := &Service{Endpoint: "https://accounts.example.invalid", Now: func() time.Time { return now }}
	existing := original["account"].(map[string]any)["id"].(string)
	got, e := postgres.InTx(ctx, pool, func(tx pgx.Tx) (Object, error) { return s.SettingsWithin(ctx, tx, existing) })
	if e != nil || !reflect.DeepEqual(normalized(t, got), original["settings"]) {
		t.Fatalf("JS→Go settings %v\nGo=%s\nJS=%s", e, encode(t, got), encode(t, original["settings"]))
	}
	update := Object{"expectedRevision": 1, "displayName": nil, "bio": "  Go修改的简介  ", "publicQuery": Object{"enabled": false, "scope": "profile-and-public-posts"}, "archiveRetentionDays": 14}
	if _, e = postgres.InTx(ctx, pool, func(tx pgx.Tx) (Object, error) { return s.UpdateSettingsWithin(ctx, tx, existing, encode(t, update)) }); e != nil {
		t.Fatal(e)
	}
	read := nodeAccounts(t, dsn, `const accountId=process.argv[1],actor={kind:'official-account',endpoint,accountId};console.log(JSON.stringify({settings:await data.settings(actor)}));`, existing)
	got, e = postgres.InTx(ctx, pool, func(tx pgx.Tx) (Object, error) { return s.SettingsWithin(ctx, tx, existing) })
	if e != nil || !reflect.DeepEqual(normalized(t, got), read["settings"]) {
		t.Fatalf("Go→JS normal update %v", e)
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
	read = nodeAccounts(t, dsn, `const accountId=process.argv[1],actor={kind:'official-account',endpoint,accountId};await data.changeType(actor,{expectedRevision:3,subjectType:'agent',reason:'本人提供下一次真实类型更正',basis:'受控差分检查不代表能力认证',preserveHistory:true});console.log(JSON.stringify({settings:await data.settings(actor)}));`, existing)
	got, e = postgres.InTx(ctx, pool, func(tx pgx.Tx) (Object, error) { return s.SettingsWithin(ctx, tx, existing) })
	if e != nil || !reflect.DeepEqual(normalized(t, got), read["settings"]) {
		t.Fatalf("JS→Go type/history %v", e)
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
