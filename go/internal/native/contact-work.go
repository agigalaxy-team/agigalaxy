package native

import (
	"context"
	"sync"
	"time"

	"github.com/agigalaxy-team/agigalaxy/go/internal/chat"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/identity"
	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
	"github.com/google/uuid"
	"github.com/modelcontextprotocol/go-sdk/mcp"
)

// NativeContactWork retains the independent Contact and Consent locators; it
// never turns an opportunity read or local refusal into recipient acceptance.
type NativeContactWork struct {
	runtime   *Runtime
	mu        sync.Mutex
	prepareMu sync.Mutex
	closed    bool
	flights   map[string]*capsuleWorkFlight
}

func NewNativeContactWork(r *Runtime) *NativeContactWork {
	return &NativeContactWork{runtime: r, flights: map[string]*capsuleWorkFlight{}}
}
func (h *NativeContactWork) Close() { h.mu.Lock(); h.closed = true; h.mu.Unlock() }
func contactWorkContracts() map[string]any {
	var v map[string]any
	_ = protocol.Decode([]byte(contactWorkContractsJSON), &v)
	return v
}
func contactWorkKey(l *nativeIdentityLease, id string) string {
	return "native-contact-work:" + l.scope.Endpoint + ":" + l.scope.Owner + ":" + id
}
func (h *NativeContactWork) check(ctx context.Context, l *nativeIdentityLease) error {
	h.mu.Lock()
	closed := h.closed
	h.mu.Unlock()
	if closed {
		return connectionFailure("native_runtime_closed")
	}
	return l.check(ctx)
}
func (h *NativeContactWork) begin(ctx context.Context) (context.Context, func(), *nativeIdentityLease, error) {
	// Unlike the ordinary HTTP tools, the purpose flow requires an already
	// selected live connection. It does not restore or create one while previewing.
	ctx, cancel, l, e := h.runtime.identityLease(ctx, false)
	if e != nil {
		return nil, nil, nil, e
	}
	if l.connection.bindingID == "" {
		cancel()
		return nil, nil, nil, connectionFailure("native_connection_choice_required")
	}
	if e = h.check(ctx, l); e != nil {
		cancel()
		return nil, nil, nil, e
	}
	return ctx, cancel, l, nil
}
func (h *NativeContactWork) call(ctx context.Context, l *nativeIdentityLease, path string, input any) (map[string]any, error) {
	if e := h.check(ctx, l); e != nil {
		return nil, e
	}
	v, e := l.call(ctx, path, input, false)
	if c := h.check(ctx, l); c != nil {
		return nil, c
	}
	return v, e
}
func (h *NativeContactWork) save(ctx context.Context, l *nativeIdentityLease, row map[string]any) error {
	if e := h.check(ctx, l); e != nil {
		return e
	}
	return l.update(ctx, contactWorkKey(l, text(row["handle"])), func(old map[string]any) (map[string]any, error) {
		if old != nil {
			if old["payloadJson"] != row["payloadJson"] || old["payloadHash"] != row["payloadHash"] || old["consentRequestId"] != row["consentRequestId"] {
				return nil, connectionFailure("contact_work_unavailable")
			}
			if old["state"] == "acknowledged" && row["state"] != "acknowledged" {
				return old, nil
			}
		}
		return row, nil
	})
}
func (h *NativeContactWork) load(ctx context.Context, l *nativeIdentityLease, id string, readOnly bool) (map[string]any, error) {
	row, e := l.read(ctx, contactWorkKey(l, id))
	if e != nil {
		return nil, e
	}
	if row == nil || row["subjectId"] != l.scope.Owner || identity.Digest([]byte(text(row["payloadJson"]))) != row["payloadHash"] {
		return nil, connectionFailure("contact_work_unavailable")
	}
	if !readOnly && row["owner"] != capsuleWorkOwner(l) {
		return nil, connectionFailure("contact_work_identity_changed")
	}
	return row, nil
}
func (h *NativeContactWork) current(ctx context.Context, l *nativeIdentityLease, row map[string]any) (map[string]any, error) {
	p, e := connectionObject([]byte(text(row["payloadJson"])))
	if e != nil {
		return nil, e
	}
	if p["kind"] == "send" {
		v, e := h.call(ctx, l, "/v2/discovery/detail", map[string]any{"context": p["context"], "purposes": []any{p["purpose"]}, "opportunityRef": p["opportunityRef"], "experienceLimit": 1})
		if e != nil {
			return nil, e
		}
		return uploadObject(v["opportunity"]), nil
	}
	contact, e := h.call(ctx, l, "/v2/contacts/"+text(p["contactId"]), nil)
	if e != nil {
		return nil, e
	}
	role := contact["recipientId"]
	if p["kind"] == "withdraw" {
		role = contact["initiatorId"]
	}
	if role != l.scope.Owner || contact["state"] != "sent" || integer(contact["revision"]) != integer(p["expectedRevision"]) {
		return nil, connectionFailure("contact_work_source_changed")
	}
	return contact, nil
}
func contactOrdered(v map[string]any, keys ...string) *protocol.OrderedObject {
	o := protocol.NewOrderedObject()
	for _, k := range keys {
		if x, ok := v[k]; ok {
			o.Set(k, x)
		}
	}
	return o
}
func contactPayload(raw map[string]any) (string, error) {
	b, e := protocol.Encode(raw)
	if e != nil {
		return "", e
	}
	parsed, e := chat.ParseContactEvent(b)
	if e != nil {
		return "", e
	}
	v := map[string]any(parsed)
	o := contactOrdered(v, "operationId", "contactId", "expectedRevision", "kind")
	if v["kind"] == "send" {
		o.Set("recipientId", v["recipientId"])
		o.Set("purpose", v["purpose"])
		c := uploadObject(v["context"])
		if c["kind"] == "project" {
			o.Set("context", contactOrdered(c, "kind", "projectId"))
		} else {
			o.Set("context", contactOrdered(c, "kind", "title", "functions", "technologies"))
		}
		ref := uploadObject(v["opportunityRef"])
		switch ref["sourceKind"] {
		case "project":
			o.Set("opportunityRef", contactOrdered(ref, "sourceKind", "subjectId", "projectId", "documentEventId", "policyEventId"))
		case "recruitment":
			o.Set("opportunityRef", contactOrdered(ref, "sourceKind", "subjectId", "projectId", "recruitmentId", "eventId"))
		default:
			o.Set("opportunityRef", contactOrdered(ref, "subjectId", "projectId", "statementId"))
		}
		o.Set("note", v["note"])
		o.Set("roomTitle", v["roomTitle"])
	} else {
		o.Set("note", v["note"])
	}
	b, e = protocol.EncodeJS(o)
	return string(b), e
}
func (h *NativeContactWork) prepare(ctx context.Context, l *nativeIdentityLease, input map[string]any) (map[string]any, error) {
	h.prepareMu.Lock()
	defer h.prepareMu.Unlock()
	if e := h.check(ctx, l); e != nil {
		return nil, e
	}
	action := text(input["action"])
	p := map[string]any{"kind": action, "operationId": uuid.NewString(), "note": input["note"]}
	var recipient any
	if action == "send" {
		v, e := h.call(ctx, l, "/v2/discovery/detail", map[string]any{"context": input["context"], "purposes": []any{input["purpose"]}, "opportunityRef": input["opportunityRef"], "experienceLimit": 1})
		if e != nil {
			return nil, e
		}
		opportunity := uploadObject(v["opportunity"])
		if opportunity == nil {
			return nil, connectionFailure("contact_work_source_changed")
		}
		recipient = opportunity["subjectId"]
		p["contactId"] = uuid.NewString()
		p["expectedRevision"] = 0
		p["recipientId"] = recipient
		p["context"] = input["context"]
		p["opportunityRef"] = input["opportunityRef"]
		p["purpose"] = input["purpose"]
		title, ok := input["roomTitle"]
		if !ok {
			title = uploadObject(opportunity["project"])["title"]
		}
		if title != nil {
			p["roomTitle"] = title
		}
	} else {
		original, e := h.call(ctx, l, "/v2/contacts/"+text(input["contactId"]), nil)
		if e != nil {
			return nil, e
		}
		role := original["recipientId"]
		if action == "withdraw" {
			role = original["initiatorId"]
		}
		if original["state"] != "sent" || role != l.scope.Owner {
			return nil, connectionFailure("contact_work_source_changed")
		}
		recipient = original["initiatorId"]
		if recipient == l.scope.Owner {
			recipient = original["recipientId"]
		}
		p["contactId"] = original["contactId"]
		p["expectedRevision"] = original["revision"]
	}
	raw, e := contactPayload(p)
	if e != nil {
		return nil, e
	}
	indexValue, e := l.readAny(ctx, contactWorkKey(l, "index"))
	if e != nil {
		return nil, e
	}
	index := uploadRows(indexValue)
	for _, id := range index {
		old, e := l.read(ctx, contactWorkKey(l, text(id)))
		if e != nil {
			return nil, e
		}
		if old != nil && !isOne(text(old["state"]), "acknowledged", "stopped", "canceled") {
			oldPayload, e := connectionObject([]byte(text(old["payloadJson"])))
			if e != nil {
				return nil, e
			}
			if oldPayload["contactId"] == p["contactId"] {
				return nil, connectionFailure("contact_work_original_pending")
			}
		}
	}
	title := map[string]string{"send": "发起联系", "accept": "接受这次交流", "decline": "谢绝这次交流", "withdraw": "撤回这次联系"}[action]
	row := map[string]any{"handle": uuid.NewString(), "subjectId": l.scope.Owner, "owner": capsuleWorkOwner(l), "action": action, "state": "prepared", "title": title, "payloadJson": raw, "payloadHash": identity.Digest([]byte(raw)), "consentRequestId": uuid.NewString(), "visibility": "Private", "viewers": []any{recipient}, "expiresAt": time.Now().UnixMilli() + 30*60000, "consentExpiresAt": h.runtime.connection.now().Unix() + 2591900}
	if e = h.save(ctx, l, row); e != nil {
		return nil, e
	}
	e = l.updateAny(ctx, contactWorkKey(l, "index"), func(old any) (any, error) { return append(uploadRows(old), row["handle"]), nil })
	if e != nil {
		return nil, e
	}
	return h.preview(ctx, l, row)
}
func (h *NativeContactWork) preview(ctx context.Context, l *nativeIdentityLease, row map[string]any) (map[string]any, error) {
	var related map[string]any
	if row["state"] == "prepared" {
		if integer(row["expiresAt"]) <= time.Now().UnixMilli() {
			return nil, connectionFailure("contact_work_preview_expired")
		}
		selected, e := h.current(ctx, l, row)
		if e != nil {
			return nil, e
		}
		if row["action"] != "send" {
			var original map[string]any
			for _, item := range uploadRows(selected["events"]) {
				event := uploadObject(item)
				if event["kind"] == "send" {
					original = event
					break
				}
			}
			if row["action"] == "accept" && (original == nil || original["contentUnavailable"] == true) {
				return nil, connectionFailure("contact_work_source_changed")
			}
			if original != nil && original["contentUnavailable"] != true {
				related = map[string]any{"title": original["roomTitle"], "note": original["note"], "purpose": selected["purpose"]}
			}
		}
	}
	ids := []string{}
	for _, v := range uploadRows(row["viewers"]) {
		ids = append(ids, text(v))
	}
	names, e := h.runtime.ReadProfileNames(ctx, ids)
	if e != nil {
		return nil, e
	}
	if e = h.check(ctx, l); e != nil {
		return nil, e
	}
	labels := []any{}
	for _, v := range uploadRows(names["items"]) {
		item := uploadObject(v)
		name := item["displayName"]
		if name == nil {
			name = item["subjectId"]
		}
		labels = append(labels, name)
	}
	out := map[string]any{"handle": row["handle"], "state": row["state"], "action": row["action"], "title": row["title"], "payloadJson": row["payloadJson"], "visibility": row["visibility"], "viewers": row["viewers"], "recipientNames": labels, "expiresAt": row["expiresAt"], "consentExpiresAt": row["consentExpiresAt"]}
	if related != nil {
		out["relatedContact"] = related
	}
	return out, nil
}
func (h *NativeContactWork) reconcile(ctx context.Context, l *nativeIdentityLease, row map[string]any) (map[string]any, error) {
	if row["state"] == "canceled" {
		return map[string]any{"state": "canceled", "handle": row["handle"], "title": row["title"], "sideEffect": false}, nil
	}
	p, e := connectionObject([]byte(text(row["payloadJson"])))
	if e != nil {
		return nil, e
	}
	contact, e := h.call(ctx, l, "/v2/contacts/"+text(p["contactId"]), nil)
	pending := func() map[string]any {
		state := "unknown"
		if row["state"] == "prepared" {
			state = "prepared"
		}
		return map[string]any{"state": state, "handle": row["handle"], "title": row["title"]}
	}
	if e != nil {
		if runtimeErrorCode(e) == "contact_not_found" || fault.Status(e) == 404 {
			return pending(), nil
		}
		return nil, e
	}
	for _, v := range uploadRows(contact["events"]) {
		event := uploadObject(v)
		if event["operationId"] == p["operationId"] && event["subjectId"] == l.scope.Owner && event["kind"] == p["kind"] && integer(event["revision"]) == integer(p["expectedRevision"])+1 {
			row["state"] = "acknowledged"
			row["receipt"] = map[string]any{"contactId": p["contactId"], "operationId": p["operationId"], "appliedRevision": event["revision"]}
			if e = h.save(ctx, l, row); e != nil {
				return nil, e
			}
			return map[string]any{"state": "acknowledged", "handle": row["handle"], "title": row["title"], "receipt": row["receipt"], "contact": contact}, nil
		}
	}
	return pending(), nil
}
func (h *NativeContactWork) flight(ctx context.Context, id string, run func() (any, error)) (result any, err error) {
	h.mu.Lock()
	if old := h.flights[id]; old != nil {
		h.mu.Unlock()
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-old.done:
			return old.result, old.err
		}
	}
	f := &capsuleWorkFlight{done: make(chan struct{})}
	h.flights[id] = f
	h.mu.Unlock()
	defer func() {
		h.mu.Lock()
		f.result, f.err = result, err
		delete(h.flights, id)
		close(f.done)
		h.mu.Unlock()
	}()
	return run()
}
func (h *NativeContactWork) execute(ctx context.Context, l *nativeIdentityLease, id string, resume bool, scope *ChoiceScope) (any, error) {
	return h.flight(ctx, id, func() (any, error) {
		row, e := h.load(ctx, l, id, false)
		if e != nil {
			return nil, e
		}
		if resume && row["state"] == "prepared" {
			return nil, connectionFailure("contact_work_original_choice_required")
		}
		if isOne(text(row["state"]), "canceled", "acknowledged") {
			return h.reconcile(ctx, l, row)
		}
		if row["state"] != "prepared" {
			checked, e := h.reconcile(ctx, l, row)
			if e != nil {
				return nil, e
			}
			if checked["state"] == "acknowledged" || !resume {
				return checked, nil
			}
			if row["approved"] != true {
				return nil, connectionFailure("contact_work_original_choice_required")
			}
		} else {
			if scope == nil || *scope != l.scope {
				return nil, connectionFailure("native_choice_binding_changed")
			}
			if _, e = h.preview(ctx, l, row); e != nil {
				return nil, e
			}
			row["approved"] = true
		}
		p, e := connectionObject([]byte(text(row["payloadJson"])))
		if e != nil {
			return nil, e
		}
		row["state"] = "authorizing"
		if e = h.save(ctx, l, row); e != nil {
			return nil, e
		}
		_, e = h.runtime.AuthorizeReviewed(ctx, map[string]any{"requestId": row["consentRequestId"], "action": "contact.write", "objectId": p["operationId"], "payloadJson": row["payloadJson"], "visibility": row["visibility"], "viewers": row["viewers"], "expiresAt": row["consentExpiresAt"]}, &l.scope)
		if e == nil {
			e = h.check(ctx, l)
		}
		if e == nil {
			row["state"] = "sending"
			e = h.save(ctx, l, row)
		}
		if e == nil {
			_, e = h.call(ctx, l, "/v2/contacts", map[string]any{"consentId": row["consentRequestId"], "payloadJson": row["payloadJson"]})
		}
		if e != nil {
			if changed := h.check(ctx, l); changed != nil {
				return nil, changed
			}
			row["state"] = "unknown"
			if save := h.save(ctx, l, row); save != nil {
				return nil, save
			}
			if checked, readError := h.reconcile(ctx, l, row); readError == nil {
				return checked, nil
			}
			return nil, e
		}
		return h.reconcile(ctx, l, row)
	})
}
func (h *NativeContactWork) cancel(ctx context.Context, l *nativeIdentityLease, id string) (any, error) {
	return h.flight(ctx, id, func() (any, error) {
		row, e := h.load(ctx, l, id, false)
		if e != nil {
			return nil, e
		}
		if row["state"] == "prepared" && row["approved"] != true {
			row["state"] = "canceled"
			row["choice"] = map[string]any{"state": "declined", "recordedAt": time.Now().UnixMilli()}
			if e = h.save(ctx, l, row); e != nil {
				return nil, e
			}
		}
		return h.reconcile(ctx, l, row)
	})
}
func (h *NativeContactWork) pending(ctx context.Context, l *nativeIdentityLease) (map[string]any, error) {
	index, e := l.readAny(ctx, contactWorkKey(l, "index"))
	if e != nil {
		return nil, e
	}
	items := []any{}
	for _, id := range uploadRows(index) {
		row, e := l.read(ctx, contactWorkKey(l, text(id)))
		if e != nil {
			return nil, e
		}
		if row != nil && !isOne(text(row["state"]), "acknowledged", "stopped", "canceled") {
			items = append(items, map[string]any{"handle": id, "action": row["action"], "title": row["title"], "state": row["state"]})
		}
	}
	return map[string]any{"items": items}, nil
}
func registerNativeContactWorkTools(server *mcp.Server, tools *toolRuntime, r *Runtime) func() {
	h := NewNativeContactWork(r)
	for name, raw := range contactWorkContracts() {
		c := uploadObject(raw)
		write := c["write"] == true
		addNativeTool(server, &mcp.Tool{Name: name, Description: text(c["description"]), InputSchema: c["schema"], Annotations: &mcp.ToolAnnotations{ReadOnlyHint: !write}}, "contact_work_unavailable", func(ctx context.Context, req *mcp.CallToolRequest) (*mcp.CallToolResult, error) {
			input, e := connectionObject(req.Params.Arguments)
			if e != nil {
				return toolError(e)
			}
			id := text(input["handle"])
			failure := func(e error) (*mcp.CallToolResult, error) {
				v, encode := toolResult(map[string]any{"error": runtimeErrorCode(e), "handle": input["handle"], "reconcileOriginal": write})
				if v != nil {
					v.IsError = true
				}
				return v, encode
			}
			ctx, cancel, l, e := h.begin(ctx)
			if e != nil {
				return failure(e)
			}
			defer cancel()
			var out any
			switch name {
			case "galaxy_contact_work_prepare":
				for _, key := range []string{"note", "roomTitle"} {
					if value, ok := input[key].(string); ok {
						input[key] = uploadTrim(value)
					}
				}
				if input["note"] == nil {
					input["note"] = ""
				}
				if remoteChatValidate(uploadObject(c["schema"]), input) != nil {
					return failure(remoteFactsInvalid())
				}
				out, e = h.prepare(ctx, l, input)
			case "galaxy_contact_work_pending":
				out, e = h.pending(ctx, l)
			case "galaxy_contact_work_status":
				var row map[string]any
				row, e = h.load(ctx, l, id, true)
				if e == nil {
					out, e = h.reconcile(ctx, l, row)
				}
			case "galaxy_contact_work_resume":
				out, e = h.execute(ctx, l, id, true, nil)
			case "galaxy_contact_work_execute":
				row, loadError := h.load(ctx, l, id, false)
				if loadError != nil {
					return failure(loadError)
				}
				preview, previewError := h.preview(ctx, l, row)
				if previewError != nil {
					return failure(previewError)
				}
				if row["state"] != "prepared" {
					out, e = h.reconcile(ctx, l, row)
					break
				}
				value := map[string]any{"handle": id, "preview": preview}
				result, reviewError := tools.review(ctx, req, value, "请本人核对这次独立联系、参与双方、当前机会或原联系和精确正文；不会创建任务、房间或替收件人接受。\n"+hostJSONString(value), func(scope *ChoiceScope) (any, error) { return h.execute(ctx, l, id, false, scope) })
				if reviewError == nil && result != nil && !result.IsError {
					decision := uploadObject(result.StructuredContent)
					if decision == nil {
						for _, item := range result.Content {
							if t, ok := item.(*mcp.TextContent); ok {
								decision, _ = connectionObject([]byte(t.Text))
								break
							}
						}
					}
					if decision["state"] == "declined" && decision["sideEffect"] == false {
						out, e = h.cancel(ctx, l, id)
						break
					}
				}
				return result, reviewError
			default:
				return failure(remoteFactsInvalid())
			}
			if e != nil {
				return failure(e)
			}
			return toolResult(out)
		})
	}
	return h.Close
}
