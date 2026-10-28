package publication

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/agigalaxy-team/agigalaxy/go/internal/access"
	"github.com/agigalaxy-team/agigalaxy/go/internal/identity"
	"github.com/agigalaxy-team/agigalaxy/go/internal/jobs"
	"github.com/agigalaxy-team/agigalaxy/go/internal/postgres"
	"github.com/agigalaxy-team/agigalaxy/go/internal/testsupport"
	"github.com/google/uuid"
)

type commandDirectory struct{}

func (commandDirectory) Roles(context.Context, string, string) ([]string, error) {
	return []string{"galaxy-reader"}, nil
}
func (commandDirectory) RolesFresh(context.Context, string, string) ([]string, error) {
	return []string{"galaxy-reader"}, nil
}
func TestOriginalPublicationHTTPWithRestrictedAPIRiverCommands(t *testing.T) {
	pool, dsn := testsupport.PostgreSQL(t)
	node(t, dsn, "setup")
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	config, _, snapshot, _, _ := fixtureFiles(t)
	root, _ := filepath.Abs("../../..")
	execute := func(sql string, args ...any) {
		t.Helper()
		if _, e := pool.Exec(ctx, sql, args...); e != nil {
			t.Fatal(e)
		}
	}
	for _, name := range []string{"api-role.sql", "worker-role.sql"} {
		b, e := os.ReadFile(filepath.Join(root, "packages/galaxy-official/src/infrastructure", name))
		if e != nil {
			t.Fatal(e)
		}
		execute(string(b))
	}
	tx, e := pool.Begin(ctx)
	if e != nil {
		t.Fatal(e)
	}
	if e = jobs.MigrateWithin(ctx, pool, tx); e != nil {
		t.Fatal(e)
	}
	if e = jobs.ProvisionRolesWithin(ctx, tx); e != nil {
		t.Fatal(e)
	}
	if e = tx.Commit(ctx); e != nil {
		t.Fatal(e)
	}
	api, e := postgres.Open(ctx, dsn+"&options=-c%20role%3Dgalaxy_api")
	if e != nil {
		t.Fatal(e)
	}
	defer api.Close()
	queue, e := jobs.New(api, nil)
	if e != nil {
		t.Fatal(e)
	}
	issuer := "https://operator.invalid/realms/admin"
	subject := "publication-requester"
	operator := identity.Digest([]byte(issuer + "\x00" + subject))
	now := time.Now().UTC().Truncate(time.Second)
	scope, token, csrf := strings.Repeat("a", 64), strings.Repeat("t", 43), strings.Repeat("c", 43)
	execute(`INSERT INTO operations_operator_principals_v1(operator_id,endpoint,issuer,external_subject,display_name,created_at,updated_at) VALUES($1,$2,$3,$4,'发布申请人',$5,$5)`, operator, config.Endpoint, issuer, subject, now)
	execute(`INSERT INTO operations_operator_sessions_v1(endpoint,configuration_id,token_hash,operator_id,issuer,external_subject,display_name,role,csrf_token,created_at,expires_at) VALUES($1,$2,$3,$4,$5,$6,'发布申请人','reader',$7,$8,$9)`, config.Endpoint, scope, identity.Digest([]byte(token)), operator, issuer, subject, csrf, now, now.Add(time.Hour))
	role, assignment := uuid.NewString(), uuid.NewString()
	execute(`INSERT INTO operations_business_roles_v1(id,endpoint,name,enabled,version,permissions,created_by,updated_by,created_at,updated_at) VALUES($1,$2,'发布及任务操作',true,1,ARRAY['cms.read','cms.publish','jobs.read','jobs.cancel','jobs.retry'],$3,$3,$4,$4)`, role, config.Endpoint, operator, now)
	execute(`INSERT INTO operations_role_assignments_v1(id,endpoint,operator_id,role_id,enabled,version,created_by,updated_by,created_at,updated_at) VALUES($1,$2,$3,$4,true,1,$3,$3,$5,$5)`, assignment, config.Endpoint, operator, role, now)
	gateway, e := access.New(api, access.Config{Endpoint: config.Endpoint, WebsiteOrigin: "https://website.invalid", AdminOrigin: config.AdminOrigin, AccountIssuer: "https://account.invalid/realms/community", OperatorIssuer: issuer, AccountScope: strings.Repeat("b", 64), OperatorConfiguration: scope, AdministratorRole: "galaxy-admin", ReaderRole: "galaxy-reader"}, commandDirectory{})
	if e != nil {
		t.Fatal(e)
	}
	server := httptest.NewServer(Handler{Commands: &Commands{Pool: api, Endpoint: config.Endpoint, Queue: queue}, Identity: gateway})
	defer server.Close()
	call := func(method, path string, body any, authenticated bool) (int, Object) {
		t.Helper()
		var encoded []byte
		if body != nil {
			encoded, _ = json.Marshal(body)
		}
		r, e := http.NewRequest(method, server.URL+path, strings.NewReader(string(encoded)))
		if e != nil {
			t.Fatal(e)
		}
		r.Header.Set("Content-Type", "application/json")
		r.Header.Set("Origin", config.AdminOrigin)
		r.Header.Set("X-Galaxy-Operator-CSRF", csrf)
		if authenticated {
			r.AddCookie(&http.Cookie{Name: "__Host-galaxy-operator", Value: token})
		}
		response, e := http.DefaultClient.Do(r)
		if e != nil {
			t.Fatal(e)
		}
		defer response.Body.Close()
		raw, _ := io.ReadAll(response.Body)
		var value Object
		if e = json.Unmarshal(raw, &value); e != nil {
			t.Fatalf("HTTP invalid JSON %d %s", response.StatusCode, raw)
		}
		return response.StatusCode, value
	}
	endpoint := "/v1/operations/content/publications"
	id := uuid.NewString()
	input := Object{"operationId": id, "snapshot": snapshot}
	if status, _ := call("POST", endpoint, input, false); status != 401 {
		t.Fatalf("anonymous request=%d", status)
	}
	status, result := call("POST", endpoint, input, true)
	if status != 200 || result["replayed"] != false {
		t.Fatalf("request %d %+v", status, result)
	}
	status, result = call("POST", endpoint, input, true)
	if status != 200 || result["replayed"] != true {
		t.Fatalf("original operation replay %d %+v", status, result)
	}
	var count int
	pool.QueryRow(ctx, "SELECT count(*) FROM galaxy_go_jobs.executions_v1 WHERE id=$1", id).Scan(&count)
	if count != 1 {
		t.Fatal("replay changed original task count")
	}
	var gateCount int
	pool.QueryRow(ctx, "SELECT count(*) FROM galaxy_go_jobs.control_v1").Scan(&gateCount)
	if gateCount != 0 {
		t.Fatal("request activated cutover")
	}
	status, result = call("GET", endpoint+"/"+id, nil, true)
	if status != 200 || result["publication"].(map[string]any)["id"] != id {
		t.Fatalf("unknown response recovery lookup %d %+v", status, result)
	}
	status, result = call("GET", endpoint+"?limit=1", nil, true)
	if status != 200 || len(result["items"].([]any)) != 1 {
		t.Fatalf("list %d %+v", status, result)
	}
	changedRaw, _ := json.Marshal(snapshot)
	var changed Object
	json.Unmarshal(changedRaw, &changed)
	changed["settings"].(map[string]any)["siteTitle"] = "changed"
	status, _ = call("POST", endpoint, Object{"operationId": id, "snapshot": changed}, true)
	if status != 409 {
		t.Fatalf("operation contents changed=%d", status)
	}
	jobPath := "/v1/operations/jobs/content-publication/" + id
	status, result = call("GET", jobPath, nil, true)
	if status != 200 || result["job"].(map[string]any)["resourceId"] != id {
		t.Fatalf("job read %d %+v", status, result)
	}
	status, result = call("POST", jobPath+"/cancel", Object{}, true)
	if status != 200 || result["state"] != "cancelled" {
		t.Fatalf("cancel %d %+v", status, result)
	}
	status, result = call("POST", jobPath+"/cancel", Object{}, true)
	if status != 200 {
		t.Fatalf("repeat cancel %d %+v", status, result)
	}
	if status, _ = call("POST", jobPath+"/retry", Object{}, true); status != 409 {
		t.Fatal("cancelled job resumed")
	}
	var state string
	var failure Object
	pool.QueryRow(ctx, "SELECT state,error FROM site_publications_v1 WHERE id=$1", id).Scan(&state, &failure)
	if state != "failed" || failure["code"] != "site_publication_cancelled" {
		t.Fatal("queue cancel omitted source cancellation")
	}
	retryID := uuid.NewString()
	status, result = call("POST", endpoint, Object{"operationId": retryID, "snapshot": snapshot}, true)
	if status != 200 {
		t.Fatalf("retry fixture request %d %+v", status, result)
	}
	// Exhausted original attempts are represented in the isolated durable source
	// and River row. The public retry uses River JobRetryTx and the same UUID.
	execute("UPDATE site_publications_v1 SET state='failed',error='{"+`"code":"site_publication_failed","retryable":true`+"}' WHERE id=$1", retryID)
	execute("UPDATE galaxy_go_jobs.executions_v1 SET state='failed',error_code='site_publication_failed' WHERE id=$1", retryID)
	execute("UPDATE galaxy_river.river_job SET state='discarded',attempt=max_attempts,finalized_at=now() WHERE id=(SELECT river_id FROM galaxy_go_jobs.executions_v1 WHERE id=$1)", retryID)
	status, result = call("POST", "/v1/operations/jobs/content-publication/"+retryID+"/retry", Object{}, true)
	if status != 200 || result["id"] != retryID || result["state"] != "created" {
		t.Fatalf("same operation retry %d %+v", status, result)
	}
	pending := uuid.NewString()
	status, _ = call("POST", endpoint, Object{"operationId": pending, "snapshot": snapshot}, true)
	if status != 200 {
		t.Fatal("pending request")
	}
	execute(`UPDATE site_publications_v1 SET result=jsonb_build_object('activationPending',true) WHERE id=$1`, pending)
	status, _ = call("POST", "/v1/operations/jobs/content-publication/"+pending+"/cancel", Object{}, true)
	if status != 409 {
		t.Fatal("unknown activation could be cancelled")
	}
	execute("UPDATE operations_role_assignments_v1 SET enabled=false WHERE id=$1", assignment)
	status, _ = call("GET", endpoint, nil, true)
	if status != 403 {
		t.Fatal("role revocation ignored")
	}
	var audits int
	pool.QueryRow(ctx, "SELECT count(*) FROM business_admin_audit_v1 WHERE action IN('job-cancel','job-retry')").Scan(&audits)
	if audits != 3 {
		t.Fatalf("original metadata audit missing: %d", audits)
	}
}
