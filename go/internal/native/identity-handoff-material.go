package native

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/x509"
	"encoding/pem"
	"github.com/agigalaxy-team/agigalaxy/go/internal/identity"
	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
	"github.com/google/uuid"
	"io"
	"os"
	"path/filepath"
)

func (r *Runtime) handoffLease(ctx context.Context) (context.Context, func(), *nativeIdentityLease, error) {
	operation, cancel, generation, e := r.operation(ctx, false)
	if e != nil {
		return nil, nil, nil, e
	}
	scope, e := r.store.ChoiceScope(operation)
	if e != nil {
		cancel()
		return nil, nil, nil, e
	}
	connection, e := r.connection.lease(operation, false)
	if e != nil {
		cancel()
		return nil, nil, nil, e
	}
	lease := &nativeIdentityLease{r, scope, connection, generation}
	if e = lease.check(operation); e != nil {
		cancel()
		return nil, nil, nil, e
	}
	return operation, cancel, lease, nil
}
func (l *nativeIdentityLease) handoffControl(ctx context.Context, subject string) (map[string]any, error) {
	value, e := l.call(ctx, "/v2/identity/"+subject+"/control", nil, true)
	if e != nil {
		return nil, e
	}
	verified, e := verifyConnectionControl(value)
	if e != nil {
		return nil, e
	}
	if value["subjectId"] != subject || value["authority"] != l.scope.Endpoint || !connectionSafeInteger(value["checkedAt"]) || verified.Epoch < 1 {
		return nil, connectionFailure("device_control_state_invalid")
	}
	return value, nil
}
func (l *nativeIdentityLease) handoffKey(ctx context.Context, subject, device string) (ed25519.PrivateKey, string, error) {
	var key ed25519.PrivateKey
	var public string
	e := l.runtime.store.With(ctx, false, func(dir string) error {
		if e := l.runtime.store.verifyChoiceWithin(dir, &l.scope); e != nil {
			return e
		}
		var record map[string]any
		ok, e := readJSON(connectionRecordPath(dir, "device:"+subject+":"+device), &record)
		if e != nil {
			return e
		}
		if !ok || record["deviceId"] != device || record["nativeDeviceKey"] != device || !handoffUUID(device) {
			return connectionFailure("device_key_unavailable")
		}
		path := filepath.Join(dir, "native-v2", "keys", device+".pem")
		if record["nativeGenesis"] == true {
			path = filepath.Join(dir, "galaxy-id-private-key.pem")
		}
		file, e := os.Open(path)
		if e != nil {
			return connectionFailure("device_key_unavailable")
		}
		defer file.Close()
		raw, e := io.ReadAll(io.LimitReader(file, 4097))
		if e != nil || len(raw) > 4096 {
			return connectionFailure("device_key_unavailable")
		}
		key, e = identity.PrivatePEM(raw)
		if e != nil {
			return e
		}
		public, e = identity.PublicPEM(key.Public().(ed25519.PublicKey))
		if e != nil || public != record["publicKeyPem"] {
			return connectionFailure("native_device_key_mismatch")
		}
		return nil
	})
	if e != nil {
		return nil, "", e
	}
	return key, public, l.check(ctx)
}
func (l *nativeIdentityLease) newHandoffDeviceWithin(dir, subject string) (map[string]any, error) {
	if e := l.runtime.store.verifyChoiceWithin(dir, &l.scope); e != nil {
		return nil, e
	}
	if e := l.runtime.checkOperation(l.generation); e != nil {
		return nil, e
	}
	public, private, e := ed25519.GenerateKey(rand.Reader)
	if e != nil {
		return nil, e
	}
	pub, e := identity.PublicPEM(public)
	if e != nil {
		return nil, e
	}
	der, e := x509.MarshalPKCS8PrivateKey(private)
	if e != nil {
		return nil, e
	}
	id := uuid.NewString()
	path := filepath.Join(dir, "native-v2", "keys", id+".pem")
	if e = os.MkdirAll(filepath.Dir(path), 0700); e != nil {
		return nil, e
	}
	file, e := os.OpenFile(path, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
	if e != nil {
		return nil, e
	}
	_, writeError := file.Write(pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: der}))
	closeError := file.Close()
	if writeError != nil {
		return nil, writeError
	}
	if closeError != nil {
		return nil, closeError
	}
	material := map[string]any{"deviceId": id, "publicKeyPem": pub, "nativeDeviceKey": id}
	if e = uploadNativeRecordWithin(dir, "device:"+subject+":"+id, material); e != nil {
		return nil, e
	}
	return material, nil
}

// Remote authorization and local selection remain separate. This private
// callback is reachable only after the exact owned handoff proof is verified.
func (r *Runtime) activateHandoff(ctx context.Context, l *nativeIdentityLease, active map[string]any, verify func(string) error) (ChoiceScope, error) {
	r.connectMu.Lock()
	defer r.connectMu.Unlock()
	if e := l.check(ctx); e != nil {
		return ChoiceScope{}, e
	}
	var next ChoiceScope
	var fingerprint string
	e := r.store.With(ctx, true, func(dir string) error {
		if e := r.store.verifyChoiceWithin(dir, &l.scope); e != nil {
			return e
		}
		if e := r.checkOperation(l.generation); e != nil {
			return e
		}
		if e := verify(dir); e != nil {
			return e
		}
		selected, e := r.connection.selectionWithin(dir)
		if e != nil {
			return e
		}
		if selected.fingerprint != l.connection.selection.fingerprint || selected.Revision >= 9007199254740991 {
			return connectionFailure("device_handoff_owner_changed")
		}
		record := map[string]any{"version": 1, "revision": selected.Revision + 1, "active": active, "permission": map[string]any{"enabled": false}}
		raw, e := protocol.Encode(record)
		if e != nil {
			return e
		}
		if e = uploadNativeRecordWithin(dir, "native-selection:"+r.config.Endpoint, record); e != nil {
			return e
		}
		fingerprint = identity.Digest(raw)
		next = ChoiceScope{Owner: text(active["subjectId"]), Endpoint: r.config.Endpoint, DeviceID: text(active["deviceId"]), Revision: selected.Revision + 1}
		return nil
	})
	if e != nil {
		return next, e
	}
	r.mu.Lock()
	r.stopped = true
	r.stopFingerprint = fingerprint
	r.rotateLocked()
	r.mu.Unlock()
	if r.privateSync != nil {
		r.privateSync.Pause()
	}
	r.connection.Disconnect()
	return next, nil
}
