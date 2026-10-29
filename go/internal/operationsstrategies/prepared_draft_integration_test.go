package operationsstrategies

import (
	"context"
	"testing"

	"github.com/agigalaxy-team/agigalaxy/go/internal/testsupport"
	"github.com/agigalaxy-team/agigalaxy/go/internal/testsupport/operationsfixture"
	"github.com/google/uuid"
)

func TestPreparedDraftBindsExistingDraftAndOriginalCommandPG(t *testing.T) {
	owner, _ := testsupport.PostgreSQL(t)
	f := operationsfixture.New(t, owner)
	ctx := context.Background()
	s := &Service{Pool: f.Pool, Endpoint: f.Endpoint, Authority: f.Gateway, Now: f.Now}
	authorize := func() (Actor, error) { return f.Root, nil }
	first, err := s.SaveDraft(ctx, f.Root, Object{"operationId": uuid.NewString(), "expectedRevision": 0, "configuration": sampleConfig(), "reason": "initial draft"}, authorize)
	if err != nil {
		t.Fatal(err)
	}
	command := Object{"operationId": uuid.NewString(), "expectedRevision": 1, "expectedDraftId": nil, "configuration": sampleConfig(), "reason": "reviewed change"}
	if _, err = s.SavePreparedDraft(ctx, f.Root, command, authorize); err == nil {
		t.Fatal("unselected existing draft replaced")
	}
	command["expectedDraftId"] = first["versionId"]
	result, err := s.SavePreparedDraft(ctx, f.Root, command, authorize)
	if err != nil || result["state"] != "saved" {
		t.Fatalf("same-owner selected draft: %#v %v", result, err)
	}
	command, err = ParseCommand("prepared-draft", command)
	if err != nil {
		t.Fatal(err)
	}
	prior, err := s.OriginalCommand(ctx, f.Root, str(command["operationId"]), "draft", command)
	if err != nil || prior["state"] != "recorded" {
		t.Fatalf("original command: %#v %v", prior, err)
	}
	changed := clone(command)
	changed["reason"] = "different command"
	if _, err = s.OriginalCommand(ctx, f.Root, str(command["operationId"]), "draft", changed); err == nil {
		t.Fatal("different original input accepted")
	}
}
