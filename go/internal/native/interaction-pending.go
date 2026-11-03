package native

import "time"

// PendingInteractions describes only process-local interactive state. The
// earliest expiry is zero when no future deadline is known; an in-flight
// operation can remain pending beyond its original deadline.
func (s *ToolServer) PendingInteractions() (int, time.Time) {
	if s == nil || s.tools == nil {
		return 0, time.Time{}
	}
	r := s.tools
	count, next := r.pendingChoices()
	if r.browser != nil {
		n, expiry := r.browser.pendingInteractions()
		count += n
		next = pendingEarlier(next, expiry)
	}
	for _, source := range r.pending {
		n, expiry := source()
		count += n
		next = pendingEarlier(next, expiry)
	}
	return count, next
}

func pendingEarlier(a, b time.Time) time.Time {
	if a.IsZero() || !b.IsZero() && b.Before(a) {
		return b
	}
	return a
}

func pendingAdd(count *int, next *time.Time, now, expires time.Time, running bool) {
	if !running && !expires.After(now) {
		return
	}
	*count++
	if expires.After(now) {
		*next = pendingEarlier(*next, expires)
	}
}

func (r *toolRuntime) pendingChoices() (int, time.Time) {
	if !r.mu.TryLock() {
		return 1, time.Time{}
	}
	defer r.mu.Unlock()
	var count int
	var next time.Time
	now := time.Now()
	for _, item := range r.choices {
		pendingAdd(&count, &next, now, item.Expires, item.Running)
	}
	return count, next
}

func (b *BrowserChoices) pendingInteractions() (int, time.Time) {
	if !b.mu.TryLock() {
		return 1, time.Time{}
	}
	if b.closed {
		b.mu.Unlock()
		return 0, time.Time{}
	}
	var count int
	var next time.Time
	now := b.now()
	for _, item := range b.entries {
		if item.state != "declined-delivered" {
			pendingAdd(&count, &next, now, item.expires, item.running)
		}
	}
	recovery := make([]*recoveryBrowserEntry, 0, len(b.recoveryEntries))
	for _, item := range b.recoveryEntries {
		recovery = append(recovery, item)
	}
	b.mu.Unlock()
	for _, item := range recovery {
		if !item.mu.TryLock() {
			count++
			continue
		}
		if item.stage != "done" {
			pendingAdd(&count, &next, now, item.expires, false)
		}
		item.mu.Unlock()
	}
	return count, next
}

func (a *NativeIdentityAccounts) pendingInteractions() (int, time.Time) {
	if !a.mu.TryLock() {
		return 1, time.Time{}
	}
	defer a.mu.Unlock()
	var count int
	var next time.Time
	now := a.runtime.connection.now()
	for _, p := range a.previews {
		if p.state == "prepared" || p.state == "running" {
			pendingAdd(&count, &next, now, time.UnixMilli(p.expiresAt), p.state == "running")
		}
	}
	return count, next
}

func (d *NativeDeviceManagement) pendingInteractions() (int, time.Time) {
	if !d.mu.TryLock() {
		return 1, time.Time{}
	}
	defer d.mu.Unlock()
	var count int
	var next time.Time
	now := d.runtime.connection.now()
	count += d.reserved
	for _, p := range d.previews {
		if p.state == "prepared" || p.state == "running" {
			pendingAdd(&count, &next, now, time.UnixMilli(p.expiresAt), p.state == "running")
		}
	}
	return count, next
}

func (h *NativeIdentityGroupOperations) pendingInteractions() (int, time.Time) {
	if !h.mu.TryLock() {
		return 1, time.Time{}
	}
	defer h.mu.Unlock()
	if h.closed {
		return 0, time.Time{}
	}
	var count int
	var next time.Time
	now := h.runtime.connection.now()
	for _, p := range h.previews {
		if p.state == "prepared" || p.state == "running" {
			pendingAdd(&count, &next, now, time.UnixMilli(p.expires), p.state == "running")
		}
	}
	return count, next
}

func (h *NativeTrust) pendingInteractions() (int, time.Time) {
	if !h.mu.TryLock() {
		return 1, time.Time{}
	}
	defer h.mu.Unlock()
	if h.closed {
		return 0, time.Time{}
	}
	var count int
	var next time.Time
	now := h.runtime.connection.now()
	for _, p := range h.previews {
		if p.state == "prepared" || p.state == "running" {
			pendingAdd(&count, &next, now, time.UnixMilli(p.expires), p.state == "running")
		}
	}
	return count, next
}

func (h *NativeA2a) pendingInteractions() (int, time.Time) {
	if !h.mu.TryLock() {
		return 1, time.Time{}
	}
	defer h.mu.Unlock()
	if h.closed {
		return 0, time.Time{}
	}
	var count int
	var next time.Time
	now := h.options.Now()
	for _, p := range h.previews {
		if p.state == "prepared" || p.state == "running" {
			pendingAdd(&count, &next, now, time.UnixMilli(p.expires), p.state == "running")
		}
	}
	return count, next
}

func (h *NativeA2aWork) pendingInteractions() (int, time.Time) {
	if !h.mu.TryLock() {
		return 1, time.Time{}
	}
	defer h.mu.Unlock()
	if h.closed {
		return 0, time.Time{}
	}
	count := h.preparing
	var next time.Time
	now := h.host.options.Now()
	for _, p := range h.operations {
		if p.state != "locally-stopped" {
			pendingAdd(&count, &next, now, time.UnixMilli(p.expires), p.state == "running")
		}
	}
	return count, next
}

func (h *NativeWorkerHost) pendingInteractions() (int, time.Time) {
	if !h.mu.TryLock() {
		return 1, time.Time{}
	}
	defer h.mu.Unlock()
	if h.closed {
		return 0, time.Time{}
	}
	count := h.preparing
	var next time.Time
	now := h.now()
	for _, p := range h.previews {
		if p.state != "locally-stopped" {
			pendingAdd(&count, &next, now, time.UnixMilli(p.expiresAt), p.state == "running")
		}
	}
	return count, next
}

func (h *NativeWebHandoff) pendingInteractions() (int, time.Time) {
	building := !h.building.TryLock()
	if !building {
		h.building.Unlock()
	}
	if !h.mu.TryLock() {
		return 1, time.Time{}
	}
	if h.closed {
		h.mu.Unlock()
		return 0, time.Time{}
	}
	entries := make([]*webIdentityBridge, 0, len(h.entries))
	for _, b := range h.entries {
		entries = append(entries, b)
	}
	h.mu.Unlock()
	count := 0
	if building {
		count++
	}
	var next time.Time
	now := h.runtime.connection.now()
	for _, b := range entries {
		if !b.mu.TryLock() {
			count++
			continue
		}
		if (!b.closed.Load() || b.state == "approving") && !isOne(b.state, "completed", "canceled", "expired", "stopped") {
			pendingAdd(&count, &next, now, time.Unix(b.expires, 0), b.state == "approving")
		}
		b.mu.Unlock()
	}
	return count, next
}
