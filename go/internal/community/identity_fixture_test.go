package community

import (
	"context"
	"github.com/agigalaxy-team/agigalaxy/go/internal/accountlinks"
	"github.com/agigalaxy-team/agigalaxy/go/internal/databaseschema"
	"github.com/agigalaxy-team/agigalaxy/go/internal/deviceauth"
	"github.com/agigalaxy-team/agigalaxy/go/internal/identity"
	"github.com/agigalaxy-team/agigalaxy/go/internal/objectremoval"
	"github.com/agigalaxy-team/agigalaxy/go/internal/postgres"
	"github.com/agigalaxy-team/agigalaxy/go/internal/testsupport/deviceauthfixture"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"sort"
	"testing"
	"time"
)

// syntheticIdentityFixture uses real Go control, binding and signed consent.
// Its external identity link is a synthetic already-verified OIDC fact; the
// production account-link consumer still performs its ordinary checks.
func syntheticIdentityFixture(t *testing.T, pool *pgxpool.Pool) Object {
	t.Helper()
	ctx := context.Background()
	endpoint := "https://go-community.example.invalid"
	at := int64(2000000000)
	now := func() time.Time { return time.Unix(at, 0) }
	issuer := "https://identity.example.invalid/realms/forum"
	scopes := []string{"binding", "consent", "assistance", "moderation", "history"}
	owner := deviceauthfixture.NewEndpoint(t, pool, t.TempDir(), scopes, endpoint)
	reporter := deviceauthfixture.NewEndpoint(t, pool, t.TempDir(), scopes, endpoint)
	moderator := deviceauthfixture.NewEndpoint(t, pool, t.TempDir(), scopes, endpoint)
	if _, e := databaseschema.Migrate(ctx, pool, []string{"worker"}); e != nil {
		t.Fatal(e)
	}
	if _, e := postgres.InTx(ctx, pool, func(tx pgx.Tx) (bool, error) {
		if e := objectremoval.MigrateWithin(ctx, tx); e != nil {
			return false, e
		}
		return true, objectremoval.ProvisionRolesWithin(ctx, tx)
	}); e != nil {
		t.Fatal(e)
	}
	if _, e := pool.Exec(ctx, `INSERT INTO operations_product_rules_v1(endpoint,policy_key,version,policy,source,created_at) VALUES($1,'business-controls',1,$2,'configured-baseline',$3) ON CONFLICT DO NOTHING`, endpoint, controls(), now()); e != nil {
		t.Fatal(e)
	}
	linkAccount := func(w deviceauthfixture.Fixture, subject string) string {
		t.Helper()
		registry := &accountlinks.Service{Pool: pool, Endpoint: endpoint, Devices: w.Service, Providers: []accountlinks.Provider{{Issuer: issuer, ClientID: "galaxy-fixture"}}, Now: now}
		linkID := uuid.NewString()
		payload := string(encode(Object{"version": 1, "id": linkID, "subjectId": w.Actor.SubjectID, "endpoint": endpoint, "issuer": issuer, "externalSubject": subject}))
		key, e := identity.PrivatePEM([]byte(w.Materials.OwnerPrivate))
		if e != nil {
			t.Fatal(e)
		}
		sig, e := identity.SignIdentityPayload(key, payload, "galaxy-identity-link+jws")
		if e != nil {
			t.Fatal(e)
		}
		value, e := postgres.InTx(ctx, pool, func(tx pgx.Tx) (Object, error) {
			control, e := w.Service.CurrentControlWithin(ctx, tx, w.Actor, "binding")
			if e != nil {
				return nil, e
			}
			_, e = tx.Exec(ctx, `INSERT INTO external_identity_links(id,subject_id,binding_id,endpoint,provider_id,issuer,external_subject,client_id,payload_text,payload_hash,signature,created_at,signer_key_id,control_epoch,control_event_hash) VALUES($1,$2,$3,$4,'forum-fixture',$5,$6,'galaxy-fixture',$7,$8,$9,$10,$11,$12,$13)`, linkID, w.Actor.SubjectID, w.Actor.BindingID, endpoint, issuer, subject, payload, identity.Digest([]byte(payload)), sig, now(), control.KeyID, control.Epoch, control.ChainHead)
			if e != nil {
				return nil, e
			}
			return registry.LinkVerifiedWithin(ctx, tx, accountlinks.VerifiedLink{SubjectID: w.Actor.SubjectID, LinkID: linkID, Endpoint: endpoint, Issuer: issuer, ExternalSubject: subject, VerificationMethod: "external-account", VerifiedAt: at})
		})
		if e != nil {
			t.Fatal(e)
		}
		return str(value, "accountId")
	}
	ownerAccount := linkAccount(owner, "go-community-owner")
	reporterAccount := linkAccount(reporter, "go-community-reporter")
	envelope := func(w deviceauthfixture.Fixture, kind string, p Object, viewers []string) Object {
		t.Helper()
		BindForumIDs(kind, w.Actor.SubjectID, p)
		raw := string(encode(p))
		fields := make([]string, 0, len(p))
		for key := range p {
			fields = append(fields, key)
		}
		sort.Strings(fields)
		action, objectKey, visibility := "", "", "Public"
		switch kind {
		case "create-post", "publish-version":
			action, objectKey = "forum.post.publish", "versionId"
		case "create-reply":
			action, objectKey = "forum.reply.publish", "replyId"
		case "withdraw-post", "withdraw-version", "withdraw-reply":
			action, objectKey = "forum.withdraw", "operationId"
		case "create-report":
			action, objectKey, visibility = "forum.report.publish", "reportId", "Private"
		case "supplement", "withdraw-report", "appeal":
			action, objectKey, visibility = "forum.report.event", "governanceEventId", "Private"
		case "resolve":
			action, objectKey, visibility = "forum.governance.resolve", "governanceEventId", "Private"
		case "create-section":
			action, objectKey = "forum.section.write", "sectionId"
		case "classify-section":
			action, objectKey = "forum.section.classify", "sectionId"
		default:
			t.Fatalf("unsupported fixture kind %s", kind)
		}
		expires := at + 3600
		if num(p, "publishedUntil") > 0 {
			expires = num(p, "publishedUntil")
		}
		purpose := "public-profile"
		if visibility == "Private" {
			purpose = "operational"
		}
		if viewers == nil {
			viewers = []string{}
		}
		intent := deviceauth.ConsentIntent{Version: 1, ID: uuid.NewString(), SubjectID: w.Actor.SubjectID, BindingID: w.Actor.BindingID, Endpoint: endpoint, ObjectID: str(p, objectKey), Action: action, Purpose: purpose, Recipient: endpoint, Fields: fields, Visibility: visibility, Viewers: viewers, PayloadHash: identity.Digest([]byte(raw)), PolicyVersion: "0.1", IssuedAt: at, ExpiresAt: expires}
		key, e := identity.PrivatePEM([]byte(w.Materials.OwnerPrivate))
		if e != nil {
			t.Fatal(e)
		}
		signed, e := identity.SignIdentityPayload(key, string(encode(intent)), "galaxy-consent+jws")
		if e != nil {
			t.Fatal(e)
		}
		return Object{"payload": p, "payloadJson": raw, "signedIntent": signed}
	}
	post := Object{"schemaVersion": 1, "operationId": uuid.NewString(), "postId": uuid.NewString(), "expectedHeadVersion": 0, "versionId": uuid.NewString(), "title": "Independent ordinary discussion", "body": "A useful question without a Task, model or history prerequisite.", "links": []any{}, "publishedUntil": at + 3600}
	postE := envelope(owner, "create-post", post, nil)
	reply := Object{"schemaVersion": 1, "operationId": uuid.NewString(), "replyId": uuid.NewString(), "postId": post["postId"], "postVersionId": post["versionId"], "expectedRevision": 0, "body": "An exact-version reply.", "publishedUntil": at + 1800, "replyTo": nil}
	replyE := envelope(reporter, "create-reply", reply, nil)
	report := Object{"schemaVersion": 1, "operationId": uuid.NewString(), "reportId": uuid.NewString(), "target": Object{"kind": "post-version", "postId": post["postId"], "versionId": post["versionId"]}, "category": "privacy", "summary": "原私有举报陈述。"}
	reportE := envelope(reporter, "create-report", report, []string{moderator.Actor.SubjectID})
	event := func(version int, kind string) Object {
		return Object{"schemaVersion": 1, "operationId": uuid.NewString(), "governanceEventId": uuid.NewString(), "reportId": report["reportId"], "expectedReportVersion": version, "kind": kind}
	}
	supplement := event(1, "supplement")
	supplement["summary"] = "补充原举报材料。"
	resolution := event(2, "resolve")
	resolution["resolution"], resolution["reason"], resolution["effect"] = "accepted", "独立处理决定。", Object{"kind": "hide-version", "until": at + 1200}
	appeal := event(3, "appeal")
	appeal["summary"] = "原受影响作者提出申诉。"
	dismiss := event(4, "resolve")
	dismiss["resolution"], dismiss["reason"], dismiss["effect"] = "dismissed", "独立复查解除原处理。", nil
	section := Object{"schemaVersion": 1, "operationId": uuid.NewString(), "sectionId": uuid.NewString(), "expectedVersion": 0, "title": "签名分区", "theme": "原本人维护分区", "description": "原范围。", "audience": Object{"read": Object{"kind": "everyone"}, "participate": Object{"kind": "everyone"}}}
	sectionE := envelope(owner, "create-section", section, nil)
	classify := Object{"schemaVersion": 1, "operationId": uuid.NewString(), "sectionId": section["sectionId"], "expectedVersion": 1, "category": "technology"}
	version := clone(post)
	version["operationId"], version["versionId"], version["expectedHeadVersion"], version["title"] = uuid.NewString(), uuid.NewString(), 1, "原ID第二版"
	versionE := envelope(owner, "publish-version", version, nil)
	withdrawVersion := Object{"schemaVersion": 1, "operationId": uuid.NewString(), "postId": post["postId"], "versionId": version["versionId"], "expectedHeadVersion": 2}
	withdrawReply := Object{"schemaVersion": 1, "operationId": uuid.NewString(), "replyId": reply["replyId"], "expectedRevision": 1}
	withdrawPost := Object{"schemaVersion": 1, "operationId": uuid.NewString(), "postId": post["postId"], "expectedHeadVersion": 3}
	fileText := "原论坛附件字节\n"
	fileID := uuid.NewString()
	fileHash := identity.Digest([]byte(fileText))
	filePost := clone(post)
	filePost["operationId"], filePost["postId"], filePost["versionId"], filePost["attachments"] = uuid.NewString(), uuid.NewString(), uuid.NewString(), []any{Object{"id": fileID, "sha256": fileHash}}
	filePostE := envelope(owner, "create-post", filePost, nil)
	fileWithdraw := Object{"schemaVersion": 1, "operationId": uuid.NewString(), "postId": filePost["postId"], "expectedHeadVersion": 1}
	return Object{"endpoint": endpoint, "now": at, "issuer": issuer, "owner": Object{"subjectId": owner.Actor.SubjectID, "token": owner.Credential, "accountId": ownerAccount}, "reporter": Object{"subjectId": reporter.Actor.SubjectID, "token": reporter.Credential, "accountId": reporterAccount}, "moderator": Object{"subjectId": moderator.Actor.SubjectID, "token": moderator.Credential}, "post": postE, "reply": replyE, "report": reportE, "supplement": envelope(reporter, "supplement", supplement, []string{moderator.Actor.SubjectID}), "resolve": envelope(moderator, "resolve", resolution, []string{owner.Actor.SubjectID, reporter.Actor.SubjectID}), "appeal": envelope(owner, "appeal", appeal, []string{moderator.Actor.SubjectID}), "dismiss": envelope(moderator, "resolve", dismiss, []string{owner.Actor.SubjectID, reporter.Actor.SubjectID}), "withdrawReport": envelope(reporter, "withdraw-report", event(5, "withdraw"), nil), "section": sectionE, "classify": envelope(moderator, "classify-section", classify, nil), "version": versionE, "withdrawVersion": envelope(owner, "withdraw-version", withdrawVersion, nil), "withdrawReply": envelope(reporter, "withdraw-reply", withdrawReply, nil), "withdrawPost": envelope(owner, "withdraw-post", withdrawPost, nil), "file": Object{"id": fileID, "hash": fileHash, "text": fileText, "post": filePostE, "withdraw": envelope(owner, "withdraw-post", fileWithdraw, nil)}}
}
