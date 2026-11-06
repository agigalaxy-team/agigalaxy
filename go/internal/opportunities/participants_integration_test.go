package opportunities_test

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/agigalaxy-team/agigalaxy/go/internal/deviceauth"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/opportunities"
	"github.com/agigalaxy-team/agigalaxy/go/internal/profiles"
	"github.com/agigalaxy-team/agigalaxy/go/internal/testsupport"
	"github.com/agigalaxy-team/agigalaxy/go/internal/testsupport/deviceauthfixture"
	"github.com/agigalaxy-team/agigalaxy/go/internal/testsupport/devicefixture"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// Signed profile statements and real service permissions exercise the same
// projection used for discovery; no project or history is created.
func TestParticipantsRealProfilesVisibilityAndPagination(t *testing.T) {
	admin, dsn := testsupport.PostgreSQL(t)
	ctx := context.Background()
	publicA := deviceauthfixture.New(t, admin, t.TempDir(), []string{"binding", "consent", "history"})
	publicB := deviceauthfixture.New(t, admin, t.TempDir(), []string{"binding", "consent", "history"})
	private := deviceauthfixture.New(t, admin, t.TempDir(), []string{"binding", "consent", "history"})
	config, e := pgxpool.ParseConfig(dsn)
	if e != nil {
		t.Fatal(e)
	}
	config.AfterConnect = func(ctx context.Context, c *pgx.Conn) error { _, e := c.Exec(ctx, "SET ROLE galaxy_api"); return e }
	pool, e := pgxpool.NewWithConfig(ctx, config)
	if e != nil {
		t.Fatal(e)
	}
	defer pool.Close()
	clock := func() time.Time { return time.Unix(devicefixture.Now, 0) }
	devices := &deviceauth.Service{Pool: pool, Endpoint: devicefixture.Endpoint, Now: clock}
	profile := &profiles.Service{Pool: pool, Endpoint: devicefixture.Endpoint, Devices: devices, Now: clock}
	publish := func(who deviceauthfixture.Fixture, name, visibility string) {
		t.Helper()
		id := uuid.NewString()
		payload := map[string]any{"id": id, "expectedRevision": 0, "selfDeclared": map[string]any{"displayName": name, "about": "数据库连接诊断", "claimedCapabilities": []any{"PostgreSQL"}}, "sharing": map[string]any{"visibility": visibility, "viewers": []any{}, "expiresAt": devicefixture.Now + 3600}}
		grant := who.Grant(t, payload, "profile.publish", id, visibility, nil)
		raw, e := json.Marshal(grant)
		if e != nil {
			t.Fatal(e)
		}
		if _, e = profile.Publish(ctx, who.Actor, raw, ""); e != nil {
			t.Fatal("publish real signed profile", e)
		}
	}
	publish(publicA, "数据库连接公开甲", "Public")
	publish(publicB, "数据库连接公开乙", "Public")
	publish(private, "数据库连接私密正文标记", "Private")
	service := &opportunities.Service{Pool: pool, Devices: devices, Profiles: profile, Endpoint: devicefixture.Endpoint, Now: clock, ScanWindowLimit: 1}
	seen := map[string]bool{}
	after := ""
	pages := 0
	for {
		input := map[string]any{"query": "数据库连接", "limit": 1}
		if after != "" {
			input["after"] = after
		}
		result, e := service.ParticipantsQuery(ctx, nil, input)
		if e != nil {
			t.Fatal("anonymous participant query", e)
		}
		encoded, _ := json.Marshal(result)
		if strings.Contains(string(encoded), "私密正文标记") || strings.Contains(string(encoded), private.Actor.SubjectID) {
			t.Fatal("private profile leaked", string(encoded))
		}
		items, ok := result["items"].([]opportunities.Object)
		if !ok {
			t.Fatalf("unexpected items %T", result["items"])
		}
		for _, item := range items {
			id, _ := item["id"].(string)
			if seen[id] {
				t.Fatal("duplicate source across pages", id)
			}
			seen[id] = true
			if item["kind"] != "unknown" || item["acceptance"] != "unknown" || item["callability"] != "unknown" {
				t.Fatal("unsubstantiated participant assertion", item)
			}
		}
		pages++
		if pages > 10 {
			t.Fatal("pagination did not finish")
		}
		next, _ := result["nextAfter"].(string)
		if next == "" {
			break
		}
		after = next
	}
	if len(seen) != 2 || !seen[publicA.Actor.SubjectID] || !seen[publicB.Actor.SubjectID] {
		t.Fatal("lost readable profile across pages", seen)
	}
	detail, e := service.ParticipantsDetail(ctx, nil, map[string]any{"sourceKind": "profile", "id": publicA.Actor.SubjectID})
	if e != nil || detail["participant"].(map[string]any)["kind"] != "unknown" {
		t.Fatal("public detail", detail, e)
	}
	_, e = service.ParticipantsDetail(ctx, nil, map[string]any{"sourceKind": "profile", "id": private.Actor.SubjectID})
	if fault.Status(e) != 404 {
		t.Fatal("private profile detail was readable", e)
	}
	after = ""
	pages = 0
	for {
		pages++
		if pages > 10 {
			t.Fatal("filtered pagination did not finish")
		}
		input := map[string]any{"query": "数据库连接", "types": []any{"person"}, "limit": 20}
		if after != "" {
			input["after"] = after
		}
		person, err := service.ParticipantsQuery(ctx, nil, input)
		if err != nil {
			t.Fatal(err)
		}
		if len(person["items"].([]opportunities.Object)) != 0 {
			t.Fatal("unknown profile matched person filter", person)
		}
		next, _ := person["nextAfter"].(string)
		if next == "" {
			break
		}
		after = next
	}
}
