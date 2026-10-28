package deviceauth

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/json"
	"errors"
	"math/big"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/identity"
	"github.com/agigalaxy-team/agigalaxy/go/internal/postgres"
	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

var DefaultScopes = []string{"binding", "consent", "case-teaser", "evidence", "proof", "history", "assistance", "context", "notifications", "moderation", "capsules", "builders", "audit", "audit-review", "data-export", "data-delete"}
var uuidV4Pattern = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`)
var guidPattern = regexp.MustCompile(`^GUID1[0-5][0123456789ABCDEFGHJKMNPQRSTVWXYZ]{26}$`)

type Genesis struct {
	Version      int    `json:"version"`
	PublicKeyPEM string `json:"publicKeyPem"`
	Nonce        string `json:"nonce"`
}
type BindingControl struct {
	DeviceID string `json:"deviceId"`
	KeyID    string `json:"keyId"`
	Epoch    int64  `json:"epoch"`
}
type BindingInput struct {
	SubjectID      string          `json:"subjectId"`
	GenesisProof   json.RawMessage `json:"genesisProof"`
	InstallationID string          `json:"installationId"`
	Scopes         []string        `json:"scopes"`
	Control        *BindingControl `json:"control,omitempty"`
}
type bindingChallengeData struct {
	BindingInput
	Purpose           string `json:"purpose"`
	Endpoint          string `json:"endpoint"`
	ClientSessionHash string `json:"clientSessionHash"`
	BindingExpiresAt  int64  `json:"bindingExpiresAt"`
}
type BindInput struct {
	Challenge     string `json:"challenge"`
	Signature     string `json:"signature"`
	ClientSession string `json:"clientSession"`
}
type BindingResult struct {
	BindingID string `json:"bindingId"`
	Receipt   string `json:"receipt"`
}
type BindingSigner interface {
	SignBinding(context.Context, string, any, string, int64, int64) (string, error)
	VerifyBinding(context.Context, string, int64) (json.RawMessage, string, error)
}

func (k *SessionKeyring) SignBinding(ctx context.Context, kind string, data any, id string, at, age int64) (string, error) {
	if kind != "binding-challenge" && kind != "binding-receipt" {
		return "", fault.New("signing_purpose_denied", 403)
	}
	return k.signEnvelope(kind, data, id, at, age)
}
func (k *SessionKeyring) VerifyBinding(ctx context.Context, token string, at int64) (json.RawMessage, string, error) {
	v, e := k.verifyEnvelope(token, "binding-challenge", 180, at)
	return v.Data, v.ID, e
}
func verifyGenesis(subject string, raw json.RawMessage) (Genesis, bool) {
	var g Genesis
	if !guidPattern.MatchString(subject) || !exactJSON(raw, "version", "publicKeyPem", "nonce") || protocol.Decode(raw, &g) != nil || g.Version != 1 || len(g.PublicKeyPEM) > 256 {
		return g, false
	}
	nonce, e := base64.RawURLEncoding.Strict().DecodeString(g.Nonce)
	if e != nil || len(nonce) < 16 || len(nonce) > 64 || base64.RawURLEncoding.EncodeToString(nonce) != g.Nonce {
		return g, false
	}
	key, e := parsePublic(g.PublicKeyPEM)
	if e != nil {
		return g, false
	}
	canonical, e := identity.PublicPEM(key)
	if e != nil || canonical != g.PublicKeyPEM {
		return g, false
	}
	const alphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"
	var stamp int64
	for _, c := range subject[6:16] {
		stamp = stamp*32 + int64(strings.IndexRune(alphabet, c))
	}
	h := sha256.New()
	_, _ = h.Write([]byte("galaxy/guid/v1\x00" + subject[5:6] + "\x00" + strconv.FormatInt(stamp, 10) + "\x00" + strings.TrimSpace(canonical) + "\x00"))
	_, _ = h.Write(nonce)
	n := new(big.Int).SetBytes(h.Sum(nil)[:10])
	encoded := make([]byte, 16)
	mask := big.NewInt(31)
	for i := 15; i >= 0; i-- {
		encoded[i] = alphabet[new(big.Int).And(n, mask).Int64()]
		n.Rsh(n, 5)
	}
	return g, subtle.ConstantTimeCompare([]byte(subject[16:]), encoded) == 1
}
func (s *Service) assertNotDeleted(ctx context.Context, db interface {
	QueryRow(context.Context, string, ...any) pgx.Row
}, subject string) error {
	var deleted bool
	e := db.QueryRow(ctx, "SELECT EXISTS(SELECT 1 FROM deletion_requests WHERE subject_id=$1 AND state IN ('partial','primary-erased'))", subject).Scan(&deleted)
	if e != nil {
		return e
	}
	if deleted {
		return fault.New("subject_deletion_recorded", 410)
	}
	return nil
}
func (s *Service) BindingChallenge(ctx context.Context, input BindingInput, v2 bool) (map[string]string, error) {
	if v2 && input.Control == nil || !v2 && input.Control != nil {
		return nil, fault.New("invalid_request", 400)
	}
	if input.Control != nil && (!uuidV4Pattern.MatchString(input.Control.DeviceID) || !hashPattern.MatchString(input.Control.KeyID) || input.Control.Epoch < 1 || input.Control.Epoch > 9007199254740991) {
		return nil, fault.New("invalid_request", 400)
	}
	allowed := s.AllowedScopes
	if allowed == nil {
		allowed = DefaultScopes
	}
	seen := map[string]bool{}
	valid := uuidV4Pattern.MatchString(input.InstallationID) && len(input.Scopes) > 0 && len(input.Scopes) <= len(allowed) && contains(input.Scopes, "binding")
	for _, v := range input.Scopes {
		if seen[v] || !contains(allowed, v) {
			valid = false
		}
		seen[v] = true
	}
	if _, ok := verifyGenesis(input.SubjectID, input.GenesisProof); !ok || !valid {
		return nil, fault.New("identity_or_scope_invalid", 400)
	}
	if e := s.assertNotDeleted(ctx, s.Pool, input.SubjectID); e != nil {
		return nil, e
	}
	if s.BindingGate != nil {
		if e := s.BindingGate(ctx, s.Pool, input.SubjectID); e != nil {
			return nil, e
		}
	}
	signer, ok := s.Signer.(BindingSigner)
	if !ok {
		return nil, fault.New("signing_unavailable", 503)
	}
	nonce := make([]byte, 32)
	if _, e := rand.Read(nonce); e != nil {
		return nil, e
	}
	clientSession := base64.RawURLEncoding.EncodeToString(nonce)
	at := s.now()
	id := uuid.NewString()
	data := bindingChallengeData{input, "bind", s.Endpoint, identity.Digest([]byte(clientSession)), at + 86400}
	token, e := signer.SignBinding(ctx, "binding-challenge", data, id, at, 180)
	if e != nil {
		return nil, e
	}
	payload, e := protocol.Encode(data)
	if e != nil {
		return nil, e
	}
	_, e = s.Pool.Exec(ctx, "INSERT INTO binding_challenges(id,subject_id,payload,token_hash,expires_at) VALUES($1,$2,$3,$4,$5)", id, input.SubjectID, payload, identity.Digest([]byte(token)), time.Unix(at+180, 0))
	if e != nil {
		return nil, e
	}
	return map[string]string{"challengeId": id, "challenge": token, "clientSession": clientSession}, nil
}
func (s *Service) Bind(ctx context.Context, input BindInput, httpID *string) (BindingResult, error) {
	if len(input.Challenge) > 16384 || len(input.Signature) > 24000 || !regexp.MustCompile(`^[A-Za-z0-9_-]{43}$`).MatchString(input.ClientSession) {
		return BindingResult{}, fault.New("invalid_request", 400)
	}
	signer, ok := s.Signer.(BindingSigner)
	if !ok {
		return BindingResult{}, denied()
	}
	raw, id, e := signer.VerifyBinding(ctx, input.Challenge, s.now())
	if e != nil {
		return BindingResult{}, fault.New("binding_proof_invalid", 401)
	}
	var data bindingChallengeData
	keys := []string{"subjectId", "genesisProof", "installationId", "scopes", "purpose", "endpoint", "clientSessionHash", "bindingExpiresAt"}
	var m map[string]json.RawMessage
	_ = json.Unmarshal(raw, &m)
	if m["control"] != nil {
		keys = append(keys, "control")
	}
	g, valid := Genesis{}, false
	if protocol.Decode(raw, &data) == nil {
		g, valid = verifyGenesis(data.SubjectID, data.GenesisProof)
	}
	if !exactJSON(raw, keys...) || !uuidV4Pattern.MatchString(id) || data.Purpose != "bind" || data.Endpoint != s.Endpoint || data.ClientSessionHash != identity.Digest([]byte(input.ClientSession)) || !valid {
		return BindingResult{}, fault.New("binding_proof_invalid", 401)
	}
	requestHash := identity.Digest([]byte(input.Challenge))
	return postgres.InTx(ctx, s.Pool, func(tx pgx.Tx) (BindingResult, error) {
		if e := s.assertNotDeleted(ctx, tx, data.SubjectID); e != nil {
			return BindingResult{}, e
		}
		if s.BindingGate != nil {
			if e := s.BindingGate(ctx, tx, data.SubjectID); e != nil {
				return BindingResult{}, e
			}
		}
		if _, e := tx.Exec(ctx, "INSERT INTO subjects(id,public_key,genesis_proof) VALUES($1,$2,$3) ON CONFLICT(id) DO NOTHING", data.SubjectID, g.PublicKeyPEM, data.GenesisProof); e != nil {
			return BindingResult{}, e
		}
		var public string
		e := tx.QueryRow(ctx, "SELECT public_key FROM public.galaxy_api_lock_subject_control($1,true)", data.SubjectID).Scan(&public)
		if e != nil {
			return BindingResult{}, e
		}
		if public != g.PublicKeyPEM {
			return BindingResult{}, fault.New("identity_conflict", 409)
		}
		selected := binding{Subject: data.SubjectID}
		if data.Control != nil {
			selected.DeviceID = &data.Control.DeviceID
			selected.KeyID = &data.Control.KeyID
			selected.Epoch = &data.Control.Epoch
		}
		control, e := currentControl(ctx, tx, selected)
		if e != nil {
			return BindingResult{}, e
		}
		if !contains(control.Scopes, "*") && !contains(control.Scopes, "binding") {
			return BindingResult{}, fault.New("identity_control_stale", 401)
		}
		for _, scope := range data.Scopes {
			if !contains(control.Scopes, "*") && !contains(control.Scopes, scope) {
				return BindingResult{}, fault.New("identity_scope_invalid", 403)
			}
		}
		if e = verifyTypedResponse(input.Signature, input.Challenge, control.PublicKey, "galaxy-binding-response+jws"); e != nil {
			return BindingResult{}, fault.New("binding_proof_invalid", 401)
		}
		var hash string
		var expiry time.Time
		var consumed *time.Time
		e = tx.QueryRow(ctx, "SELECT token_hash,expires_at,consumed_at FROM binding_challenges WHERE id=$1 FOR UPDATE", id).Scan(&hash, &expiry, &consumed)
		if errors.Is(e, pgx.ErrNoRows) || e == nil && (hash != requestHash || expiry.Unix() <= s.now()) {
			return BindingResult{}, fault.New("challenge_expired_or_unknown", 401)
		}
		if e != nil {
			return BindingResult{}, e
		}
		if consumed != nil {
			var previous BindingResult
			var previousHash string
			var revoked *time.Time
			e = tx.QueryRow(ctx, "SELECT id::text,receipt,request_hash,revoked_at FROM bindings WHERE challenge_id=$1", id).Scan(&previous.BindingID, &previous.Receipt, &previousHash, &revoked)
			if errors.Is(e, pgx.ErrNoRows) || e == nil && (previousHash != requestHash || revoked != nil) {
				return BindingResult{}, fault.New("challenge_consumed", 409)
			}
			return previous, e
		}
		bindingID := uuid.NewString()
		receiptData := struct {
			BindingID      string          `json:"bindingId"`
			SubjectID      string          `json:"subjectId"`
			Fingerprint    string          `json:"publicKeyFingerprint"`
			InstallationID string          `json:"installationId"`
			Endpoint       string          `json:"endpoint"`
			Scopes         []string        `json:"scopes"`
			Expires        int64           `json:"expiresAt"`
			RevokePath     string          `json:"revokePath"`
			AuditReference string          `json:"auditReference"`
			Control        *BindingControl `json:"control,omitempty"`
		}{bindingID, data.SubjectID, identity.Digest([]byte(g.PublicKeyPEM)), data.InstallationID, s.Endpoint, data.Scopes, data.BindingExpiresAt, "/v1/bindings/" + bindingID + "/revoke", id, nil}
		if data.Control != nil {
			receiptData.Control = &BindingControl{*control.DeviceID, control.KeyID, control.Epoch}
		}
		receipt, e := signer.SignBinding(ctx, "binding-receipt", receiptData, bindingID, s.now(), data.BindingExpiresAt-s.now())
		if e != nil {
			return BindingResult{}, e
		}
		var keyID, epoch any
		if control.Epoch != 0 {
			keyID = control.KeyID
			epoch = control.Epoch
		}
		if _, e = tx.Exec(ctx, `INSERT INTO bindings(id,subject_id,challenge_id,request_hash,audience,scopes,receipt,expires_at,device_id,key_id,control_epoch) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`, bindingID, data.SubjectID, id, requestHash, s.Endpoint, data.Scopes, receipt, time.Unix(data.BindingExpiresAt, 0), control.DeviceID, keyID, epoch); e != nil {
			return BindingResult{}, e
		}
		if _, e = tx.Exec(ctx, "UPDATE binding_challenges SET consumed_at=$2 WHERE id=$1", id, time.Unix(s.now(), 0)); e != nil {
			return BindingResult{}, e
		}
		result, e := tx.Exec(ctx, `INSERT INTO audit_events(actor,action,object_id,request_id,outcome,context_version,client_id,audience,scope,consent_id,binding_id,http_request_id,idempotency_key,binding_scopes,credential_scopes,caller_binding_id,caller_client_id,caller_audience,caller_binding_scopes) SELECT $1,'binding.create',b.id::text,$3,'accepted',1,ch.payload->>'installationId',b.audience,'binding',NULL,b.id,$4,$3,b.scopes,NULL,b.id,ch.payload->>'installationId',b.audience,b.scopes FROM bindings b JOIN binding_challenges ch ON ch.id=b.challenge_id WHERE b.id=$2 AND b.subject_id=$1`, data.SubjectID, bindingID, id, httpID)
		if e != nil {
			return BindingResult{}, e
		}
		if result.RowsAffected() != 1 {
			return BindingResult{}, errors.New("audit_context_unavailable")
		}
		return BindingResult{bindingID, receipt}, nil
	})
}
