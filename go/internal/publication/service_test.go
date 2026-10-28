package publication

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/postgres"
	"github.com/agigalaxy-team/agigalaxy/go/internal/testsupport"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

type fixturePublicationAuthority struct {
	denied  bool
	actions []string
}

func (a *fixturePublicationAuthority) Revalidate(_ context.Context, _ pgx.Tx, operator, action string) error {
	a.actions = append(a.actions, action)
	if a.denied || operator != strings.Repeat("a", 64) {
		return fault.New("operations_permission_denied", 403)
	}
	return nil
}

type publicationProxy struct {
	Publisher
	afterPrepare          func()
	loseAck               bool
	prepares, activations int
}

func (p *publicationProxy) Prepare(ctx context.Context, id string, snapshot Snapshot) (Artifact, error) {
	p.prepares++
	a, e := p.Publisher.Prepare(ctx, id, snapshot)
	if p.afterPrepare != nil {
		p.afterPrepare()
	}
	return a, e
}
func (p *publicationProxy) Activate(ctx context.Context, a Artifact) error {
	p.activations++
	e := p.Publisher.Activate(ctx, a)
	if e == nil && p.loseAck {
		p.loseAck = false
		return fault.New("controlled_lost_activation_ack", 503)
	}
	return e
}
func TestOriginalPostgresStateAndActivationRecovery(t *testing.T) {
	pool, dsn := testsupport.PostgreSQL(t)
	node(t, dsn, "setup")
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	config, files, snapshot, _, _ := fixtureFiles(t)
	root, _ := filepath.Abs("../../..")
	b, e := os.ReadFile(filepath.Join(root, "packages/galaxy-official/src/infrastructure/content-publisher-role.sql"))
	if e != nil {
		t.Fatal(e)
	}
	if _, e = pool.Exec(ctx, string(b)); e != nil {
		t.Fatal(e)
	}
	publisherPool, e := postgres.Open(ctx, dsn+"&options=-c%20role%3Dgalaxy_content_publisher")
	if e != nil {
		t.Fatal(e)
	}
	defer publisherPool.Close()
	auth := &fixturePublicationAuthority{}
	proxy := &publicationProxy{Publisher: files, loseAck: true}
	s := &Service{Pool: publisherPool, Endpoint: config.Endpoint, PublicOrigin: config.PublicOrigin, Publisher: proxy, Authority: auth}
	insert := func(id string, base *string) {
		t.Helper()
		raw, _ := json.Marshal(snapshot)
		if _, e = pool.Exec(ctx, `INSERT INTO site_publications_v1(id,endpoint,requested_by,snapshot,state,created_at,updated_at,base_publication_id) VALUES($1,$2,$3,$4,'queued',now(),now(),$5)`, id, config.Endpoint, strings.Repeat("a", 64), raw, base); e != nil {
			t.Fatal(e)
		}
	}
	id := uuid.NewString()
	insert(id, nil)
	_, e = s.Execute(ctx, id)
	if fault.Code(e) != "site_publication_failed" {
		t.Fatalf("lost activation acknowledgement %v", e)
	}
	var state string
	var result Object
	if e = pool.QueryRow(ctx, "SELECT state,result FROM site_publications_v1 WHERE id=$1", id).Scan(&state, &result); e != nil || state != "building" || result["activationPending"] != true {
		t.Fatalf("unknown activation cleared original marker state: %s %+v %v", state, result, e)
	}
	got, e := s.Execute(ctx, id)
	if e != nil || got["state"] != "published" || proxy.prepares != 1 || proxy.activations != 1 {
		t.Fatalf("original publication not reconciled: %+v %v prepare=%d activate=%d", got, e, proxy.prepares, proxy.activations)
	}
	var original struct {
		ID, State string
		Result    Object
		Error     any
	}
	if e = json.Unmarshal(node(t, dsn, "read", id), &original); e != nil {
		t.Fatal(e)
	}
	if original.ID != id || original.State != "published" || original.Error != nil || original.Result["publicationId"] != id || original.Result["siteVersion"] != "original-software-1" || original.Result["publicUrl"] != config.PublicOrigin+"/" {
		t.Fatalf("original JS cannot read Go publication: %+v", original)
	}
	var events int
	if e = pool.QueryRow(ctx, "SELECT count(*) FROM web_event_outbox_v1 WHERE module='site-content' AND source_ref->>'id'=$1", id).Scan(&events); e != nil || events != 1 {
		t.Fatalf("committed publication did not produce original public event: %d %v", events, e)
	}
	// A newer published result supersedes older requests without another switch.
	older := uuid.NewString()
	insert(older, nil)
	newer := uuid.NewString()
	insert(newer, nil)
	if _, e = pool.Exec(ctx, "UPDATE site_publications_v1 SET state='published',published_at=now() WHERE id=$1", newer); e != nil {
		t.Fatal(e)
	}
	got, e = s.Execute(ctx, older)
	if e != nil || got["state"] != "superseded" || proxy.activations != 1 {
		t.Fatalf("older publication activated: %+v %v", got, e)
	}
	// Cancellation after file preparation is still authoritative in the next
	// transaction. It cannot be undone by the independent queue execution.
	cancelled := uuid.NewString()
	insert(cancelled, nil)
	proxy.afterPrepare = func() {
		if _, e := pool.Exec(ctx, `UPDATE site_publications_v1 SET state='failed',error='{"code":"site_publication_cancelled","retryable":false}' WHERE id=$1`, cancelled); e != nil {
			t.Fatal(e)
		}
	}
	got, e = s.Execute(ctx, cancelled)
	if e != nil || got["state"] != "superseded" || proxy.activations != 1 {
		t.Fatalf("cancelled publication activated: %+v %v", got, e)
	}
	proxy.afterPrepare = nil
	// Current authority is checked again after expensive media preparation.
	revoked := uuid.NewString()
	insert(revoked, nil)
	proxy.afterPrepare = func() { auth.denied = true }
	_, e = s.Execute(ctx, revoked)
	if fault.Code(e) != "site_publication_failed" || proxy.activations != 1 {
		t.Fatalf("revoked publication activated: %v", e)
	}
	auth.denied = false
	proxy.afterPrepare = nil
	// Only an original recorded General bridge changes the required action, and
	// its exact content base must still be active at the final switch.
	wrongBase := uuid.NewString()
	settings := uuid.NewString()
	insert(settings, &wrongBase)
	if _, e = pool.Exec(ctx, `INSERT INTO operations_system_general_publications_v1(endpoint,operation_id,operator_id,input,publication_id) VALUES($1,$2,$3,jsonb_build_object('expectedPublicationId',$4::text),$2)`, config.Endpoint, settings, strings.Repeat("a", 64), wrongBase); e != nil {
		t.Fatal(e)
	}
	_, e = s.Execute(ctx, settings)
	if fault.Code(e) != "site_publication_base_changed" || proxy.activations != 1 {
		t.Fatalf("settings base changed without rejection: %v", e)
	}
	if auth.actions[len(auth.actions)-1] != "system.settings.apply" {
		t.Fatal("settings publication borrowed cms.publish")
	}
	unbridged := uuid.NewString()
	insert(unbridged, &wrongBase)
	_, e = s.Execute(ctx, unbridged)
	if fault.Code(e) != "operations_authorization_unavailable" {
		t.Fatal("unrecorded settings bridge accepted")
	}
	active, e := files.Current(ctx)
	if e != nil || active.PublicationID != id {
		t.Fatalf("failed candidates changed current content: %v %v", active, e)
	}
}
