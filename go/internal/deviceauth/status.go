package deviceauth

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"time"

	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/postgres"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

func (s *Service) ControlPublicState(ctx context.Context, subject string) (map[string]any, error) {
	if !guidPattern.MatchString(subject) {
		return nil, controlInvalid()
	}
	return postgres.InTx(ctx, s.Pool, func(tx pgx.Tx) (map[string]any, error) {
		var genesis []byte
		e := tx.QueryRow(ctx, "SELECT genesis_proof FROM public.galaxy_api_lock_subject_control($1,false)", subject).Scan(&genesis)
		if errors.Is(e, pgx.ErrNoRows) {
			return nil, fault.New("identity_not_registered", 404)
		}
		if e != nil {
			return nil, e
		}
		head, _, e := readHead(ctx, tx, subject)
		if e != nil {
			return nil, e
		}
		rec, e := readRecovery(ctx, tx, subject)
		if e != nil {
			return nil, e
		}
		devices, e := publicRows(ctx, tx, "SELECT device_id,key_id,public_key,epoch,scopes,status,source_event_id,revoked_at FROM device_authorizations WHERE subject_id=$1 ORDER BY device_id", subject)
		if e != nil {
			return nil, e
		}
		events, e := publicRows(ctx, tx, "SELECT * FROM subject_control_events WHERE subject_id=$1 ORDER BY sequence", subject)
		if e != nil {
			return nil, e
		}
		var recovery any
		readiness := "not-configured"
		if rec != nil {
			var saved any
			if rec.SavedAt != nil {
				saved = rec.SavedAt.UTC().Format("2006-01-02T15:04:05.000Z")
			}
			recovery = map[string]any{"generation": rec.Generation, "epoch": rec.Epoch, "publicKeyPem": rec.PublicKey, "sourceEventId": rec.EventID, "saveDeclaredAt": saved}
			readiness = "registered-awaiting-save-declaration"
			if rec.SavedAt != nil {
				readiness = "registered-save-declared"
			}
		}
		var g any
		if json.Unmarshal(genesis, &g) != nil {
			return nil, controlInvalid()
		}
		return map[string]any{"subjectId": subject, "genesisProof": g, "epoch": head.Epoch, "sequence": head.Sequence, "chainHead": head.Hash, "authority": s.Endpoint, "checkedAt": s.now(), "devices": devices, "recovery": recovery, "recoveryReadiness": readiness, "events": events, "dataRecovery": "separate/not-performed"}, nil
	})
}
func publicRows(ctx context.Context, tx pgx.Tx, q string, args ...any) ([]map[string]any, error) {
	rows, e := tx.Query(ctx, q, args...)
	if e != nil {
		return nil, e
	}
	out, e := pgx.CollectRows(rows, pgx.RowToMap)
	if e != nil {
		return nil, e
	}
	if out == nil {
		out = []map[string]any{}
	}
	for _, row := range out {
		for key, v := range row {
			switch value := v.(type) {
			case time.Time:
				row[key] = value.UTC().Format("2006-01-02T15:04:05.000Z")
			case [16]byte:
				row[key] = uuid.UUID(value).String()
			}
		}
	}
	return out, nil
}

type ReceiptControl struct {
	DeviceID *string `json:"deviceId"`
	KeyID    string  `json:"keyId"`
	Epoch    int64   `json:"epoch"`
}
type ReceiptOperation struct {
	Kind        string `json:"kind"`
	SnapshotID  string `json:"snapshotId"`
	VersionID   string `json:"versionId"`
	RequestHash string `json:"requestHash"`
}
type ReceiptChallengeInput struct {
	SubjectID   string           `json:"subjectId"`
	Control     ReceiptControl   `json:"control"`
	Operation   ReceiptOperation `json:"operation"`
	ClientNonce string           `json:"clientNonce"`
}
type receiptData struct {
	ReceiptChallengeInput
	Version   int    `json:"version"`
	Purpose   string `json:"purpose"`
	Endpoint  string `json:"endpoint"`
	Authority string `json:"authority"`
}
type ReceiptQueryInput struct {
	Challenge string `json:"challenge"`
	Signature string `json:"signature"`
}
type ReceiptSigner interface {
	SignReceipt(context.Context, any, string, int64, int64) (string, error)
	VerifyReceipt(context.Context, string, int64) (json.RawMessage, string, error)
}

