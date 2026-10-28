package community

import (
	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
	"sync/atomic"
)

type forumPolicySnapshot struct {
	policy Object
	hash   string
}
type forumPolicyState struct {
	current atomic.Pointer[forumPolicySnapshot]
}

func cloneForumPolicy(p Object) Object {
	out := clone(p)
	for _, k := range []string{"new", "normal"} {
		if limits := obj(p, k); limits != nil {
			out[k] = clone(limits)
		}
	}
	return out
}
func newForumPolicySnapshot(p Object) *forumPolicySnapshot {
	copy := cloneForumPolicy(p)
	static := Service{Policy: copy}
	return &forumPolicySnapshot{policy: copy, hash: static.policyHash()}
}

func adoptionPolicy(input Object) (Object, error) {
	raw, err := protocol.Encode(input)
	if err != nil {
		return nil, err
	}
	var policy Object
	if err = protocol.Decode(raw, &policy); err != nil {
		return nil, err
	}
	return parseForumPolicy(policy)
}

// PolicyAdopter is initialized during service construction, before this service
// or any request copies are published. The returned callback atomically swaps
// one immutable policy+hash snapshot shared by all later identity/read copies.
// Public Policy remains a construction input; runtime readers use the getter.
func (s *Service) PolicyAdopter() (func(Object) error, error) {
	if s.policyState == nil {
		p, e := adoptionPolicy(s.policy())
		if e != nil {
			return nil, e
		}
		state := &forumPolicyState{}
		state.current.Store(newForumPolicySnapshot(p))
		s.policyState = state
	}
	state := s.policyState
	return func(p Object) error {
		normalized, e := adoptionPolicy(p)
		if e != nil {
			return e
		}
		state.current.Store(newForumPolicySnapshot(normalized))
		return nil
	}, nil
}

// PolicySnapshot returns value and exact original ordered hash from the same
// immutable snapshot. No mutable policy map escapes to an external consumer.
func (s *Service) PolicySnapshot() (Object, string) {
	if s.policyState != nil {
		if current := s.policyState.current.Load(); current != nil {
			return cloneForumPolicy(current.policy), current.hash
		}
	}
	p := cloneForumPolicy(s.policy())
	static := Service{Policy: p}
	return p, static.policyHash()
}
