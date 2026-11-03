package subjectlifecycle

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"path/filepath"
	"testing"
	"time"

	"github.com/agigalaxy-team/agigalaxy/go/internal/deviceauth"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/identity"
	"github.com/agigalaxy-team/agigalaxy/go/internal/postgres"
	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
	"github.com/agigalaxy-team/agigalaxy/go/internal/testsupport"
	"github.com/agigalaxy-team/agigalaxy/go/internal/testsupport/deviceauthfixture"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
)

func TestOriginalTakeoutSignedDeletionAndDurableResume(t *testing.T) {
	owner, dsn := testsupport.PostgreSQL(t)
	ctx, cancel := context.WithTimeout(context.Background(), 100*time.Second)
	defer cancel()
	dir := t.TempDir()
	prepared := deviceauthfixture.Prepare(t, owner, dir, []string{"binding", "history", "data-export", "data-delete"})
	for i, id := range []string{"00000000-0000-4000-8000-000000000001", "00000000-0000-4000-8000-000000000002"} {
		reference, _ := json.Marshal(map[string]any{"kind": "forum-post", "postId": uuid.NewString(), "versionId": uuid.NewString()})
		if _, e := owner.Exec(ctx, `INSERT INTO reading_bookmarks_v1(id,subject_id,reference_key,reference,saved,revision,created_at,saved_at,updated_at) VALUES($1,$2,$3,$4,true,1,now(),now(),now())`, id, prepared.Materials.Genesis.ID, fmt.Sprintf("fixture-%d", i), reference); e != nil {
			t.Fatal(e)
		}
	}
	api, e := postgres.Open(ctx, dsn+"&options=-c%20role%3Dgalaxy_api")
	if e != nil {
		t.Fatal(e)
	}
	cfg := api.Config()
	api.Close()
	cfg.ConnConfig.Tracer = queryErrors{t}
	api, e = pgxpool.NewWithConfig(ctx, cfg)
	if e != nil {
		t.Fatal(e)
	}
	defer api.Close()
	now := func() time.Time { return time.Unix(2000000000, 0) }
	devices, e := deviceauth.Load(ctx, api, deviceauth.Configuration{Endpoint: "https://device.example.invalid", SigningKeyID: "fixture", SigningKeyFile: filepath.Join(dir, "hub-private.pem"), RootPinsFile: filepath.Join(dir, "root-pins.json"), KeyringFile: filepath.Join(dir, "keyring.json"), TrustDirectory: filepath.Join(dir, "trust"), Now: now})
	if e != nil {
		t.Fatal(e)
	}
	makeService := func() *Service { return &Service{Pool: api, Endpoint: devices.Endpoint, Devices: devices, Now: now} }
	service := makeService()
	prepared.Service = devices
	prepared = deviceauthfixture.Bind(t, prepared, dir, []string{"binding", "history", "data-export", "data-delete"})
	a := Actor{Actor: prepared.Actor}
	ticketID := uuid.NewString()
	if _, e = service.Create(ctx, a, CreateInput{ID: ticketID, Datasets: []string{"identity", "reading-bookmarks", "bindings"}}); e != nil {
		t.Fatal(e)
	}
	first, e := service.Page(ctx, a, PageInput{ID: ticketID, Dataset: "reading-bookmarks", Limit: 1})
	if e != nil {
		t.Fatal(e)
	}
	var page struct {
		Items     []json.RawMessage `json:"items"`
		NextAfter *string           `json:"nextAfter"`
	}
	raw, _ := json.Marshal(first)
	if json.Unmarshal(raw, &page) != nil || len(page.Items) != 1 || page.NextAfter == nil {
		t.Fatal("first export page", string(raw))
	}
	cursor := *page.NextAfter
	for _, dataset := range []string{"identity", "bindings"} {
		if _, e = service.Page(ctx, a, PageInput{ID: ticketID, Dataset: dataset}); e != nil {
			t.Fatal(e)
		}
	}
	private, e := identity.PrivatePEM([]byte(prepared.Materials.OwnerPrivate))
	if e != nil {
		t.Fatal(e)
	}
	signIntent := func(intent map[string]any, typ string) string {
		t.Helper()
		raw, err := protocol.EncodeJS(intent)
		if err != nil {
			t.Fatal(err)
		}
		signed, err := identity.SignIdentityPayload(private, string(raw), typ)
		if err != nil {
			t.Fatal(err)
		}
		return signed
	}
	intent := func(action string) map[string]any {
		return map[string]any{"version": 1, "id": uuid.NewString(), "endpoint": devices.Endpoint, "subjectId": a.SubjectID, "bindingId": a.BindingID, "issuedAt": int64(2000000000), "expiresAt": int64(2000000300), "action": action}
	}
	request := intent("request")
	request["scope"] = "all-owned-service-data"
	request["reason"] = "privacy"
	request["takeout"] = "not-needed"
	signed := signIntent(request, "galaxy-deletion-intent+jws")
	created, e := service.SubmitDeletion(ctx, a, signed)
	if e != nil {
		t.Fatal(e)
	}
	receipt := created.(Object)
	if receipt["physicalDeletionPerformed"] != false || receipt["serviceWideDeletionComplete"] != false {
		t.Fatal("deletion submission claimed erasure", receipt)
	}
	requestID := receipt["id"].(string)
	detail, e := service.ReadDeletion(ctx, a, requestID, 0)
	if e != nil || len(detail.(Object)["events"].([]Object)) != 1 {
		t.Fatal("deletion initial event", e)
	}
	cancelIntent := intent("cancel")
	cancelIntent["requestId"] = requestID
	cancelIntent["expectedRevision"] = int64(1)
	if _, e = service.SubmitDeletion(ctx, a, signIntent(cancelIntent, "galaxy-deletion-intent+jws")); e != nil {
		t.Fatal(e)
	}
	detail, e = service.ReadDeletion(ctx, a, requestID, 0)
	if e != nil || len(detail.(Object)["events"].([]Object)) != 2 {
		t.Fatal("deletion cancellation event", e)
	}
	listed, e := service.QueryDeletions(ctx, a, "", 10)
	if e != nil || len(listed.(Object)["items"].([]Object)) != 1 {
		t.Fatal("deletion query", e)
	}
	replayed, e := service.SubmitDeletion(ctx, a, signed)
	if e != nil || replayed.(Object)["state"] != "cancelled" || integer(replayed.(Object)["revision"]) != 2 {
		t.Fatal("deletion replay", e)
	}
	for _, dataset := range []string{"forum-events", "task-materials", "outcome-materials-v2"} {
		if _, e = service.Create(ctx, a, CreateInput{ID: uuid.NewString(), Datasets: []string{dataset}}); fault.Status(e) != 503 {
			t.Fatalf("missing consumer %s status %v", dataset, e)
		}
	}
	if _, e = service.Create(ctx, a, CreateInput{ID: uuid.NewString()}); fault.Status(e) != 503 {
		t.Fatal("default full-catalog export concealed missing consumer", e)
	}
	var tickets int
	if e = owner.QueryRow(ctx, "SELECT count(*) FROM data_exports").Scan(&tickets); e != nil || tickets != 1 {
		t.Fatal("failed create left ticket", tickets, e)
	}
	// A fresh service instance resumes the existing ticket and cursor.
	service = makeService()
	second, e := service.Page(ctx, a, PageInput{ID: ticketID, Dataset: "reading-bookmarks", After: cursor, Limit: 1})
	if e != nil {
		t.Fatal(e)
	}
	raw, _ = json.Marshal(second)
	page = struct {
		Items     []json.RawMessage `json:"items"`
		NextAfter *string           `json:"nextAfter"`
	}{}
	if json.Unmarshal(raw, &page) != nil || len(page.Items) != 1 || page.NextAfter != nil {
		t.Fatal("resumed export page", string(raw))
	}
	var verified struct {
		pageSnapshot
		SHA256 string `json:"sha256"`
	}
	if e = json.Unmarshal(raw, &verified); e != nil {
		t.Fatal(e)
	}
	snapshot, e := encoded(verified.pageSnapshot)
	if e != nil || identity.Digest(snapshot) != verified.SHA256 {
		t.Fatal("export page digest", e)
	}
	if _, e = owner.Exec(ctx, "UPDATE access_credentials SET revoked_at=now() WHERE binding_id=$1", a.BindingID); e != nil {
		t.Fatal(e)
	}
	status := map[string]any{"version": 1, "id": uuid.NewString(), "endpoint": devices.Endpoint, "subjectId": a.SubjectID, "issuedAt": int64(2000000000), "expiresAt": int64(2000000300), "action": "status", "requestId": requestID}
	value, e := service.DeletionStatus(ctx, signIntent(status, "galaxy-deletion-status+jws"))
	if e != nil || value.(Object)["state"] != "cancelled" || value.(Object)["holderProofVerified"] != true {
		t.Fatal("holder deletion status", e)
	}
	if _, e = service.Page(ctx, a, PageInput{ID: ticketID, Dataset: "identity"}); fault.Status(e) != 401 {
		t.Fatal("revoked credential read resumed ticket", e)
	}
	if _, e = service.Execute(ctx, nil); fault.Status(e) != 503 {
		t.Fatal("incomplete executor reported ready", e)
	}
	var bookmarks int
	if e = owner.QueryRow(ctx, "SELECT count(*) FROM reading_bookmarks_v1").Scan(&bookmarks); e != nil || bookmarks != 2 {
		t.Fatal("signed request/cancel performed physical erasure", bookmarks, e)
	}
}

type queryErrors struct{ t *testing.T }

func (q queryErrors) TraceQueryStart(ctx context.Context, _ *pgx.Conn, _ pgx.TraceQueryStartData) context.Context {
	return ctx
}
func (q queryErrors) TraceQueryEnd(_ context.Context, _ *pgx.Conn, d pgx.TraceQueryEndData) {
	var e *pgconn.PgError
	if errors.As(d.Err, &e) {
		q.t.Logf("database error %s: %s", e.Code, e.Message)
	}
}
