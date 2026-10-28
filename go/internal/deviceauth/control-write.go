package deviceauth

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"regexp"
	"time"

	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/identity"
	"github.com/agigalaxy-team/agigalaxy/go/internal/postgres"
	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

type ControlDevice struct {
	DeviceID     string   `json:"deviceId"`
	PublicKeyPEM string   `json:"publicKeyPem"`
	Scopes       []string `json:"scopes"`
}
type ControlRequest struct {
	Version               int             `json:"version"`
	OperationID           string          `json:"operationId"`
	SubjectID             string          `json:"subjectId"`
	Kind                  string          `json:"kind"`
	ExpectedEpoch         int64           `json:"expectedEpoch"`
	PreviousEventHash     *string         `json:"previousEventHash"`
	SignerKeyID           string          `json:"signerKeyId"`
	GenesisProof          json.RawMessage `json:"genesisProof,omitempty"`
	NewDevice             *ControlDevice  `json:"newDevice,omitempty"`
	DeviceID              string          `json:"deviceId,omitempty"`
	RecoveryGeneration    *int64          `json:"recoveryGeneration,omitempty"`
	NextRecoveryPublicKey *string         `json:"nextRecoveryPublicKey,omitempty"`
	SaveDeclaration       *bool           `json:"saveDeclaration,omitempty"`
}
type ControlCommit struct {
	OperationID         string  `json:"operationId"`
	ControllerSignature string  `json:"controllerSignature"`
	NewDeviceProof      *string `json:"newDeviceProof,omitempty"`
}
type controlOperation struct {
	ID, Subject, RequestHash, Challenge, State string
	Request                                    ControlRequest
	Expires                                    time.Time
	Receipt                                    map[string]any
}
type controlHead struct {
	Epoch, Sequence int64
	Hash            *string
}
type recovery struct {
	Generation, Epoch int64
	PublicKey         string
	SavedAt           *time.Time
	EventID           string
}

var controlScope = regexp.MustCompile(`^[a-z][a-z0-9:-]{0,63}$|^\*$`)

