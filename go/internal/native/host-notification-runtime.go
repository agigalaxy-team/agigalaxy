package native

import (
	"context"
	"regexp"
	"strings"
	"sync"
	"time"

	"github.com/google/uuid"
)

type hostNotificationVisible struct {
	prompt map[string]any
	cancel context.CancelFunc
}
type HostNotificationOptions struct {
	CreateChannel func() (HostNotificationChannel, error)
	Interval      time.Duration
}

// NativeHostNotifications is the original explicit, process-local opt-in. It
// resumes only observed display ACKs, never a saved enable choice or OS display.
type NativeHostNotifications struct {
	permissionRevision uint64
	permissionWait     sync.WaitGroup
	runtime            *Runtime
	options            HostNotificationOptions
	mu                 sync.Mutex
	instanceMu         sync.Mutex
	closed, enabled    bool
	generation         uint64
	selected           *nativeIdentityLease
	channel            HostNotificationChannel
	clientID           string
	timerCancel        context.CancelFunc
	permissionCancels  map[string]context.CancelFunc
	visible            map[string]*hostNotificationVisible
	inFlight           *capsuleWorkFlight
	activation         string
}

func NewNativeHostNotifications(r *Runtime, options HostNotificationOptions) (*NativeHostNotifications, error) {
	if options.Interval == 0 {
		options.Interval = 60 * time.Second
	}
	if options.Interval < 60*time.Second {
		return nil, connectionFailure("notification_poll_interval_invalid")
	}
	if options.CreateChannel == nil {
		options.CreateChannel = func() (HostNotificationChannel, error) {
			return NewConfiguredHostNotificationChannel(r.config.HostNotifications)
		}
	}
	return &NativeHostNotifications{runtime: r, options: options, activation: uuid.NewString(), permissionCancels: map[string]context.CancelFunc{}, visible: map[string]*hostNotificationVisible{}}, nil
}
func notificationJournalKey(l *nativeIdentityLease) string {
	return "host-notifications:" + hostJSONString([]any{l.scope.Endpoint, l.scope.Owner})
}
func notificationFlags(v map[string]any) map[string]any {
	v["humanReadChanged"] = false
	v["agentCursorChanged"] = false
	return v
}
func (h *NativeHostNotifications) guard(ctx context.Context, l *nativeIdentityLease, epoch *uint64) error {
	h.mu.Lock()
	valid := !h.closed
	if epoch != nil {
		valid = valid && h.enabled && h.generation == *epoch && h.selected != nil && h.selected.scope == l.scope && h.selected.connection.bindingID == l.connection.bindingID && h.selected.connection.generation == l.connection.generation
	}
	h.mu.Unlock()
	if !valid {
		return connectionFailure("notification_binding_or_choice_changed")
	}
	return l.check(ctx)
}
func (h *NativeHostNotifications) instance(ctx context.Context, l *nativeIdentityLease) error {
	h.instanceMu.Lock()
	defer h.instanceMu.Unlock()
	h.mu.Lock()
	channel := h.channel
	closed := h.closed
	h.mu.Unlock()
	if closed {
		return connectionFailure("notification_runtime_closed")
	}
	if channel != nil {
		return h.guard(ctx, l, nil)
	}
	if e := h.guard(ctx, l, nil); e != nil {
		return e
	}
	var saved map[string]any
	e := l.update(ctx, "native-notification-delivery-client", func(old map[string]any) (map[string]any, error) {
		if old == nil {
			old = map[string]any{"id": uuid.NewString()}
		}
		if !controlUUID(text(old["id"])) {
			return nil, connectionFailure("notification_runtime_configuration_invalid")
		}
		saved = old
		return old, nil
	})
	if e != nil {
		return e
	}
	channel, e = h.options.CreateChannel()
	if e != nil {
		return e
	}
	if e = h.guard(ctx, l, nil); e != nil {
		_ = channel.Close(context.Background())
		return e
	}
	h.mu.Lock()
	if h.closed {
		h.mu.Unlock()
		_ = channel.Close(context.Background())
		return connectionFailure("notification_runtime_closed")
	}
	h.channel = channel
	h.clientID = text(saved["id"])
	h.mu.Unlock()
	return nil
}
func (h *NativeHostNotifications) update(ctx context.Context, l *nativeIdentityLease, change func(map[string]any) error) error {
	return l.update(ctx, notificationJournalKey(l), func(old map[string]any) (map[string]any, error) {
		if old == nil {
			old = map[string]any{"owner": map[string]any{"subjectId": l.scope.Owner, "endpoint": l.scope.Endpoint}, "prompts": []any{}}
		}
		owner := uploadObject(old["owner"])
		prompts, ok := old["prompts"].([]any)
		if owner["subjectId"] != l.scope.Owner || owner["endpoint"] != l.scope.Endpoint || !ok {
			return nil, connectionFailure("notification_journal_owner_invalid")
		}
		kept := []any{}
		for _, v := range prompts {
			p := uploadObject(v)
			at := integer(p["at"])
			if at > h.runtime.connection.now().Unix()-90*86400 {
				kept = append(kept, p)
			}
		}
		old["prompts"] = kept
		if e := change(old); e != nil {
			return nil, e
		}
		return old, nil
	})
}
func (h *NativeHostNotifications) Status(ctx context.Context) (map[string]any, error) {
	h.mu.Lock()
	initialized := h.channel != nil
	enabled := h.enabled
	l := h.selected
	h.mu.Unlock()
	empty := notificationFlags(map[string]any{"enabled": false, "activationRequiredAfterRestart": true, "prompts": []any{}})
	if !initialized {
		return empty, nil
	}
	op, cancel, current, e := h.runtime.identityLease(ctx, false)
	if e != nil {
		return notificationFlags(map[string]any{"enabled": false, "prompts": []any{}}), nil
	}
	defer cancel()
	saved, e := current.read(op, notificationJournalKey(current))
	if e != nil {
		return nil, e
	}
	items := []any{}
	for _, v := range uploadRows(saved["prompts"]) {
		p := uploadObject(v)
		ids := []any{}
		ack := true
		for _, v := range uploadRows(p["claims"]) {
			claim := uploadObject(v)
			ids = append(ids, claim["id"])
			ack = ack && claim["acknowledged"] == true
		}
		items = append(items, map[string]any{"promptId": p["promptId"], "state": p["state"], "at": p["at"], "displayEvidence": p["displayEvidence"], "notificationIds": ids, "presentationAcknowledged": ack})
	}
	empty["prompts"] = items
	empty["enabled"] = enabled && l != nil && l.scope == current.scope && l.connection.bindingID == current.connection.bindingID && l.connection.generation == current.connection.generation
	return empty, nil
}
func (h *NativeHostNotifications) withdraw(ctx context.Context) error {
	h.mu.Lock()
	channel := h.channel
	visible := h.visible
	h.visible = map[string]*hostNotificationVisible{}
	h.mu.Unlock()
	var first error
	for id, v := range visible {
		v.cancel()
		if channel != nil {
			if e := channel.Withdraw(ctx, id); e != nil && first == nil {
				first = e
			}
		}
	}
	return first
}
func (h *NativeHostNotifications) Disable(ctx context.Context) error {
	_, e := h.DisableResult(ctx)
	return e
}
func (h *NativeHostNotifications) DisableResult(ctx context.Context) (map[string]any, error) {
	h.mu.Lock()
	h.generation++
	epoch := h.generation
	l := h.selected
	h.selected = nil
	h.enabled = false
	cancel := h.timerCancel
	h.timerCancel = nil
	permissions := h.permissionCancels
	h.permissionCancels = map[string]context.CancelFunc{}
	h.mu.Unlock()
	if cancel != nil {
		cancel()
	}
	for _, cancel := range permissions {
		cancel()
	}
	if e := h.withdraw(ctx); e != nil {
		return nil, e
	}
	if l != nil {
		if e := h.update(ctx, l, func(state map[string]any) error {
			h.mu.Lock()
			defer h.mu.Unlock()
			if h.generation == epoch {
				state["choice"] = map[string]any{"enabled": false, "selectedAt": h.runtime.connection.now().Unix(), "bindingId": l.connection.bindingID}
			}
			return nil
		}); e != nil {
			return nil, e
		}
	}
	h.mu.Lock()
	superseded := h.generation != epoch
	enabled := h.enabled
	h.mu.Unlock()
	return notificationFlags(map[string]any{"enabled": enabled, "superseded": superseded, "systemRecall": "best-effort"}), nil
}
func (h *NativeHostNotifications) EnableReviewed(ctx context.Context, l *nativeIdentityLease, scope *ChoiceScope, expected uint64) (map[string]any, error) {
	if scope == nil || *scope != l.scope {
		return nil, connectionFailure("notification_binding_or_choice_changed")
	}
	h.mu.Lock()
	if h.closed || h.generation != expected {
		h.mu.Unlock()
		return nil, connectionFailure("notification_choice_changed")
	}
	h.generation++
	epoch := h.generation
	h.enabled = false
	h.selected = nil
	oldTimer := h.timerCancel
	h.timerCancel = nil
	h.mu.Unlock()
	if oldTimer != nil {
		oldTimer()
	}
	if e := h.instance(ctx, l); e != nil {
		return nil, e
	}
	if e := h.withdraw(ctx); e != nil {
		return nil, e
	}
	if e := h.update(ctx, l, func(state map[string]any) error {
		h.mu.Lock()
		defer h.mu.Unlock()
		if h.closed || h.generation != epoch {
			return connectionFailure("notification_choice_changed")
		}
		state["choice"] = map[string]any{"enabled": true, "selectedAt": h.runtime.connection.now().Unix(), "bindingId": l.connection.bindingID}
		return nil
	}); e != nil {
		return nil, e
	}
	if e := h.guard(ctx, l, nil); e != nil {
		return nil, e
	}
	h.mu.Lock()
	if h.closed || h.generation != epoch {
		h.mu.Unlock()
		return notificationFlags(map[string]any{"enabled": false, "superseded": true, "modelCalls": 0}), nil
	}
	h.selected = l
	h.enabled = true
	timerCtx, cancel := context.WithCancel(context.Background())
	h.timerCancel = cancel
	channel := h.channel
	h.mu.Unlock()
	go func() {
		timer := time.NewTicker(h.options.Interval)
		defer timer.Stop()
		for {
			select {
			case <-timerCtx.Done():
				return
			case <-timer.C:
				if result, e := h.Check(timerCtx); e != nil || result["state"] == "binding-changed" || result["state"] == "disabled" {
					_, _ = h.DisableResult(context.Background())
					return
				}
				h.mu.Lock()
				active := h.enabled && h.generation == epoch
				h.mu.Unlock()
				if !active {
					return
				}
			}
		}
	}()
	return notificationFlags(map[string]any{"enabled": true, "channel": channel.Kind(), "checkIntervalSeconds": h.options.Interval.Seconds(), "modelCalls": 0}), nil
}
func (h *NativeHostNotifications) PermissionReviewed(ctx context.Context, l *nativeIdentityLease, scope *ChoiceScope, expected uint64) (map[string]any, error) {
	if scope == nil || *scope != l.scope {
		return nil, connectionFailure("notification_binding_or_choice_changed")
	}
	h.mu.Lock()
	if h.closed || h.generation != expected {
		h.mu.Unlock()
		return nil, connectionFailure("notification_choice_changed")
	}
	id := uuid.NewString()
	permissionCtx, cancel := context.WithCancel(ctx)
	h.permissionCancels[id] = cancel
	h.permissionWait.Add(1)
	h.mu.Unlock()
	defer h.permissionWait.Done()
	channel, e := h.options.CreateChannel()
	if e != nil {
		cancel()
		h.mu.Lock()
		delete(h.permissionCancels, id)
		h.mu.Unlock()
		return nil, e
	}
	defer func() {
		cancel()
		_ = channel.Close(context.Background())
		h.mu.Lock()
		delete(h.permissionCancels, id)
		h.mu.Unlock()
	}()
	current := func() bool {
		h.mu.Lock()
		valid := !h.closed && h.generation == expected
		h.mu.Unlock()
		return valid && l.check(permissionCtx) == nil
	}
	result, e := channel.Permission(permissionCtx, current)
	if e != nil {
		return nil, e
	}
	if !current() {
		return nil, connectionFailure("notification_binding_or_choice_changed")
	}
	result["reminderPreferenceChanged"] = false
	result["systemDisplayConfirmed"] = false
	result["modelCalls"] = 0
	return notificationFlags(result), nil
}

