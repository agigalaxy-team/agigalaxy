package native

import (
	"context"
	"github.com/agigalaxy-team/agigalaxy/go/internal/identity"
	"github.com/agigalaxy-team/agigalaxy/go/internal/identitygroups"
	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
	"github.com/google/uuid"
	"sync"
)

type groupPreview struct {
	lease                     *nativeIdentityLease
	payloadJson, proofJson    string
	preview, renewal, receipt map[string]any
	state                     string
	expires                   int64
}
type NativeIdentityGroupOperations struct {
	runtime  *Runtime
	serial   sync.Mutex
	mu       sync.Mutex
	closed   bool
	previews map[string]*groupPreview
}

func NewNativeIdentityGroupOperations(r *Runtime) *NativeIdentityGroupOperations {
	return &NativeIdentityGroupOperations{runtime: r, previews: map[string]*groupPreview{}}
}
func (h *NativeIdentityGroupOperations) Close() {
	h.mu.Lock()
	h.closed = true
	h.previews = map[string]*groupPreview{}
	h.mu.Unlock()
}
func (h *NativeIdentityGroupOperations) begin(ctx context.Context) (context.Context, func(), *nativeIdentityLease, error) {
	h.mu.Lock()
	closed := h.closed
	h.mu.Unlock()
	if closed {
		return nil, nil, nil, connectionFailure("identity_group_native_closed")
	}
	return h.runtime.identityLease(ctx, true)
}
func groupCurrent(ctx context.Context, l *nativeIdentityLease) (map[string]any, error) {
	c, e := l.call(ctx, "/v2/identity-groups/current", nil, false)
	if e != nil {
		return nil, e
	}
	if c["subjectId"] != l.scope.Owner || c["endpoint"] != l.scope.Endpoint || !connectionHash.MatchString(text(c["keyId"])) || groupInt(c["epoch"]) < 0 {
		return nil, connectionFailure("identity_group_control_changed")
	}
	return c, nil
}
func (h *NativeIdentityGroupOperations) prepareBytes(ctx context.Context, l *nativeIdentityLease, payload, decision string, renewal map[string]any) (map[string]any, error) {
	p, e := identitygroups.ParseIntent([]byte(payload))
	if e != nil {
		return nil, e
	}
	current, e := groupCurrent(ctx, l)
	if e != nil {
		return nil, e
	}
	if p["endpoint"] != l.scope.Endpoint {
		return nil, connectionFailure("identity_group_identity_changed")
	}
	if groupInt(p["expiresAt"]) <= h.runtime.connection.now().Unix() {
		return nil, connectionFailure("identity_group_proposal_expired")
	}
	proof := protocol.NewOrderedObject()
	for _, entry := range []struct {
		k string
		v any
	}{{"schemaVersion", 2}, {"id", uuid.NewString()}, {"operationId", p["operationId"]}, {"groupId", p["groupId"]}, {"payloadHash", identity.Digest([]byte(payload))}, {"endpoint", l.scope.Endpoint}, {"subjectId", l.scope.Owner}, {"keyId", current["keyId"]}, {"epoch", current["epoch"]}, {"decision", decision}, {"issuedAt", h.runtime.connection.now().Unix()}, {"expiresAt", p["expiresAt"]}} {
		proof.Set(entry.k, entry.v)
	}
	raw, e := protocol.EncodeJS(proof)
	if e != nil {
		return nil, e
	}
	preview := map[string]any{"payload": p, "payloadHash": proof.Values()["payloadHash"], "subjectId": l.scope.Owner, "decision": decision, "scope": "canonical-display-only; original-source-permissions-remain", "control": map[string]any{"keyId": current["keyId"], "epoch": current["epoch"]}}
	h.mu.Lock()
	defer h.mu.Unlock()
	now := h.runtime.connection.now().UnixMilli()
	for id, p := range h.previews {
		if p.expires <= now {
			delete(h.previews, id)
		}
	}
	if h.closed {
		return nil, connectionFailure("identity_group_native_closed")
	}
	if len(h.previews) >= 32 {
		return nil, connectionFailure("identity_group_preview_limit")
	}
	id := uuid.NewString()
	h.previews[id] = &groupPreview{lease: l, payloadJson: payload, proofJson: string(raw), preview: preview, renewal: renewal, state: "prepared", expires: now + 300000}
	return map[string]any{"previewId": id, "operationId": p["operationId"], "state": "prepared", "preview": preview, "remoteSubmitted": false, "privateKeyExported": false}, nil
}