func (k *SessionKeyring) SignReceipt(ctx context.Context, data any, id string, at, age int64) (string, error) {
	return k.signEnvelope("receipt-status-challenge", data, id, at, age)
}
func (k *SessionKeyring) VerifyReceipt(ctx context.Context, token string, at int64) (json.RawMessage, string, error) {
	v, e := k.verifyEnvelope(token, "receipt-status-challenge", 120, at)
	if !consentUUID.MatchString(v.ID) {
		return nil, "", denied()
	}
	return v.Data, v.ID, e
}
func validateReceiptInput(r ReceiptChallengeInput) error {
	validNonce := len(r.ClientNonce) == 43 && strings.ContainsRune("AEIMQUYcgkosw048", rune(r.ClientNonce[len(r.ClientNonce)-1]))
	for _, c := range r.ClientNonce {
		if !(c >= 'A' && c <= 'Z' || c >= 'a' && c <= 'z' || c >= '0' && c <= '9' || c == '_' || c == '-') {
			validNonce = false
		}
	}
	if !guidPattern.MatchString(r.SubjectID) || !hashPattern.MatchString(r.Control.KeyID) || r.Control.Epoch < 0 || r.Control.Epoch > 9007199254740991 || r.Control.Epoch == 0 && r.Control.DeviceID != nil || r.Control.Epoch > 0 && (r.Control.DeviceID == nil || !consentUUID.MatchString(*r.Control.DeviceID)) || r.Operation.Kind != "choice-snapshot" || !consentUUID.MatchString(r.Operation.SnapshotID) || !consentUUID.MatchString(r.Operation.VersionID) || !hashPattern.MatchString(r.Operation.RequestHash) || !validNonce {
		return fault.New("invalid_receipt_status_request", 400)
	}
	return nil
}
func (s *Service) receiptDeadline() (int64, error) {
	if s.ReceiptStatusDeadline != nil {
		deadline, e := s.ReceiptStatusDeadline()
		if e != nil {
			return 0, e
		}
		if deadline <= s.now() {
			return 0, fault.New("service_retired", 410)
		}
		return min(s.now()+120, deadline), nil
	}
	return s.now() + 120, nil
}
func (s *Service) receiptControl(ctx context.Context, tx pgx.Tx, r ReceiptChallengeInput) (control, error) {
	c, e := currentControl(ctx, tx, binding{Subject: r.SubjectID, DeviceID: r.Control.DeviceID, KeyID: &r.Control.KeyID, Epoch: &r.Control.Epoch})
	if e != nil {
		return c, e
	}
	if !sameText(c.DeviceID, r.Control.DeviceID) || c.KeyID != r.Control.KeyID || c.Epoch != r.Control.Epoch || !contains(c.Scopes, "*") && !contains(c.Scopes, "binding") {
		return c, fault.New("receipt_status_access_denied", 401)
	}
	var deleted bool
	e = tx.QueryRow(ctx, "SELECT EXISTS(SELECT 1 FROM deletion_requests WHERE subject_id=$1 AND state IN ('partial','primary-erased'))", r.SubjectID).Scan(&deleted)
	if e != nil {
		return c, e
	}
	if deleted {
		return c, fault.New("receipt_status_access_denied", 401)
	}
	return c, nil
}
func (s *Service) ReceiptChallenge(ctx context.Context, r ReceiptChallengeInput) (map[string]any, error) {
	if e := validateReceiptInput(r); e != nil {
		return nil, e
	}
	return postgres.InTx(ctx, s.Pool, func(tx pgx.Tx) (map[string]any, error) {
		if _, e := s.receiptDeadline(); e != nil {
			return nil, e
		}
		if _, e := s.receiptControl(ctx, tx, r); e != nil {
			return nil, e
		}
		expiry, e := s.receiptDeadline()
		if e != nil {
			return nil, e
		}
		id := uuid.NewString()
		signer, ok := s.Signer.(ReceiptSigner)
		if !ok {
			return nil, fault.New("signing_unavailable", 503)
		}
		token, e := signer.SignReceipt(ctx, receiptData{r, 1, "receipt-status", s.Endpoint, "retained-owner-operation-only"}, id, s.now(), expiry-s.now())
		if e != nil {
			return nil, e
		}
		if _, e = s.receiptDeadline(); e != nil {
			return nil, e
		}
		return map[string]any{"challenge": token, "challengeId": id, "expiresAt": expiry, "ordinarySessionCreated": false}, nil
	})
}
func (s *Service) ReceiptQuery(ctx context.Context, r ReceiptQueryInput) (map[string]any, error) {
	if len(r.Challenge) < 1 || len(r.Challenge) > 8192 || len(r.Signature) < 1 || len(r.Signature) > 24000 {
		return nil, fault.New("invalid_receipt_status_request", 400)
	}
	signer, ok := s.Signer.(ReceiptSigner)
	if !ok {
		return nil, fault.New("receipt_status_proof_invalid", 401)
	}
	open := func() (receiptData, error) {
		var d receiptData
		raw, _, e := signer.VerifyReceipt(ctx, r.Challenge, s.now())
		if e != nil || !exactJSON(raw, "subjectId", "control", "operation", "clientNonce", "version", "purpose", "endpoint", "authority") || json.Unmarshal(raw, &d) != nil || validateReceiptInput(d.ReceiptChallengeInput) != nil || d.Version != 1 || d.Purpose != "receipt-status" || d.Endpoint != s.Endpoint || d.Authority != "retained-owner-operation-only" {
			return d, fault.New("receipt_status_proof_invalid", 401)
		}
		return d, nil
	}
	if _, e := open(); e != nil {
		return nil, e
	}
	return postgres.InTx(ctx, s.Pool, func(tx pgx.Tx) (map[string]any, error) {
		if _, e := s.receiptDeadline(); e != nil {
			return nil, e
		}
		d, e := open()
		if e != nil {
			return nil, e
		}
		control, e := s.receiptControl(ctx, tx, d.ReceiptChallengeInput)
		if e != nil {
			return nil, e
		}
		if e = verifyTypedResponse(r.Signature, r.Challenge, control.PublicKey, "galaxy-receipt-status-response+jws"); e != nil {
			return nil, fault.New("receipt_status_proof_invalid", 401)
		}
		result, e := s.ChoiceReceiptWithin(ctx, tx, d.SubjectID, d.Operation)
		if e != nil {
			return nil, e
		}
		if _, e = s.receiptDeadline(); e != nil {
			return nil, e
		}
		if _, e = open(); e != nil {
			return nil, e
		}
		return result, nil
	})
}

