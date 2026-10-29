package deviceauthfixture

import (
	"github.com/agigalaxy-team/agigalaxy/go/internal/testsupport"
	"github.com/google/uuid"
	"testing"
)

func TestFixtureGrantCapturesSignedConsent(t *testing.T) {
	pool, _ := testsupport.PostgreSQL(t)
	fixture := New(t, pool, t.TempDir(), []string{"binding", "consent"})
	id := uuid.NewString()
	grant := fixture.Grant(t, map[string]any{"operationId": id, "kind": "send"}, "contact.write", id, "Private", nil)
	if grant["consentId"] == "" || grant["payloadJson"] == "" {
		t.Fatal("synthetic consent was not retained")
	}
}
