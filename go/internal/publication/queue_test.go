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
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/identity"
	"github.com/agigalaxy-team/agigalaxy/go/internal/jobs"
	"github.com/agigalaxy-team/agigalaxy/go/internal/postgres"
	"github.com/agigalaxy-team/agigalaxy/go/internal/testsupport"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

func TestRestrictedPublisherQueueWithStoredCurrentAuthority(t *testing.T) {
	pool, dsn := testsupport.PostgreSQL(t)
	node(t, dsn, "setup")
	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	defer cancel()
	config, files, snapshot, _, configPath := fixtureFiles(t)
	root, _ := filepath.Abs("../../..")
	execute := func(sql string, args ...any) {
		t.Helper()
		if _, e := pool.Exec(ctx, sql, args...); e != nil {
			t.Fatal(e)
		}
	}
	for _, name := range []string{"api-role.sql", "worker-role.sql", "content-publisher-role.sql"} {
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
	publisherPool, e := postgres.Open(ctx, dsn+"&options=-c%20role%3Dgalaxy_content_publisher")
	if e != nil {
		t.Fatal(e)
	}
	defer publisherPool.Close()
	issuer := "https://operator.invalid/realms/publishing"
	subject := "publisher-member"
	operator := identity.Digest([]byte(issuer + "\x00" + subject))
	rootID := identity.Digest([]byte(issuer + "\x00publisher-root"))
	for _, v := range []struct{ id, subject string }{{operator, subject}, {rootID, "publisher-root"}} {
		execute(`INSERT INTO operations_operator_principals_v1(operator_id,endpoint,issuer,external_subject,display_name,created_at,updated_at) VALUES($1,$2,$3,$4,'隔离发布人员',now(),now())`, v.id, config.Endpoint, issuer, v.subject)
	}
	role, assignment := uuid.NewString(), uuid.NewString()
	execute(`INSERT INTO operations_business_roles_v1(id,endpoint,name,enabled,version,permissions,created_by,updated_by,created_at,updated_at) VALUES($1,$2,'内容发布',true,1,ARRAY['cms.publish'],$3,$3,now(),now())`, role, config.Endpoint, rootID)
	execute(`INSERT INTO operations_role_assignments_v1(id,endpoint,operator_id,role_id,enabled,version,created_by,updated_by,created_at,updated_at) VALUES($1,$2,$3,$4,true,1,$5,$5,now(),now())`, assignment, config.Endpoint, operator, role, rootID)
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		if strings.HasSuffix(r.URL.Path, "/token") {
			r.ParseForm()
			if r.Form.Get("client_id") != "fixture-publisher" || r.Form.Get("client_secret") != "synthetic-read-only-directory" {
				w.WriteHeader(401)
				return
			}
			io.WriteString(w, `{"access_token":"synthetic-directory-token","expires_in":120}`)
			return
		}
		if r.Header.Get("Authorization") != "Bearer synthetic-directory-token" {
			w.WriteHeader(401)
			return
		}
		if strings.HasSuffix(r.URL.Path, "/role-mappings/realm/composite") {
			io.WriteString(w, `[{"name":"galaxy-reader"}]`)
			return
		}
		json.NewEncoder(w).Encode(map[string]any{"id": subject, "enabled": true})
	}))
	defer upstream.Close()
	write := func(name string, value any) string {
		t.Helper()
		path := filepath.Join(filepath.Dir(configPath), name)
		b, _ := json.Marshal(value)
		if e := os.WriteFile(path, b, 0600); e != nil {
			t.Fatal(e)
		}
		return path
	}
	rootFile := write("root.json", map[string]any{"version": 1, "endpoint": config.Endpoint, "issuer": issuer, "externalSubject": "publisher-root", "operatorId": rootID})
	credential := write("directory.json", map[string]any{"version": 1, "clientId": "fixture-publisher", "clientSecret": "synthetic-read-only-directory"})
	operations := write("operations.json", map[string]any{"version": 1, "adminOrigin": config.AdminOrigin, "issuer": issuer, "clientId": "fixture-admin", "directoryCredentialFile": credential, "directoryOrigin": upstream.URL, "roles": map[string]string{"administrator": "galaxy-admin", "reader": "galaxy-reader"}, "rootOperatorFile": rootFile, "sessionRenewal": map[string]any{"keyFile": filepath.Join(filepath.Dir(configPath), "INTENTIONALLY_ABSENT_REFRESH_KEY")}})
	authority, e := access.LoadWorker(ctx, publisherPool, config.Endpoint, operations)
	if e != nil {
		t.Fatal(e)
	}
	service := &Service{Pool: publisherPool, Endpoint: config.Endpoint, PublicOrigin: config.PublicOrigin, Publisher: files, Authority: authority}
	q, e := jobs.NewWithQueues(publisherPool, func(ctx context.Context, t jobs.Task) (jobs.Outcome, error) {
		if t.Action != jobs.ContentPublication || t.Endpoint != config.Endpoint || t.ID != t.SourceID || t.ID != t.OperationID {
			return jobs.Outcome{}, fault.New("operations_job_source_changed", 409)
		}
		result, e := service.Execute(ctx, t.SourceID)
		return jobs.Outcome{Result: result}, e
	}, map[string]int{jobs.ContentPublication: 1})
	if e != nil {
		t.Fatal(e)
	}
	producer, e := jobs.New(pool, nil)
	if e != nil {
		t.Fatal(e)
	}
	id := uuid.NewString()
	raw, _ := json.Marshal(snapshot)
	execute(`INSERT INTO site_publications_v1(id,endpoint,requested_by,snapshot,state,created_at,updated_at) VALUES($1,$2,$3,$4,'queued',now(),now())`, id, config.Endpoint, operator, raw)
	task := jobs.Task{ID: id, Endpoint: config.Endpoint, Action: jobs.ContentPublication, SourceID: id, OperationID: id}
	tx, e = pool.Begin(ctx)
	if e != nil {
		t.Fatal(e)
	}
	if _, e = producer.EnqueueWithin(ctx, tx, task, time.Time{}); e != nil {
		t.Fatal(e)
	}
	if e = tx.Commit(ctx); e != nil {
		t.Fatal(e)
	}
	// Explicit administrative adoption exists only in this synthetic cluster.
	execute("INSERT INTO galaxy_go_jobs.control_v1(endpoint,backend) VALUES($1,'river')", config.Endpoint)
	work, stop := context.WithCancel(ctx)
	defer stop()
	if e = q.Start(work); e != nil {
		t.Fatal(e)
	}
	defer func() {
		cleanup, c := context.WithTimeout(context.Background(), 10*time.Second)
		defer c()
		if e := q.Stop(cleanup); e != nil {
			t.Error(e)
		}
	}()
	deadline := time.Now().Add(15 * time.Second)
	for {
		view, e := producer.Get(ctx, config.Endpoint, id)
		if e == nil && view.State == "succeeded" {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("restricted publisher did not finish: %+v %v", view, e)
		}
		time.Sleep(25 * time.Millisecond)
	}
	current, e := files.Current(ctx)
	if e != nil || current.PublicationID != id {
		t.Fatalf("queued original publication was not activated: %+v %v", current, e)
	}
	var schemaWriter bool
	if e = publisherPool.QueryRow(ctx, "SELECT has_table_privilege(current_user,'galaxy_go_jobs.control_v1','UPDATE') OR has_table_privilege(current_user,'operations_operator_principals_v1','UPDATE')").Scan(&schemaWriter); e != nil || schemaWriter {
		t.Fatal("publisher gained gate/principal writes")
	}
	// The exact same stored authority loses its business permission immediately.
	execute("UPDATE operations_role_assignments_v1 SET enabled=false WHERE id=$1", assignment)
	_, e = postgres.InTx(ctx, publisherPool, func(tx pgx.Tx) (bool, error) {
		e := authority.Revalidate(ctx, tx, operator, "cms.publish")
		return e == nil, e
	})
	if fault.Code(e) != "operations_permission_denied" {
		t.Fatalf("stored publisher borrowed stale grant: %v", e)
	}
	var sessions int
	pool.QueryRow(ctx, "SELECT count(*) FROM operations_operator_sessions_v1").Scan(&sessions)
	if sessions != 0 {
		t.Fatal("publisher created or borrowed a portal session")
	}
}
