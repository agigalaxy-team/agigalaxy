package nativebridge

import (
	"context"
	"time"

	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/google/uuid"
)

func (s *service) addRelay(r *relayDrainState) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.draining {
		return false
	}
	if s.relays == nil {
		s.relays = map[*relayDrainState]struct{}{}
	}
	s.relays[r] = struct{}{}
	return true
}
func (s *service) removeRelay(r *relayDrainState) {
	s.mu.Lock()
	delete(s.relays, r)
	s.mu.Unlock()
	r.mu.Lock()
	r.closed = true
	r.signal()
	r.mu.Unlock()
}
func (s *service) addLegacy() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.draining {
		return false
	}
	s.legacy++
	return true
}
func (s *service) removeLegacy() { s.mu.Lock(); s.legacy--; s.mu.Unlock() }
func (s *service) pendingChoices() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	n := 0
	for _, p := range s.profiles {
		if p.local != nil {
			c, _ := p.local.PendingInteractions()
			n += c
		}
		if p.full != nil {
			c, _ := p.full.PendingInteractions()
			n += c
		}
	}
	return n
}
func (s *service) pendingHostNotifications() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	n := 0
	for _, p := range s.profiles {
		if p.runtime != nil {
			n += p.runtime.PendingHostNotifications()
		}
	}
	return n
}
func (s *service) drain(ctx context.Context) (result error) {
	s.mu.Lock()
	if s.draining {
		s.mu.Unlock()
		return fault.New("native_handover_in_progress", 409)
	}
	if s.legacy != 0 {
		s.mu.Unlock()
		return fault.New("native_handover_legacy_connection", 409)
	}
	s.draining = true
	relays := make([]*relayDrainState, 0, len(s.relays))
	for r := range s.relays {
		relays = append(relays, r)
	}
	s.mu.Unlock()
	attempt := uuid.NewString()
	for _, r := range relays {
		r.mu.Lock()
		r.attempt, r.paused, r.drained, r.pauseSent = attempt, false, false, 0
		r.mu.Unlock()
	}
	defer func() {
		if result != nil {
			for _, r := range relays {
				_ = r.writer.control(map[string]any{"type": "resume", "attempt": attempt})
			}
			s.mu.Lock()
			s.draining = false
			s.mu.Unlock()
		}
	}()
	ticker := time.NewTicker(20 * time.Millisecond)
	defer ticker.Stop()
	wait := func(check func() bool) error {
		for {
			for _, r := range relays {
				r.mu.Lock()
				lost := r.closed && !r.drained
				r.mu.Unlock()
				if lost {
					return fault.New("native_handover_connection_lost", 409)
				}
			}
			if check() {
				return nil
			}
			select {
			case <-ctx.Done():
				return fault.New("native_handover_waiting_requests", 409)
			case <-ticker.C:
			}
		}
	}
	if err := wait(func() bool {
		for _, r := range relays {
			r.mu.Lock()
			ready := r.ready || r.closed
			r.mu.Unlock()
			if !ready {
				return false
			}
		}
		return true
	}); err != nil {
		return err
	}
	for _, r := range relays {
		r.mu.Lock()
		closed := r.closed
		r.mu.Unlock()
		if !closed {
			if e := r.writer.control(map[string]any{"type": "pause", "attempt": attempt}); e != nil {
				return e
			}
		}
	}
	if err := wait(func() bool {
		for _, r := range relays {
			if !r.safe() {
				return false
			}
		}
		return true
	}); err != nil {
		return err
	}
	if err := wait(func() bool { return s.pendingHostNotifications() == 0 }); err != nil {
		return err
	}
	if s.pendingChoices() > 0 {
		return fault.New("native_handover_waiting_choice", 409)
	}
	for _, r := range relays {
		r.mu.Lock()
		closed := r.closed
		r.mu.Unlock()
		if !closed {
			if e := r.writer.control(map[string]any{"type": "drained", "attempt": attempt}); e != nil {
				return e
			}
		}
	}
	if err := wait(func() bool {
		for _, r := range relays {
			r.mu.Lock()
			done := r.drained || r.closed
			r.mu.Unlock()
			if !done {
				return false
			}
		}
		return true
	}); err != nil {
		return err
	}
	return nil
}