// ChoiceReceiptWithin reads only retained owner-operation metadata. It neither
// reads snapshot content nor mints an ordinary credential or replacement write.
func (s *Service) ChoiceReceiptWithin(ctx context.Context, tx pgx.Tx, subject string, r ReceiptOperation) (map[string]any, error) {
	common := map[string]any{"snapshotId": r.SnapshotID, "versionId": r.VersionID, "requestHash": r.RequestHash, "authority": "accepted-operation-only", "audience": "owner-only", "currentAccessGranted": false, "contentReturned": false, "sourceAccessChecked": false}
	var snapshot, version, hash, state string
	var base, revision int64
	var accepted, expiry time.Time
	e := tx.QueryRow(ctx, "SELECT snapshot_id::text,version_id::text,request_hash,base_revision,revision,state,created_at,expires_at FROM choice_snapshot_versions WHERE subject_id=$1 AND version_id=$2", subject, r.VersionID).Scan(&snapshot, &version, &hash, &base, &revision, &state, &accepted, &expiry)
	if errors.Is(e, pgx.ErrNoRows) {
		common["state"] = "absent"
		common["absenceMeaning"] = "no-retained-owner-operation"
		return common, nil
	}
	if e != nil {
		return nil, e
	}
	if snapshot != r.SnapshotID || hash != r.RequestHash {
		common["state"] = "conflict"
		common["reason"] = "original-operation-mismatch"
		return common, nil
	}
	common["state"] = "acknowledged"
	common["receipt"] = map[string]any{"snapshotId": snapshot, "versionId": version, "requestHash": hash, "baseRevision": base, "revision": revision, "storedState": state, "acceptedAt": accepted.UTC().Format("2006-01-02T15:04:05.000Z"), "contentExpiresAt": expiry.UTC().Format("2006-01-02T15:04:05.000Z"), "contentRetentionDue": expiry.Unix() <= s.now()}
	return common, nil
}
