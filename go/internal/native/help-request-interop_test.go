package native

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/http/httputil"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/agigalaxy-team/agigalaxy/go/internal/access"
	"github.com/agigalaxy-team/agigalaxy/go/internal/accountlinks"
	"github.com/agigalaxy-team/agigalaxy/go/internal/accounts"
	"github.com/agigalaxy-team/agigalaxy/go/internal/deviceauth"
	"github.com/agigalaxy-team/agigalaxy/go/internal/identity"
	"github.com/agigalaxy-team/agigalaxy/go/internal/publicwrites"
	"github.com/agigalaxy-team/agigalaxy/go/internal/taskmaterials"
	"github.com/agigalaxy-team/agigalaxy/go/internal/testsupport"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/modelcontextprotocol/go-sdk/mcp"
)

// The publisher uses the existing real Native binding/account fixture. Only the
// second account's online session is fixture setup, as in the account-comment
// integration test; publication, consent, reply and read-back are actual writes
// and reads through their original services. This does not test OIDC login UI.
func TestHelpMCPPublishesOpenRequestReadsActualAccountReplyAndReturns(t *testing.T) {
	ctx := context.Background()
	ownerPool, _ := testsupport.PostgreSQL(t)
	store, meta, transport := nativeGoUploadFixtureWithPool(t, ownerPool, false)
	now := func() time.Time { return time.Unix(meta.Now, 0) }
	cfg := ownerPool.Config()
	cfg.AfterConnect = func(ctx context.Context, c *pgx.Conn) error { _, e := c.Exec(ctx, "SET ROLE galaxy_api"); return e }
	pool, e := pgxpool.NewWithConfig(ctx, cfg)
	if e != nil {
		t.Fatal(e)
	}
	defer pool.Close()
	devices := &deviceauth.Service{Pool: pool, Endpoint: meta.Configuration.Endpoint, Now: now}
	owner, e := store.Owner(ctx)
	if e != nil {
		t.Fatal(e)
	}
	var issuer, clientID string
	if e = ownerPool.QueryRow(ctx, "SELECT issuer,client_id FROM external_identity_links WHERE subject_id=$1 LIMIT 1", owner).Scan(&issuer, &clientID); e != nil {
		t.Fatal(e)
	}
	profiles := &accounts.Service{Endpoint: meta.Configuration.Endpoint, Now: now}
	links := &accountlinks.Service{Pool: pool, Endpoint: meta.Configuration.Endpoint, Devices: devices, Accounts: profiles, Providers: []accountlinks.Provider{{Issuer: issuer, ClientID: clientID}}, Now: now}
	writes := &publicwrites.Service{Pool: pool, Endpoint: meta.Configuration.Endpoint, Links: links, Now: now}
	tasks := &taskmaterials.Service{Pool: pool, Endpoint: meta.Configuration.Endpoint, Devices: devices, Links: links, Writes: writes, Now: now}
	comments := &taskmaterials.CommentService{Service: tasks}
	original, _ := url.Parse(meta.Origin)
	server := httptest.NewServer(taskmaterials.Handler{Task: tasks, Next: taskmaterials.CommentHandler{Service: comments, Next: httputil.NewSingleHostReverseProxy(original)}})
	defer server.Close()
	transport.origin, _ = url.Parse(server.URL)
	r, e := NewRuntime(store, meta.Configuration, ConnectionOptions{HTTPClient: &http.Client{Transport: transport}, Now: now})
	if e != nil {
		t.Fatal(e)
	}
	defer r.Close()
	if _, e = r.Restore(ctx); e != nil {
		t.Fatal(e)
	}
	toolServer := mcp.NewServer(&mcp.Implementation{Name: "help-request-interop", Version: "1"}, nil)
	tools := &toolRuntime{store: store, key: make([]byte, 32), choices: map[string]*choiceRecord{}, browser: NewBrowserChoices(store, now)}
	defer tools.browser.Close()
	defer registerNativeHelpTools(toolServer, tools, r)()
	ct, st := mcp.NewInMemoryTransports()
	ss, e := toolServer.Connect(ctx, st, nil)
	if e != nil {
		t.Fatal(e)
	}
	defer ss.Close()
	choices := 0
	client := mcp.NewClient(&mcp.Implementation{Name: "help-request-client", Version: "1"}, &mcp.ClientOptions{ElicitationHandler: func(context.Context, *mcp.ElicitRequest) (*mcp.ElicitResult, error) {
		choices++
		return &mcp.ElicitResult{Action: "accept", Content: map[string]any{"confirm": true}}, nil
	}})
	session, e := client.Connect(ctx, ct, &mcp.ClientSessionOptions{ProtocolVersion: "2025-11-25"})
	if e != nil {
		t.Fatal(e)
	}
	defer session.Close()
	call := func(name string, input map[string]any) map[string]any {
		t.Helper()
		result, e := session.CallTool(ctx, &mcp.CallToolParams{Name: name, Arguments: input})
		if e != nil || result == nil || result.IsError {
			t.Fatal(name, result, e)
		}
		return uploadObject(result.StructuredContent)
	}
	started := call("galaxy_help_start", map[string]any{"localTaskRef": meta.WorkID})
	id := text(started["id"])
	prepared := call("galaxy_help_prepare_action", map[string]any{"sessionId": id, "kind": "publish-task", "request": map[string]any{"title": "连接诊断求助", "summary": "认证失败，请建议下一步检查。", "goal": "恢复当前连接", "currentSituation": "端口可达，认证仍失败。"}})
	preview := call("galaxy_help_action_preview", map[string]any{"sessionId": id, "operationId": prepared["operationId"]})
	payload := uploadObject(preview["payload"])
	taskID, operationID := text(preview["taskId"]), text(preview["operationId"])
	var consentCount, taskCount int
	if e = ownerPool.QueryRow(ctx, "SELECT count(*) FROM consents WHERE intent->>'objectId'=$1", operationID).Scan(&consentCount); e != nil {
		t.Fatal(e)
	}
	if e = ownerPool.QueryRow(ctx, "SELECT count(*) FROM task_requests WHERE id=$1", taskID).Scan(&taskCount); e != nil {
		t.Fatal(e)
	}
	if choices != 0 || consentCount != 0 || taskCount != 0 || payload["enrollmentExpiresAt"] != nil || payload["caseId"] != nil || preview["payloadHash"] != prepared["payloadHash"] {
		t.Fatal("preparation/preview published, signed or invented a deadline/formal source", preview, choices, consentCount, taskCount)
	}
	execute := map[string]any{"sessionId": id, "operationId": operationID, "payloadHash": preview["payloadHash"]}
	published := call("galaxy_help_execute_action", execute)
	if uploadObject(published["operation"])["state"] != "acknowledged" || choices != 1 {
		t.Fatal("Native choice did not acknowledge the original publication, or repetition requested another choice", published, choices)
	}
	call("galaxy_help_execute_action", execute)
	if choices != 1 {
		t.Fatal("repeated publication requested another Native choice", choices)
	}
	if e = ownerPool.QueryRow(ctx, "SELECT count(*) FROM consents WHERE intent->>'objectId'=$1", operationID).Scan(&consentCount); e != nil {
		t.Fatal(e)
	}
	if consentCount != 1 {
		t.Fatal("publication did not retain exactly its actual original consent", consentCount)
	}

	// Reuse the online account-session fixture shape. This account has no local
	// subject/device association; Gateway.Account issues its current authority.
	accountID, accountSubject := uuid.NewString(), "online-helper-"+uuid.NewString()
	token, csrf, portalScope := strings.Repeat("a", 43), strings.Repeat("c", 43), strings.Repeat("1", 64)
	if _, e = ownerPool.Exec(ctx, `INSERT INTO community_accounts(id,endpoint,issuer,external_subject,verification_method,verified_at,created_at) VALUES($1,$2,$3,$4,'external-account',$5,$5)`, accountID, meta.Configuration.Endpoint, issuer, accountSubject, now()); e != nil {
		t.Fatal(e)
	}
	if _, e = ownerPool.Exec(ctx, `INSERT INTO official_account_sessions_v1(scope_hash,token_hash,login_hash,account_id,issuer,external_subject,email_verified,csrf_token,created_at,expires_at) VALUES($1,$2,$3,$4,$5,$6,true,$7,$8,$9)`, portalScope, identity.Digest([]byte(token)), strings.Repeat("3", 64), accountID, issuer, accountSubject, csrf, meta.Now, meta.Now+3600); e != nil {
		t.Fatal(e)
	}
	gateway, e := access.New(pool, access.Config{Endpoint: meta.Configuration.Endpoint, WebsiteOrigin: meta.Configuration.Website, AdminOrigin: "https://admin.example.invalid", AccountIssuer: issuer, OperatorIssuer: "https://operator.example.invalid", AccountScope: portalScope, OperatorConfiguration: strings.Repeat("2", 64), AdministratorRole: "admin", ReaderRole: "reader"}, nil)
	if e != nil {
		t.Fatal(e)
	}
	gateway.Now = now
	onlineRequest := httptest.NewRequest("POST", meta.Configuration.Website+"/", nil)
	onlineRequest.Header.Set("Origin", meta.Configuration.Website)
	onlineRequest.Header.Set("Cookie", "__Host-galaxy-account="+token)
	onlineRequest.Header.Set("X-Galaxy-Account-ID", accountID)
	onlineRequest.Header.Set("X-Galaxy-Account-CSRF", csrf)
	actualAccount, authority, e := gateway.Account(onlineRequest, true)
	if e != nil || actualAccount != accountID || accountID == meta.TargetID {
		t.Fatal("independent current online account was not authenticated", e)
	}
	commentID := uuid.NewString()
	body := "请比较客户端实际发送的认证字段与服务端要求，再检查凭据适用范围。"
	raw, e := json.Marshal(map[string]any{"schemaVersion": 2, "id": uuid.NewString(), "commentId": commentID, "taskId": taskID, "expectedRevision": 0, "kind": "create", "visibility": "inherit-task", "body": body})
	if e != nil {
		t.Fatal(e)
	}
	if _, e = comments.SubmitAccount(ctx, taskmaterials.AccountCommentActor{AccountID: actualAccount, Authority: authority}, string(raw)); e != nil {
		t.Fatal(e)
	}
	refreshed := call("galaxy_help_refresh", map[string]any{"sessionId": id})
	assertReply := func(result map[string]any) {
		t.Helper()
		remote := uploadObject(result["remote"])
		response := uploadObject(result["responses"])
		items := uploadRows(uploadObject(response["page"])["items"])
		if remote["taskId"] != taskID || remote["caseId"] != nil || uploadObject(remote["request"])["enrollmentExpiresAt"] != nil || response["state"] != "ready" || len(items) != 1 {
			t.Fatal("original public undated request or actual replies were not read through HTTP", result)
		}
		reply := uploadObject(items[0])
		author := uploadObject(reply["author"])
		if reply["commentId"] != commentID || reply["body"] != body || author["kind"] != "account" || author["accountId"] != accountID {
			t.Fatal("account reply text or its real author was lost on return to MCP", reply)
		}
	}
	assertReply(refreshed)
	returned := call("galaxy_help_return", map[string]any{"sessionId": id, "expectedRevision": uploadObject(refreshed["session"])["revision"]})
	assertReply(returned)
	handoff := uploadObject(returned["handoff"])
	if handoff["localTaskRef"] != meta.WorkID || handoff["taskId"] != taskID || handoff["hostCallbackVerified"] != false || returned["successFactsCreated"] != false || uploadObject(returned["session"])["pauseState"] != "returned" || choices != 1 {
		t.Fatal("return lost original work, inferred goal success, or repeated an approval", returned, choices)
	}
	var linked, participations int
	if e = ownerPool.QueryRow(ctx, "SELECT count(*) FROM community_account_links WHERE account_id=$1", accountID).Scan(&linked); e != nil {
		t.Fatal(e)
	}
	participations = len(uploadRows(uploadObject(returned["remote"])["participations"]))
	if linked != 0 || participations != 0 {
		t.Fatal("ordinary online reply acquired a local identity or formal participation", linked, participations)
	}
}
