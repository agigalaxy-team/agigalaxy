package community

import (
	"context"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/agigalaxy-team/agigalaxy/go/internal/accountlinks"
	"github.com/agigalaxy-team/agigalaxy/go/internal/deviceauth"
	"github.com/agigalaxy-team/agigalaxy/go/internal/testsupport"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

type activityEvidenceCountTx struct {
	pgx.Tx
	evidenceReads, accountReads int
}

func (tx *activityEvidenceCountTx) QueryRow(ctx context.Context, sql string, args ...any) pgx.Row {
	if strings.Contains(sql, "FROM community_accounts a JOIN") {
		tx.evidenceReads++
	}
	if strings.Contains(sql, "FROM community_accounts WHERE id=$1 AND endpoint=$2") {
		tx.accountReads++
	}
	return tx.Tx.QueryRow(ctx, sql, args...)
}

func TestActivityOfficialAccountEvidenceReuseAndInvalidation(t *testing.T) {
	pool, dsn := testsupport.PostgreSQL(t)
	fixture := seedCommunity(t, pool)
	ctx := context.Background()
	at := time.Unix(2000000000, 0)
	s := &Service{Pool: pool, Endpoint: str(fixture, "endpoint"), Authority: &fixtureAuth{}, Now: func() time.Time { return at }}
	accounts := fixture["accounts"].([]any)
	post := obj(fixture, "payload")
	if _, err := s.Publish(ctx, asString(accounts[0]), string(encode(post))); err != nil {
		t.Fatal(err)
	}
	reply := bind(t, dsn, "create-reply", asString(accounts[1]), Object{"schemaVersion": 1, "operationId": uuid.NewString(), "accountId": accounts[1], "replyId": uuid.NewString(), "postId": post["postId"], "postVersionId": post["versionId"], "expectedRevision": 0, "body": "Synthetic public reply", "publishedUntil": int64(2000001800), "replyTo": nil})
	if _, err := s.CreateReply(ctx, asString(accounts[1]), string(encode(reply))); err != nil {
		t.Fatal(err)
	}
	var postPermission, postHash, eventID, replyPermission, replyHash string
	if err := pool.QueryRow(ctx, "SELECT permission_id::text,payload_hash,publication_event_id::text FROM forum_versions_v1 WHERE id=$1", post["versionId"]).Scan(&postPermission, &postHash, &eventID); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(ctx, "SELECT permission_id::text,payload_hash FROM forum_replies_v1 WHERE id=$1", reply["replyId"]).Scan(&replyPermission, &replyHash); err != nil {
		t.Fatal(err)
	}
	realTx, err := pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.RepeatableRead})
	if err != nil {
		t.Fatal(err)
	}
	defer realTx.Rollback(ctx)
	tx := &activityEvidenceCountTx{Tx: realTx}
	check := func(service *Service, kind, source, permission, hash string, want bool) {
		t.Helper()
		tx.evidenceReads, tx.accountReads = 0, 0
		allowed, err := service.ActivityAllowedWithin(ctx, tx, kind, str(post, "postId"), source, permission, hash, at.Unix())
		if err != nil || allowed != want {
			t.Fatalf("%s allowed=%v want=%v: %v", kind, allowed, want, err)
		}
		if tx.evidenceReads != 1 || tx.accountReads != 0 {
			t.Fatalf("%s evidence=%d standalone account=%d", kind, tx.evidenceReads, tx.accountReads)
		}
	}
	check(s, "post", str(post, "versionId"), postPermission, postHash, true)
	check(s, "reply", str(reply, "replyId"), replyPermission, replyHash, true)
	check(s, "post", str(post, "versionId"), postPermission, strings.Repeat("0", 64), false)
	otherEndpoint := *s
	otherEndpoint.Endpoint = "https://other.example.invalid"
	check(&otherEndpoint, "post", str(post, "versionId"), postPermission, postHash, false)
	if _, err = tx.Exec(ctx, "UPDATE forum_permissions_v1 SET revoked_at=$2 WHERE id=$1", postPermission, at); err != nil {
		t.Fatal(err)
	}
	check(s, "post", str(post, "versionId"), postPermission, postHash, false)
	if _, err = tx.Exec(ctx, "UPDATE forum_permissions_v1 SET revoked_at=NULL WHERE id=$1", postPermission); err != nil {
		t.Fatal(err)
	}
	if _, err = tx.Exec(ctx, "UPDATE forum_events_v1 SET erased_at=$2 WHERE id=$1", eventID, at); err != nil {
		t.Fatal(err)
	}
	check(s, "post", str(post, "versionId"), postPermission, postHash, false)
}

