package resourcebudget

import (
	"context"
	"testing"
	"time"

	"github.com/agigalaxy-team/agigalaxy/go/internal/identity"
	"github.com/agigalaxy-team/agigalaxy/go/internal/testsupport/deviceauthfixture"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
)

type budgetFixture struct {
	SubjectID, BindingID, CredentialHash, AccountID, ScopeID string
}

func seedBudgetFixture(t *testing.T, owner *pgxpool.Pool) budgetFixture {
	t.Helper()
	ctx := context.Background()
	device := deviceauthfixture.NewEndpoint(t, owner, t.TempDir(), []string{"binding", "consent"}, "https://budget.example.invalid")
	f := budgetFixture{SubjectID: device.Actor.SubjectID, BindingID: device.Actor.BindingID, CredentialHash: identity.Digest([]byte(device.Credential)), AccountID: uuid.NewString(), ScopeID: uuid.NewString()}
	at := time.Unix(2000000000, 0)
	exec := func(q string, args ...any) {
		t.Helper()
		if _, err := owner.Exec(ctx, q, args...); err != nil {
			t.Fatal(err)
		}
	}
	// The actor in the test carries stale scopes; the transaction must use
	// the credential's current narrower row and the binding's separate scopes.
	exec(`UPDATE access_credentials SET scopes='["binding"]' WHERE token_hash=$1`, f.CredentialHash)
	exec(`INSERT INTO community_accounts(id,endpoint,issuer,external_subject,verification_method,verified_at,created_at) VALUES($1,'https://budget.example.invalid','https://issuer.example.invalid',$2,'external-account',$3,$3)`, f.AccountID, f.SubjectID, at)
	exec(`INSERT INTO account_work_scopes_v1(account_id,scope_id,work_id,origin_subject_id,created_at) VALUES($1,$2,'原工作',$3,$4)`, f.AccountID, f.ScopeID, f.SubjectID, at)
	exec(`INSERT INTO account_work_v1(account_id,work_id,origin_subject_id,scope_id,revision,state,upload_level,data,last_operation_id,created_at,updated_at) VALUES($1,'原工作',$2,$3,1,'stored','work-content',$4,$5,$6,$6)`, f.AccountID, f.SubjectID, f.ScopeID, map[string]any{"title": "字节检查", "body": "原有效内容"}, uuid.NewString(), at)
	for _, row := range []struct{ state, subject string }{{"pending", f.SubjectID}, {"running", f.SubjectID}, {"completed", f.SubjectID}, {"pending", "unrelated-subject"}} {
		exec(`INSERT INTO jobs(id,kind,deduplication_key,payload,state) VALUES($1,'builder-probe',$2,$3,$4)`, uuid.NewString(), uuid.NewString(), map[string]any{"subjectId": row.subject}, row.state)
	}
	for _, row := range []struct {
		expires int64
		revoked any
	}{{2000000600, nil}, {1999999999, nil}, {2000000600, at}} {
		exec(`INSERT INTO data_exports(id,subject_id,binding_id,datasets,bounds,selection_cutoff,expires_at,revoked_at) VALUES($1,$2,$3,'[]','{}',$4,$5,$6)`, uuid.NewString(), f.SubjectID, f.BindingID, at, time.Unix(row.expires, 0), row.revoked)
	}
	return f
}
