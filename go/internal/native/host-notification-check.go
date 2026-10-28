package native

import (
	"context"
	"github.com/google/uuid"
)

func (h *NativeHostNotifications) Check(ctx context.Context) (out map[string]any, err error) {
	h.mu.Lock()
	if h.closed {
		h.mu.Unlock()
		return nil, connectionFailure("notification_runtime_closed")
	}
	if !h.enabled || h.selected == nil {
		h.mu.Unlock()
		return notificationFlags(map[string]any{"state": "disabled"}), nil
	}
	if flight := h.inFlight; flight != nil {
		h.mu.Unlock()
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-flight.done:
			return uploadObject(flight.result), flight.err
		}
	}
	l, epoch, channel, client := h.selected, h.generation, h.channel, h.clientID
	flight := &capsuleWorkFlight{done: make(chan struct{})}
	h.inFlight = flight
	visible := map[string]*hostNotificationVisible{}
	for key, v := range h.visible {
		visible[key] = v
	}
	h.mu.Unlock()
	defer func() {
		if err != nil {
			if l.check(ctx) != nil {
				_ = h.withdraw(context.Background())
				out = notificationFlags(map[string]any{"state": "binding-changed", "privateContentWithheld": true})
				err = nil
			} else if h.guard(ctx, l, &epoch) != nil {
				out = notificationFlags(map[string]any{"state": "disabled"})
				err = nil
			} else {
				out = notificationFallback("current_notification_unavailable", nil)
				err = nil
			}
		}
		h.mu.Lock()
		flight.result, flight.err = out, err
		h.inFlight = nil
		close(flight.done)
		h.mu.Unlock()
	}()
	if err = h.guard(ctx, l, &epoch); err != nil {
		return nil, err
	}
	for id, shown := range visible {
		current := true
		for _, v := range uploadRows(shown.prompt["claims"]) {
			claim := uploadObject(v)
			if err = h.guard(ctx, l, &epoch); err != nil {
				return nil, err
			}
			value, e := l.call(ctx, "/v2/notifications/presentation/claim", map[string]any{"id": claim["id"], "deliveryClientId": claim["deliveryClientId"], "claimId": claim["claimId"]}, false)
			if e != nil || value["id"] != claim["id"] || value["quiet"] == true || value["presented"] != true && value["claimed"] != true {
				current = false
			}
		}
		if !current {
			shown.cancel()
			if err = channel.Withdraw(ctx, id); err != nil {
				return nil, err
			}
			h.mu.Lock()
			delete(h.visible, id)
			h.mu.Unlock()
			if err = h.guard(ctx, l, &epoch); err != nil {
				return nil, err
			}
		}
	}
	capability, e := channel.Capabilities(ctx)
	if e != nil {
		return nil, e
	}
	if err = h.guard(ctx, l, &epoch); err != nil {
		return nil, err
	}
	response, e := l.call(ctx, "/v2/notifications/query", map[string]any{"limit": 20, "unreadOnly": true}, false)
	if e != nil {
		return nil, e
	}
	if err = h.guard(ctx, l, &epoch); err != nil {
		return nil, err
	}
	items, ok := response["items"].([]any)
	if !ok || len(items) > 20 {
		return notificationFallback("notification_query_invalid", nil), nil
	}
	eligible := []any{}
	for _, v := range items {
		if hostNotificationEligible(uploadObject(v)) {
			eligible = append(eligible, v)
		}
	}
	saved, e := l.read(ctx, notificationJournalKey(l))
	if e != nil {
		return nil, e
	}
	attempted := map[string]bool{}
	for _, v := range uploadRows(saved["prompts"]) {
		for _, c := range uploadRows(uploadObject(v)["claims"]) {
			attempted[text(uploadObject(c)["id"])] = true
		}
	}
	fresh := []any{}
	for _, v := range eligible {
		if !attempted[text(uploadObject(v)["id"])] {
			fresh = append(fresh, v)
		}
	}
	if len(fresh) == 0 {
		return notificationFlags(map[string]any{"state": "no-new-items", "checked": len(eligible)}), nil
	}
	if capability["available"] != true {
		reason := text(capability["reason"])
		if reason == "" {
			reason = "host_notification_unavailable"
		}
		return notificationFallback(reason, fresh), nil
	}
	claims := []any{}
	for _, v := range fresh {
		claim, e := h.claim(ctx, l, map[string]any{"id": uploadObject(v)["id"], "deliveryClientId": client, "claimId": uuid.NewString()}, epoch)
		if e != nil {
			return nil, e
		}
		if claim != nil {
			claims = append(claims, claim)
		}
	}
	if len(claims) == 0 {
		return notificationFlags(map[string]any{"state": "claimed-by-another-or-quiet"}), nil
	}
	currentClaims := []any{}
	for _, v := range claims {
		claim := uploadObject(v)
		value, e := h.claim(ctx, l, map[string]any{"id": claim["id"], "deliveryClientId": client, "claimId": claim["claimId"]}, epoch)
		if e != nil {
			return nil, e
		}
		if value != nil {
			value["acknowledged"] = false
			currentClaims = append(currentClaims, value)
		}
	}
	if len(currentClaims) == 0 {
		return notificationFlags(map[string]any{"state": "source-or-preference-changed"}), nil
	}
	prompt := map[string]any{"promptId": uuid.NewString(), "at": h.runtime.connection.now().Unix(), "claims": currentClaims, "state": "dispatching", "displayEvidence": nil}
	err = h.update(ctx, l, func(state map[string]any) error {
		h.mu.Lock()
		active := !h.closed && h.enabled && h.generation == epoch
		h.mu.Unlock()
		if !active {
			return connectionFailure("notification_binding_or_choice_changed")
		}
		ids := map[string]bool{}
		prompts := uploadRows(state["prompts"])
		for _, v := range prompts {
			for _, v := range uploadRows(uploadObject(v)["claims"]) {
				ids[text(uploadObject(v)["id"])] = true
			}
		}
		retained := []any{}
		for _, v := range currentClaims {
			if !ids[text(uploadObject(v)["id"])] {
				retained = append(retained, v)
			}
		}
		prompt["claims"] = retained
		if len(retained) > 0 {
			if len(prompts) >= 256 {
				return connectionFailure("notification_journal_capacity")
			}
			state["prompts"] = append(prompts, identityClone(prompt))
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	if len(uploadRows(prompt["claims"])) == 0 {
		return notificationFlags(map[string]any{"state": "original-attempt-retained"}), nil
	}
	if err = h.guard(ctx, l, &epoch); err != nil {
		return nil, err
	}
	id := text(prompt["promptId"])
	promptCtx, cancel := context.WithCancel(context.Background())
	h.runtime.mu.Lock()
	lifecycle := h.runtime.lifecycle
	h.runtime.mu.Unlock()
	stopLifecycle := context.AfterFunc(lifecycle, cancel)
	shown := &hostNotificationVisible{prompt: prompt, cancel: cancel}
	h.mu.Lock()
	if !h.enabled || h.closed || h.generation != epoch {
		h.mu.Unlock()
		cancel()
		return nil, connectionFailure("notification_binding_or_choice_changed")
	}
	h.visible[id] = shown
	h.mu.Unlock()
	current := func() bool { return h.guard(promptCtx, l, &epoch) == nil }
	delivery, e := channel.Show(promptCtx, HostNotificationShow{PromptID: id, EventCount: len(uploadRows(prompt["claims"])), IsCurrent: current, OnClosed: func() { stopLifecycle(); h.mu.Lock(); delete(h.visible, id); h.mu.Unlock(); cancel() }, OnClicked: func() {
		if !current() {
			return
		}
		page, e := l.call(promptCtx, "/v2/notifications/query", map[string]any{"limit": 20}, false)
		if e != nil || !current() {
			return
		}
		ids := map[string]bool{}
		for _, v := range uploadRows(prompt["claims"]) {
			ids[text(uploadObject(v)["id"])] = true
		}
		found := false
		for _, v := range uploadRows(page["items"]) {
			item := uploadObject(v)
			if ids[text(item["id"])] && item["quiet"] == false {
				found = true
				break
			}
		}
		if found && current() {
			_, _ = NewNativeNavigation(h.runtime, NavigationOptions{}).Open(promptCtx, map[string]any{"object": map[string]any{"kind": "notifications"}})
		}
	}})
	if e != nil {
		delivery = notificationUnknown("notification_display_unconfirmed")
	}
	displayed := delivery["state"] == "shown" && delivery["displayed"] == true && delivery["evidence"] == "BalloonTipShown" && delivery["promptId"] == id
	err = h.update(ctx, l, func(state map[string]any) error {
		for _, v := range uploadRows(state["prompts"]) {
			record := uploadObject(v)
			if record["promptId"] == id {
				record["state"] = "unknown"
				record["displayEvidence"] = nil
				if displayed {
					record["state"] = "shown"
					record["displayEvidence"] = "BalloonTipShown"
				} else if delivery["state"] == "unavailable" {
					record["state"] = "unavailable"
				}
			}
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	if err = h.guard(ctx, l, nil); err != nil {
		return nil, err
	}
	still := map[string]bool{}
	if current() {
		for _, v := range uploadRows(prompt["claims"]) {
			claim := uploadObject(v)
			value, e := h.claim(ctx, l, map[string]any{"id": claim["id"], "deliveryClientId": client, "claimId": claim["claimId"]}, epoch)
			if e == nil && value != nil {
				still[text(claim["id"])] = true
			}
		}
	}
	if len(still) != len(uploadRows(prompt["claims"])) {
		cancel()
		_ = channel.Withdraw(ctx, id)
		h.mu.Lock()
		delete(h.visible, id)
		h.mu.Unlock()
	}
	if displayed {
		_ = h.acknowledge(ctx, l, prompt)
		ids := []any{}
		for _, v := range uploadRows(prompt["claims"]) {
			ids = append(ids, uploadObject(v)["id"])
		}
		state := "system-reported-display"
		if len(still) != len(ids) {
			state = "displayed-then-withdrawn"
		}
		return notificationFlags(map[string]any{"state": state, "promptId": id, "notificationIds": ids, "displayEvidence": "BalloonTipShown"}), h.guard(ctx, l, nil)
	}
	if delivery["systemAccepted"] != true || delivery["promptId"] != id {
		cancel()
		h.mu.Lock()
		delete(h.visible, id)
		h.mu.Unlock()
	}
	available := []any{}
	for _, v := range fresh {
		if still[text(uploadObject(v)["id"])] {
			available = append(available, v)
		}
	}
	reason := text(delivery["reason"])
	if reason == "" {
		reason = "notification_display_unconfirmed"
	}
	return notificationFallback(reason, available), nil
}
