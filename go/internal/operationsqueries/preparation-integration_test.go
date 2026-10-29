package operationsqueries

import (
	"context"
	"testing"
	"time"

	"github.com/agigalaxy-team/agigalaxy/go/internal/accountlinks"
	"github.com/agigalaxy-team/agigalaxy/go/internal/community"
	"github.com/agigalaxy-team/agigalaxy/go/internal/databaseschema"
	"github.com/agigalaxy-team/agigalaxy/go/internal/filegovernance"
	"github.com/agigalaxy-team/agigalaxy/go/internal/identity"
	"github.com/agigalaxy-team/agigalaxy/go/internal/objectremoval"
	"github.com/agigalaxy-team/agigalaxy/go/internal/operationscommunity"
	"github.com/agigalaxy-team/agigalaxy/go/internal/postgres"
	"github.com/agigalaxy-team/agigalaxy/go/internal/testsupport"
	"github.com/agigalaxy-team/agigalaxy/go/internal/testsupport/operationsfixture"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

func TestPreparationReadCurrentFileAndCasePermissions(t *testing.T) {
	owner, _ := testsupport.PostgreSQL(t)
	ctx := context.Background()
	f := operationsfixture.New(t, owner)
	f.Automation(t)
	if _, err := databaseschema.Migrate(ctx, owner, []string{"worker"}); err != nil {
		t.Fatal(err)
	}
	if _, err := postgres.InTx(ctx, owner, func(tx pgx.Tx) (bool, error) {
		if err := objectremoval.MigrateWithin(ctx, tx); err != nil {
			return false, err
		}
		return true, objectremoval.ProvisionRolesWithin(ctx, tx)
	}); err != nil {
		t.Fatal(err)
	}
	role := seedQueryRole(t, f, "governance", []any{"files.read", "files.scan.retry", "cases.read", "cases.resolve"})
	published := seedQueryPublication(t, f)
	account := str(published["accounts"].([]any)[0])
	post := object(published["payload"])
	forum := &community.Service{Pool: f.Pool, Endpoint: f.Endpoint, Authority: publicationFixtureAuthority{}, Now: f.Now, OperationsHandling: true}
	if _, err := forum.Publish(ctx, account, encoded(post)); err != nil {
		t.Fatal(err)
	}
	report := Object{"schemaVersion": 1, "operationId": uuid.NewString(), "reportId": uuid.NewString(), "target": Object{"kind": "post-version", "postId": post["postId"], "versionId": post["versionId"]}, "category": "privacy", "summary": "Synthetic review."}
	community.BindForumIDs("create-report", account, report)
	if _, err := forum.Report(ctx, account, encoded(report)); err != nil {
		t.Fatal(err)
	}
	fileID := uuid.NewString()
	at := f.Now()
	hash := identity.Digest([]byte("synthetic file"))
	if _, err := owner.Exec(ctx, `INSERT INTO forum_attachments_v1(id,account_id,request_hash,name,media_type,byte_size,sha256,storage_key,encryption_key_id,state,created_at,prepare_expires_at,uploaded_at,expires_at,scan_attempts,scan_result,last_error) VALUES($1,$2,$3,'Synthetic file','text/plain',14,$3,$4,'isolated-managed-key','scan-pending',$5,$6,$5,$6,1,NULL,'attachment_scan_failed')`, fileID, account, hash, "forum-attachments/"+fileID, at, at.Add(time.Hour)); err != nil {
		t.Fatal(err)
	}
	files := &filegovernance.Service{Pool: f.Pool, Endpoint: f.Endpoint, Authority: f.Gateway, PrincipalWithin: f.Gateway.LockOperationsPrincipalWithin, Now: f.Now, Forum: &filegovernance.FileAdapter{Available: func() bool { return true }}}
	cases := &operationscommunity.Service{Pool: f.Pool, Endpoint: f.Endpoint, Authority: f.Gateway, PrincipalWithin: f.Gateway.LockOperationsPrincipalWithin, ReadPrincipalWithin: f.Gateway.ReadOperationsPrincipalWithin, Forum: forum, Links: &accountlinks.Service{Endpoint: f.Endpoint}, Now: f.Now}
	queries := &Service{Pool: f.Pool, Permissions: f.Permissions, Files: files, Community: cases, Now: f.Now}
	read := func(kind, id string) Object {
		t.Helper()
		out, err := queries.Query(ctx, f.Root, "governance", "read-operation-object", Object{"kind": kind, "id": id})
		if err != nil {
			t.Fatal(kind, err)
		}
		return object(out["data"])
	}
	file := read("forum-file", fileID)
	if file["canRetryScan"] != true {
		t.Fatalf("scan eligibility %#v", file)
	}
	caseData := read("case", str(report["reportId"]))
	if object(caseData["handling"])["canModerate"] != true {
		t.Fatalf("case eligibility %#v", caseData["handling"])
	}
	if access := object(file["access"]); access["canStop"] != false || object(access["preparationEligibility"])["stop"] != nil {
		t.Fatalf("file-access boundary %#v", access)
	}
	_, err := f.Permissions.SaveRole(ctx, f.Root, Object{"id": role["id"], "operationId": uuid.NewString(), "expectedVersion": role["version"], "name": "Selected governance query role", "description": "Synthetic current read source", "subjectScope": "ai-only", "enabled": true, "permissions": []any{"files.read", "cases.read"}})
	if err != nil {
		t.Fatal(err)
	}
	file = read("forum-file", fileID)
	caseData = read("case", str(report["reportId"]))
	if file["canRetryScan"] != false || object(caseData["handling"])["canModerate"] != false {
		t.Fatalf("revoked eligibility file=%v case=%v", file["canRetryScan"], object(caseData["handling"])["canModerate"])
	}
}
