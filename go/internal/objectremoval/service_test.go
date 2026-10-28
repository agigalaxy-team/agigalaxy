package objectremoval

import (
	"context"
	"github.com/agigalaxy-team/agigalaxy/go/internal/attachments"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/postgres"
	"github.com/agigalaxy-team/agigalaxy/go/internal/testsupport"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"strings"
	"testing"
)

type controlledStore struct {
	present       bool
	mode          string
	headFailure   bool
	erases, heads int
	size          int64
	hash          string
}

func (s *controlledStore) Head(ctx context.Context, key, kid string) (*attachments.Head, error) {
	s.heads++
	if e := ctx.Err(); e != nil {
		return nil, e
	}
	if s.headFailure {
		return nil, fault.New("attachment_storage_unavailable", 503)
	}
	if !s.present {
		return nil, nil
	}
	return &attachments.Head{Size: s.size, SHA256: &s.hash}, nil
}
func (s *controlledStore) Erase(context.Context, string) error {
	s.erases++
	if s.mode != "unknown-present" && s.mode != "success-present" {
		s.present = false
	}
	if strings.HasPrefix(s.mode, "unknown") {
		return fault.New("attachment_storage_unavailable", 503)
	}
	return nil
}
func TestCommittedRemovalReceiptUnknownNeverResendsAndRoleIdentityImmutable(t *testing.T) {
	owner, dsn := testsupport.PostgreSQL(t)
	ctx := context.Background()
	_, e := postgres.InTx(ctx, owner, func(tx pgx.Tx) (Object, error) {
		if _, e := tx.Exec(ctx, "CREATE ROLE galaxy_api NOLOGIN;CREATE ROLE galaxy_evidence_worker NOLOGIN"); e != nil {
			return nil, e
		}
		if e := MigrateWithin(ctx, tx); e != nil {
			return nil, e
		}
		return nil, ProvisionRolesWithin(ctx, tx)
	})
	if e != nil {
		t.Fatal(e)
	}
	apiCfg, _ := pgxpool.ParseConfig(dsn)
	apiCfg.AfterConnect = func(ctx context.Context, c *pgx.Conn) error { _, e := c.Exec(ctx, "SET ROLE galaxy_api"); return e }
	api, e := pgxpool.NewWithConfig(ctx, apiCfg)
	if e != nil {
		t.Fatal(e)
	}
	defer api.Close()
	workerCfg, _ := pgxpool.ParseConfig(dsn)
	workerCfg.AfterConnect = func(ctx context.Context, c *pgx.Conn) error {
		_, e := c.Exec(ctx, "SET ROLE galaxy_evidence_worker")
		return e
	}
	worker, e := pgxpool.NewWithConfig(ctx, workerCfg)
	if e != nil {
		t.Fatal(e)
	}
	defer worker.Close()
	s := &Service{Pool: api, Endpoint: "https://removal.example.invalid"}
	descriptor := func(domain string) Descriptor {
		return Descriptor{Domain: domain, ObjectID: uuid.NewString(), StorageKey: domain + "/" + uuid.NewString(), KeyID: "isolated-key", ByteSize: 11, SHA256: strings.Repeat("a", 64)}
	}
	reserve := func(service *Service, pool *pgxpool.Pool, d Descriptor, legacy bool) *Reservation {
		t.Helper()
		r, e := postgres.InTx(ctx, pool, func(tx pgx.Tx) (*Reservation, error) { return service.ReserveWithin(ctx, tx, d, legacy) })
		if e != nil {
			t.Fatal(e)
		}
		return r
	}
	resolve := func(service *Service, pool *pgxpool.Pool, store *controlledStore, d Descriptor, claim *Reservation) (Result, error) {
		t.Helper()
		var external error
		r, e := postgres.InTx(ctx, pool, func(tx pgx.Tx) (Result, error) {
			r, e := service.ResolveWithin(ctx, tx, store, d, claim)
			if e != nil && r.State == "" {
				return r, e
			}
			external = e
			return r, nil
		})
		if e != nil {
			return r, e
		}
		return r, external
	}
	for _, domain := range []string{"chat", "forum", "outcome"} {
		d := descriptor(domain)
		store := &controlledStore{present: true, mode: "unknown-present", size: d.ByteSize, hash: d.SHA256}
		claim := reserve(s, api, d, false)
		first, e := resolve(s, api, store, d, claim)
		if e == nil || first.ObjectRemoved || first.OperationID == nil || first.State != "result-unknown" || store.erases != 1 {
			t.Fatal("unknown first dispatch", domain, first, e, store.erases)
		}
		restarted := &Service{Pool: worker, Endpoint: s.Endpoint}
		old := reserve(restarted, worker, d, false)
		second, e := resolve(restarted, worker, store, d, old)
		if e != nil || second.ObjectRemoved || store.erases != 1 || *second.OperationID != *first.OperationID {
			t.Fatal("unknown operation resent", second, e, store.erases)
		}
		store.present = false
		final, e := resolve(restarted, worker, store, d, nil)
		if e != nil || !final.ObjectRemoved || store.erases != 1 || *final.OperationID != *first.OperationID {
			t.Fatal("absent HEAD not reconciled", final, e)
		}
		if _, e = worker.Exec(ctx, "UPDATE galaxy_go_storage.object_removals_v1 SET operation_id=$4 WHERE endpoint=$1 AND domain=$2 AND object_id=$3", s.Endpoint, d.Domain, d.ObjectID, uuid.NewString()); e == nil {
			t.Fatal("worker changed original operation identity")
		}
	}
	legacy := descriptor("forum")
	store := &controlledStore{present: true, size: legacy.ByteSize, hash: legacy.SHA256}
	claim := reserve(s, api, legacy, true)
	observed, e := resolve(s, api, store, legacy, claim)
	if e != nil || observed.OperationID != nil || observed.State != "legacy-unknown" || store.erases != 0 {
		t.Fatal("legacy invented a dispatch", observed, e)
	}
	store.present = false
	observed, e = resolve(s, api, store, legacy, nil)
	if e != nil || !observed.ObjectRemoved || observed.OperationID != nil || store.erases != 0 {
		t.Fatal("legacy absent observation", observed, e)
	}
	abandoned := descriptor("chat")
	reserve(s, api, abandoned, false)
	store = &controlledStore{present: true, size: abandoned.ByteSize, hash: abandoned.SHA256}
	restart := &Service{Pool: worker, Endpoint: s.Endpoint}
	claim = reserve(restart, worker, abandoned, false)
	r, e := resolve(restart, worker, store, abandoned, claim)
	if e != nil || r.ObjectRemoved || store.erases != 0 {
		t.Fatal("abandoned reservation dispatched", r, e, store.erases)
	}
	success := descriptor("outcome")
	store = &controlledStore{present: true, mode: "unknown-absent", size: success.ByteSize, hash: success.SHA256}
	r, e = resolve(s, api, store, success, reserve(s, api, success, false))
	if e != nil || !r.ObjectRemoved || store.erases != 1 {
		t.Fatal("lost ACK with absent HEAD", r, e, store.erases)
	}
	dishonest := descriptor("chat")
	store = &controlledStore{present: true, mode: "success-present", size: dishonest.ByteSize, hash: dishonest.SHA256}
	r, e = resolve(s, api, store, dishonest, reserve(s, api, dishonest, false))
	if e != nil || r.ObjectRemoved || store.erases != 1 {
		t.Fatal("DELETE ACK treated as absence", r, e)
	}
	r, e = resolve(s, api, store, dishonest, nil)
	if e != nil || r.ObjectRemoved || store.erases != 1 {
		t.Fatal("positive HEAD resent successful ACK", r, e, store.erases)
	}
	changed := dishonest
	changed.StorageKey += "-changed"
	_, e = postgres.InTx(ctx, api, func(tx pgx.Tx) (*Reservation, error) { return s.ReserveWithin(ctx, tx, changed, false) })
	if fault.Code(e) != "attachment_cleanup_source_changed" {
		t.Fatal("changed object reused receipt", e)
	}
}
