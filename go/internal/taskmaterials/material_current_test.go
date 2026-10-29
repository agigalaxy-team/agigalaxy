package taskmaterials

import (
	"bytes"
	"context"
	"encoding/json"
	"testing"
	"time"

	"github.com/agigalaxy-team/agigalaxy/go/internal/accountlinks"
	"github.com/agigalaxy-team/agigalaxy/go/internal/community"
	"github.com/agigalaxy-team/agigalaxy/go/internal/deviceauth"
	"github.com/agigalaxy-team/agigalaxy/go/internal/postgres"
	"github.com/agigalaxy-team/agigalaxy/go/internal/testsupport"
	"github.com/agigalaxy-team/agigalaxy/go/internal/testsupport/qualificationfixture"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

func TestCurrentSelectedForumMaterialRevocationAndExport(t *testing.T) {
	owner, dsn := testsupport.PostgreSQL(t)
	ctx := context.Background()
	var f struct {
		Endpoint, Token, Issuer string
		Now                     int64
	}
	qualificationfixture.SelectedMaterial(t, owner, &f)
	pool, e := postgres.Open(ctx, dsn+"&options=-c%20role%3Dgalaxy_api")
	if e != nil {
		t.Fatal(e)
	}
	defer pool.Close()
	now := func() time.Time { return time.Unix(f.Now, 0) }
	devices := &deviceauth.Service{Pool: pool, Endpoint: f.Endpoint, Now: now}
	links := &accountlinks.Service{Pool: pool, Endpoint: f.Endpoint, Devices: devices, Providers: []accountlinks.Provider{{Issuer: f.Issuer, ClientID: "galaxy-fixture"}}, Now: now}
	forum := &community.Service{Pool: pool, Endpoint: f.Endpoint, DeviceAuth: devices, AccountLinks: links, Now: now}
	svc := &Service{Pool: pool, Endpoint: f.Endpoint, Devices: devices, Forum: ForumSourceAdapter(forum.TaskMaterialSourceWithin), Now: now}
	device, e := devices.Authenticate(ctx, f.Token, "assistance")
	if e != nil {
		t.Fatal(e)
	}
	actor := Actor{Actor: device}
	var material Object
	if e = owner.QueryRow(ctx, "SELECT to_jsonb(m) FROM task_materials_v1 m LIMIT 1").Scan(&material); e != nil {
		t.Fatal(e)
	}
	descriptor := obj(material, "descriptor")
	source := obj(descriptor, "source")
	input := PrepareInput{ExpiresAt: f.Now + 600, Selections: []Selection{{MaterialID: uuid.NewString(), Field: "title", Start: 0, End: 8}}}
	input.Source.PostID, input.Source.VersionID = str(source, "postId"), str(source, "versionId")
	prepared, e := svc.Prepare(ctx, actor, input)
	if e != nil {
		t.Fatal(e)
	}
	var p Object
	raw, _ := json.Marshal(prepared)
	_ = json.Unmarshal(raw, &p)
	bodies := arr(p["materialBodies"])
	if len(bodies) != 1 || str(bodies[0].(map[string]any), "text") != "Selected" {
		t.Fatal("exact selected source bytes changed", p)
	}
	status, e := svc.Status(ctx, actor, str(material, "task_id"))
	if e != nil {
		t.Fatal(e)
	}
	var s Object
	raw, _ = json.Marshal(status)
	_ = json.Unmarshal(raw, &s)
	if len(arr(s["items"])) != 1 || str(arr(s["items"])[0].(map[string]any), "status") != "available" {
		t.Fatal("selected material unavailable", s)
	}
	history := func() []byte {
		t.Helper()
		raw, err := postgres.InTx(ctx, pool, func(tx pgx.Tx) (json.RawMessage, error) {
			return svc.ReadHistoryWireWithin(ctx, tx, &device, str(material, "task_id"))
		})
		if err != nil {
			t.Fatal(err)
		}
		return raw
	}
	beforeWire := history()
	if !bytes.Contains(beforeWire, []byte("Selected public source title")) || !bytes.Contains(beforeWire, []byte(`"fields":{"title":`)) {
		t.Fatal("selected source absent from ordered History wire", string(beforeWire))
	}
	exported, e := postgres.InTx(ctx, pool, func(tx pgx.Tx) (Object, error) { return svc.ExportMaterialWithin(ctx, tx, device, material) })
	if e != nil || !truth(exported["contentAvailable"]) || str(exported, "body_text") != "Selected public source title" {
		t.Fatal("current lifecycle material", exported, e)
	}
	if _, e = owner.Exec(ctx, "UPDATE forum_permissions_v1 SET revoked_at=to_timestamp($2) WHERE id=$1", source["permissionId"], f.Now); e != nil {
		t.Fatal(e)
	}
	if _, e = svc.Prepare(ctx, actor, input); e == nil {
		t.Fatal("revoked forum source accepted for a new selection")
	}
	status, e = svc.Status(ctx, actor, str(material, "task_id"))
	if e != nil {
		t.Fatal(e)
	}
	raw, _ = json.Marshal(status)
	_ = json.Unmarshal(raw, &s)
	if str(arr(s["items"])[0].(map[string]any), "status") != "unavailable" {
		t.Fatal("revoked source status", s)
	}
	if wire := history(); bytes.Contains(wire, []byte("Selected public source title")) {
		t.Fatal("history leaked revoked source", string(wire))
	}
	exported, e = postgres.InTx(ctx, pool, func(tx pgx.Tx) (Object, error) { return svc.ExportMaterialWithin(ctx, tx, device, material) })
	if e != nil || truth(exported["contentAvailable"]) || str(exported, "body_text") != "" {
		t.Fatal("revoked source remained exportable", exported, e)
	}
	if _, e = postgres.InTx(ctx, owner, func(tx pgx.Tx) (Object, error) { return svc.CleanupWithin(ctx, tx, f.Now) }); e != nil {
		t.Fatal(e)
	}
	var body string
	if e = owner.QueryRow(ctx, "SELECT body_text FROM task_materials_v1 WHERE material_id=$1", material["material_id"]).Scan(&body); e != nil || body != "" {
		t.Fatal("permanent source revocation did not erase derived text", e)
	}
}
