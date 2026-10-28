package resourcebudget

import (
	"encoding/json"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"math"
)

func ParsePolicy(input map[string]any) (Policy, error) {
	bad := func() (Policy, error) { return Policy{}, fault.New("resource_budget_policy_invalid", 400) }
	names := []string{"version", "maxPayloadBytesPerSubject", "maxQueuedJobsPerSubject", "maxActiveExportsPerSubject", "maxActiveJobsGlobal", "maxActiveJobsPerSubject"}
	if len(input) != len(names) {
		return bad()
	}
	values := make([]int64, len(names))
	for i, key := range names {
		v, exists := input[key]
		if !exists {
			return bad()
		}
		var n float64
		switch v := v.(type) {
		case int:
			n = float64(v)
		case int64:
			n = float64(v)
		case float64:
			n = v
		case json.Number:
			f, e := v.Float64()
			if e != nil {
				return bad()
			}
			n = f
		default:
			return bad()
		}
		if math.IsNaN(n) || math.IsInf(n, 0) || n != math.Trunc(n) || n < 0 || n > 1099511627776 {
			return bad()
		}
		values[i] = int64(n)
	}
	p := Policy{Version: int(values[0]), MaxPayloadBytesPerSubject: values[1], MaxQueuedJobsPerSubject: values[2], MaxActiveExportsPerSubject: values[3], MaxActiveJobsGlobal: values[4], MaxActiveJobsPerSubject: values[5]}
	if e := p.Validate(); e != nil {
		return Policy{}, e
	}
	return p, nil
}
func (s *Service) AdoptPolicy(p Policy) error {
	if e := p.Validate(); e != nil {
		return e
	}
	copy := p
	s.policyMu.Lock()
	s.policy = &copy
	s.policyMu.Unlock()
	return nil
}

// SnapshotPolicy is immutable for the entire authorized operation, as with the
// original const budget capture before asynchronous authorization and writes.
func (s *Service) SnapshotPolicy() *Policy {
	if s == nil {
		return nil
	}
	s.policyMu.RLock()
	defer s.policyMu.RUnlock()
	if s.policy == nil {
		return nil
	}
	copy := *s.policy
	return &copy
}
