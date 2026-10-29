package main

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"encoding/pem"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/agigalaxy-team/agigalaxy/go/internal/access"
	"github.com/agigalaxy-team/agigalaxy/go/internal/accounts"
	"github.com/agigalaxy-team/agigalaxy/go/internal/community"
	"github.com/agigalaxy-team/agigalaxy/go/internal/identity"
	"github.com/agigalaxy-team/agigalaxy/go/internal/testsupport/accessfixture"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
)

// seedFullBrowser operates only on the disposable database and temporary files
// created by TestFullEntryBrowserFlow. Publication remains a real HTTP write.
func seedFullBrowser(t *testing.T, ctx context.Context, pool *pgxpool.Pool, dir, descriptorFile string, files accessfixture.Files, config access.Config, website, admin string) map[string]any {
	t.Helper()
	now := time.Now().Unix()
	at := time.Unix(now, 0).UTC()
	token := func() string {
		b := make([]byte, 32)
		if _, e := rand.Read(b); e != nil {
			t.Fatal(e)
		}
		return base64.RawURLEncoding.EncodeToString(b)
	}
	hash := func(s string) string { h := sha256.Sum256([]byte(s)); return hex.EncodeToString(h[:]) }
	tx, e := pool.Begin(ctx)
	if e != nil {
		t.Fatal(e)
	}
	defer tx.Rollback(ctx)
	people := []map[string]any{}
	accountIDs := []string{}
	accountService := accounts.Service{Endpoint: files.Endpoint, Now: func() time.Time { return at }}
	for _, name := range []string{"网页联检甲", "网页联检乙"} {
		subject := "browser-" + uuid.NewString()
		account, e := accountService.EnsureAccountWithin(ctx, tx, accounts.VerifiedIdentity{Issuer: config.AccountIssuer, ExternalSubject: subject, VerificationMethod: "external-account", VerifiedAt: at})
		if e != nil {
			t.Fatal(e)
		}
		person := "person"
		if _, e = accountService.EnsureProfileWithin(ctx, tx, account.ID, &person); e != nil {
			t.Fatal(e)
		}
		if _, e = tx.Exec(ctx, "UPDATE official_account_profiles_v1 SET display_name=$2 WHERE account_id=$1", account.ID, name); e != nil {
			t.Fatal(e)
		}
		value, csrf := token(), token()
		if _, e = tx.Exec(ctx, `INSERT INTO official_account_sessions_v1(scope_hash,token_hash,login_hash,account_id,issuer,external_subject,email_verified,csrf_token,created_at,expires_at) VALUES($1,$2,$3,$4,$5,$6,true,$7,$8,$9)`, config.AccountScope, hash(value), hash("fixture-login:"+value), account.ID, config.AccountIssuer, subject, csrf, now, now+3600); e != nil {
			t.Fatal(e)
		}
		if _, e = tx.Exec(ctx, `INSERT INTO chat_participants_v3(actor_ref,kind,account_id) VALUES($1,'official-account',$2) ON CONFLICT DO NOTHING`, "account:"+account.ID, account.ID); e != nil {
			t.Fatal(e)
		}
		accountIDs = append(accountIDs, account.ID)
		people = append(people, map[string]any{"accountId": account.ID, "subject": subject, "cookie": map[string]any{"name": "__Host-galaxy-account", "value": value}, "csrf": csrf})
	}
	operatorIssuer := "https://login.example.invalid/realms/management"
	operatorSubject := "fixture-root"
	if _, e = tx.Exec(ctx, `INSERT INTO operations_operator_principals_v1(operator_id,endpoint,issuer,external_subject,display_name,created_at,updated_at) VALUES($1,$2,$3,$4,'隔离网页处理员',$5,$5) ON CONFLICT DO NOTHING`, files.RootID, files.Endpoint, operatorIssuer, operatorSubject, at); e != nil {
		t.Fatal(e)
	}
	operatorToken, operatorCSRF := token(), token()
	if _, e = tx.Exec(ctx, `INSERT INTO operations_operator_sessions_v1(endpoint,configuration_id,token_hash,operator_id,issuer,external_subject,display_name,role,csrf_token,expires_at) VALUES($1,$2,$3,$4,$5,$6,'隔离网页处理员','administrator',$7,$8)`, files.Endpoint, config.OperatorConfiguration, hash(operatorToken), files.RootID, operatorIssuer, operatorSubject, operatorCSRF, at.Add(time.Hour)); e != nil {
		t.Fatal(e)
	}
	roomID, operationID := uuid.NewString(), uuid.NewString()
	create := map[string]any{"roomId": roomID, "operationId": operationID, "title": "隔离网页会话", "kind": "ordinary", "taskRefs": []any{}, "retentionDays": 90}
	canonical, e := identity.Canonical(create)
	if e != nil {
		t.Fatal(e)
	}
	if _, e = tx.Exec(ctx, `INSERT INTO chat_rooms(room_id,creator_subject_id,operation_id,request_hash,title,kind,task_refs,retention_days,created_at,updated_at) VALUES($1,$2,$3,$4,$5,'ordinary','[]',90,$6,$6)`, roomID, "account:"+accountIDs[0], operationID, hash(string(canonical)), create["title"], at); e != nil {
		t.Fatal(e)
	}
	for _, id := range accountIDs {
		if _, e = tx.Exec(ctx, `INSERT INTO chat_memberships(room_id,subject_id,controller_ref,joined_at) VALUES($1,$2,$2,$3)`, roomID, "account:"+id, at); e != nil {
			t.Fatal(e)
		}
	}
	payload := community.Object{"schemaVersion": 1, "operationId": uuid.NewString(), "accountId": accountIDs[0], "postId": uuid.NewString(), "versionId": uuid.NewString(), "expectedHeadVersion": 0, "title": "隔离网页连续流程", "body": "该帖子应通过真实 Go API 发布，再从官网与社区回读。", "links": []any{}, "attachments": []any{}, "topic": "technology", "publishedUntil": now + 3600}
	community.BindCreatePostIDs(accountIDs[0], payload)
	if e = tx.Commit(ctx); e != nil {
		t.Fatal(e)
	}
	pub, priv, e := ed25519.GenerateKey(rand.Reader)
	if e != nil {
		t.Fatal(e)
	}
	pubDER, e := x509.MarshalPKIXPublicKey(pub)
	if e != nil {
		t.Fatal(e)
	}
	privDER, e := x509.MarshalPKCS8PrivateKey(priv)
	if e != nil {
		t.Fatal(e)
	}
	kid := "isolated-browser-api"
	pin := map[string]any{"kid": kid, "publicKeyPem": string(pem.EncodeToMemory(&pem.Block{Type: "PUBLIC KEY", Bytes: pubDER})), "notBefore": now - 60, "notAfter": now + 172800, "revoked": false}
	keyData := map[string]any{"version": 1, "endpoint": files.Endpoint, "sequence": 1, "keys": []any{pin}}
	b64 := base64.RawURLEncoding.EncodeToString
	encode := func(v any) string {
		b, e := json.Marshal(v)
		if e != nil {
			t.Fatal(e)
		}
		return b64(b)
	}
	input := encode(map[string]any{"alg": "Ed25519", "typ": "galaxy-keyring+jwt", "kid": kid}) + "." + encode(map[string]any{"data": keyData, "iss": files.Endpoint, "aud": files.Endpoint, "iat": now, "nbf": now, "exp": now + 86400, "jti": uuid.NewString()})
	signed := input + "." + b64(ed25519.Sign(priv, []byte(input)))
	paths := map[string]any{"signingKeyFile": filepath.Join(dir, "browser-signing.pem"), "rootPinsFile": filepath.Join(dir, "browser-root-pins.json"), "keyringFile": filepath.Join(dir, "browser-keyring.json"), "trustDirectory": filepath.Join(dir, "browser-trust"), "signingKeyId": kid}
	if e = os.Mkdir(paths["trustDirectory"].(string), 0700); e != nil {
		t.Fatal(e)
	}
	write := func(path string, b []byte) {
		t.Helper()
		if e := os.WriteFile(path, b, 0600); e != nil {
			t.Fatal(e)
		}
	}
	writeJSON := func(path string, v any) {
		t.Helper()
		b, e := json.Marshal(v)
		if e != nil {
			t.Fatal(e)
		}
		write(path, b)
	}
	write(paths["signingKeyFile"].(string), pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: privDER}))
	writeJSON(paths["rootPinsFile"].(string), keyData)
	writeJSON(paths["keyringFile"].(string), map[string]any{"signed": signed})
	publicFile := filepath.Join(dir, "browser-web-config.json")
	writeJSON(publicFile, map[string]any{"version": 1, "endpoint": files.Endpoint, "signingKeys": []any{pin}, "operator": "隔离 Go API"})
	result := map[string]any{"version": 1, "endpoint": files.Endpoint, "websiteOrigin": website, "adminOrigin": admin, "people": people, "operator": map[string]any{"operatorId": files.RootID, "issuer": operatorIssuer, "subject": operatorSubject, "cookie": map[string]any{"name": "__Host-galaxy-operator", "value": operatorToken}, "csrf": operatorCSRF}, "forum": map[string]any{"payload": payload, "postId": payload["postId"], "versionId": payload["versionId"], "published": false}, "chat": map[string]any{"roomId": roomID, "messageDeliverySeeded": false}, "expiresAt": now + 3600, "serviceFiles": paths, "publicConfigurationFile": publicFile}
	writeJSON(descriptorFile, result)
	return result
}
