package actions_test

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/agigalaxy-team/agigalaxy/go/internal/agentos/actions"
	"github.com/agigalaxy-team/agigalaxy/go/internal/discovery"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	p "github.com/agigalaxy-team/agigalaxy/go/internal/operationspermissions"
	"github.com/agigalaxy-team/agigalaxy/go/internal/testsupport"
	"github.com/agigalaxy-team/agigalaxy/go/internal/testsupport/operationsfixture"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

func TestOldSearchCardCannotConfirmWithoutFullReviewPG(t *testing.T) {
	owner, _ := testsupport.PostgreSQL(t)
	f := operationsfixture.New(t, owner)
	f.Automation(t)
	ctx := context.Background()
	role, err := f.Permissions.SaveRole(ctx, f.Root, map[string]any{"operationId": uuid.NewString(), "expectedVersion": 0, "name": "Search reviewer", "description": "Isolated test", "subjectScope": "ai-only", "enabled": true, "permissions": []string{"search-quality.read", "search-quality.publish"}})
	if err != nil {
		t.Fatal(err)
	}
	_, err = f.Permissions.AIWorkAssignment(ctx, f.Root, "discovery", map[string]any{"operationId": uuid.NewString(), "expectedVersion": 0, "roleId": role["role"].(map[string]any)["id"], "enabled": true})
	if err != nil {
		t.Fatal(err)
	}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		if r.URL.Path == "/indexes/test/settings" {
			_, _ = w.Write([]byte(`{"synonyms":{},"rankingRules":["words","typo","proximity","attribute","sort","exactness"]}`))
			return
		}
		http.NotFound(w, r)
	}))
	defer server.Close()
	meili, err := discovery.NewMeilisearch(server.URL, strings.Repeat("synthetic-", 5), "test", discovery.ClientOptions{})
	if err != nil {
		t.Fatal(err)
	}
	source := &discovery.SearchQuality{Pool: f.Pool, Endpoint: f.Endpoint, Authority: &p.BusinessAuthority{Human: f.Gateway}, Meili: meili, Now: f.Now}
	settings := map[string]any{"synonyms": []any{}, "rankingMode": "newest", "fixedConstraints": map[string]any{"currentSource": true, "anonymousPublic": true, "withdrawnExcluded": true, "expiredExcluded": true}}
	if _, err = source.Command(ctx, f.Root, "draft", map[string]any{"operationId": uuid.NewString(), "expectedRevision": 0, "reason": "draft", "settings": settings}); err != nil {
		t.Fatal(err)
	}
	service := &actions.Service{Pool: f.Pool, Endpoint: f.Endpoint, Permissions: f.Permissions, SearchQuality: source, Now: f.Now}
	op := uuid.NewString()
	proposal, err := service.Prepare(ctx, f.Root, "discovery", map[string]any{"kind": "search-apply", "reason": "apply"}, op)
	if err != nil {
		t.Fatal(err)
	}
	proposal["impact"] = []any{"legacy generic review"}
	authorize := func(ctx context.Context, tx pgx.Tx) (p.Actor, error) {
		if tx == nil {
			return f.Root, nil
		}
		return f.Permissions.HumanAIWithin(ctx, tx, f.Root, "discovery", "prepare", "search-quality.publish")
	}
	if _, err = service.ExecutePrepared(ctx, f.Root, proposal, op, authorize); fault.Code(err) != "operations_agentos_review_changed" {
		t.Fatalf("old search card: %v", err)
	}
	var count int
	if err = f.Pool.QueryRow(ctx, `SELECT count(*) FROM operations_search_quality_operations_v1 WHERE endpoint=$1 AND operation_id=$2`, f.Endpoint, op).Scan(&count); err != nil || count != 0 {
		t.Fatalf("old card caused command: %d %v", count, err)
	}
}
