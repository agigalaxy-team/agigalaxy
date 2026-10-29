package operationscommunity_test

import (
	"context"
	"errors"
	"github.com/agigalaxy-team/agigalaxy/go/internal/accounts"
	"github.com/agigalaxy-team/agigalaxy/go/internal/community"
	"github.com/agigalaxy-team/agigalaxy/go/internal/databaseschema"
	"github.com/agigalaxy-team/agigalaxy/go/internal/identity"
	"github.com/agigalaxy-team/agigalaxy/go/internal/objectremoval"
	"github.com/agigalaxy-team/agigalaxy/go/internal/operationsrules"
	"github.com/agigalaxy-team/agigalaxy/go/internal/postgres"
	"github.com/agigalaxy-team/agigalaxy/go/internal/testsupport/operationsfixture"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"testing"
	"time"
)

type fixtureAuthority struct{}

func (fixtureAuthority) Account(ctx context.Context, tx pgx.Tx, endpoint, id string) error {
	var exists bool
	if err := tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM community_accounts WHERE endpoint=$1 AND id=$2)`, endpoint, id).Scan(&exists); err != nil {
		return err
	}
	if !exists {
		return errors.New("synthetic account absent")
	}
	return nil
}
func seedManagedForum(t *testing.T, owner *pgxpool.Pool, f *operationsfixture.Fixture) object {
	t.Helper()
	ctx := context.Background()
	now := f.Now()
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
	if _, err := owner.Exec(ctx, `INSERT INTO operations_product_rules_v1(endpoint,policy_key,version,policy,source,created_at) VALUES($1,'business-controls',1,$2,'configured-baseline',$3)`, f.Endpoint, operationsrules.EmptyControls(), now); err != nil {
		t.Fatal(err)
	}
	codes := []any{"content.read", "sections.read", "sections.classify", "sections.hide", "sections.restore", "cases.read", "cases.resolve", "content.hide", "content.restore", "content.curate", "content.batch.hide", "content.batch.restore", "content.tags.read", "content.tags.manage"}
	result, err := f.Permissions.SaveRole(ctx, f.Root, object{"operationId": uuid.NewString(), "expectedVersion": 0, "name": "Forum operator", "description": "Synthetic forum authority", "enabled": true, "permissions": codes})
	if err != nil {
		t.Fatal(err)
	}
	role := obj(result["role"])
	if _, err = f.Permissions.SaveAssignment(ctx, f.Root, object{"operationId": uuid.NewString(), "expectedVersion": 0, "operatorId": f.IDs["writer"], "roleId": role["id"], "enabled": true}); err != nil {
		t.Fatal(err)
	}
	ids := []string{}
	service := &accounts.Service{Endpoint: f.Endpoint, Now: f.Now}
	for _, name := range []string{"source", "reporter"} {
		subject := uuid.NewString()
		if name == "reporter" {
			subject = "writer"
		}
		a, e := postgres.InTx(ctx, owner, func(tx pgx.Tx) (accounts.Account, error) {
			a, e := service.EnsureAccountWithin(ctx, tx, accounts.VerifiedIdentity{Issuer: f.Issuer, ExternalSubject: subject, VerificationMethod: "external-account", VerifiedAt: now.Add(-10000 * time.Second)})
			if e != nil {
				return a, e
			}
			kind := "person"
			_, e = service.EnsureProfileWithin(ctx, tx, a.ID, &kind)
			return a, e
		})
		if e != nil {
			t.Fatal(e)
		}
		if _, e = owner.Exec(ctx, `UPDATE official_account_profiles_v1 SET display_name=$2,query_enabled=true WHERE account_id=$1`, a.ID, "Original "+name); e != nil {
			t.Fatal(e)
		}
		ids = append(ids, a.ID)
	}
	forum := &community.Service{Pool: f.Pool, Endpoint: f.Endpoint, Authority: fixtureAuthority{}, Now: f.Now}
	bind := func(kind string, i int, p object) object {
		t.Helper()
		if !community.BindForumIDs(kind, ids[i], p) {
			t.Fatal("unknown kind", kind)
		}
		return p
	}
	section := bind("create-section", 0, object{"schemaVersion": 1, "operationId": uuid.NewString(), "sectionId": uuid.NewString(), "expectedVersion": 0, "accountId": ids[0], "title": "Original section", "theme": "Current topic", "description": "Original available section", "audience": object{"read": object{"kind": "everyone"}, "participate": object{"kind": "accounts"}}, "state": "active"})
	if _, err = forum.SaveSection(ctx, ids[0], string(enc(section))); err != nil {
		t.Fatal(err)
	}
	attachment := uuid.NewString()
	data := []byte("Original managed forum attachment.")
	sha := identity.Digest(data)
	if _, err = owner.Exec(ctx, `INSERT INTO forum_attachments_v1(id,account_id,request_hash,name,media_type,byte_size,sha256,storage_key,encryption_key_id,state,created_at,prepare_expires_at,uploaded_at,expires_at,scan_result) VALUES($1,$2,$3,'原运营附件.txt','text/plain',$4,$3,$5,'isolated-forum-key','available',$6,$7,$6,$7,'{"state":"clean"}')`, attachment, ids[0], sha, len(data), "forum-attachments/"+attachment, now, now.Add(time.Hour)); err != nil {
		t.Fatal(err)
	}
	post := bind("create-post", 0, object{"schemaVersion": 1, "operationId": uuid.NewString(), "accountId": ids[0], "postId": uuid.NewString(), "versionId": uuid.NewString(), "expectedHeadVersion": 0, "title": "原运营帖子 🚀", "body": "原公开正文，当前授权。", "links": []any{}, "attachments": []any{object{"id": attachment, "sha256": sha}}, "topic": "technology", "sectionId": section["sectionId"], "publishedUntil": now.Unix() + 3600})
	if _, err = forum.Publish(ctx, ids[0], string(enc(post))); err != nil {
		t.Fatal(err)
	}
	reply := bind("create-reply", 1, object{"schemaVersion": 1, "operationId": uuid.NewString(), "accountId": ids[1], "replyId": uuid.NewString(), "postId": post["postId"], "postVersionId": post["versionId"], "expectedRevision": 0, "body": "原独立回复正文。", "publishedUntil": now.Unix() + 1800, "replyTo": nil})
	if _, err = forum.CreateReply(ctx, ids[1], string(enc(reply))); err != nil {
		t.Fatal(err)
	}
	report := bind("create-report", 1, object{"schemaVersion": 1, "operationId": uuid.NewString(), "reportId": uuid.NewString(), "target": object{"kind": "post-version", "postId": post["postId"], "versionId": post["versionId"]}, "category": "privacy", "summary": "仅发送运营的原举报说明。"})
	if _, err = forum.Report(ctx, ids[1], string(enc(report))); err != nil {
		t.Fatal(err)
	}
	return object{"section": section, "post": post, "reply": reply, "report": report, "role": role, "codes": codes, "attachmentId": attachment}
}
