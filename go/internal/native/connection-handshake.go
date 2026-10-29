package native

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"errors"
	"os"
	"path/filepath"
	"time"

	"github.com/agigalaxy-team/agigalaxy/go/internal/identity"
)

var connectionBrowserScopes = []string{"binding", "consent", "case-teaser", "evidence", "proof", "history", "assistance", "context", "notifications", "moderation", "capsules", "builders", "audit", "data-export", "data-delete"}

func (c *Connection) currentEnvelope(ctx context.Context, lease connectionLease, token, kind string, maxAge int64) (connectionEnvelope, error) {
	v, e := c.envelope(token, kind, maxAge)
	var boundary *connectionNotBefore
	if errors.As(e, &boundary) {
		ahead := boundary.second - c.now().Unix()
		if ahead >= -2 && ahead <= 2 {
			timer := time.NewTimer(time.Duration(max(int64(0), ahead))*time.Second + 25*time.Millisecond)
			defer timer.Stop()
			select {
			case <-ctx.Done():
				return v, ctx.Err()
			case <-timer.C:
			}
			if e = c.check(ctx, lease); e != nil {
				return v, e
			}
			return c.envelope(token, kind, maxAge)
		}
	}
	return v, e
}
func (c *Connection) rememberControl(ctx context.Context, lease connectionLease, state map[string]any) (connectionControl, error) {
	verified, e := verifyConnectionControl(state)
	if e != nil {
		return verified, e
	}
	if state["authority"] != c.config.Endpoint || !connectionSafeInteger(state["checkedAt"]) || state["subjectId"] != lease.selection.Active.SubjectID || integer(state["epoch"]) != verified.Epoch {
		return verified, connectionFailure("trust_identity_authority_changed")
	}
	cache := map[string]any{"subjectId": state["subjectId"], "genesisProof": state["genesisProof"], "events": state["events"], "authority": state["authority"], "checkedAt": state["checkedAt"]}
	e = c.store.With(ctx, true, func(dir string) error {
		selected, e := c.selectionWithin(dir)
		if e != nil {
			return e
		}
		if selected.fingerprint != lease.selection.fingerprint {
			return connectionFailure("native_connection_selection_changed")
		}
		path := connectionRecordPath(dir, "native-trust-identity:"+c.config.Endpoint+":"+selected.Active.SubjectID)
		var prior map[string]any
		ok, e := readJSON(path, &prior)
		if e != nil {
			return e
		}
		if ok {
			old, e := verifyConnectionControl(prior)
			if e != nil {
				return e
			}
			if old.Sequence > verified.Sequence || old.Sequence == verified.Sequence && old.Head != verified.Head {
				return connectionFailure("trust_identity_snapshot_rollback")
			}
		}
		if e = os.MkdirAll(filepath.Dir(path), 0700); e != nil {
			return e
		}
		return writeJSON(path, cache)
	})
	return verified, e
}

// Restore consumes only an already saved connection choice and existing device.
// It never bootstraps an identity, adds a device, grants scopes or rewrites selection.
func (c *Connection) Restore(ctx context.Context) (*ConnectionSnapshot, error) {
	return c.connectWithPermission(ctx, nil)
}

