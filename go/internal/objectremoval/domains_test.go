package objectremoval_test

import (
	"bytes"
	"context"
	"github.com/agigalaxy-team/agigalaxy/go/internal/attachments"
	"github.com/agigalaxy-team/agigalaxy/go/internal/chat"
	"github.com/agigalaxy-team/agigalaxy/go/internal/community"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/objectremoval"
	"github.com/agigalaxy-team/agigalaxy/go/internal/postgres"
	"github.com/agigalaxy-team/agigalaxy/go/internal/testsupport"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
	"time"
)

type store struct {
	dir, mode string
	erases    int
}

func (s *store) KeyID() string          { return "isolated-removal-key" }
func (s *store) path(key string) string { return filepath.Join(s.dir, filepath.Base(key)) }
func (s *store) Put(_ context.Context, key string, b []byte, _ string) error {
	return os.WriteFile(s.path(key), b, 0600)
}
func (s *store) Get(_ context.Context, key, _ string, _ int64) ([]byte, error) {
	return os.ReadFile(s.path(key))
}
func (s *store) Head(_ context.Context, key, _ string) (*attachments.Head, error) {
	b, e := os.ReadFile(s.path(key))
	if os.IsNotExist(e) {
		return nil, nil
	}
	if e != nil {
		return nil, e
	}
	hash := attachments.Digest(b)
	return &attachments.Head{Size: int64(len(b)), SHA256: &hash}, nil
}
func (s *store) Erase(_ context.Context, key string) error {
	s.erases++
	if s.mode == "unknown-present" {
		return fault.New("attachment_storage_unavailable", 503)
	}
	e := os.Remove(s.path(key))
	if os.IsNotExist(e) {
		e = nil
	}
	if s.mode == "unknown-absent" {
		return fault.New("attachment_storage_unavailable", 503)
	}
	return e
}

type scanner struct{}