var hostNotificationID = regexp.MustCompile(`^(moderation-report|moderation-event|target-governance|information-change|qualification-request|assistance|context|context-accept|capsule|incident|room-message|room-invite|task-v2|task-comment|comment-governance):[0-9a-f-]{36}$`)

func hostNotificationEligible(item map[string]any) bool {
	id := text(item["id"])
	part := strings.Split(id, ":")
	return hostNotificationID.MatchString(id) && len(part) == 2 && controlUUID(part[1]) && item["interruptiveEligible"] == true && item["quiet"] == false && item["read"] == false && item["presented"] == false
}
func notificationSafeObject(v any) any {
	object := uploadObject(v)
	if !isOne(text(object["type"]), "capsule", "qualification-request", "room", "task", "information-watch", "project", "target-governance", "moderation", "room-invitation", "builder", "worker-pack", "hub", "assistance", "incident", "context", "context-accept") || !controlUUID(text(object["id"])) {
		return nil
	}
	return map[string]any{"type": object["type"], "id": object["id"]}
}
func notificationFallback(reason string, items []any) map[string]any {
	out := []any{}
	for _, v := range items {
		item := uploadObject(v)
		out = append(out, map[string]any{"notificationId": item["id"], "object": notificationSafeObject(item["object"]), "navigation": "/app/notifications"})
	}
	return notificationFlags(map[string]any{"state": "foreground-fallback", "reason": reason, "systemDisplayConfirmed": false, "automaticRetry": false, "items": out})
}
func (h *NativeHostNotifications) claim(ctx context.Context, l *nativeIdentityLease, input map[string]any, epoch uint64) (map[string]any, error) {
	if e := h.guard(ctx, l, &epoch); e != nil {
		return nil, e
	}
	v, e := l.call(ctx, "/v2/notifications/presentation/claim", input, false)
	if e != nil {
		return nil, e
	}
	if e = h.guard(ctx, l, &epoch); e != nil {
		return nil, e
	}
	claimed, ok := v["claimed"].(bool)
	if v["id"] != input["id"] || !ok {
		return nil, connectionFailure("notification_claim_invalid")
	}
	if !claimed {
		return nil, nil
	}
	until, e := time.Parse(time.RFC3339Nano, text(v["leaseUntil"]))
	if e != nil || v["claimId"] != input["claimId"] || !until.After(h.runtime.connection.now()) {
		return nil, connectionFailure("notification_claim_invalid")
	}
	claim := identityClone(input)
	claim["leaseUntil"] = v["leaseUntil"]
	return claim, nil
}
func (h *NativeHostNotifications) acknowledge(ctx context.Context, l *nativeIdentityLease, prompt map[string]any) error {
	for _, v := range uploadRows(prompt["claims"]) {
		claim := uploadObject(v)
		if claim["acknowledged"] == true {
			continue
		}
		if e := h.guard(ctx, l, nil); e != nil {
			return e
		}
		receipt, e := l.call(ctx, "/v2/notifications/presentation/ack", map[string]any{"id": claim["id"], "deliveryClientId": claim["deliveryClientId"], "claimId": claim["claimId"]}, false)
		if e != nil {
			return e
		}
		_, boolean := receipt["presented"].(bool)
		if receipt["id"] != claim["id"] || !boolean || receipt["humanReadChanged"] != false || receipt["acknowledgement"] != "client-reported-display" {
			return connectionFailure("notification_presentation_receipt_invalid")
		}
		if receipt["presented"] == true {
			e = h.update(ctx, l, func(state map[string]any) error {
				for _, p := range uploadRows(state["prompts"]) {
					saved := uploadObject(p)
					if saved["promptId"] != prompt["promptId"] {
						continue
					}
					for _, c := range uploadRows(saved["claims"]) {
						exact := uploadObject(c)
						if exact["id"] == claim["id"] && exact["claimId"] == claim["claimId"] {
							exact["acknowledged"] = true
						}
					}
				}
				return nil
			})
			if e != nil {
				return e
			}
		}
	}
	return h.guard(ctx, l, nil)
}
func (h *NativeHostNotifications) Reconcile(ctx context.Context, l *nativeIdentityLease) (map[string]any, error) {
	if e := h.instance(ctx, l); e != nil {
		return nil, e
	}
	state, e := l.read(ctx, notificationJournalKey(l))
	if e != nil {
		return nil, e
	}
	for _, v := range uploadRows(state["prompts"]) {
		p := uploadObject(v)
		if p["state"] == "shown" && p["displayEvidence"] == "BalloonTipShown" {
			if e = h.acknowledge(ctx, l, p); e != nil {
				return nil, e
			}
		}
	}
	return notificationFlags(map[string]any{"state": "original-display-receipts-only", "systemNotificationStarts": 0}), h.guard(ctx, l, nil)
}
func (h *NativeHostNotifications) Close() {
	h.runtime.mu.Lock()
	if h.runtime.notifications == h {
		h.runtime.notifications = nil
	}
	h.runtime.mu.Unlock()
	h.mu.Lock()
	if h.closed {
		h.mu.Unlock()
		return
	}
	h.closed = true
	h.generation++
	h.enabled = false
	timer := h.timerCancel
	permissions := h.permissionCancels
	channel := h.channel
	flight := h.inFlight
	h.mu.Unlock()
	if timer != nil {
		timer()
	}
	for _, cancel := range permissions {
		cancel()
	}
	_ = h.withdraw(context.Background())
	h.permissionWait.Wait()
	if flight != nil {
		<-flight.done
	}
	if channel != nil {
		_ = channel.Close(context.Background())
	}
}