// approved is supplied only by the Runtime after an exact person-reviewed
// connection plan. It remains in memory until the completed handshake is CAS-saved.
func (c *Connection) connectWithPermission(ctx context.Context, approved *connectionPermission) (*ConnectionSnapshot, error) {
	c.restoreMu.Lock()
	defer c.restoreMu.Unlock()
	if approved == nil {
		if snapshot, e := c.Snapshot(ctx); e != nil || snapshot != nil {
			return snapshot, e
		}
	} else {
		c.Disconnect()
	}
	lease, e := c.lease(ctx, false)
	if e != nil {
		return nil, e
	}
	c.mu.Lock()
	trusted := c.discoveryTrustCurrentLocked()
	c.mu.Unlock()
	if !trusted {
		return nil, connectionFailure("native_server_pin_invalid")
	}
	lease.requireTrust = true
	active, permission := lease.selection.Active, lease.selection.Permission
	if approved != nil {
		permission = approved
	}
	if active == nil || permission == nil || !permission.Enabled || permission.SubjectID != active.SubjectID || permission.DeviceID != active.DeviceID || permission.Scopes == nil {
		return nil, connectionFailure("native_connection_choice_required")
	}
	if !connectionSubject.MatchString(active.SubjectID) || !controlUUID(active.DeviceID) || !controlUUID(active.InstallationID) || !connectionGenesis(active.SubjectID, active.GenesisProof) {
		return nil, connectionFailure("native_identity_selection_invalid")
	}
	_, public, e := c.deviceKey(ctx, lease)
	if e != nil {
		return nil, e
	}
	started := c.now().Unix()
	check := func() error {
		if c.now().Unix() < started || c.now().Unix() >= started+300 {
			return connectionFailure("native_connection_deadline_exceeded")
		}
		return c.check(ctx, lease)
	}
	state, e := c.send(ctx, "/v2/identity/"+active.SubjectID+"/control", nil, "GET", "", "", 1048576)
	if e != nil {
		return nil, e
	}
	if e = check(); e != nil {
		return nil, e
	}
	control, e := c.rememberControl(ctx, lease, state)
	if e != nil {
		return nil, e
	}
	if control.Epoch == 0 {
		return nil, connectionFailure("native_identity_bootstrap_not_migrated")
	}
	device, ok := control.Devices[identity.Digest([]byte(public))]
	if !ok || device.DeviceID != active.DeviceID || device.Epoch != control.Epoch {
		return nil, connectionFailure("current_device_control_required")
	}
	scopes := []string{}
	for _, scope := range connectionBrowserScopes {
		if connectionIncludes(permission.Scopes, scope) && (connectionIncludes(device.Scopes, scope) || connectionIncludes(device.Scopes, "*")) {
			scopes = append(scopes, scope)
		}
	}
	if !connectionIncludes(scopes, "binding") {
		return nil, connectionFailure("native_connection_choice_required")
	}
	currentControl := map[string]any{"deviceId": active.DeviceID, "keyId": device.KeyID, "epoch": device.Epoch}
	request := map[string]any{"subjectId": active.SubjectID, "genesisProof": active.GenesisProof, "installationId": active.InstallationID, "scopes": scopes, "control": currentControl}
	post := func(path string, input any) (map[string]any, error) {
		if e := check(); e != nil {
			return nil, e
		}
		v, e := c.send(ctx, path, input, "POST", "", "", 1048576)
		if e != nil {
			return nil, e
		}
		if e = check(); e != nil {
			return nil, e
		}
		return v, nil
	}
	challenge, e := post("/v2/binding-challenges", request)
	if e != nil {
		return nil, e
	}
	verifyChallenge := func() (connectionEnvelope, error) {
		if !connectionExact(challenge, "challengeId", "challenge", "clientSession") || !connectionUUID.MatchString(text(challenge["challengeId"])) || !connectionCredential(challenge["clientSession"]) {
			return connectionEnvelope{}, connectionFailure("native_binding_challenge_invalid")
		}
		opened, e := c.currentEnvelope(ctx, lease, text(challenge["challenge"]), "binding-challenge", 180)
		if e != nil {
			return opened, e
		}
		data := opened.Data
		if !connectionExact(data, "subjectId", "genesisProof", "installationId", "scopes", "purpose", "endpoint", "clientSessionHash", "bindingExpiresAt", "control") || opened.ID != challenge["challengeId"] || data["purpose"] != "bind" || data["endpoint"] != c.config.Endpoint || data["subjectId"] != request["subjectId"] || data["installationId"] != request["installationId"] || !connectionEqual(data["genesisProof"], request["genesisProof"]) || !connectionEqual(data["scopes"], scopes) || !connectionEqual(data["control"], currentControl) || data["clientSessionHash"] != identity.Digest([]byte(text(challenge["clientSession"]))) || !connectionSafeInteger(data["bindingExpiresAt"]) || integer(data["bindingExpiresAt"]) <= c.now().Unix() || integer(data["bindingExpiresAt"]) > opened.IssuedAt+86400 {
			return opened, connectionFailure("native_binding_challenge_mismatch")
		}
		return opened, nil
	}
	openedChallenge, e := verifyChallenge()
	if e != nil {
		return nil, e
	}
	signature, e := c.sign(ctx, lease, text(challenge["challenge"]), "galaxy-binding-response+jws")
	if e != nil {
		return nil, e
	}
	if _, e = verifyChallenge(); e != nil {
		return nil, e
	}
	bound, e := post("/v1/bindings", map[string]any{"challenge": challenge["challenge"], "clientSession": challenge["clientSession"], "signature": signature})
	if e != nil {
		return nil, e
	}
	verifyBinding := func() (connectionEnvelope, error) {
		if !connectionExact(bound, "bindingId", "receipt") || !connectionUUID.MatchString(text(bound["bindingId"])) {
			return connectionEnvelope{}, connectionFailure("native_binding_receipt_invalid")
		}
		opened, e := c.currentEnvelope(ctx, lease, text(bound["receipt"]), "binding-receipt", 86400)
		if e != nil {
			return opened, e
		}
		d := opened.Data
		expected := openedChallenge.Data
		if !connectionExact(d, "bindingId", "subjectId", "publicKeyFingerprint", "installationId", "endpoint", "scopes", "expiresAt", "revokePath", "auditReference", "control") || opened.ID != bound["bindingId"] || d["bindingId"] != bound["bindingId"] || d["subjectId"] != expected["subjectId"] || d["installationId"] != expected["installationId"] || d["endpoint"] != c.config.Endpoint || !connectionEqual(d["scopes"], expected["scopes"]) || !connectionEqual(d["control"], expected["control"]) || d["publicKeyFingerprint"] != identity.Digest([]byte(text(active.GenesisProof["publicKeyPem"]))) || integer(d["expiresAt"]) != integer(expected["bindingExpiresAt"]) || integer(d["expiresAt"]) != opened.ExpiresAt || d["revokePath"] != "/v1/bindings/"+text(bound["bindingId"])+"/revoke" || d["auditReference"] != openedChallenge.ID {
			return opened, connectionFailure("native_binding_receipt_mismatch")
		}
		return opened, nil
	}
	binding, e := verifyBinding()
	if e != nil {
		return nil, e
	}
	random := make([]byte, 32)
	if _, e = rand.Read(random); e != nil {
		return nil, e
	}
	credential := base64.RawURLEncoding.EncodeToString(random)
	credentialHash := identity.Digest([]byte(credential))
	sessionChallenge, e := post("/v1/session-challenges", map[string]any{"bindingId": bound["bindingId"], "credentialHash": credentialHash})
	if e != nil {
		return nil, e
	}
	verifySession := func() (connectionEnvelope, error) {
		if !connectionExact(sessionChallenge, "challenge") {
			return connectionEnvelope{}, connectionFailure("native_session_challenge_invalid")
		}
		opened, e := c.currentEnvelope(ctx, lease, text(sessionChallenge["challenge"]), "session-challenge", 120)
		if e != nil {
			return opened, e
		}
		d := opened.Data
		if !connectionExact(d, "bindingId", "credentialHash", "purpose", "scopes", "credentialExpiresAt") || d["purpose"] != "session" || d["bindingId"] != binding.Data["bindingId"] || binding.ExpiresAt <= c.now().Unix() || d["credentialHash"] != credentialHash || !connectionEqual(d["scopes"], binding.Data["scopes"]) || !connectionSafeInteger(d["credentialExpiresAt"]) || integer(d["credentialExpiresAt"]) <= c.now().Unix() || integer(d["credentialExpiresAt"]) > min(opened.IssuedAt+600, binding.ExpiresAt) {
			return opened, connectionFailure("native_session_challenge_mismatch")
		}
		return opened, nil
	}
	openedSession, e := verifySession()
	if e != nil {
		return nil, e
	}
	sessionSignature, e := c.sign(ctx, lease, text(sessionChallenge["challenge"]), "galaxy-session-response+jws")
	if e != nil {
		return nil, e
	}
	if _, e = verifySession(); e != nil {
		return nil, e
	}
	activation, e := post("/v1/sessions", map[string]any{"challenge": sessionChallenge["challenge"], "signature": sessionSignature})
	if e != nil {
		return nil, e
	}
	if !connectionExact(activation, "bindingId", "expiresAt", "scopes") || c.now().Unix() < openedSession.IssuedAt || openedSession.ExpiresAt <= c.now().Unix() || activation["bindingId"] != openedSession.Data["bindingId"] || integer(activation["expiresAt"]) != integer(openedSession.Data["credentialExpiresAt"]) || integer(activation["expiresAt"]) <= c.now().Unix() || !connectionEqual(activation["scopes"], openedSession.Data["scopes"]) {
		return nil, connectionFailure("native_session_activation_mismatch")
	}
	if _, e = verifyBinding(); e != nil {
		return nil, e
	}
	if e = check(); e != nil {
		return nil, e
	}
	c.mu.Lock()
	if c.closed || c.generation != lease.generation || c.fingerprint != lease.selection.fingerprint {
		c.mu.Unlock()
		return nil, connectionFailure("native_connection_selection_changed")
	}
	c.generation++
	snapshot := ConnectionSnapshot{BindingID: text(activation["bindingId"]), ExpiresAt: integer(activation["expiresAt"]), Scopes: append([]string{}, scopes...), SubjectID: active.SubjectID, Endpoint: c.config.Endpoint, Control: currentControl, Generation: c.generation}
	c.session = &connectionSession{snapshot: snapshot, credential: credential}
	c.mu.Unlock()
	result, e := c.Snapshot(ctx)
	if e == nil && result == nil {
		return nil, connectionFailure("native_connection_selection_changed")
	}
	return result, e
}
