// Package objectremoval records technical object-removal uncertainty. Owning
// domains still authorize, lock and qualify every source and erase their own
// metadata; this package never treats a pending marker as business permission.
package objectremoval

import (
	"context"
	"encoding/json"
	"github.com/agigalaxy-team/agigalaxy/go/internal/attachments"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/identity"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"strings"
	"sync/atomic"
	"time"
)

type Object = map[string]any
type Service struct {
	Pool     *pgxpool.Pool
	Endpoint string
	Now      func() time.Time
}
type Descriptor struct {
	Domain, ObjectID, StorageKey, KeyID, SHA256 string
	ByteSize                                    int64
}
type Result struct {
	State          string
	ObjectRemoved  bool
	OperationID    *string
	DispatchIssued bool
}

// Reservation is deliberately opaque and single-use. Only a newly committed
// reservation from this service can authorize one current process dispatch.
// Existing reserved/unknown and legacy records can only be inspected by HEAD.
type Reservation struct {
	service                            *Service
	tx                                 pgx.Tx
	fingerprint, domain, id, operation string
	fresh                              bool
	progress                           atomic.Int32 // 0 fresh, 1 inspecting, 2 proved not sent, 3 sent
}
type removalStore interface {
	Head(context.Context, string, string) (*attachments.Head, error)
	Erase(context.Context, string) error
}

func fail(code string, status int) error { return fault.New(code, status) }
func Capable(store any) bool             { _, ok := store.(removalStore); return ok }
func (s *Service) now() time.Time {
	if s.Now != nil {
		return s.Now().UTC()
	}
	return time.Now().UTC()
}
func descriptorFingerprint(d Descriptor) (string, error) {
	u, e := uuid.Parse(d.ObjectID)
	if e != nil || !strings.EqualFold(u.String(), d.ObjectID) || d.Domain != "chat" && d.Domain != "forum" && d.Domain != "outcome" || d.StorageKey == "" || d.KeyID == "" || d.ByteSize < 0 || len(d.SHA256) != 64 || strings.Trim(d.SHA256, "0123456789abcdef") != "" {
		return "", fail("attachment_cleanup_source_changed", 409)
	}
	b, e := identity.Canonical(Object{"domain": d.Domain, "objectId": d.ObjectID, "key": d.StorageKey, "keyId": d.KeyID, "byteSize": d.ByteSize, "sha256": d.SHA256})
	if e != nil {
		return "", e
	}
	return identity.Digest(b), nil
}
func load(ctx context.Context, tx pgx.Tx, endpoint string, d Descriptor, lock bool) (Object, error) {
	clause := ""
	if lock {
		clause = " FOR UPDATE"
	}
	var b []byte
	e := tx.QueryRow(ctx, "SELECT to_jsonb(r) FROM galaxy_go_storage.object_removals_v1 r WHERE endpoint=$1 AND domain=$2 AND object_id=$3"+clause, endpoint, d.Domain, d.ObjectID).Scan(&b)
	if e == pgx.ErrNoRows {
		return nil, nil
	}
	if e != nil {
		return nil, e
	}
	var r Object
	e = json.Unmarshal(b, &r)
	return r, e
}
func text(r Object, k string) string { v, _ := r[k].(string); return v }
func result(r Object) Result {
	v := Result{State: text(r, "state"), ObjectRemoved: text(r, "state") == "absent"}
	if op := text(r, "operation_id"); op != "" {
		v.OperationID = &op
	}
	return v
}

// ReserveWithin must be committed before ResolveWithin. The caller holds its
// original source lock and has established the current cleanup qualification.
// legacyUnknown only preserves an old indeterminate cleanup; it never infers
// that a DELETE was sent and never creates a substitute operation identifier.
func (s *Service) ReserveWithin(ctx context.Context, tx pgx.Tx, d Descriptor, legacyUnknown bool) (*Reservation, error) {
	return s.reserveWithin(ctx, tx, d, legacyUnknown, true)
}

// ObserveWithin adopts/rechecks uncertainty without claiming a dispatch, even
// when another current path has proved that its own attempt was not sent.
func (s *Service) ObserveWithin(ctx context.Context, tx pgx.Tx, d Descriptor) (*Reservation, error) {
	return s.reserveWithin(ctx, tx, d, true, false)
}
func (s *Service) reserveWithin(ctx context.Context, tx pgx.Tx, d Descriptor, legacyUnknown, allowDispatch bool) (*Reservation, error) {
	fingerprint, e := descriptorFingerprint(d)
	if e != nil {
		return nil, e
	}
	state := "reserved"
	var operation any = uuid.NewString()
	if legacyUnknown {
		state = "legacy-unknown"
		operation = nil
	}
	tag, e := tx.Exec(ctx, `INSERT INTO galaxy_go_storage.object_removals_v1(endpoint,domain,object_id,operation_id,object_fingerprint,state,created_at,checked_at) VALUES($1,$2,$3,$4,$5,$6,$7,$7) ON CONFLICT(endpoint,domain,object_id) DO NOTHING`, s.Endpoint, d.Domain, d.ObjectID, operation, fingerprint, state, s.now())
	if e != nil {
		return nil, fail("attachment_cleanup_unavailable", 503)
	}
	r, e := load(ctx, tx, s.Endpoint, d, true)
	if e != nil {
		return nil, e
	}
	if r == nil || text(r, "object_fingerprint") != fingerprint {
		return nil, fail("attachment_cleanup_source_changed", 409)
	}
	fresh := allowDispatch && tag.RowsAffected() == 1 && !legacyUnknown
	if allowDispatch && text(r, "state") == "not-dispatched" {
		if _, e = tx.Exec(ctx, "UPDATE galaxy_go_storage.object_removals_v1 SET state='reserved',checked_at=$4 WHERE endpoint=$1 AND domain=$2 AND object_id=$3 AND state='not-dispatched'", s.Endpoint, d.Domain, d.ObjectID, s.now()); e != nil {
			return nil, e
		}
		fresh = true
	}
	return &Reservation{service: s, tx: tx, fingerprint: fingerprint, domain: d.Domain, id: d.ObjectID, operation: text(r, "operation_id"), fresh: fresh}, nil
}