// Identity-consent publications keep the separate account endpoint check and
// the original signed consent checks; official-account evidence is not reused.
func TestActivityIdentityConsentKeepsAccountAndSignatureChecks(t *testing.T) {
	pool, _ := testsupport.PostgreSQL(t)
	fixture := syntheticIdentityFixture(t, pool)
	at := time.Unix(num(fixture, "now"), 0)
	ctx := context.Background()
	s := &Service{Pool: pool, Endpoint: str(fixture, "endpoint"), Now: func() time.Time { return at }, DeviceAuth: &deviceauth.Service{Pool: pool, Endpoint: str(fixture, "endpoint"), Now: func() time.Time { return at }}}
	s.AccountLinks = &accountlinks.Service{Pool: pool, Endpoint: s.Endpoint, Devices: s.DeviceAuth, Providers: []accountlinks.Provider{{Issuer: str(fixture, "issuer"), ClientID: "galaxy-fixture"}}, Now: s.Now}
	server := httptest.NewServer(Handler{Service: s})
	defer server.Close()
	envelope := obj(fixture, "post")
	post := obj(envelope, "payload")
	status, response := requestJSON(t, server.URL, "/v2/community/posts", str(obj(fixture, "owner"), "token"), Object{"payloadJson": envelope["payloadJson"], "signedIntent": envelope["signedIntent"]})
	if status != 200 {
		t.Fatalf("identity post status=%d error=%s", status, str(response, "error"))
	}
	var permissionID, hash string
	var accountID *string
	if err := pool.QueryRow(ctx, `SELECT v.permission_id::text,v.payload_hash,p.account_id::text FROM forum_versions_v1 v JOIN forum_permissions_v1 p ON p.id=v.permission_id WHERE v.id=$1`, post["versionId"]).Scan(&permissionID, &hash, &accountID); err != nil {
		t.Fatal(err)
	}
	if accountID == nil {
		t.Fatal("fixture must exercise an identity-consent account")
	}
	realTx, err := pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.RepeatableRead})
	if err != nil {
		t.Fatal(err)
	}
	defer realTx.Rollback(ctx)
	tx := &activityEvidenceCountTx{Tx: realTx}
	allowed, err := s.ActivityAllowedWithin(ctx, tx, "post", str(post, "postId"), str(post, "versionId"), permissionID, hash, at.Unix())
	if err != nil || !allowed || tx.accountReads != 1 || tx.evidenceReads != 0 {
		t.Fatalf("identity qualification allowed=%v account=%d official=%d: %v", allowed, tx.accountReads, tx.evidenceReads, err)
	}
	if _, err = tx.Exec(ctx, "UPDATE forum_permissions_v1 SET signature_hash=$2 WHERE id=$1", permissionID, strings.Repeat("0", 64)); err != nil {
		t.Fatal(err)
	}
	allowed, err = s.ActivityAllowedWithin(ctx, tx, "post", str(post, "postId"), str(post, "versionId"), permissionID, hash, at.Unix())
	if err != nil || allowed {
		t.Fatalf("mismatched signature accepted: allowed=%v err=%v", allowed, err)
	}
}