func (scanner) Scan(context.Context, []byte) (map[string]any, error) {
	return map[string]any{"state": "clean"}, nil
}
func TestAttachmentWorkersReconcileOnlyAndKeepOriginalScanEvidence(t *testing.T) {
	testAttachmentWorkers(t, false)
}
func TestChatAttachmentWorkerReconcileAfterRoomFixture(t *testing.T) { testAttachmentWorkers(t, true) }
func testAttachmentWorkers(t *testing.T, chatOnly bool) {
	owner, dsn := testsupport.PostgreSQL(t)
	ctx := context.Background()
	root, _ := filepath.Abs("../../..")
	cmd := exec.Command("node", "--input-type=module", "-e", `import pg from './packages/galaxy-official/node_modules/pg/lib/index.js';import{migrate}from './packages/galaxy-official/src/infrastructure/database.mjs';const u=new URL(process.env.GALAXY_GO_TEST_DATABASE_URL);if(u.hostname!=='127.0.0.1'||!u.pathname.startsWith('/galaxy_go_test_'))throw Error('isolated required');const db=new pg.Pool({connectionString:u.href});try{await migrate(db,{roles:['api','worker']})}finally{await db.end()}`)
	cmd.Dir = root
	cmd.Env = append(os.Environ(), "GALAXY_GO_TEST_DATABASE_URL="+dsn)
	if b, e := cmd.CombinedOutput(); e != nil {
		t.Fatalf("original migrations %v %s", e, b)
	}
	if _, e := postgres.InTx(ctx, owner, func(tx pgx.Tx) (any, error) {
		if e := objectremoval.MigrateWithin(ctx, tx); e != nil {
			return nil, e
		}
		return nil, objectremoval.ProvisionRolesWithin(ctx, tx)
	}); e != nil {
		t.Fatal(e)
	}
	cfg, _ := pgxpool.ParseConfig(dsn)
	cfg.AfterConnect = func(ctx context.Context, c *pgx.Conn) error {
		_, e := c.Exec(ctx, "SET ROLE galaxy_evidence_worker")
		return e
	}
	worker, e := pgxpool.NewWithConfig(ctx, cfg)
	if e != nil {
		t.Fatal(e)
	}
	defer worker.Close()
	now := time.Unix(2000000000, 0)
	clock := func() time.Time { return now }
	endpoint := "https://removal-domains.example.invalid"
	account := uuid.NewString()
	if _, e = owner.Exec(ctx, "INSERT INTO community_accounts(id,endpoint,issuer,external_subject,verification_method,verified_at,created_at)VALUES($1::uuid,$2,'https://isolated.example.invalid',$1::text,'external-account',$3,$3)", account, endpoint, now); e != nil {
		t.Fatal(e)
	}
	room := uuid.NewString()
	if _, e = owner.Exec(ctx, "INSERT INTO chat_participants_v3(actor_ref,kind,account_id)VALUES($1,'official-account',$2) ON CONFLICT DO NOTHING", "account:"+account, account); e != nil {
		t.Fatal(e)
	}
	if _, e = owner.Exec(ctx, "INSERT INTO chat_rooms(room_id,creator_subject_id,operation_id,request_hash,title,created_at,updated_at)VALUES($1,$2,$3,$4,'Isolated cleanup room',$5,$5)", room, "account:"+account, uuid.NewString(), attachments.Digest([]byte(room)), now); e != nil {
		t.Fatal(e)
	}
	for _, domain := range []string{"forum", "chat"} {
		if chatOnly && domain != "chat" {
			continue
		}
		s := &store{dir: t.TempDir(), mode: "unknown-present"}
		table := "forum_attachments_v1"
		keyPrefix := "forum-attachments/"
		if domain == "chat" {
			table = "chat_attachments"
			keyPrefix = "attachments/"
		}
		var purge func() (map[string]any, error)
		freshConsumer := func() {
			if domain == "forum" {
				f := &community.AttachmentService{Forum: &community.Service{Pool: worker, Endpoint: endpoint, Now: clock}, Store: s, Scanner: scanner{}}
				purge = func() (map[string]any, error) { return f.PurgeExpired(ctx, 10) }
			} else {
				f := &chat.AttachmentService{Chat: &chat.Service{Pool: worker, Endpoint: endpoint, Now: clock}, Store: s, Scanner: scanner{}}
				purge = func() (map[string]any, error) { return f.PurgeExpired(ctx, 10) }
			}
		}
		freshConsumer()
		body := []byte("Original synthetic cleanup bytes")
		hash := attachments.Digest(body)
		insert := func(lastError string, activeLease bool) (string, string, string) {
			t.Helper()
			id, lease := uuid.NewString(), uuid.NewString()
			key := keyPrefix + id
			if e := s.Put(ctx, key, body, hash); e != nil {
				t.Fatal(e)
			}
			leaseUntil := now.Add(-time.Minute)
			if activeLease {
				leaseUntil = now.Add(time.Hour)
			}
			columns := "id,subject_id,request_hash,name,media_type,byte_size,sha256,storage_key,encryption_key_id,state,created_at,prepare_expires_at,uploaded_at,expires_at,scan_attempts,scan_result,last_error,revoked_at,purge_pending,lease_id,lease_until"
			actor := "account:" + account
			args := []any{id, actor, hash, "Original filename", "text/plain", len(body), hash, key, s.KeyID(), "available", now.Add(-time.Hour), now.Add(time.Hour), now.Add(-time.Minute), now.Add(time.Hour), 2, []byte(`{"state":"clean","checkedAt":1999999900}`), lastError, now.Add(-time.Second), true, lease, leaseUntil}
			if domain == "forum" {
				columns = "id,account_id" + columns[len("id,subject_id"):]
				args[1] = account
			}
			values := "$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21"
			if domain == "chat" {
				columns += ",room_id"
				values += ",$22"
				args = append(args, room)
			}
			_, e = owner.Exec(ctx, "INSERT INTO "+table+"("+columns+") VALUES("+values+")", args...)
			if e != nil {
				t.Fatal(e)
			}
			return id, key, lease
		}
		check := func(id, lease, errorValue string, removed bool) {
			t.Helper()
			var gotLease, gotError, state string
			var scan []byte
			var purged *time.Time
			if e = owner.QueryRow(ctx, "SELECT lease_id::text,last_error,scan_result,state,purged_at FROM "+table+" WHERE id=$1", id).Scan(&gotLease, &gotError, &scan, &state, &purged); e != nil {
				t.Fatal(e)
			}
			if gotLease != lease || gotError != errorValue || !bytes.Contains(scan, []byte(`"clean"`)) || (purged != nil) != removed || removed && state != "erased" {
				t.Fatalf("%s original scan/lease/failure changed lease%v error%v state%v purged%v", domain, gotLease, gotError, state, purged)
			}
		}
		id, key, lease := insert("attachment_scan_failed", false)
		_, e = purge()
		if e != nil && fault.Code(e) != "attachment_storage_unavailable" {
			t.Fatal(e)
		}
		check(id, lease, "attachment_scan_failed", false)
		if s.erases != 1 {
			t.Fatal("first dispatch", domain, s.erases)
		}
		freshConsumer()
		if _, e = purge(); e != nil {
			t.Fatal(e)
		}
		if s.erases != 1 {
			t.Fatal("unknown DELETE resent", domain, s.erases)
		}
		if e = os.Remove(s.path(key)); e != nil {
			t.Fatal(e)
		}
		if _, e = purge(); e != nil {
			t.Fatal(e)
		}
		check(id, lease, "attachment_scan_failed", true)
		if s.erases != 1 {
			t.Fatal("reconciliation sent DELETE", domain, s.erases)
		}
		id, key, lease = insert("attachment_cleanup_failed", false)
		if _, e = purge(); e != nil {
			t.Fatal(e)
		}
		check(id, lease, "attachment_cleanup_failed", false)
		if s.erases != 1 {
			t.Fatal("legacy failure inferred dispatch/retry", domain, s.erases)
		}
		var op *string
		if e = owner.QueryRow(ctx, "SELECT operation_id::text FROM galaxy_go_storage.object_removals_v1 WHERE endpoint=$1 AND domain=$2 AND object_id=$3", endpoint, domain, id).Scan(&op); e != nil || op != nil {
			t.Fatal("legacy operation invented", op, e)
		}
		os.Remove(s.path(key))
		if _, e = purge(); e != nil {
			t.Fatal(e)
		}
		check(id, lease, "attachment_cleanup_failed", true)
		id, _, lease = insert("attachment_scan_failed", true)
		if _, e = purge(); e != nil {
			t.Fatal(e)
		}
		check(id, lease, "attachment_scan_failed", false)
		if s.erases != 1 {
			t.Fatal("active original lease overwritten", domain, s.erases)
		}
		s.mode = "unknown-absent"
		id, _, lease = insert("attachment_scan_failed", false)
		if _, e = purge(); e != nil {
			t.Fatal(e)
		}
		check(id, lease, "attachment_scan_failed", true)
		if s.erases != 2 {
			t.Fatal("lost ACK completion", domain, s.erases)
		}
	}
}
