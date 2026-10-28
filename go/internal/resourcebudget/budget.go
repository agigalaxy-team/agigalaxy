// Package resourcebudget preserves the original optional per-subject storage,
// queued-work and active-export growth checks in the caller's transaction.
package resourcebudget

import (
	"context"
	"encoding/json"
	"io"
	"math/big"
	"os"
	"path/filepath"
	"strconv"
	"sync"
	"time"

	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

type Policy struct {
	Version                    int   `json:"version"`
	MaxPayloadBytesPerSubject  int64 `json:"maxPayloadBytesPerSubject"`
	MaxQueuedJobsPerSubject    int64 `json:"maxQueuedJobsPerSubject"`
	MaxActiveExportsPerSubject int64 `json:"maxActiveExportsPerSubject"`
	MaxActiveJobsGlobal        int64 `json:"maxActiveJobsGlobal"`
	MaxActiveJobsPerSubject    int64 `json:"maxActiveJobsPerSubject"`
}

func DefaultPolicy() Policy { return Policy{1, 1048576, 32, 3, 4, 1} }
func (p Policy) Validate() error {
	if p.Version != 1 || p.MaxPayloadBytesPerSubject < 0 || p.MaxPayloadBytesPerSubject > 1099511627776 || p.MaxQueuedJobsPerSubject < 1 || p.MaxQueuedJobsPerSubject > 100000 || p.MaxActiveExportsPerSubject < 1 || p.MaxActiveExportsPerSubject > 1000 || p.MaxActiveJobsGlobal < 1 || p.MaxActiveJobsGlobal > 1000 || p.MaxActiveJobsPerSubject < 1 || p.MaxActiveJobsPerSubject > 1000 {
		return fault.New("resource_budget_policy_invalid", 400)
	}
	return nil
}

// Load is the original server startup path: GALAXY_RESOURCE_BUDGET_FILE may be
// empty, in which case the original published defaults are returned. New(nil)
// remains the separate unconfigured optional-library case and applies no quota.
func Load(path string) (*Policy, error) {
	if path == "" {
		p := DefaultPolicy()
		return &p, nil
	}
	if !filepath.IsAbs(path) {
		return nil, fault.New("resource_budget_policy_invalid", 400)
	}
	before, e := os.Lstat(path)
	if e != nil {
		return nil, e
	}
	if !before.Mode().IsRegular() || before.Size() > 8192 {
		return nil, fault.New("resource_budget_policy_invalid", 400)
	}
	f, e := os.Open(path)
	if e != nil {
		return nil, e
	}
	defer f.Close()
	opened, e := f.Stat()
	if e != nil || !os.SameFile(before, opened) {
		return nil, fault.New("resource_budget_policy_invalid", 400)
	}
	raw, e := io.ReadAll(io.LimitReader(f, 8193))
	if e != nil {
		return nil, e
	}
	after, e := f.Stat()
	if e != nil || len(raw) > 8192 || after.Size() != int64(len(raw)) || !after.ModTime().Equal(opened.ModTime()) {
		return nil, fault.New("resource_budget_policy_invalid", 400)
	}
	var p Policy
	var fields map[string]json.RawMessage
	if protocol.Decode(raw, &p) != nil || json.Unmarshal(raw, &fields) != nil || len(fields) != 6 {
		return nil, fault.New("resource_budget_policy_invalid", 400)
	}
	for _, name := range []string{"version", "maxPayloadBytesPerSubject", "maxQueuedJobsPerSubject", "maxActiveExportsPerSubject", "maxActiveJobsGlobal", "maxActiveJobsPerSubject"} {
		v, ok := fields[name]
		if !ok || string(v) == "null" {
			return nil, fault.New("resource_budget_policy_invalid", 400)
		}
	}
	if e = p.Validate(); e != nil {
		return nil, e
	}
	return &p, nil
}

type SQLReader interface {
	QueryRow(context.Context, string, ...any) pgx.Row
}
type SQLExecutor interface {
	Exec(context.Context, string, ...any) (pgconn.CommandTag, error)
}
type Usage struct {
	PayloadBytes              *big.Int
	QueuedJobs, ActiveExports int64
}

func LockSubjectResourceBudget(ctx context.Context, db SQLExecutor, subject string) error {
	_, e := db.Exec(ctx, "SELECT pg_advisory_xact_lock(734912309,hashtext($1))", subject)
	return e
}

// SubjectResourceUsage executes the unchanged original SQL, including forum
// subject projections and fixed reservations. Payload bytes stay arbitrary
// precision, matching the original BigInt rather than a float or int64 counter.
func SubjectResourceUsage(ctx context.Context, db SQLReader, subject string, now int64) (Usage, error) {
	var u Usage
	var payload string
	if e := db.QueryRow(ctx, subjectPayloadSQL, subject).Scan(&payload); e != nil {
		return u, e
	}
	n, ok := new(big.Int).SetString(payload, 10)
	if !ok {
		return u, fault.New("resource_usage_invalid", 500)
	}
	u.PayloadBytes = n
	var jobs, exports string
	if e := db.QueryRow(ctx, subjectJobsSQL, subject).Scan(&jobs); e != nil {
		return u, e
	}
	if e := db.QueryRow(ctx, subjectExportsSQL, subject, time.Unix(now, 0).UTC()).Scan(&exports); e != nil {
		return u, e
	}
	var e error
	u.QueuedJobs, e = strconv.ParseInt(jobs, 10, 64)
	if e != nil {
		return u, e
	}
	u.ActiveExports, e = strconv.ParseInt(exports, 10, 64)
	if e != nil {
		return u, e
	}
	return u, nil
}
func EnforceResourceGrowth(before, after Usage, p Policy) error {
	if after.PayloadBytes.Cmp(big.NewInt(p.MaxPayloadBytesPerSubject)) > 0 && after.PayloadBytes.Cmp(before.PayloadBytes) > 0 {
		return fault.New("storage_quota_exceeded", 409)
	}
	if after.QueuedJobs > p.MaxQueuedJobsPerSubject && after.QueuedJobs > before.QueuedJobs {
		return fault.New("job_queue_quota_exceeded", 409)
	}
	if after.ActiveExports > p.MaxActiveExportsPerSubject && after.ActiveExports > before.ActiveExports {
		return fault.New("export_ticket_quota_exceeded", 409)
	}
	return nil
}

// Actor identifies the subject whose existing resource budget is counted. It is
// not an authenticated principal; authorize must validate the real caller in tx.
type Actor struct{ SubjectID string }
type Options struct{ Control bool }
type Service struct {
	policyMu sync.RWMutex
	policy   *Policy
	now      func() time.Time
}

func New(policy *Policy, now func() time.Time) (*Service, error) {
	if policy != nil {
		if e := policy.Validate(); e != nil {
			return nil, e
		}
		copy := *policy
		policy = &copy
	}
	return &Service{policy: policy, now: now}, nil
}
func (s *Service) stamp() int64 {
	if s.now != nil {
		return s.now().Unix()
	}
	return time.Now().Unix()
}

// ResourceWrite must run in the caller's real business transaction, with its
// error propagated to that transaction. Lock order is budget, then authority;
// optional policy/control behavior is identical to original AccessService.
func (s *Service) ResourceWrite(ctx context.Context, tx pgx.Tx, actor Actor, authorize func(context.Context, pgx.Tx) error, operation func(context.Context, pgx.Tx) (any, error), o Options) (any, error) {
	policy := s.SnapshotPolicy()
	if policy != nil {
		if e := LockSubjectResourceBudget(ctx, tx, actor.SubjectID); e != nil {
			return nil, e
		}
	}
	if e := authorize(ctx, tx); e != nil {
		return nil, e
	}
	var before Usage
	if policy != nil && !o.Control {
		var e error
		before, e = SubjectResourceUsage(ctx, tx, actor.SubjectID, s.stamp())
		if e != nil {
			return nil, e
		}
	}
	result, e := operation(ctx, tx)
	if e != nil {
		return nil, e
	}
	if policy != nil && !o.Control {
		after, e := SubjectResourceUsage(ctx, tx, actor.SubjectID, s.stamp())
		if e != nil {
			return nil, e
		}
		if e = EnforceResourceGrowth(before, after, *policy); e != nil {
			return nil, e
		}
	}
	return result, nil
}
