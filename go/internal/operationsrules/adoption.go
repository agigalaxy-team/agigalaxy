package operationsrules

import (
	"context"
	"github.com/google/uuid"
	"sync"
)

type PolicyConsumer struct {
	Key   string
	Apply func(context.Context, Object, int64) error
}
type PolicyRuntime struct {
	Rules                 *Service
	Component, InstanceID string
	consumers             []PolicyConsumer
	mu                    sync.Mutex
	active                *refreshCall
	adopted               map[string]int64
}
type refreshCall struct {
	done   chan struct{}
	result Object
	err    error
}

func NewPolicyRuntime(rules *Service, component, instanceID string, consumers []PolicyConsumer) (*PolicyRuntime, error) {
	if rules == nil || rules.Pool == nil || !has([]string{"api", "worker", "content-publisher"}, component) || len(consumers) == 0 {
		return nil, fail("operations_policy_consumers_invalid", 400)
	}
	seen := map[string]bool{}
	for _, c := range consumers {
		if !has(Keys[:3], c.Key) || c.Apply == nil || seen[c.Key] {
			return nil, fail("operations_policy_consumers_invalid", 400)
		}
		seen[c.Key] = true
	}
	if instanceID == "" {
		instanceID = uuid.NewString()
	}
	return &PolicyRuntime{Rules: rules, Component: component, InstanceID: instanceID, consumers: append([]PolicyConsumer(nil), consumers...), adopted: map[string]int64{}}, nil
}
func (r *PolicyRuntime) Refresh(ctx context.Context) (Object, error) {
	r.mu.Lock()
	if current := r.active; current != nil {
		r.mu.Unlock()
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-current.done:
			return current.result, current.err
		}
	}
	call := &refreshCall{done: make(chan struct{})}
	r.active = call
	r.mu.Unlock()
	call.result, call.err = r.refresh(ctx)
	r.mu.Lock()
	r.active = nil
	close(call.done)
	r.mu.Unlock()
	return call.result, call.err
}
func (r *PolicyRuntime) refresh(ctx context.Context) (Object, error) {
	items := []any{}
	for _, c := range r.consumers {
		row, e := r.Rules.CurrentWithin(ctx, r.Rules.Pool, c.Key)
		if e != nil {
			return nil, e
		}
		if row == nil {
			return nil, fail("operations_policy_not_initialized", 503)
		}
		version := num(row["version"])
		var errorCode any
		if r.adopted[c.Key] != version {
			policy, e := ParsePolicy(c.Key, obj(row["policy"]))
			if e == nil {
				e = c.Apply(ctx, policy, version)
			}
			if e == nil {
				r.adopted[c.Key] = version
			} else {
				errorCode = "operations_policy_apply_failed"
			}
		}
		var adopted any
		if v, ok := r.adopted[c.Key]; ok {
			adopted = v
		}
		if _, e = r.Rules.Pool.Exec(ctx, `INSERT INTO operations_policy_processes_v1(endpoint,component,instance_id,policy_key,adopted_version,attempted_version,error_code,checked_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(endpoint,component,instance_id,policy_key) DO UPDATE SET adopted_version=EXCLUDED.adopted_version,attempted_version=EXCLUDED.attempted_version,error_code=EXCLUDED.error_code,checked_at=EXCLUDED.checked_at`, r.Rules.Endpoint, r.Component, r.InstanceID, c.Key, adopted, version, errorCode, r.Rules.now()); e != nil {
			return nil, e
		}
		items = append(items, Object{"key": c.Key, "adoptedVersion": adopted, "attemptedVersion": version, "errorCode": errorCode})
	}
	return Object{"component": r.Component, "instanceId": r.InstanceID, "items": items}, nil
}
