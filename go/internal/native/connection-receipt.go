package native

import (
	"context"
	"crypto/rand"
	"encoding/base64"

	"github.com/agigalaxy-team/agigalaxy/go/internal/identity"
)

type ReceiptOperation struct {
	Kind        string `json:"kind"`
	SnapshotID  string `json:"snapshotId"`
	VersionID   string `json:"versionId"`
	RequestHash string `json:"requestHash"`
}

func (c *Connection) receiptCheck(ctx context.Context, lease connectionLease) error {
	if ctx.Err() != nil {
		return ctx.Err()
	}
	if e := c.check(ctx, lease); e != nil {
		return connectionFailure("receipt_status_authority_changed")
	}
	snapshot, e := c.Snapshot(ctx)
	if e != nil {
		return connectionFailure("receipt_status_authority_changed")
	}
	binding := ""
	if snapshot != nil {
		binding = snapshot.BindingID
	}
	if binding != lease.bindingID {
		return connectionFailure("receipt_status_authority_changed")
	}
	return nil
}

// QueryReceipt is independent of ordinary session restoration. It sends only
// the retained original operation locator and a purpose-bound device proof.
func (c *Connection) QueryReceipt(ctx context.Context, operation ReceiptOperation) (map[string]any, error) {
	if operation.Kind != "choice-snapshot" || !controlUUID(operation.SnapshotID) || !controlUUID(operation.VersionID) || !connectionHash.MatchString(operation.RequestHash) {
		return nil, connectionFailure("receipt_status_input_invalid")
	}
	lease, e := c.lease(ctx, false)
	if e != nil || lease.selection.Active == nil {
		return nil, connectionFailure("receipt_status_authority_changed")
	}
	active := lease.selection.Active
	_, public, e := c.deviceKey(ctx, lease)
	if e != nil {
		return nil, e
	}
	var verified connectionControl
	e = c.store.With(ctx, false, func(dir string) error {
		selected, e := c.selectionWithin(dir)
		if e != nil {
			return e
		}
		if selected.fingerprint != lease.selection.fingerprint {
			return connectionFailure("receipt_status_authority_changed")
		}
		var state map[string]any
		ok, e := readJSON(connectionRecordPath(dir, "native-trust-identity:"+c.config.Endpoint+":"+active.SubjectID), &state)
		if e != nil {
			return e
		}
		if !ok {
			return connectionFailure("trust_identity_snapshot_required")
		}
		if state["subjectId"] != active.SubjectID || state["authority"] != nil && state["authority"] != c.config.Endpoint {
			return connectionFailure("trust_identity_authority_changed")
		}
		verified, e = verifyConnectionControl(state)
		return e
	})
	if e != nil {
		return nil, e
	}
	keyID := identity.Digest([]byte(public))
	device, ok := verified.Devices[keyID]
	if !ok || device.PublicKey != public || device.Epoch != verified.Epoch {
		return nil, connectionFailure("trust_device_not_in_cached_control")
	}
	var deviceID any = active.DeviceID
	if verified.Epoch == 0 {
		deviceID = nil
	}
	control := map[string]any{"deviceId": deviceID, "keyId": keyID, "epoch": verified.Epoch}
	nonce := make([]byte, 32)
	if _, e = rand.Read(nonce); e != nil {
		return nil, e
	}
	request := map[string]any{"subjectId": active.SubjectID, "control": control, "operation": operation, "clientNonce": base64.RawURLEncoding.EncodeToString(nonce)}
	if e = c.receiptCheck(ctx, lease); e != nil {
		return nil, e
	}
	issued, e := c.send(ctx, "/v2/receipt-status/challenges", request, "POST", "", "", 32768)
	if e != nil {
		return nil, e
	}
	if e = c.receiptCheck(ctx, lease); e != nil {
		return nil, e
	}
	if !connectionExact(issued, "challenge", "challengeId", "expiresAt", "ordinarySessionCreated") || issued["ordinarySessionCreated"] != false || !controlUUID(issued["challengeId"]) || !connectionSafeInteger(issued["expiresAt"]) || len(text(issued["challenge"])) == 0 || len(text(issued["challenge"])) > 8192 {
		return nil, connectionFailure("receipt_status_response_invalid")
	}
	verify := func() error {
		opened, e := c.envelope(text(issued["challenge"]), "receipt-status-challenge", 120)
		if e != nil {
			return e
		}
		d := opened.Data
		if !connectionExact(d, "subjectId", "control", "operation", "clientNonce", "version", "purpose", "endpoint", "authority") || !controlUUID(opened.ID) || d["subjectId"] != active.SubjectID || !connectionEqual(d["control"], control) || !connectionEqual(d["operation"], operation) || d["clientNonce"] != request["clientNonce"] || integer(d["version"]) != 1 || d["purpose"] != "receipt-status" || d["endpoint"] != c.config.Endpoint || d["authority"] != "retained-owner-operation-only" || opened.ID != issued["challengeId"] || opened.ExpiresAt != integer(issued["expiresAt"]) {
			return connectionFailure("receipt_status_challenge_mismatch")
		}
		return nil
	}
	if e = verify(); e != nil {
		return nil, e
	}
	if e = c.receiptCheck(ctx, lease); e != nil {
		return nil, e
	}
	signature, e := c.sign(ctx, lease, text(issued["challenge"]), "galaxy-receipt-status-response+jws")
	if e != nil {
		return nil, e
	}
	if e = verify(); e != nil {
		return nil, e
	}
	if e = c.receiptCheck(ctx, lease); e != nil {
		return nil, e
	}
	receipt, e := c.send(ctx, "/v2/receipt-status/query", map[string]any{"challenge": issued["challenge"], "signature": signature}, "POST", "", "", 32768)
	if e != nil {
		return nil, e
	}
	if e = c.receiptCheck(ctx, lease); e != nil {
		return nil, e
	}
	if e = validateConnectionReceipt(receipt, operation); e != nil {
		return nil, e
	}
	return receipt, nil
}
func validateConnectionReceipt(receipt map[string]any, operation ReceiptOperation) error {
	if receipt["snapshotId"] != operation.SnapshotID || receipt["versionId"] != operation.VersionID || receipt["requestHash"] != operation.RequestHash || receipt["authority"] != "accepted-operation-only" || receipt["audience"] != "owner-only" || receipt["currentAccessGranted"] != false || receipt["contentReturned"] != false || receipt["sourceAccessChecked"] != false {
		return connectionFailure("receipt_status_receipt_mismatch")
	}
	keys := []string{"snapshotId", "versionId", "requestHash", "authority", "audience", "currentAccessGranted", "contentReturned", "sourceAccessChecked", "state"}
	switch receipt["state"] {
	case "acknowledged":
		keys = append(keys, "receipt")
		r, ok := receipt["receipt"].(map[string]any)
		if !ok || !connectionExact(r, "snapshotId", "versionId", "requestHash", "baseRevision", "revision", "storedState", "acceptedAt", "contentExpiresAt", "contentRetentionDue") || r["snapshotId"] != operation.SnapshotID || r["versionId"] != operation.VersionID || r["requestHash"] != operation.RequestHash || !connectionSafeInteger(r["baseRevision"]) || !connectionSafeInteger(r["revision"]) || !isOne(text(r["storedState"]), "current", "conflict", "superseded", "expired", "deleted", "invalidated") || !validWorkTime(text(r["acceptedAt"])) || text(r["acceptedAt"]) == "" || !validWorkTime(text(r["contentExpiresAt"])) || text(r["contentExpiresAt"]) == "" {
			return connectionFailure("receipt_status_response_invalid")
		}
		if _, ok = r["contentRetentionDue"].(bool); !ok {
			return connectionFailure("receipt_status_response_invalid")
		}
	case "absent":
		keys = append(keys, "absenceMeaning")
		if receipt["absenceMeaning"] != "no-retained-owner-operation" {
			return connectionFailure("receipt_status_response_invalid")
		}
	case "conflict":
		keys = append(keys, "reason")
		if receipt["reason"] != "original-operation-mismatch" {
			return connectionFailure("receipt_status_response_invalid")
		}
	default:
		return connectionFailure("receipt_status_response_invalid")
	}
	if !connectionExact(receipt, keys...) {
		return connectionFailure("receipt_status_response_invalid")
	}
	return nil
}
