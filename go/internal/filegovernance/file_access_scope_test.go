package filegovernance_test

import (
	"context"
	"testing"
	"time"

	files "github.com/agigalaxy-team/agigalaxy/go/internal/filegovernance"
	"github.com/agigalaxy-team/agigalaxy/go/internal/operationspermissions"
	"github.com/agigalaxy-team/agigalaxy/go/internal/postgres"
	"github.com/agigalaxy-team/agigalaxy/go/internal/testsupport"
	"github.com/agigalaxy-team/agigalaxy/go/internal/testsupport/operationsfixture"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

func TestLegacyDeviceFileRemainsReadableForPreparation(t *testing.T) {
	ctx := context.Background()
	owner, _ := testsupport.PostgreSQL(t)
	f := operationsfixture.Principals(t, owner, "https://files.example.invalid", map[string]string{"root": "R", "writer": "W", "empty": "E"})
	automation := f.Automation(t)
	seed := seedManagedFiles(t, owner, f, &fixtureStore{dir: t.TempDir()})
	role, e := f.Permissions.SaveRole(ctx, f.Root, object{"operationId": uuid.NewString(), "expectedVersion": 0, "name": "File read fixture", "description": "Synthetic", "subjectScope": "ai-only", "enabled": true, "permissions": []string{"files.read", "files.access.stop"}})
	if e != nil {
		t.Fatal(e)
	}
	if _, e = f.Permissions.AIWorkAssignment(ctx, f.Root, "maintenance", object{"operationId": uuid.NewString(), "expectedVersion": 0, "roleId": obj(role["role"])["id"], "enabled": true}); e != nil {
		t.Fatal(e)
	}
	subject, room, id := "device-fixture", uuid.NewString(), uuid.NewString()
	now := f.Now()
	if _, e = owner.Exec(ctx, `INSERT INTO subjects(id,public_key,genesis_proof) VALUES($1,'fixture','{}')`, subject); e != nil {
		t.Fatal(e)
	}
	if _, e = owner.Exec(ctx, `INSERT INTO chat_rooms(room_id,creator_subject_id,operation_id,request_hash,title,created_at,updated_at) VALUES($1,$2,$3,'fixture','fixture',$4,$4)`, room, subject, uuid.NewString(), now); e != nil {
		t.Fatal(e)
	}
	if _, e = owner.Exec(ctx, `INSERT INTO chat_attachments(id,room_id,subject_id,request_hash,name,media_type,byte_size,sha256,storage_key,encryption_key_id,state,created_at,prepare_expires_at,uploaded_at,expires_at) VALUES($1,$2,$3,'fixture','fixture','text/plain',1,'fixture',$4,'fixture','available',$5,$6,$5,$6)`, id, room, subject, "chat/"+id, now, now.Add(time.Hour)); e != nil {
		t.Fatal(e)
	}
	actor, e := postgres.InTx(ctx, f.Pool, func(tx pgx.Tx) (operationspermissions.Actor, error) {
		return f.Permissions.HumanAIWithin(ctx, tx, f.Root, "maintenance", "prepare", "files.read")
	})
	if e != nil {
		t.Fatal(e)
	}
	s := &files.Service{Pool: f.Pool, Endpoint: f.Endpoint, Authority: f.Permissions.PreparationReader(), Now: f.Now}
	result, e := s.Get(ctx, actor, "chat", id)
	if e != nil {
		t.Fatal(e)
	}
	access := obj(result["access"])
	eligibility := obj(access["preparationEligibility"])
	if eligibility["basis"] != "not-checked" || eligibility["stop"] != nil || eligibility["restore"] != nil {
		t.Fatal("legacy source incorrectly qualified")
	}
	var forumID string
	for _, item := range seed["rows"].([]any) {
		if r := obj(item); r["kind"] == "available" {
			forumID = str(r["id"])
		}
	}
	if forumID == "" {
		t.Fatal("missing forum fixture")
	}
	foreign := *s
	foreign.Endpoint = "https://foreign.example.invalid"
	tx, e := f.Pool.Begin(ctx)
	if e != nil {
		t.Fatal(e)
	}
	if _, e = foreign.ScopeFileAccessWithin(ctx, tx, "forum", forumID, false); e == nil {
		t.Fatal("foreign endpoint accepted")
	}
	_ = tx.Rollback(ctx)
	forum, e := s.Get(ctx, actor, "forum", forumID)
	if e != nil {
		t.Fatal(e)
	}
	accountID := str(obj(automation["accounts"])["maintenance"])
	count := 0
	authorize := func(ctx context.Context, tx pgx.Tx) (operationspermissions.Actor, error) {
		count++
		if count == 3 {
			if _, err := tx.Exec(ctx, `UPDATE operations_ai_work_accounts_v1 SET enabled=false WHERE id=$1`, accountID); err != nil {
				return operationspermissions.Actor{}, err
			}
		}
		return f.Permissions.HumanAIWithin(ctx, tx, f.Root, "maintenance", "prepare", "files.read")
	}
	_, e = s.ChangePreparedAccess(ctx, actor, "forum", forumID, object{"operationId": uuid.NewString(), "action": "stop", "until": now.Add(10 * time.Minute).Unix(), "reason": "Synthetic", "expectedVersion": forum["version"], "expectedRevision": obj(forum["access"])["revision"]}, authorize)
	if e == nil || count < 3 {
		t.Fatal("mid-transaction AI revocation accepted")
	}
	var events int
	if e = owner.QueryRow(ctx, `SELECT count(*) FROM operations_file_access_events_v1 WHERE endpoint=$1 AND file_id=$2`, f.Endpoint, forumID).Scan(&events); e != nil || events != 0 {
		t.Fatalf("revoked write created event count=%d err=%v", events, e)
	}
}
