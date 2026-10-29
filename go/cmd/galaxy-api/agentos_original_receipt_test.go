package main

import (
	"context"
	"encoding/json"
	"strings"
	"testing"

	"github.com/agigalaxy-team/agigalaxy/go/internal/accounts"
	"github.com/agigalaxy-team/agigalaxy/go/internal/agentos"
	"github.com/agigalaxy-team/agigalaxy/go/internal/businessadmin"
	"github.com/agigalaxy-team/agigalaxy/go/internal/community"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/feedback"
	"github.com/agigalaxy-team/agigalaxy/go/internal/operationsautonomy"
	"github.com/agigalaxy-team/agigalaxy/go/internal/operationscommunity"
	"github.com/agigalaxy-team/agigalaxy/go/internal/postgres"
	"github.com/agigalaxy-team/agigalaxy/go/internal/testsupport"
	"github.com/agigalaxy-team/agigalaxy/go/internal/testsupport/operationsfixture"
	"github.com/agigalaxy-team/agigalaxy/go/internal/testsupport/publicationfixture"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

type receiptPublicationAuthority struct{}

func (receiptPublicationAuthority) Account(context.Context, pgx.Tx, string, string) error { return nil }

func TestOriginalAIReceiptProductionSourceWiring(t *testing.T) {
	owner, _ := testsupport.PostgreSQL(t)
	f := operationsfixture.New(t, owner)
	ctx := context.Background()
	account, err := postgres.InTx(ctx, f.Pool, func(tx pgx.Tx) (accounts.Account, error) {
		return (&accounts.Service{Endpoint: f.Endpoint, Now: f.Now}).EnsureAccountWithin(ctx, tx, accounts.VerifiedIdentity{Issuer: "https://source.example.invalid", ExternalSubject: "feedback-source", VerificationMethod: "external-account", VerifiedAt: f.Now()})
	})
	if err != nil {
		t.Fatal(err)
	}
	id := uuid.NewString()
	_, err = owner.Exec(ctx, `INSERT INTO operations_feedback_v1(id,endpoint,account_id,submission_operation_id,request_hash,title,body,submitted_module,module,state,revision,created_at,updated_at) VALUES($1,$2,$3,$4,$5,'Synthetic feedback','Synthetic detail','other','other','pending',1,$6,$6)`, id, f.Endpoint, account.ID, uuid.NewString(), strings.Repeat("a", 64), f.Now())
	if err != nil {
		t.Fatal(err)
	}
	autonomy := &operationsautonomy.Service{Pool: f.Pool, Endpoint: f.Endpoint}
	publication := publicationfixture.Prepare(t, f.Pool, f.Endpoint, f.Now)
	forum := &community.Service{Pool: f.Pool, Endpoint: f.Endpoint, Authority: receiptPublicationAuthority{}, Now: f.Now, OperationsHandling: true}
	payload := publication["payload"].(community.Object)
	raw, err := json.Marshal(payload)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = forum.Publish(ctx, publication["accounts"].([]any)[0].(string), string(raw)); err != nil {
		t.Fatal(err)
	}
	content := &operationscommunity.Service{Pool: f.Pool, Endpoint: f.Endpoint, Forum: forum, Now: f.Now}
	service := connectWorkbenchActions(&agentos.Conversations{Pool: f.Pool, Endpoint: f.Endpoint, Permissions: f.Permissions, Tools: &agentos.ConversationTools{}}, autonomy, content, nil)
	service.Feedback = &feedback.Operations{Service: &feedback.Service{Pool: f.Pool, Endpoint: f.Endpoint}}
	check := func(id string) (agentos.Object, error) {
		return postgres.InTx(ctx, f.Pool, func(tx pgx.Tx) (agentos.Object, error) {
			return autonomy.ReadTargetWithin(ctx, tx, f.Root, "overview", "feedback", id)
		})
	}
	result, err := check(id)
	if err != nil || result["availability"] != "available" || len(result) != 1 {
		t.Fatalf("live source: %v %v", result, err)
	}
	deleteID := uuid.NewString()
	_, err = owner.Exec(ctx, `INSERT INTO account_feedback_data_operations_v1(operation_id,endpoint,account_id,kind,cutoff_sequence,state,feedback_count,attachment_count,metadata_deleted,created_at,updated_at) VALUES($1,$2,$3,'delete',0,'completed',1,0,true,$4,$4)`, deleteID, f.Endpoint, account.ID, f.Now())
	if err != nil {
		t.Fatal(err)
	}
	_, err = owner.Exec(ctx, `UPDATE operations_feedback_v1 SET owner_deleted_at=$2,owner_delete_operation_id=$3,title=NULL,body=NULL WHERE id=$1`, id, f.Now(), deleteID)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = check(id); fault.Status(err) != 404 {
		t.Fatalf("deleted source accepted: %v", err)
	}
	if _, err = check(uuid.NewString()); fault.Status(err) != 404 {
		t.Fatalf("missing source accepted: %v", err)
	}
	postID := payload["postId"].(string)
	postCheck := func() (agentos.Object, error) {
		return postgres.InTx(ctx, f.Pool, func(tx pgx.Tx) (agentos.Object, error) {
			return autonomy.ReadTargetWithin(ctx, tx, f.Root, "overview", "post", postID)
		})
	}
	result, err = postCheck()
	if err != nil || result["availability"] != "available" || len(result) != 1 {
		t.Fatalf("live post source: %v %v", result, err)
	}
	if _, err = owner.Exec(ctx, `UPDATE forum_posts_v1 SET state='withdrawn' WHERE id=$1`, postID); err != nil {
		t.Fatal(err)
	}
	if _, err = postCheck(); fault.Status(err) != 503 {
		t.Fatalf("withdrawn source accepted: %v", err)
	}
}

func TestOriginalAIReceiptNormalizesAndBindsWholeCall(t *testing.T) {
	target := uuid.NewString()
	call := map[string]any{"kind": "feedback-update", "targetId": target, "state": "processing"}
	src := businessadmin.OriginalAIReceiptSource{CallArguments: call, Request: call, Command: map[string]any{"expectedRevision": 1}}
	if _, e := normalizeOriginalAIReceiptSource(src); e != nil {
		t.Fatal(e)
	}
	src.Request = map[string]any{"kind": "feedback-update", "targetId": target, "state": "closed"}
	if _, e := normalizeOriginalAIReceiptSource(src); fault.Status(e) != 404 {
		t.Fatalf("changed command accepted: %v", e)
	}
	src.Request = call
	src.CallArguments = map[string]any{"kind": "feedback-update", "targetId": target, "state": "processing", "unrecognized": "private"}
	if _, e := normalizeOriginalAIReceiptSource(src); fault.Status(e) != 404 {
		t.Fatalf("extra input accepted: %v", e)
	}
}