func controlInvalid() error { return fault.New("invalid_identity_control_request", 400) }
func validControlPublic(value string) bool {
	key, e := parsePublic(value)
	if e != nil || protocol.TextLength(value) > 256 {
		return false
	}
	canonical, e := identity.PublicPEM(key)
	return e == nil && canonical == value
}
func parseControlRequest(raw []byte) (ControlRequest, error) {
	var m map[string]json.RawMessage
	var r ControlRequest
	if json.Unmarshal(raw, &m) != nil || m == nil {
		return r, controlInvalid()
	}
	if protocol.Decode(raw, &r) != nil {
		return r, controlInvalid()
	}
	keys := []string{"operationId", "subjectId", "kind", "expectedEpoch", "previousEventHash", "signerKeyId"}
	if _, ok := m["version"]; ok {
		keys = append(keys, "version")
	} else {
		r.Version = 2
	}
	switch r.Kind {
	case "bootstrap":
		keys = append(keys, "genesisProof", "newDevice")
	case "authorize-device":
		keys = append(keys, "newDevice")
	case "revoke-device":
		keys = append(keys, "deviceId")
	case "set-recovery":
		keys = append(keys, "recoveryGeneration", "nextRecoveryPublicKey", "saveDeclaration")
	case "recover":
		keys = append(keys, "recoveryGeneration", "newDevice", "nextRecoveryPublicKey")
	case "declare-recovery-saved":
		keys = append(keys, "recoveryGeneration", "saveDeclaration")
	default:
		return r, controlInvalid()
	}
	if !exactJSON(raw, keys...) || r.Version != 2 || !consentUUID.MatchString(r.OperationID) || !guidPattern.MatchString(r.SubjectID) || r.ExpectedEpoch < 0 || r.ExpectedEpoch > 9007199254740991 || string(m["expectedEpoch"]) == "null" || r.PreviousEventHash != nil && !hashPattern.MatchString(*r.PreviousEventHash) || !hashPattern.MatchString(r.SignerKeyID) {
		return r, controlInvalid()
	}
	if r.Kind == "bootstrap" || r.Kind == "authorize-device" || r.Kind == "recover" {
		d := r.NewDevice
		if d == nil || !consentUUID.MatchString(d.DeviceID) || !validControlPublic(d.PublicKeyPEM) || len(d.Scopes) < 1 || len(d.Scopes) > 64 || !unique(d.Scopes) {
			return r, controlInvalid()
		}
		for _, scope := range d.Scopes {
			if !controlScope.MatchString(scope) {
				return r, controlInvalid()
			}
		}
	}
	if r.Kind == "revoke-device" && !consentUUID.MatchString(r.DeviceID) {
		return r, controlInvalid()
	}
	if r.Kind == "recover" || r.Kind == "set-recovery" || r.Kind == "declare-recovery-saved" {
		if r.RecoveryGeneration == nil || *r.RecoveryGeneration < 0 || *r.RecoveryGeneration > 9007199254740991 || r.Kind != "set-recovery" && *r.RecoveryGeneration < 1 {
			return r, controlInvalid()
		}
	}
	if r.Kind == "recover" || r.Kind == "set-recovery" {
		if r.NextRecoveryPublicKey == nil || !validControlPublic(*r.NextRecoveryPublicKey) {
			return r, controlInvalid()
		}
	}
	if r.Kind == "set-recovery" || r.Kind == "declare-recovery-saved" {
		if r.SaveDeclaration == nil || !*r.SaveDeclaration {
			return r, controlInvalid()
		}
	}
	return r, nil
}
func validateControlCommit(r ControlCommit) error {
	if !consentUUID.MatchString(r.OperationID) || protocol.TextLength(r.ControllerSignature) < 1 || protocol.TextLength(r.ControllerSignature) > 24000 || r.NewDeviceProof != nil && (protocol.TextLength(*r.NewDeviceProof) < 1 || protocol.TextLength(*r.NewDeviceProof) > 24000) {
		return controlInvalid()
	}
	return nil
}
func controlProof(signature, public, payload string) error {
	if verifyTypedResponse(signature, payload, public, "galaxy-identity-control-v2+jws") != nil {
		return fault.New("identity_control_proof_invalid", 401)
	}
	return nil
}
func (s *Service) ControlChallenge(ctx context.Context, raw []byte) (map[string]any, error) {
	r, e := parseControlRequest(raw)
	if e != nil {
		return nil, e
	}
	canonical, e := identity.Canonical(r)
	if e != nil {
		return nil, e
	}
	requestHash := identity.Digest(canonical)
	if r.Kind == "bootstrap" {
		g, ok := verifyGenesis(r.SubjectID, r.GenesisProof)
		if !ok || r.NewDevice.PublicKeyPEM != g.PublicKeyPEM || r.SignerKeyID != identity.Digest([]byte(g.PublicKeyPEM)) {
			return nil, fault.New("identity_control_proof_invalid", 401)
		}
	}
	allowed := s.AllowedScopes
	if allowed == nil {
		allowed = DefaultScopes
	}
	if r.NewDevice != nil {
		for _, scope := range r.NewDevice.Scopes {
			if scope != "manage-identity" && !contains(allowed, scope) && !(scope == "*" && r.Kind == "bootstrap") {
				return nil, fault.New("identity_scope_invalid", 400)
			}
		}
	}
	nonce := make([]byte, 32)
	if _, e = rand.Read(nonce); e != nil {
		return nil, e
	}
	challenge, e := identity.Canonical(map[string]any{"version": 2, "type": "identity-control", "audience": s.Endpoint, "request": r, "nonce": base64.RawURLEncoding.EncodeToString(nonce), "expiresAt": s.now() + 180})
	if e != nil {
		return nil, e
	}
	requestRaw, e := protocol.Encode(r)
	if e != nil {
		return nil, e
	}
	_, e = s.Pool.Exec(ctx, "INSERT INTO identity_control_operations(id,subject_id,request_hash,request,challenge_text,expires_at) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(id) DO NOTHING", r.OperationID, r.SubjectID, requestHash, requestRaw, string(challenge), time.Unix(s.now()+180, 0))
	if e != nil {
		return nil, e
	}
	op, e := readControlOperation(ctx, s.Pool, r.OperationID, false)
	if e != nil {
		return nil, e
	}
	if op.RequestHash != requestHash {
		return nil, fault.New("operation_conflict", 409)
	}
	return map[string]any{"operationId": op.ID, "challenge": op.Challenge, "expiresAt": op.Expires.Unix(), "state": op.State}, nil
}
func readControlOperation(ctx context.Context, db SQLReader, id string, lock bool) (controlOperation, error) {
	var op controlOperation
	var raw, receipt []byte
	q := "SELECT id::text,subject_id,request_hash,request,challenge_text,expires_at,state,receipt FROM identity_control_operations WHERE id=$1"
	if lock {
		q += " FOR UPDATE"
	}
	e := db.QueryRow(ctx, q, id).Scan(&op.ID, &op.Subject, &op.RequestHash, &raw, &op.Challenge, &op.Expires, &op.State, &receipt)
	if errors.Is(e, pgx.ErrNoRows) {
		return op, fault.New("identity_operation_unknown", 404)
	}
	if e != nil {
		return op, e
	}
	if json.Unmarshal(raw, &op.Request) != nil {
		return op, controlInvalid()
	}
	if receipt != nil {
		e = json.Unmarshal(receipt, &op.Receipt)
	}
	return op, e
}
func readHead(ctx context.Context, db SQLReader, id string) (controlHead, bool, error) {
	var h controlHead
	e := db.QueryRow(ctx, "SELECT epoch,sequence,event_hash FROM subject_control_heads WHERE subject_id=$1", id).Scan(&h.Epoch, &h.Sequence, &h.Hash)
	if errors.Is(e, pgx.ErrNoRows) {
		return h, false, nil
	}
	return h, e == nil, e
}
func readRecovery(ctx context.Context, db SQLReader, id string) (*recovery, error) {
	var r recovery
	e := db.QueryRow(ctx, "SELECT generation,epoch,public_key,save_declared_at,source_event_id::text FROM recovery_authorizations WHERE subject_id=$1 AND status='active'", id).Scan(&r.Generation, &r.Epoch, &r.PublicKey, &r.SavedAt, &r.EventID)
	if errors.Is(e, pgx.ErrNoRows) {
		return nil, nil
	}
	return &r, e
}
func sameText(a, b *string) bool { return a == nil && b == nil || a != nil && b != nil && *a == *b }
func (s *Service) controlReceiptProof(ctx context.Context, db SQLReader, op controlOperation, c ControlCommit) error {
	var signature string
	var newProof *string
	e := db.QueryRow(ctx, "SELECT controller_signature,new_device_proof FROM subject_control_events WHERE id=$1", op.ID).Scan(&signature, &newProof)
	if e != nil {
		return e
	}
	if signature == c.ControllerSignature && sameText(newProof, c.NewDeviceProof) {
		return nil
	}
	if op.Request.NewDevice != nil && c.NewDeviceProof != nil {
		return controlProof(*c.NewDeviceProof, op.Request.NewDevice.PublicKeyPEM, op.Challenge)
	}
	return fault.New("identity_control_proof_invalid", 401)
}
func (s *Service) currentOperationProof(ctx context.Context, tx pgx.Tx, op controlOperation, signature string) error {
	r := op.Request
	var public string
	if r.Kind == "bootstrap" {
		var g Genesis
		_ = json.Unmarshal(r.GenesisProof, &g)
		public = g.PublicKeyPEM
	} else if r.Kind == "recover" {
		e := tx.QueryRow(ctx, "SELECT public_key FROM recovery_authorizations WHERE subject_id=$1 AND generation=$2", r.SubjectID, r.RecoveryGeneration).Scan(&public)
		if e != nil && !errors.Is(e, pgx.ErrNoRows) {
			return e
		}
	} else {
		c, e := currentControl(ctx, tx, binding{Subject: r.SubjectID, KeyID: &r.SignerKeyID, Epoch: &r.ExpectedEpoch})
		if e != nil {
			return e
		}
		if !contains(c.Scopes, "*") && !contains(c.Scopes, "manage-identity") {
			return fault.New("identity_control_stale", 401)
		}
		public = c.PublicKey
	}
	return controlProof(signature, public, op.Challenge)
}
func (s *Service) ControlCommit(ctx context.Context, c ControlCommit) (map[string]any, error) {
	if e := validateControlCommit(c); e != nil {
		return nil, e
	}
	out, e := postgres.InTx(ctx, s.Pool, func(tx pgx.Tx) (map[string]any, error) {
		initial, e := readControlOperation(ctx, tx, c.OperationID, false)
		if e != nil {
			return nil, e
		}
		r := initial.Request
		var genesis Genesis
		if r.Kind == "bootstrap" {
			_ = json.Unmarshal(r.GenesisProof, &genesis)
			if e = controlProof(c.ControllerSignature, genesis.PublicKeyPEM, initial.Challenge); e != nil {
				return nil, e
			}
			if _, e = tx.Exec(ctx, "INSERT INTO subjects(id,public_key,genesis_proof) VALUES($1,$2,$3) ON CONFLICT(id) DO NOTHING", r.SubjectID, genesis.PublicKeyPEM, r.GenesisProof); e != nil {
				return nil, e
			}
		}
		var subjectPublic string
		e = tx.QueryRow(ctx, "SELECT public_key FROM public.galaxy_api_lock_subject_control($1,true)", r.SubjectID).Scan(&subjectPublic)
		if errors.Is(e, pgx.ErrNoRows) {
			return nil, fault.New("identity_not_registered", 404)
		}
		if e != nil {
			return nil, e
		}
		if e = s.assertNotDeleted(ctx, tx, r.SubjectID); e != nil {
			return nil, e
		}
		op, e := readControlOperation(ctx, tx, c.OperationID, true)
		if e != nil {
			return nil, e
		}
		if op.State == "committed" {
			if e = s.controlReceiptProof(ctx, tx, op, c); e != nil {
				return nil, e
			}
			return op.Receipt, nil
		}
		if op.State == "canceled" {
			return nil, fault.New("identity_operation_canceled", 409)
		}
		if op.Expires.Unix() <= s.now() {
			return nil, fault.New("identity_challenge_expired", 401)
		}
		head, hasHead, e := readHead(ctx, tx, r.SubjectID)
		if e != nil {
			return nil, e
		}
		if r.ExpectedEpoch != head.Epoch {
			return nil, fault.New("control_epoch_changed", 409)
		}
		if !sameText(r.PreviousEventHash, head.Hash) {
			return nil, fault.New("control_head_changed", 409)
		}
		recovery, e := readRecovery(ctx, tx, r.SubjectID)
		if e != nil {
			return nil, e
		}
		var signer control
		if r.Kind == "bootstrap" {
			if hasHead || subjectPublic != genesis.PublicKeyPEM {
				return nil, fault.New("identity_already_upgraded", 409)
			}
			signer = control{PublicKey: subjectPublic, KeyID: identity.Digest([]byte(subjectPublic)), Scopes: []string{"*"}}
		} else if r.Kind == "recover" {
			if recovery == nil || recovery.Epoch != head.Epoch || r.RecoveryGeneration == nil || recovery.Generation != *r.RecoveryGeneration {
				return nil, fault.New("recovery_generation_consumed", 409)
			}
			signer = control{PublicKey: recovery.PublicKey, KeyID: identity.Digest([]byte(recovery.PublicKey)), Scopes: []string{"*"}}
		} else {
			if !hasHead {
				return nil, fault.New("identity_control_upgrade_required", 409)
			}
			signer, e = currentControl(ctx, tx, binding{Subject: r.SubjectID, KeyID: &r.SignerKeyID, Epoch: &r.ExpectedEpoch})
			if e != nil {
				return nil, e
			}
			if !contains(signer.Scopes, "*") && !contains(signer.Scopes, "manage-identity") {
				return nil, fault.New("identity_control_stale", 401)
			}
		}
		if signer.KeyID != r.SignerKeyID {
			return nil, fault.New("identity_control_proof_invalid", 401)
		}
		if e = controlProof(c.ControllerSignature, signer.PublicKey, op.Challenge); e != nil {
			return nil, e
		}
		if r.NewDevice != nil {
			if c.NewDeviceProof == nil {
				return nil, fault.New("identity_control_proof_invalid", 401)
			}
			if e = controlProof(*c.NewDeviceProof, r.NewDevice.PublicKeyPEM, op.Challenge); e != nil {
				return nil, e
			}
			for _, scope := range r.NewDevice.Scopes {
				if !contains(signer.Scopes, "*") && !contains(signer.Scopes, scope) {
					return nil, fault.New("identity_scope_escalation", 403)
				}
			}
			if (r.Kind == "bootstrap" || r.Kind == "recover") && !contains(r.NewDevice.Scopes, "manage-identity") {
				return nil, fault.New("identity_manager_required", 400)
			}
		}
		generation := int64(0)
		if recovery != nil {
			generation = recovery.Generation
		}
		if r.Kind == "set-recovery" && *r.RecoveryGeneration != generation || r.Kind == "declare-recovery-saved" && (recovery == nil || recovery.Generation != *r.RecoveryGeneration) {
			return nil, fault.New("recovery_generation_consumed", 409)
		}
		if r.NextRecoveryPublicKey != nil {
			var reused bool
			e = tx.QueryRow(ctx, "SELECT EXISTS(SELECT 1 FROM recovery_authorizations WHERE subject_id=$1 AND public_key=$2)", r.SubjectID, *r.NextRecoveryPublicKey).Scan(&reused)
			if e != nil {
				return nil, e
			}
			if *r.NextRecoveryPublicKey == signer.PublicKey || r.NewDevice != nil && *r.NextRecoveryPublicKey == r.NewDevice.PublicKeyPEM || reused {
				return nil, fault.New("recovery_key_reused", 409)
			}
		}
		at := time.Unix(s.now(), 0).UTC()
		accepted := at.Format("2006-01-02T15:04:05.000Z")
		epoch := head.Epoch
		if epoch == 0 {
			epoch = 1
		}
		if r.Kind == "recover" {
			epoch = head.Epoch + 1
		}
		sequence := head.Sequence + 1
		event := map[string]any{"id": r.OperationID, "subjectId": r.SubjectID, "sequence": sequence, "epoch": epoch, "kind": r.Kind, "previousEventHash": head.Hash, "payloadText": op.Challenge, "controllerSignature": c.ControllerSignature, "newDeviceProof": c.NewDeviceProof, "signerKeyId": signer.KeyID, "acceptedAt": accepted}
		canonical, e := identity.Canonical(event)
		if e != nil {
			return nil, e
		}
		eventHash := identity.Digest(canonical)
		if _, e = tx.Exec(ctx, `INSERT INTO subject_control_events(id,subject_id,sequence,epoch,kind,previous_event_hash,event_hash,payload_text,controller_signature,new_device_proof,signer_key_id,accepted_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`, r.OperationID, r.SubjectID, sequence, epoch, r.Kind, head.Hash, eventHash, op.Challenge, c.ControllerSignature, c.NewDeviceProof, signer.KeyID, at); e != nil {
			return nil, e
		}
		if r.Kind == "recover" {
			for _, q := range []string{"UPDATE device_authorizations SET status='revoked',revoked_at=$2 WHERE subject_id=$1 AND status='active'", "UPDATE bindings SET revoked_at=$2,revocation_kind='recovery',revocation_control_event_id=$3,revocation_request_id=$3 WHERE subject_id=$1 AND revoked_at IS NULL", "UPDATE access_credentials SET revoked_at=$2 WHERE binding_id IN (SELECT id FROM bindings WHERE subject_id=$1) AND revoked_at IS NULL"} {
				args := []any{r.SubjectID, at}
				if q[7:15] == "bindings" {
					args = append(args, r.OperationID)
				}
				if _, e = tx.Exec(ctx, q, args...); e != nil {
					return nil, e
				}
			}
		}
		if r.NewDevice != nil {
			d := r.NewDevice
			if _, e = tx.Exec(ctx, `INSERT INTO device_authorizations(device_id,subject_id,key_id,public_key,epoch,scopes,status,source_event_id) VALUES($1,$2,$3,$4,$5,$6,'active',$7)`, d.DeviceID, r.SubjectID, identity.Digest([]byte(d.PublicKeyPEM)), d.PublicKeyPEM, epoch, d.Scopes, r.OperationID); e != nil {
				return nil, e
			}
			if r.Kind == "bootstrap" {
				if _, e = tx.Exec(ctx, "UPDATE bindings SET device_id=$2,key_id=$3,control_epoch=$4 WHERE subject_id=$1 AND device_id IS NULL", r.SubjectID, d.DeviceID, signer.KeyID, epoch); e != nil {
					return nil, e
				}
				if _, e = tx.Exec(ctx, "UPDATE access_credentials SET device_id=$2,key_id=$3,control_epoch=$4 WHERE binding_id IN (SELECT id FROM bindings WHERE subject_id=$1) AND device_id IS NULL", r.SubjectID, d.DeviceID, signer.KeyID, epoch); e != nil {
					return nil, e
				}
			}
		}
		if r.Kind == "revoke-device" {
			var scopes []string
			e = tx.QueryRow(ctx, "SELECT scopes FROM device_authorizations WHERE device_id=$1 AND subject_id=$2 AND status='active' AND epoch=$3", r.DeviceID, r.SubjectID, epoch).Scan(&scopes)
			if errors.Is(e, pgx.ErrNoRows) {
				return nil, fault.New("identity_device_not_active", 409)
			}
			if e != nil {
				return nil, e
			}
			if contains(scopes, "manage-identity") {
				var others bool
				e = tx.QueryRow(ctx, "SELECT EXISTS(SELECT 1 FROM device_authorizations WHERE subject_id=$1 AND epoch=$2 AND status='active' AND device_id<>$3 AND scopes ? 'manage-identity')", r.SubjectID, epoch, r.DeviceID).Scan(&others)
				if e != nil {
					return nil, e
				}
				if !others && recovery == nil {
					return nil, fault.New("identity_last_controller", 409)
				}
			}
			if _, e = tx.Exec(ctx, "UPDATE device_authorizations SET status='revoked',revoked_at=$2 WHERE device_id=$1", r.DeviceID, at); e != nil {
				return nil, e
			}
			if _, e = tx.Exec(ctx, "UPDATE bindings SET revoked_at=COALESCE(revoked_at,$2),revocation_kind='device-revoked',revocation_control_event_id=$3,revocation_request_id=$3 WHERE device_id=$1 AND (revoked_at IS NULL OR revocation_kind='recovery')", r.DeviceID, at, r.OperationID); e != nil {
				return nil, e
			}
			if _, e = tx.Exec(ctx, "UPDATE access_credentials SET revoked_at=$2 WHERE device_id=$1 AND revoked_at IS NULL", r.DeviceID, at); e != nil {
				return nil, e
			}
		}
		if r.NextRecoveryPublicKey != nil {
			if recovery != nil {
				state := "replaced"
				if r.Kind == "recover" {
					state = "consumed"
				}
				if _, e = tx.Exec(ctx, "UPDATE recovery_authorizations SET status=$3 WHERE subject_id=$1 AND generation=$2", r.SubjectID, recovery.Generation, state); e != nil {
					return nil, e
				}
			}
			var saved any
			if r.Kind == "set-recovery" {
				saved = at
			}
			if _, e = tx.Exec(ctx, `INSERT INTO recovery_authorizations(subject_id,generation,epoch,public_key,source_event_id,status,save_declared_at) VALUES($1,$2,$3,$4,$5,'active',$6)`, r.SubjectID, generation+1, epoch, *r.NextRecoveryPublicKey, r.OperationID, saved); e != nil {
				return nil, e
			}
		}
		if r.Kind == "declare-recovery-saved" {
			if _, e = tx.Exec(ctx, "UPDATE recovery_authorizations SET save_declared_at=$3 WHERE subject_id=$1 AND generation=$2", r.SubjectID, recovery.Generation, at); e != nil {
				return nil, e
			}
		}
		if _, e = tx.Exec(ctx, `INSERT INTO subject_control_heads(subject_id,epoch,sequence,event_hash) VALUES($1,$2,$3,$4) ON CONFLICT(subject_id) DO UPDATE SET epoch=excluded.epoch,sequence=excluded.sequence,event_hash=excluded.event_hash`, r.SubjectID, epoch, sequence, eventHash); e != nil {
			return nil, e
		}
		receipt := map[string]any{"operationId": r.OperationID, "subjectId": r.SubjectID, "state": "committed", "kind": r.Kind, "epoch": epoch, "sequence": sequence, "chainHead": eventHash, "dataRecovery": "separate/not-performed", "acceptedAt": accepted}
		if r.NewDevice != nil {
			receipt["deviceId"] = r.NewDevice.DeviceID
			receipt["keyId"] = identity.Digest([]byte(r.NewDevice.PublicKeyPEM))
		}
		if r.NextRecoveryPublicKey != nil {
			receipt["activeRecoveryGeneration"] = generation + 1
		}
		if r.Kind == "recover" {
			receipt["consumedRecoveryGeneration"] = recovery.Generation
			receipt["oldDeviceAccess"] = "revoked-on-current-authority"
			receipt["recoveryReadiness"] = "registered-awaiting-save-declaration"
		}
		raw, e := protocol.Encode(receipt)
		if e != nil {
			return nil, e
		}
		if _, e = tx.Exec(ctx, "UPDATE identity_control_operations SET state='committed',receipt=$2,committed_at=$3 WHERE id=$1", r.OperationID, raw, at); e != nil {
			return nil, e
		}
		return receipt, nil
	})
	var pgerr *pgconn.PgError
	if errors.As(e, &pgerr) && pgerr.Code == "23505" {
		return nil, fault.New("identity_operation_conflict", 409)
	}
	return out, e
}
func (s *Service) ControlStatus(ctx context.Context, c ControlCommit) (map[string]any, error) {
	if e := validateControlCommit(c); e != nil {
		return nil, e
	}
	return postgres.InTx(ctx, s.Pool, func(tx pgx.Tx) (map[string]any, error) {
		op, e := readControlOperation(ctx, tx, c.OperationID, false)
		if e != nil {
			return nil, e
		}
		if op.State == "committed" {
			if op.Request.Kind == "authorize-device" && c.NewDeviceProof == nil {
				var sig string
				if e = tx.QueryRow(ctx, "SELECT controller_signature FROM subject_control_events WHERE id=$1", op.ID).Scan(&sig); e != nil {
					return nil, e
				}
				if sig != c.ControllerSignature {
					return nil, fault.New("identity_control_proof_invalid", 401)
				}
				if e = s.currentOperationProof(ctx, tx, op, c.ControllerSignature); e != nil {
					return nil, e
				}
			} else if e = s.controlReceiptProof(ctx, tx, op, c); e != nil {
				return nil, e
			}
			return op.Receipt, nil
		}
		if op.Request.NewDevice != nil && c.NewDeviceProof != nil {
			e = controlProof(*c.NewDeviceProof, op.Request.NewDevice.PublicKeyPEM, op.Challenge)
		} else {
			e = s.currentOperationProof(ctx, tx, op, c.ControllerSignature)
		}
		if e != nil {
			return nil, e
		}
		state := op.State
		if state == "requested" && op.Expires.Unix() <= s.now() {
			state = "expired"
		}
		return map[string]any{"operationId": op.ID, "subjectId": op.Subject, "state": state}, nil
	})
}
func (s *Service) ControlCancel(ctx context.Context, c ControlCommit) (map[string]any, error) {
	if e := validateControlCommit(c); e != nil {
		return nil, e
	}
	return postgres.InTx(ctx, s.Pool, func(tx pgx.Tx) (map[string]any, error) {
		initial, e := readControlOperation(ctx, tx, c.OperationID, false)
		if e != nil {
			return nil, e
		}
		var public string
		e = tx.QueryRow(ctx, "SELECT public_key FROM public.galaxy_api_lock_subject_control($1,false)", initial.Subject).Scan(&public)
		if e != nil && !errors.Is(e, pgx.ErrNoRows) {
			return nil, e
		}
		op, e := readControlOperation(ctx, tx, c.OperationID, true)
		if e != nil {
			return nil, e
		}
		if op.State == "committed" {
			if e = s.controlReceiptProof(ctx, tx, op, c); e != nil {
				return nil, e
			}
			return op.Receipt, nil
		}
		if e = s.currentOperationProof(ctx, tx, op, c.ControllerSignature); e != nil {
			return nil, e
		}
		if _, e = tx.Exec(ctx, "UPDATE identity_control_operations SET state='canceled' WHERE id=$1", op.ID); e != nil {
			return nil, e
		}
		return map[string]any{"operationId": op.ID, "subjectId": op.Subject, "state": "canceled"}, nil
	})
}
