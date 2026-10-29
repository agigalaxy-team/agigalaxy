package operationsstrategies

import (
	"context"
	"testing"

	p "github.com/agigalaxy-team/agigalaxy/go/internal/operationspermissions"
	"github.com/agigalaxy-team/agigalaxy/go/internal/testsupport"
	"github.com/agigalaxy-team/agigalaxy/go/internal/testsupport/operationsfixture"
	"github.com/google/uuid"
)

func TestVersionRehearsalsUsesOriginalOwnerAndStablePagesPG(t *testing.T) {
	owner, _ := testsupport.PostgreSQL(t)
	ctx := context.Background()
	f := operationsfixture.New(t, owner)
	s := &Service{Pool: f.Pool, Endpoint: f.Endpoint, Authority: f.Gateway, Now: f.Now}
	draft, e := s.SaveDraft(ctx, f.Root, Object{"operationId": uuid.NewString(), "expectedRevision": 0, "configuration": EmptyConfiguration(), "reason": "Original test draft"}, func() (p.Actor, error) { return f.Root, nil })
	if e != nil {
		t.Fatal(e)
	}
	version := str(draft["versionId"])
	for i := 0; i < 2; i++ {
		if _, e = s.Rehearsal(ctx, f.Root, Object{"operationId": uuid.NewString(), "versionId": version, "executionIds": []any{}}); e != nil {
			t.Fatal(e)
		}
	}
	foreign := uuid.NewString()
	if _, e = owner.Exec(ctx, `INSERT INTO operations_p13_strategy_rehearsals_v1(id,endpoint,version_id,operator_id,execution_ids,result,created_at) VALUES($1,$2,$3,'other-owner','{}',$4,$5)`, foreign, f.Endpoint, version, Object{"versionId": version, "valid": true}, f.Now()); e != nil {
		t.Fatal(e)
	}
	value, e := s.QueryRead(ctx, f.Root, f.Gateway, "strategy-version", version, Object{"limit": 1})
	if e != nil {
		t.Fatal(e)
	}
	page := obj(value["rehearsals"])
	first := obj(list(page["items"])[0])
	if page["hasMore"] != true || first["valid"] != true || first["versionId"] != version || first["currentPublishEligibility"] != "not-checked" || first["rehearsalId"] == foreign {
		t.Fatalf("first page %#v", page)
	}
	second, e := s.QueryRead(ctx, f.Root, f.Gateway, "strategy-version", version, Object{"limit": 1, "after": page["nextAfter"]})
	if e != nil {
		t.Fatal(e)
	}
	other := obj(second["rehearsals"])
	if other["hasMore"] != false || len(list(other["items"])) != 1 || obj(list(other["items"])[0])["rehearsalId"] == first["rehearsalId"] {
		t.Fatalf("second page %#v", other)
	}
	if _, e = s.QueryRead(ctx, f.Root, f.Gateway, "strategy-version", version, Object{"after": foreign}); e == nil {
		t.Fatal("other owner's cursor accepted")
	}
	if _, e = owner.Exec(ctx, `UPDATE operations_p13_strategy_rehearsals_v1 SET result=jsonb_set(result,'{valid}','"invalid"'::jsonb) WHERE id=$1`, first["rehearsalId"]); e != nil {
		t.Fatal(e)
	}
	value, e = s.QueryRead(ctx, f.Root, f.Gateway, "strategy-version", version, Object{})
	if e != nil {
		t.Fatal(e)
	}
	page = obj(value["rehearsals"])
	found := false
	for _, v := range list(page["items"]) {
		r := obj(v)
		if r["rehearsalId"] == first["rehearsalId"] {
			found = true
			if r["valid"] != nil || r["availability"] != "unknown" {
				t.Fatalf("invalid value %#v", r)
			}
		}
	}
	if !found || page["availability"] != "partial" {
		t.Fatalf("partial page %#v", page)
	}
}
