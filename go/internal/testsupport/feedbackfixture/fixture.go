package feedbackfixture

import (
	"context"
	"testing"
	"time"

	"github.com/agigalaxy-team/agigalaxy/go/internal/databaseschema"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
)

type Seed struct {
	Accounts    []string
	Endpoint    string
	Submission  map[string]any
	Fingerprint string
}

// SeedFeedback creates synthetic accounts in the caller's isolated test DB;
// the fixed fingerprint is the captured original wire-contract value.
func Create(t *testing.T, pool *pgxpool.Pool, roles ...string) Seed {
	t.Helper()
	ctx := context.Background()
	if _, e := databaseschema.Migrate(ctx, pool, roles); e != nil {
		t.Fatalf("feedback schema: %v", e)
	}
	endpoint := "https://go-feedback.example.invalid"
	at := time.Unix(2000000000, 0).UTC()
	accounts := []string{}
	for _, name := range []string{"林澈", "唐禾"} {
		id := uuid.NewString()
		if _, e := pool.Exec(ctx, `INSERT INTO community_accounts(id,endpoint,issuer,external_subject,verification_method,verified_at,created_at)
    VALUES($1,$2,'https://login.example.invalid',$4,'external-account',$3,$3)`, id, endpoint, at, id); e != nil {
			t.Fatal(e)
		}
		if _, e := pool.Exec(ctx, `INSERT INTO official_account_profiles_v1(account_id,subject_type,display_name,query_enabled,updated_at)
    VALUES($1,'person',$2,false,$3)`, id, name, at); e != nil {
			t.Fatal(e)
		}
		accounts = append(accounts, id)
	}
	for _, row := range [][2]string{{"go-admin", "反馈处理员"}, {"go-reader", "反馈观察员"}} {
		if _, e := pool.Exec(ctx, `INSERT INTO operations_operator_principals_v1(operator_id,endpoint,issuer,external_subject,display_name,created_at,updated_at)
    VALUES($1,$2,'https://login.example.invalid',$1,$3,$4,$4)`, row[0], endpoint, row[1], at); e != nil {
			t.Fatal(e)
		}
	}
	return Seed{Accounts: accounts, Endpoint: endpoint, Submission: map[string]any{"operationId": "11111111-1111-4111-8111-111111111111", "body": "  搜索结果返回后，先前选择的分类未保留。\n请检查返回路径。  ", "category": "problem", "module": "discovery"}, Fingerprint: "f5ebf3c9dff6b44976405246bda1b29cf185243453a4740a1f3d20116809036c"}
}
