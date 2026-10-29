package systemsettings_test

import (
	"context"
	"testing"

	"github.com/agigalaxy-team/agigalaxy/go/internal/databaseschema"
	"github.com/agigalaxy-team/agigalaxy/go/internal/testsupport/operationsfixture"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
)

func settingsFixture(t *testing.T, owner *pgxpool.Pool) object {
	t.Helper()
	ctx := context.Background()
	management := operationsfixture.Principals(t, owner, "https://settings.example.invalid", map[string]string{"root": "R", "editor": "E"})
	if _, err := databaseschema.Migrate(ctx, owner, []string{"worker"}); err != nil {
		t.Fatal(err)
	}
	role, err := management.Permissions.SaveRole(ctx, management.Root, object{"operationId": uuid.NewString(), "expectedVersion": 0, "name": "Only current system settings", "description": "Isolated purpose scope", "enabled": true, "permissions": []any{"workbench.read", "system.settings.read", "system.settings.configure", "system.settings.test", "system.settings.apply", "system.settings.credentials.write"}})
	if err != nil {
		t.Fatal(err)
	}
	roleValue := obj(role["role"])
	if _, err = management.Permissions.SaveAssignment(ctx, management.Root, object{"operationId": uuid.NewString(), "expectedVersion": 0, "operatorId": management.IDs["editor"], "roleId": roleValue["id"], "enabled": true}); err != nil {
		t.Fatal(err)
	}
	publication := uuid.NewString()
	snapshot := object{"version": 1, "settings": object{"siteTitle": "原网站", "description": "原说明", "footerLinks": []any{}}, "pages": []any{}, "media": []any{}}
	if _, err = owner.Exec(ctx, `INSERT INTO site_publications_v1(id,endpoint,requested_by,snapshot,state,created_at,updated_at,published_at) VALUES($1,$2,$3,$4,'published',$5,$5,$5)`, publication, management.Endpoint, management.Root.ID, snapshot, management.Now()); err != nil {
		t.Fatal(err)
	}
	base := management.Data
	base["role"], base["publication"], base["snapshot"] = roleValue, publication, snapshot
	return base
}