// groupIntentText follows the original Zod object field order for newly prepared
// intents. Existing response/renewal strings bypass this writer entirely.
func groupIntentText(input any) (string, error) {
	raw, e := groupWire(input)
	if e != nil {
		return "", e
	}
	p, e := identitygroups.ParseIntent(raw)
	if e != nil {
		return "", e
	}
	keys := []string{"schemaVersion", "operationId", "groupId", "endpoint", "expectedVersion", "previousOperationId", "issuedAt", "expiresAt", "kind"}
	if p["kind"] == "revoke" {
		keys = append(keys, "reason")
	} else {
		keys = append(keys, "memberIds", "canonicalDisplayId", "visibility", "viewers", "sourceRefs", "attributionCorrections", "purpose", "capabilityMerged", "accessGranted")
	}
	if p["kind"] != "revoke" {
		refs := []any{}
		for _, r := range uploadRows(p["sourceRefs"]) {
			refs = append(refs, groupOrderedSource(uploadObject(r)))
		}
		p["sourceRefs"] = refs
		corrections := []any{}
		for _, r := range uploadRows(p["attributionCorrections"]) {
			c := uploadObject(r)
			o := protocol.NewOrderedObject()
			o.Set("source", groupOrderedSource(uploadObject(c["source"])))
			o.Set("displaySubjectId", c["displaySubjectId"])
			o.Set("reason", c["reason"])
			corrections = append(corrections, o)
		}
		p["attributionCorrections"] = corrections
	}
	out := protocol.NewOrderedObject()
	for _, k := range keys {
		if v, ok := p[k]; ok {
			out.Set(k, v)
		}
	}
	b, e := groupWire(out)
	return string(b), e
}
func (h *NativeIdentityGroupOperations) Prepare(ctx context.Context, input map[string]any) (map[string]any, error) {
	h.mu.Lock()
	now := h.runtime.connection.now().UnixMilli()
	for id, p := range h.previews {
		if p.expires <= now {
			delete(h.previews, id)
		}
	}
	full := len(h.previews) >= 32
	closed := h.closed
	h.mu.Unlock()
	if closed {
		return nil, connectionFailure("identity_group_native_closed")
	}
	if full {
		return nil, connectionFailure("identity_group_preview_limit")
	}
	ctx, cancel, l, e := h.begin(ctx)
	if e != nil {
		return nil, e
	}
	defer cancel()
	h.serial.Lock()
	defer h.serial.Unlock()
	if e = l.check(ctx); e != nil {
		return nil, e
	}
	switch input["action"] {
	case "intent":
		payload, e := groupIntentText(input["input"])
		if e != nil {
			return nil, e
		}
		return h.prepareBytes(ctx, l, payload, "approve", nil)
	case "response":
		id := text(input["operationId"])
		decision := text(input["decision"])
		if decision == "" {
			decision = "approve"
		}
		if !controlUUID(id) || !isOne(decision, "approve", "decline", "cancel") {
			return nil, remoteFactsInvalid()
		}
		p, e := l.call(ctx, "/v2/identity-groups/operations/"+id, nil, false)
		if e != nil {
			return nil, e
		}
		if text(p["payloadJson"]) == "" {
			return nil, connectionFailure("identity_group_source_unavailable")
		}
		allowed := false
		for _, v := range uploadRows(p["availableActions"]) {
			allowed = allowed || v == decision
		}
		if !allowed {
			return nil, connectionFailure("identity_group_action_unavailable")
		}
		return h.prepareBytes(ctx, l, text(p["payloadJson"]), decision, nil)
	case "renew":
		row, e := groupFind(ctx, l, text(input["proofId"]), false)
		if e != nil {
			return nil, e
		}
		if row["state"] == "stopped-local" {
			return nil, connectionFailure("identity_group_local_retry_stopped")
		}
		status, e := groupReconcile(ctx, l, row)
		if e != nil {
			return nil, e
		}
		if status["ownApprovalAcknowledged"] == true || status["operationClosed"] == true {
			return nil, connectionFailure("identity_group_operation_closed")
		}
		if !isOne(text(status["state"]), "absent", "pending") {
			return nil, connectionFailure("identity_group_operation_conflict")
		}
		_, proof, e := groupExact(l, row)
		if e != nil {
			return nil, e
		}
		return h.prepareBytes(ctx, l, text(row["payloadJson"]), text(proof["decision"]), identityClone(row))
	default:
		return nil, remoteFactsInvalid()
	}
}
func (h *NativeIdentityGroupOperations) Preview(ctx context.Context, id string) (any, error) {
	h.mu.Lock()
	p := h.previews[id]
	if h.closed || p == nil || p.expires <= h.runtime.connection.now().UnixMilli() {
		h.mu.Unlock()
		return nil, connectionFailure("identity_group_preview_expired_or_identity_changed")
	}
	preview := groupClone(p.preview)
	lease := p.lease
	state := p.state
	receipt := p.receipt
	h.mu.Unlock()
	if e := lease.check(ctx); e != nil {
		return nil, e
	}
	if state != "prepared" {
		return map[string]any{"state": state, "operationId": uploadObject(preview["payload"])["operationId"], "receipt": receipt, "recoverWith": "galaxy_identity_group_native_recover"}, nil
	}
	return map[string]any{"previewId": id, "operationId": uploadObject(preview["payload"])["operationId"], "preview": preview}, nil
}
func (h *NativeIdentityGroupOperations) ExecuteReviewed(ctx context.Context, id string, scope *ChoiceScope) (result any, err error) {
	if scope == nil {
		return nil, connectionFailure("identity_group_preview_required")
	}
	ctx, cancel, l, e := h.begin(ctx)
	if e != nil {
		return nil, e
	}
	defer cancel()
	h.serial.Lock()
	defer h.serial.Unlock()
	h.mu.Lock()
	p := h.previews[id]
	if h.closed || p == nil || p.expires <= h.runtime.connection.now().UnixMilli() {
		h.mu.Unlock()
		return nil, connectionFailure("identity_group_preview_expired_or_identity_changed")
	}
	if p.lease.scope != *scope || l.scope != *scope {
		h.mu.Unlock()
		return nil, connectionFailure("identity_group_identity_changed")
	}
	if p.state != "prepared" {
		out := map[string]any{"state": p.state, "operationId": uploadObject(p.preview["payload"])["operationId"], "receipt": p.receipt, "recoverWith": "galaxy_identity_group_native_recover"}
		h.mu.Unlock()
		return out, nil
	}
	p.state = "running"
	h.mu.Unlock()
	defer func() {
		h.mu.Lock()
		if err != nil {
			p.state = "original-operation-needs-reconciliation"
		} else {
			p.state = "completed"
			p.receipt = uploadObject(result)
		}
		h.mu.Unlock()
	}()
	if e = p.lease.check(ctx); e != nil {
		return nil, e
	}
	if p.renewal != nil {
		current, e := groupFind(ctx, l, text(p.renewal["proofId"]), false)
		if e != nil {
			return nil, e
		}
		if !connectionEqual(current, p.renewal) {
			return nil, connectionFailure("identity_group_operation_changed")
		}
		status, e := groupReconcile(ctx, l, current)
		if e != nil {
			return nil, e
		}
		if status["ownApprovalAcknowledged"] == true || status["operationClosed"] == true {
			return status, nil
		}
	}
	proof, e := identitygroups.ParseProof([]byte(p.proofJson))
	if e != nil {
		return nil, e
	}
	row := map[string]any{"operationId": proof["operationId"], "groupId": proof["groupId"], "proofId": proof["id"], "payloadHash": proof["payloadHash"], "payloadJson": p.payloadJson, "proofJson": p.proofJson, "signature": nil, "state": "prepared", "bindingId": l.connection.bindingID, "journalRevision": 1}
	if _, _, e = groupExact(l, row); e != nil {
		return nil, e
	}
	e = l.update(ctx, groupJournalKey(l), func(v map[string]any) (map[string]any, error) {
		j, e := groupJournal(v)
		if e != nil {
			return nil, e
		}
		var previous map[string]any
		for _, v := range uploadRows(j["pending"]) {
			r := uploadObject(v)
			if r["operationId"] == row["operationId"] {
				previous = r
				break
			}
		}
		if previous != nil && p.renewal == nil {
			return nil, connectionFailure("identity_group_operation_pending")
		}
		if p.renewal != nil && !connectionEqual(previous, p.renewal) {
			return nil, connectionFailure("identity_group_operation_changed")
		}
		for _, v := range uploadRows(j["originals"]) {
			if uploadObject(v)["proofId"] == row["proofId"] {
				return nil, connectionFailure("identity_group_operation_changed")
			}
		}
		pending := uploadRows(j["pending"])
		if previous != nil {
			pending = groupRowsExcept(pending, text(previous["proofId"]))
			old := identityClone(previous)
			old["supersededBy"] = row["proofId"]
			j["originals"] = append([]any{old}, uploadRows(j["originals"])...)
		}
		j["pending"] = append(pending, row)
		return j, nil
	})
	if e != nil {
		return nil, e
	}
	current, e := groupCurrent(ctx, l)
	if e != nil {
		return nil, e
	}
	if current["keyId"] != proof["keyId"] || groupInt(current["epoch"]) != groupInt(proof["epoch"]) {
		return nil, connectionFailure("identity_group_control_changed")
	}
	if groupInt(proof["expiresAt"]) <= h.runtime.connection.now().Unix() {
		return nil, connectionFailure("identity_group_proposal_expired")
	}
	signature, e := groupSign(ctx, l, p.proofJson, proof)
	if e != nil {
		return nil, e
	}
	signed, e := groupReplace(ctx, l, row, map[string]any{"signature": signature})
	if e != nil {
		return nil, e
	}
	return groupSend(ctx, l, signed)
}
func (h *NativeIdentityGroupOperations) CancelPreview(ctx context.Context, id string) (map[string]any, error) {
	h.mu.Lock()
	p := h.previews[id]
	if p == nil || h.closed {
		h.mu.Unlock()
		return nil, connectionFailure("identity_group_preview_unavailable")
	}
	owner := p.lease.scope.Owner
	state := p.state
	h.mu.Unlock()
	scope, e := h.runtime.store.ChoiceScope(ctx)
	if e != nil {
		return nil, e
	}
	if scope.Owner != owner {
		return nil, connectionFailure("identity_group_preview_unavailable")
	}
	if state != "prepared" {
		return map[string]any{"state": state, "serverCancellationConfirmed": false, "recoverWith": "galaxy_identity_group_native_recover"}, nil
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	if p.state != "prepared" {
		return nil, connectionFailure("identity_group_operation_changed")
	}
	delete(h.previews, id)
	return map[string]any{"state": "canceled-before-signing", "remoteSubmitted": false}, nil
}
func (h *NativeIdentityGroupOperations) Recover(ctx context.Context, action, id string) (any, error) {
	ctx, cancel, l, e := h.begin(ctx)
	if e != nil {
		return nil, e
	}
	defer cancel()
	h.serial.Lock()
	defer h.serial.Unlock()
	if e = l.check(ctx); e != nil {
		return nil, e
	}
	if action == "pending" {
		j, e := l.read(ctx, groupJournalKey(l))
		if e != nil {
			return nil, e
		}
		j, e = groupJournal(j)
		if e != nil {
			return nil, e
		}
		out := []any{}
		for _, v := range uploadRows(j["pending"]) {
			row := uploadObject(v)
			clean := identityClone(row)
			delete(clean, "signature")
			delete(clean, "payloadJson")
			delete(clean, "proofJson")
			clean["locator"] = groupLocator(l, row)
			out = append(out, clean)
		}
		return out, nil
	}
	if !controlUUID(id) {
		return nil, connectionFailure("identity_group_proof_id_required")
	}
	row, e := groupFind(ctx, l, id, action != "stop-local-retry")
	if e != nil {
		return nil, e
	}
	status, e := groupReconcile(ctx, l, row)
	if e != nil {
		return nil, e
	}
	if status["ownApprovalAcknowledged"] == true || status["operationClosed"] == true || action == "reconcile" {
		return status, nil
	}
	if action == "stop-local-retry" {
		if row["state"] != "stopped-local" {
			if _, e = groupReplace(ctx, l, row, map[string]any{"state": "stopped-local"}); e != nil {
				return nil, e
			}
		}
		status["localRetryStopped"] = true
		status["serverCancellationConfirmed"] = false
		return status, nil
	}
	if action != "retry" {
		return nil, remoteFactsInvalid()
	}
	if row["state"] == "stopped-local" {
		return nil, connectionFailure("identity_group_local_retry_stopped")
	}
	if row["supersededBy"] != nil {
		return nil, connectionFailure("identity_group_explicit_new_approval_required")
	}
	if row["businessFailure"] != nil {
		return map[string]any{"state": "blocked", "reason": "business-declined", "locator": groupLocator(l, row), "operationState": nil, "ownApprovalAcknowledged": false, "operationClosed": false, "businessFailure": row["businessFailure"]}, nil
	}
	p, proof, e := groupExact(l, row)
	if e != nil {
		return nil, e
	}
	if groupInt(p["expiresAt"]) <= h.runtime.connection.now().Unix() {
		return nil, connectionFailure("identity_group_proposal_expired")
	}
	if text(row["signature"]) == "" || text(row["bindingId"]) == "" || row["bindingId"] != l.connection.bindingID {
		return nil, connectionFailure("identity_group_explicit_new_approval_required")
	}
	current, e := groupCurrent(ctx, l)
	if e != nil {
		return nil, e
	}
	if current["keyId"] != proof["keyId"] || groupInt(current["epoch"]) != groupInt(proof["epoch"]) {
		return nil, connectionFailure("identity_group_explicit_new_approval_required")
	}
	return groupSend(ctx, l, row)
}

func groupSign(ctx context.Context, l *nativeIdentityLease, raw string, proof map[string]any) (string, error) {
	state, e := l.control(ctx)
	if e != nil {
		return "", e
	}
	device := deviceManager(state, l.scope.DeviceID)
	if state["subjectId"] != l.scope.Owner || device == nil || device["key_id"] != proof["keyId"] || groupInt(state["epoch"]) != groupInt(proof["epoch"]) || !deviceCanManage(device) {
		return "", connectionFailure("identity_group_control_changed")
	}
	_, public, e := l.runtime.connection.deviceKey(ctx, l.connection)
	if e != nil {
		return "", e
	}
	if identity.Digest([]byte(public)) != proof["keyId"] {
		return "", connectionFailure("identity_group_control_changed")
	}
	return l.sign(ctx, raw, identitygroups.SignatureType)
}
