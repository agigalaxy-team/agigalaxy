package deviceauthfixture

import (
	"context"
	"github.com/agigalaxy-team/agigalaxy/go/internal/testsupport"
	"testing"
)

func TestDeviceAuthorityFixture(t *testing.T) {
	pool, _ := testsupport.PostgreSQL(t)
	fixture := New(t, pool, t.TempDir(), []string{"binding", "history", "consent"})
	actor, e := fixture.Service.Authenticate(context.Background(), fixture.Credential, "history")
	if e != nil || actor.SubjectID != fixture.Materials.Genesis.ID || actor.DeviceID == nil || *actor.DeviceID != fixture.Materials.DeviceID {
		t.Fatalf("current authority: %+v %v", actor, e)
	}
}

func TestDeviceAuthoritySelectedEndpoint(t *testing.T) {
	pool, _ := testsupport.PostgreSQL(t)
	fixture := NewEndpoint(t, pool, t.TempDir(), []string{"binding", "history", "consent"}, "https://peer.example.invalid")
	actor, err := fixture.Service.Authenticate(context.Background(), fixture.Credential, "history")
	if err != nil || actor.SubjectID != fixture.Materials.Genesis.ID {
		t.Fatalf("selected endpoint authority: %+v %v", actor, err)
	}
}