// ResolveWithin is called under the owning domain's source lock after its
// current qualification recheck. Pass a fresh committed reservation for a
// single first dispatch, or nil to reconcile only. The state transition and
// owning source's purged marker are committed in the same transaction.
func (s *Service) ResolveWithin(ctx context.Context, tx pgx.Tx, store any, d Descriptor, claim *Reservation) (Result, error) {
	fingerprint, e := descriptorFingerprint(d)
	if e != nil {
		return Result{}, e
	}
	r, e := load(ctx, tx, s.Endpoint, d, true)
	if e != nil {
		return Result{}, fail("attachment_cleanup_unavailable", 503)
	}
	if r == nil || text(r, "object_fingerprint") != fingerprint {
		return Result{}, fail("attachment_cleanup_source_changed", 409)
	}
	out := result(r)
	if out.ObjectRemoved {
		return out, nil
	}
	fresh := claim != nil && claim.service == s && claim.tx != tx && claim.fresh && claim.domain == d.Domain && claim.id == d.ObjectID && claim.fingerprint == fingerprint && claim.operation == text(r, "operation_id") && text(r, "state") == "reserved" && claim.progress.CompareAndSwap(0, 1)
	inspected, inspectError := inspect(ctx, store, d)
	dispatched := false
	if inspectError == nil && fresh && !inspected.ObjectRemoved {
		controlled := store.(removalStore)
		dispatched = true
		claim.progress.Store(3)
		eraseError := controlled.Erase(ctx, d.StorageKey)
		inspected, inspectError = inspect(ctx, store, d)
		if inspectError == nil && !inspected.ObjectRemoved && eraseError != nil {
			inspectError = eraseError
		}
	}
	if fresh && !dispatched {
		claim.progress.Store(2)
	}
	state := text(r, "state")
	var completed any
	if inspectError == nil && inspected.ObjectRemoved {
		state = "absent"
		completed = s.now()
	} else if fresh && !dispatched || state == "not-dispatched" {
		state = "not-dispatched"
	} else if state != "legacy-unknown" {
		state = "result-unknown"
	}
	var code any
	if inspectError != nil {
		code = fault.Code(inspectError)
	} else if !inspected.ObjectRemoved {
		code = "attachment_cleanup_failed"
	}
	_, e = tx.Exec(ctx, `UPDATE galaxy_go_storage.object_removals_v1 SET state=$4,checked_at=$5,completed_at=$6,last_error=COALESCE($7,last_error) WHERE endpoint=$1 AND domain=$2 AND object_id=$3`, s.Endpoint, d.Domain, d.ObjectID, state, s.now(), completed, code)
	if e != nil {
		return Result{}, e
	}
	out.State, out.ObjectRemoved, out.DispatchIssued = state, state == "absent", dispatched
	if inspectError != nil {
		return out, inspectError
	}
	return out, nil
}
func (s *Service) StatusWithin(ctx context.Context, tx pgx.Tx, d Descriptor) (Result, error) {
	fingerprint, e := descriptorFingerprint(d)
	if e != nil {
		return Result{}, e
	}
	r, e := load(ctx, tx, s.Endpoint, d, false)
	if e != nil {
		return Result{}, e
	}
	if r == nil {
		return Result{State: "not-recorded"}, nil
	}
	if text(r, "object_fingerprint") != fingerprint {
		return Result{}, fail("attachment_cleanup_source_changed", 409)
	}
	return result(r), nil
}
func inspect(ctx context.Context, store any, d Descriptor) (Result, error) {
	s, ok := store.(removalStore)
	if !ok {
		return Result{}, fail("attachment_cleanup_unavailable", 503)
	}
	head, e := s.Head(ctx, d.StorageKey, d.KeyID)
	if e != nil {
		return Result{}, e
	}
	if head == nil {
		return Result{State: "absent", ObjectRemoved: true}, nil
	}
	if head.Size != d.ByteSize || head.SHA256 != nil && *head.SHA256 != d.SHA256 {
		return Result{}, fail("attachment_storage_integrity_failed", 502)
	}
	return Result{State: "present"}, nil
}

// NotDispatchedWithin records only a positive observation from this process's
// own unused reservation, never a legacy error code or an attempt counter.
func (s *Service) NotDispatchedWithin(ctx context.Context, tx pgx.Tx, claim *Reservation, code string) (bool, error) {
	if claim == nil || claim.service != s || claim.tx == tx || !claim.fresh {
		return false, nil
	}
	progress := claim.progress.Load()
	if progress == 0 {
		if !claim.progress.CompareAndSwap(0, 2) {
			return false, nil
		}
	} else if progress != 2 {
		return false, nil
	}
	var errorCode any
	if code != "" {
		errorCode = code
	}
	tag, e := tx.Exec(ctx, `UPDATE galaxy_go_storage.object_removals_v1 SET state='not-dispatched',checked_at=$6,last_error=COALESCE($7,last_error) WHERE endpoint=$1 AND domain=$2 AND object_id=$3 AND operation_id=$4 AND object_fingerprint=$5 AND state='reserved'`, s.Endpoint, claim.domain, claim.id, claim.operation, claim.fingerprint, s.now(), errorCode)
	return e == nil && tag.RowsAffected() == 1, e
}
