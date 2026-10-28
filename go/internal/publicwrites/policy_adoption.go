package publicwrites

import "sync/atomic"

type policySnapshot struct{ value Object }
type policyState struct {
	current atomic.Pointer[policySnapshot]
}

func clonePolicyValue(v any) any {
	switch v := v.(type) {
	case map[string]any:
		out := Object{}
		for k, x := range v {
			out[k] = clonePolicyValue(x)
		}
		return out
	case []any:
		out := make([]any, len(v))
		for i, x := range v {
			out[i] = clonePolicyValue(x)
		}
		return out
	case []string:
		return append([]string(nil), v...)
	default:
		return v
	}
}

// PolicyAdopter is initialized before publishing the service or request copies.
// Runtime adoption swaps an immutable original-policy snapshot shared by copies.
func (s *Service) PolicyAdopter() (func(Object) error, error) {
	if s.policyState == nil {
		p, e := s.policy()
		if e != nil {
			return nil, e
		}
		state := &policyState{}
		state.current.Store(&policySnapshot{value: clonePolicyValue(p).(Object)})
		s.policyState = state
	}
	state := s.policyState
	return func(p Object) error {
		if e := ValidatePolicy(p); e != nil {
			return e
		}
		state.current.Store(&policySnapshot{value: clonePolicyValue(p).(Object)})
		return nil
	}, nil
}
