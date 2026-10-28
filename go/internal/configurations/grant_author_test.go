package configurations

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/agigalaxy-team/agigalaxy/go/internal/cases"
	"github.com/agigalaxy-team/agigalaxy/go/internal/deviceauth"
	"github.com/agigalaxy-team/agigalaxy/go/internal/postgres"
	"github.com/agigalaxy-team/agigalaxy/go/internal/testsupport"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

func TestGrantAuthorPrivateConfigurationCaseAndCurrentConsent(t *testing.T) {
	owner, dsn := testsupport.PostgreSQL(t)
	ctx, cancel := context.WithTimeout(context.Background(), 70*time.Second)
	defer cancel()
	path := filepath.Join(t.TempDir(), "configuration-fixture.json")
	node(t, dsn, "setup", path, Object{"privateForGrant": true})
	raw, _ := os.ReadFile(path)
	var f struct {
		Endpoint, CaseID string
		Clock            int64
		Owner            struct{ Subject string }
		First            Object
	}
	if e := json.Unmarshal(raw, &f); e != nil {
		t.Fatal(e)
	}
	c := owner.Config()
	c.AfterConnect = func(ctx context.Context, c *pgx.Conn) error { _, e := c.Exec(ctx, "SET ROLE galaxy_api"); return e }
	api, e := pgxpool.NewWithConfig(ctx, c)
	if e != nil {
		t.Fatal(e)
	}
	defer api.Close()
	now := func() time.Time { return time.Unix(f.Clock, 0) }
	devices := &deviceauth.Service{Pool: api, Endpoint: f.Endpoint, Now: now}
	s := &Service{Pool: api, Endpoint: f.Endpoint, Devices: devices, Now: now}
	cs := &cases.Service{Pool: api, Endpoint: f.Endpoint, Devices: devices, Now: now, ConfigurationCondition: s.ConditionWithin, GrantAuthorConfigurationCondition: s.ConditionGrantAuthorWithin}
	ref := Object{"id": f.First["id"], "version": 1}
	read := func() Object {
		t.Helper()
		v, e := postgres.InTx(ctx, api, func(tx pgx.Tx) (Object, error) {
			condition, e := s.ConditionGrantAuthorWithin(ctx, tx, f.Owner.Subject, ref)
			if e != nil {
				return nil, e
			}
			view, e := cs.ReadV2GrantAuthorWithin(ctx, tx, f.Owner.Subject, f.CaseID, "")
			return Object{"condition": condition, "case": view}, e
		})
		if e != nil {
			t.Fatal(e)
		}
		return v
	}
	original := node(t, dsn, "grant-read", path, nil)
	same(t, read(), original)
	anon, e := postgres.InTx(ctx, api, func(tx pgx.Tx) (Object, error) { return s.ConditionWithin(ctx, tx, nil, ref) })
	if e != nil || anon["record"] != nil || anon["sourceStatus"] != "unavailable" {
		t.Fatal("private author viewer leaked to ordinary anonymous read", anon, e)
	}
	if _, e = owner.Exec(ctx, `UPDATE consents SET revoked_at=now() WHERE id=(SELECT consent_id FROM configuration_events WHERE configuration_id=$1 AND version=1)`, f.First["id"]); e != nil {
		t.Fatal(e)
	}
	current := read()
	same(t, current, node(t, dsn, "grant-read", path, nil))
	if obj(current["condition"])["record"] != nil || obj(current["condition"])["sourceStatus"] != "unavailable" {
		t.Fatal("revoked source reproduced", current)
	}
}
