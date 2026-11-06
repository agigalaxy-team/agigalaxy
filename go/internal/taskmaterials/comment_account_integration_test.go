package taskmaterials

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"strings"
	"testing"
	"time"

	"github.com/agigalaxy-team/agigalaxy/go/internal/access"
	"github.com/agigalaxy-team/agigalaxy/go/internal/accounts"
	"github.com/agigalaxy-team/agigalaxy/go/internal/databaseschema"
	"github.com/agigalaxy-team/agigalaxy/go/internal/deviceauth"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/identity"
	"github.com/agigalaxy-team/agigalaxy/go/internal/publicwrites"
	"github.com/agigalaxy-team/agigalaxy/go/internal/testsupport"
	"github.com/agigalaxy-team/agigalaxy/go/internal/testsupport/accountlinkfixture"
	"github.com/agigalaxy-team/agigalaxy/go/internal/testsupport/deviceauthfixture"
	"github.com/agigalaxy-team/agigalaxy/go/internal/testsupport/devicefixture"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

func TestOpenEndedTaskAccountCommentIntegration(t *testing.T) {
	ctx := context.Background()
	ownerPool, _ := testsupport.PostgreSQL(t)
	if _, e := databaseschema.Migrate(ctx, ownerPool, []string{"api", "worker"}); e != nil {
		t.Fatal(e)
	}
	owner := deviceauthfixture.New(t, ownerPool, t.TempDir(), []string{"binding", "consent", "assistance"})
	linked := accountlinkfixture.New(t, ownerPool, owner.Service)
	linked.Link(owner, "open-task-owner")
	cfg := ownerPool.Config()
	cfg.AfterConnect = func(ctx context.Context, c *pgx.Conn) error { _, e := c.Exec(ctx, "SET ROLE galaxy_api"); return e }
	pool, e := pgxpool.NewWithConfig(ctx, cfg)
	if e != nil {
		t.Fatal(e)
	}
	defer pool.Close()
	now := func() time.Time { return time.Unix(devicefixture.Now, 0) }
	devices := &deviceauth.Service{Pool: pool, Endpoint: devicefixture.Endpoint, Now: now}
	links := linked.Registry
	links.Pool = pool
	links.Devices = devices
	writes := &publicwrites.Service{Pool: pool, Endpoint: devicefixture.Endpoint, Links: links, Now: now}
	svc := &Service{Pool: pool, Endpoint: devicefixture.Endpoint, Devices: devices, Links: links, Writes: writes, Now: now}
	comments := &CommentService{Service: svc}
	taskID, op := uuid.NewString(), uuid.NewString()
	request := Object{"operationId": op, "taskId": taskID, "caseId": nil, "intent": "stuck", "title": "Open request", "summary": "Need a practical suggestion", "workContext": Object{"goal": "Continue the work", "currentSituation": "A concrete obstacle", "attemptRefs": []any{}}, "visibility": "Public", "collaboration": "open-assistance", "enrollmentExpiresAt": nil}
	grant := owner.Grant(t, request, "assistance.publish", op, "Public", nil)
	_, e = svc.CreateTask(ctx, Actor{Actor: owner.Actor}, TaskSubmission{ConsentID: str(grant, "consentId"), PayloadJSON: str(grant, "payloadJson")})
	if e != nil {
		t.Fatal(e)
	}
	rawTask, e := svc.GetTask(ctx, nil, taskID)
	if e != nil {
		t.Fatal(e)
	}
	task := rawTask.(Object)
	if obj(task, "request")["enrollmentExpiresAt"] != nil || task["enrollmentOpen"] != true {
		t.Fatalf("undated task: %#v", task)
	}
	issuer := "https://accounts.example.invalid"
	scope := strings.Repeat("1", 64)
	csrf := strings.Repeat("c", 43)
	ids := []string{uuid.NewString(), uuid.NewString()}
	tokens := []string{strings.Repeat("a", 43), strings.Repeat("b", 43)}
	for i, id := range ids {
		sub := uuid.NewString()
		_, e = ownerPool.Exec(ctx, `INSERT INTO community_accounts(id,endpoint,issuer,external_subject,verification_method,verified_at,created_at) VALUES($1,$2,$3,$4,'external-account',$5,$5)`, id, devicefixture.Endpoint, issuer, sub, now())
		if e != nil {
			t.Fatal(e)
		}
		if i == 0 {
			_, e = ownerPool.Exec(ctx, `INSERT INTO official_account_profiles_v1(account_id,subject_type,display_name,avatar_key,updated_at) VALUES($1,'person','  实际作者  ','leaf',$2)`, id, now())
			if e != nil {
				t.Fatal(e)
			}
		}
		_, e = ownerPool.Exec(ctx, `INSERT INTO official_account_sessions_v1(scope_hash,token_hash,login_hash,account_id,issuer,external_subject,email_verified,csrf_token,created_at,expires_at) VALUES($1,$2,$3,$4,$5,$6,true,$7,$8,$9)`, scope, identity.Digest([]byte(tokens[i])), strings.Repeat("3", 64), id, issuer, sub, csrf, devicefixture.Now, devicefixture.Now+3600)
		if e != nil {
			t.Fatal(e)
		}
	}
	gateway, e := access.New(pool, access.Config{Endpoint: devicefixture.Endpoint, WebsiteOrigin: "https://web.example.invalid", AdminOrigin: "https://admin.example.invalid", AccountIssuer: issuer, OperatorIssuer: "https://operator.example.invalid", AccountScope: scope, OperatorConfiguration: strings.Repeat("2", 64), AdministratorRole: "admin", ReaderRole: "reader"}, nil)
	if e != nil {
		t.Fatal(e)
	}
	gateway.Now = now
	actors := make([]AccountCommentActor, 2)
	for i, id := range ids {
		r := httptest.NewRequest("POST", "https://web.example.invalid/", nil)
		r.Header.Set("Origin", "https://web.example.invalid")
		r.Header.Set("Cookie", "__Host-galaxy-account="+tokens[i])
		r.Header.Set("X-Galaxy-Account-ID", id)
		r.Header.Set("X-Galaxy-Account-CSRF", csrf)
		got, authority, e := gateway.Account(r, true)
		if e != nil {
			t.Fatal(e)
		}
		actors[i] = AccountCommentActor{AccountID: got, Authority: authority}
	}
	// These account actors have no linked local subject or device identity.
	var linkedCount int
	if e = ownerPool.QueryRow(ctx, `SELECT count(*) FROM community_account_links WHERE account_id=ANY($1::uuid[])`, ids).Scan(&linkedCount); e != nil || linkedCount != 0 {
		t.Fatalf("account fixture unexpectedly linked: %d %v", linkedCount, e)
	}
	commentID, eventID := uuid.NewString(), uuid.NewString()
	encode := func(v Object) string {
		t.Helper()
		b, e := json.Marshal(v)
		if e != nil {
			t.Fatal(e)
		}
		return string(b)
	}
	create := encode(Object{"schemaVersion": 2, "id": eventID, "commentId": commentID, "taskId": taskID, "expectedRevision": 0, "kind": "create", "visibility": "inherit-task", "body": "Try inspecting the actual input."})
	created, e := comments.SubmitAccount(ctx, actors[0], create)
	if e != nil {
		t.Fatal(e)
	}
	if num(created.(Object)["revision"]) != 1 {
		t.Fatal(created)
	}
	receipt, e := comments.ReceiptAccount(ctx, actors[0], eventID, identity.Digest([]byte(create)))
	if e != nil || receipt.(Object)["commentId"] != commentID || num(receipt.(Object)["revision"]) != 1 {
		t.Fatalf("receipt %v %v", receipt, e)
	}
	replay, e := comments.SubmitAccount(ctx, actors[0], create)
	if e != nil || replay.(Object)["operationId"] != eventID {
		t.Fatalf("replay %v %v", replay, e)
	}
	public, e := comments.Query(ctx, nil, Object{"taskId": taskID})
	if e != nil {
		t.Fatal(e)
	}
	items := arr(public.(Object)["items"])
	if len(items) != 1 {
		t.Fatal(public)
	}
	view := items[0].(Object)
	if obj(view, "author")["kind"] != "account" || obj(view, "author")["accountId"] != ids[0] || view["body"] == nil {
		t.Fatal(view)
	}
	var actualUID string
	if e = ownerPool.QueryRow(ctx, `SELECT uid FROM community_accounts WHERE id=$1`, ids[0]).Scan(&actualUID); e != nil {
		t.Fatal(e)
	}
	author := obj(view, "author")
	if author["uid"] != actualUID || author["displayName"] != "实际作者" || author["avatarKey"] != "leaf" || author["subjectType"] != "person" {
		t.Fatalf("account author projection: %#v", author)
	}
	owned, e := comments.GetAccount(ctx, actors[0], commentID)
	if e != nil || owned.(Object)["canEdit"] != true || owned.(Object)["canRetract"] != true {
		t.Fatalf("owner view %v %v", owned, e)
	}
	editID := uuid.NewString()
	edit := encode(Object{"schemaVersion": 2, "id": editID, "commentId": commentID, "taskId": taskID, "expectedRevision": 1, "kind": "edit", "visibility": "inherit-task", "body": "Inspect the input and compare its source."})
	if _, e = comments.SubmitAccount(ctx, actors[1], edit); fault.Status(e) != 404 {
		t.Fatalf("different account edited comment: %v", e)
	}
	changed, e := comments.SubmitAccount(ctx, actors[0], edit)
	if e != nil || num(changed.(Object)["revision"]) != 2 {
		t.Fatalf("edit %v %v", changed, e)
	}
	edited, e := comments.GetAccount(ctx, actors[0], commentID)
	if e != nil || commentBodyFromView(edited.(Object)["body"]).decoded() != "Inspect the input and compare its source." {
		t.Fatalf("edited view %v %v", edited, e)
	}
	retractID := uuid.NewString()
	retract := encode(Object{"schemaVersion": 2, "id": retractID, "commentId": commentID, "taskId": taskID, "expectedRevision": 2, "kind": "retract"})
	_, e = comments.SubmitAccount(ctx, actors[0], retract)
	if e != nil {
		t.Fatal(e)
	}
	ended, e := comments.GetAccount(ctx, actors[0], commentID)
	if e != nil || ended.(Object)["state"] != "retracted" || ended.(Object)["body"] != nil {
		t.Fatalf("retracted view %v %v", ended, e)
	}
	receipt, e = comments.ReceiptAccount(ctx, actors[0], retractID, identity.Digest([]byte(retract)))
	if e != nil || num(receipt.(Object)["revision"]) != 3 {
		t.Fatalf("retraction receipt %v %v", receipt, e)
	}
	handler := AccountCommentHandler{Service: comments, Identity: accounts.HTTPIdentityFunc(func(r *http.Request, write bool) (string, accounts.Authorization, error) {
		id, authority, err := gateway.Account(r, write)
		return id, authority, err
	})}
	callHTTP := func(path, body string) Object {
		t.Helper()
		req := httptest.NewRequest("POST", "https://web.example.invalid"+path, bytes.NewBufferString(body))
		req.Header.Set("Origin", "https://web.example.invalid")
		req.Header.Set("Cookie", "__Host-galaxy-account="+tokens[0])
		req.Header.Set("X-Galaxy-Account-ID", ids[0])
		req.Header.Set("X-Galaxy-Account-CSRF", csrf)
		req.Header.Set("Content-Type", "application/json")
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, req)
		if response.Code != 200 {
			t.Fatalf("%s: status %d %s", path, response.Code, response.Body.String())
		}
		var result Object
		if err := json.Unmarshal(response.Body.Bytes(), &result); err != nil {
			t.Fatal(err)
		}
		return result
	}
	httpID, httpOperation := uuid.NewString(), uuid.NewString()
	httpPayload := encode(Object{"schemaVersion": 2, "id": httpOperation, "commentId": httpID, "taskId": taskID, "expectedRevision": 0, "kind": "create", "visibility": "inherit-task", "body": "Another useful suggestion."}) + "\n"
	submitted := callHTTP("/v2/account-comments/events", httpPayload)
	if submitted["commentId"] != httpID {
		t.Fatal(submitted)
	}
	httpReceipt := callHTTP("/v2/account-comments/receipt", encode(Object{"id": httpOperation, "payloadHash": identity.Digest([]byte(httpPayload))}))
	if httpReceipt["commentId"] != httpID || httpReceipt["state"] != "accepted" {
		t.Fatal(httpReceipt)
	}
	httpGet := callHTTP("/v2/account-comments/get", encode(Object{"id": httpID}))
	if obj(httpGet, "author")["displayName"] != "实际作者" || httpGet["canEdit"] != true {
		t.Fatal(httpGet)
	}
	httpList := callHTTP("/v2/account-comments/query", encode(Object{"taskId": taskID}))
	found := false
	for _, entry := range arr(httpList["items"]) {
		if value, ok := entry.(map[string]any); ok && value["commentId"] == httpID {
			found = true
		}
	}
	if !found {
		t.Fatal(httpList)
	}
	if script := os.Getenv("GALAXY_ACCOUNT_REPLY_BROWSER"); script != "" {
		asset := os.Getenv("GALAXY_ACCOUNT_REPLY_ASSET")
		if asset == "" {
			t.Fatal("GALAXY_ACCOUNT_REPLY_ASSET is required for the browser fixture")
		}
		mux := http.NewServeMux()
		mux.HandleFunc("/fixture-app.js", func(w http.ResponseWriter, r *http.Request) {
			w.Header().Set("Content-Type", "text/javascript; charset=utf-8")
			http.ServeFile(w, r, asset)
		})
		mux.HandleFunc("/fixture/task", func(w http.ResponseWriter, r *http.Request) {
			view, err := svc.GetTask(r.Context(), nil, taskID)
			if err != nil {
				http.Error(w, "task unavailable", 500)
				return
			}
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(view)
		})
		mux.HandleFunc("/v1/account/session", func(w http.ResponseWriter, r *http.Request) {
			verified := r.Clone(r.Context())
			verified.Header = r.Header.Clone()
			verified.Header.Set("Origin", gateway.Config.WebsiteOrigin)
			verified.Header.Set("X-Galaxy-Account-ID", ids[0])
			id, _, err := gateway.Account(verified, false)
			if err != nil {
				http.Error(w, "account session unavailable", 401)
				return
			}
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(Object{"state": "signed-in", "account": Object{"id": id, "uid": actualUID, "displayName": "实际作者", "avatarKey": "leaf", "subjectType": "person", "email": nil, "emailVerified": true}, "linkedIds": []any{}, "nextAfter": nil, "expiresAt": devicefixture.Now + 3600, "csrfToken": csrf, "galaxyAuthorization": false})
		})
		mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
			if r.URL.Path != "/" {
				http.NotFound(w, r)
				return
			}
			w.Header().Set("Content-Type", "text/html; charset=utf-8")
			// The DB and signed-device fixture use the same fixed clock. Expose
			// it before React runs so session TTL and comment age are consistent.
			_, _ = fmt.Fprintf(w, `<!doctype html><html><head><meta charset="utf-8"><script>Date.now=()=>%d;</script></head><body><div id="root"></div><script type="module" src="/fixture-app.js"></script></body></html>`, devicefixture.Now*1000)
		})
		taskHTTP := Handler{Task: svc}
		commentHTTP := CommentHandler{Service: comments, Next: taskHTTP}
		accountHTTP := AccountCommentHandler{Service: comments, Identity: handler.Identity, Next: commentHTTP}
		mux.Handle("/v2/", accountHTTP)
		server := httptest.NewTLSServer(mux)
		defer server.Close()
		gateway.Config.WebsiteOrigin = server.URL
		input, err := json.Marshal(Object{"url": server.URL, "taskId": taskID, "accountId": ids[0], "cookie": "__Host-galaxy-account=" + tokens[0], "csrf": csrf, "uid": actualUID, "displayName": "实际作者", "avatarKey": "leaf", "subjectType": "person"})
		if err != nil {
			t.Fatal(err)
		}
		browserCtx, cancel := context.WithTimeout(ctx, 55*time.Second)
		defer cancel()
		cmd := exec.CommandContext(browserCtx, "node", script)
		cmd.Stdin = bytes.NewReader(input)
		// Do not relay child output: it might accidentally include fixture cookies.
		if err = cmd.Run(); err != nil {
			t.Fatalf("browser fixture failed: %v", err)
		}
	}

}
