package watchcontrol

import (
	"context"
	"encoding/json"
	"os"
	"testing"

	"github.com/agigalaxy-team/agigalaxy/go/internal/databaseschema"
	"github.com/agigalaxy-team/agigalaxy/go/internal/testsupport"
	"github.com/jackc/pgx/v5/pgxpool"
)

func setupWatchControl(t *testing.T, owner *pgxpool.Pool) Object {
	t.Helper()
	if _, err := databaseschema.Migrate(context.Background(), owner, []string{"api", "worker"}); err != nil {
		t.Fatal(err)
	}
	raw, err := os.ReadFile("testdata/setup.json")
	if err != nil {
		t.Fatal(err)
	}
	var capture struct {
		Fixture Object
		Rows    map[string]json.RawMessage
	}
	if err = json.Unmarshal(raw, &capture); err != nil {
		t.Fatal(err)
	}
	// Existing signed synthetic identity/device and source records are
	// prerequisites. All watch transitions, reads, authorization and retention
	// execute against the current Go services and restricted API/worker roles.
	testsupport.RestoreSyntheticRows(t, owner, capture.Rows,
		"subjects", "subject_control_events", "subject_control_heads", "device_authorizations",
		"binding_challenges", "bindings", "access_credentials", "consents",
		"chat_rooms", "chat_memberships", "chat_agent_grants", "chat_message_refs", "chat_cursors",
		"task_requests", "task_events")
	return capture.Fixture
}
