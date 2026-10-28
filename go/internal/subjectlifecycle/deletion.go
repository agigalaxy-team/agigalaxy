package subjectlifecycle

import (
	"context"
	"crypto/ed25519"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"errors"
	"net/url"
	"regexp"
	"strings"
	"unicode/utf8"

	"github.com/agigalaxy-team/agigalaxy/go/internal/deviceauth"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/identity"
	"github.com/agigalaxy-team/agigalaxy/go/internal/postgres"
	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
	"github.com/jackc/pgx/v5"
)

type deletionIntent struct {
	Version              int     `json:"version"`
	ID                   string  `json:"id"`
	Endpoint             string  `json:"endpoint"`
	SubjectID            string  `json:"subjectId"`
	BindingID            string  `json:"bindingId,omitempty"`
	IssuedAt             int64   `json:"issuedAt"`
	ExpiresAt            int64   `json:"expiresAt"`
	Action               string  `json:"action"`
	Scope                string  `json:"scope,omitempty"`
	Reason               string  `json:"reason,omitempty"`
	Takeout              string  `json:"takeout,omitempty"`
	ExportManifestSHA256 *string `json:"exportManifestSha256,omitempty"`
	RequestID            string  `json:"requestId,omitempty"`
	ExpectedRevision     int64   `json:"expectedRevision,omitempty"`
}

var subjectID = regexp.MustCompile(`^GUID[0-9A-Z]{28}$`)
var hashPattern = regexp.MustCompile(`^[a-f0-9]{64}$`)

func invalidDeletion() error { return fault.New("invalid_deletion_request", 400) }
func openSigned(signed, publicKey, kind string) ([]byte, error) {
	parts := strings.Split(signed, ".")
	if len(parts) != 3 {
		return nil, errors.New("invalid signature")
	}
	header, e := base64.RawURLEncoding.Strict().DecodeString(parts[0])
	if e != nil {
		return nil, e
	}
	var h map[string]string
	if json.Unmarshal(header, &h) != nil || len(h) != 2 || h["alg"] != "Ed25519" || h["typ"] != kind {
		return nil, errors.New("invalid signature")
	}
	payload, e := base64.RawURLEncoding.Strict().DecodeString(parts[1])
	if e != nil || !utf8.Valid(payload) {
		return nil, errors.New("invalid payload")
	}
	signature, e := base64.RawURLEncoding.Strict().DecodeString(parts[2])
	if e != nil {
		return nil, e
	}
	block, rest := pem.Decode([]byte(publicKey))
	if block == nil || block.Type != "PUBLIC KEY" || len(rest) != 0 {
		return nil, errors.New("invalid public key")
	}
	parsed, e := x509.ParsePKIXPublicKey(block.Bytes)
	if e != nil {
		return nil, e
	}
	key, ok := parsed.(ed25519.PublicKey)
	if !ok || !ed25519.Verify(key, []byte(parts[0]+"."+parts[1]), signature) {
		return nil, errors.New("invalid signature")
	}
	return payload, nil
}
func parseIntent(payload []byte, status bool) (deletionIntent, error) {
	var v deletionIntent
	var fields map[string]json.RawMessage
	if protocol.Decode(payload, &v) != nil || json.Unmarshal(payload, &fields) != nil || fields == nil {
		return v, invalidDeletion()
	}
	allowed := []string{"version", "id", "endpoint", "subjectId", "issuedAt", "expiresAt", "action"}
	required := append([]string{}, allowed...)
	if status {
		allowed = append(allowed, "requestId")
		required = append(required, "requestId")
		if v.Action != "status" || !validID(v.RequestID) {
			return v, invalidDeletion()
		}
	} else {
		allowed = append(allowed, "bindingId")
		required = append(required, "bindingId")
		if !validID(v.BindingID) {
			return v, invalidDeletion()
		}
		if v.Action == "request" {
			allowed = append(allowed, "scope", "reason", "takeout", "exportManifestSha256")
			required = append(required, "scope", "reason", "takeout")
			if v.Scope != "all-owned-service-data" || v.Reason != "account-exit" && v.Reason != "privacy" && v.Reason != "other" || v.Takeout != "already-exported" && v.Takeout != "not-needed" || v.ExportManifestSHA256 != nil && (!hashPattern.MatchString(*v.ExportManifestSHA256) || v.Takeout != "already-exported") {
				return v, invalidDeletion()
			}
		} else if v.Action == "cancel" {
			allowed = append(allowed, "requestId", "expectedRevision")
			required = append(required, "requestId", "expectedRevision")
			if !validID(v.RequestID) || v.ExpectedRevision < 1 {
				return v, invalidDeletion()
			}
		} else {
			return v, invalidDeletion()
		}
	}
	for k, raw := range fields {
		if !contains(allowed, k) || string(raw) == "null" {
			return v, invalidDeletion()
		}
	}
	for _, k := range required {
		if _, ok := fields[k]; !ok {
			return v, invalidDeletion()
		}
	}
	u, e := url.Parse(v.Endpoint)
	if e != nil || u.Scheme == "" || u.Host == "" || v.Version != 1 || !validID(v.ID) || !subjectID.MatchString(v.SubjectID) || v.IssuedAt < 0 || v.ExpiresAt <= v.IssuedAt || v.ExpiresAt-v.IssuedAt > 300 {
		return v, invalidDeletion()
	}
	return v, nil
}
func contains(values []string, value string) bool {
	for _, v := range values {
		if v == value {
			return true
		}
	}
	return false
}
func deletionReceipt(row Object, endpoint string) Object {
	var execution any = row["execution_result"]
	physical := false
	if x, ok := execution.(map[string]any); ok {
		physical, _ = x["physicalDeletionPerformed"].(bool)
	}
	return Object{"version": 1, "endpoint": endpoint, "id": row["id"], "subjectId": row["subject_id"], "revision": integer(row["revision"]), "state": row["state"], "requestHash": row["payload_hash"], "scope": "all-owned-service-data", "receivedAt": row["created_at"], "updatedAt": row["updated_at"], "minimizedAt": row["minimized_at"], "physicalDeletionPerformed": physical, "execution": execution, "statusSource": "request-review-and-execution-ledger", "executionImplemented": true, "serviceWideDeletionComplete": false}
}
func (s *Service) DeletionConfig(ctx context.Context, a Actor) (any, error) {
	return s.run(ctx, a, "data-delete", false, func(pgx.Tx, deviceauth.ControlAuthorization) (any, error) {
		return Object{"version": 1, "endpoint": s.Endpoint, "subjectId": a.SubjectID, "scope": "all-owned-service-data", "intentLifetimeSeconds": 300, "physicalDeletionOnSubmission": false, "oneActiveRequestPerSubject": true, "executionImplemented": true}, nil
	})
}
func (s *Service) SubmitDeletion(ctx context.Context, a Actor, signed string) (any, error) {
	if protocol.TextLength(signed) > 16384 {
		return nil, invalidDeletion()
	}
	return s.run(ctx, a, "data-delete", false, func(tx pgx.Tx, auth deviceauth.ControlAuthorization) (any, error) {
		payload, e := openSigned(signed, auth.PublicKey, "galaxy-deletion-intent+jws")
		if e != nil {
			return nil, fault.New("invalid_deletion_signature", 403)
		}
		intent, e := parseIntent(payload, false)
		if e != nil {
			return nil, fault.New("invalid_deletion_signature", 403)
		}
		if intent.SubjectID != a.SubjectID || intent.BindingID != a.BindingID || intent.Endpoint != s.Endpoint || intent.IssuedAt > s.now() || intent.ExpiresAt <= s.now() {
			return nil, fault.New("deletion_intent_expired_or_mismatched", 403)
		}
		if _, e = tx.Exec(ctx, "SELECT pg_advisory_xact_lock(hashtext($1))", "deletion:"+a.SubjectID); e != nil {
			return nil, e
		}
		prior, e := one(ctx, tx, "SELECT request_id,payload_hash,actor_ref FROM deletion_events WHERE id=$1", intent.ID)
		if e == nil {
			if text(prior["actor_ref"]) != a.SubjectID || text(prior["payload_hash"]) != identity.Digest(payload) {
				return nil, fault.New("deletion_conflict", 409)
			}
			row, e := s.ownedDeletion(ctx, tx, a, text(prior["request_id"]), false)
			if e != nil {
				return nil, e
			}
			return deletionReceipt(row, s.Endpoint), nil
		}
		if !errors.Is(e, pgx.ErrNoRows) {
			return nil, e
		}
		var row Object
		if intent.Action == "request" {
			var exists bool
			if e = tx.QueryRow(ctx, "SELECT EXISTS(SELECT 1 FROM deletion_requests WHERE subject_id=$1 AND state IN ('requested','review-needed','approved','partial','primary-erased'))", a.SubjectID).Scan(&exists); e != nil {
				return nil, e
			}
			if exists {
				return nil, fault.New("active_deletion_request_exists", 409)
			}
			row, e = one(ctx, tx, `INSERT INTO deletion_requests(id,subject_id,binding_id,requester_public_key,payload_text,payload_hash,signature,state,revision) VALUES($1,$2,$3,$4,$5,$6,$7,'requested',1) RETURNING *`, intent.ID, a.SubjectID, a.BindingID, auth.PublicKey, string(payload), identity.Digest(payload), signed)
		} else {
			row, e = s.ownedDeletion(ctx, tx, a, intent.RequestID, true)
			if e != nil {
				return nil, e
			}
			if integer(row["revision"]) != intent.ExpectedRevision || !contains([]string{"requested", "review-needed", "approved"}, text(row["state"])) {
				return nil, fault.New("deletion_request_changed", 409)
			}
			row, e = one(ctx, tx, "UPDATE deletion_requests SET state='cancelled',revision=revision+1,updated_at=now() WHERE id=$1 RETURNING *", row["id"])
		}
		if e != nil {
			return nil, e
		}
		chain, e := captureChain(ctx, tx, a.SubjectID)
		if e != nil {
			return nil, e
		}
		if _, e = tx.Exec(ctx, `INSERT INTO deletion_events(id,request_id,revision,actor_kind,actor_ref,kind,payload_text,payload_hash,signature,signer_public_key,signer_control_chain) VALUES($1,$2,$3,'subject',$4,$5,$6,$7,$8,$9,$10::jsonb)`, intent.ID, row["id"], integer(row["revision"]), a.SubjectID, intent.Action, string(payload), identity.Digest(payload), signed, auth.PublicKey, chain); e != nil {
			return nil, e
		}
		if e = audit(ctx, tx, a, auth, "data.deletion."+intent.Action, intent.ID, "data-delete"); e != nil {
			return nil, e
		}
		return deletionReceipt(row, s.Endpoint), nil
	})
}
func captureChain(ctx context.Context, tx pgx.Tx, subject string) ([]byte, error) {
	var genesis any
	if e := tx.QueryRow(ctx, "SELECT genesis_proof FROM public.galaxy_api_lock_subject_control($1,false)", subject).Scan(&genesis); e != nil {
		return nil, e
	}
	events, e := rows(ctx, tx, "SELECT * FROM subject_control_events WHERE subject_id=$1 ORDER BY sequence", subject)
	if e != nil {
		return nil, e
	}
	if len(events) == 0 {
		return nil, nil
	}
	return encoded(Object{"subjectId": subject, "genesisProof": genesis, "events": events})
}
func (s *Service) ownedDeletion(ctx context.Context, tx pgx.Tx, a Actor, id string, lock bool) (Object, error) {
	sql := "SELECT * FROM deletion_requests WHERE id=$1 AND subject_id=$2"
	if lock {
		sql += " FOR UPDATE"
	}
	row, e := one(ctx, tx, sql, id, a.SubjectID)
	return row, notfound(e)
}
func (s *Service) ReadDeletion(ctx context.Context, a Actor, id string, after int64) (any, error) {
	if !validID(id) || after < 0 {
		return nil, invalidDeletion()
	}
	return s.run(ctx, a, "data-delete", false, func(tx pgx.Tx, _ deviceauth.ControlAuthorization) (any, error) {
		row, e := s.ownedDeletion(ctx, tx, a, id, true)
		if e != nil {
			return nil, e
		}
		if after > integer(row["revision"]) {
			return nil, fault.New("invalid_deletion_cursor", 400)
		}
		events, e := rows(ctx, tx, `SELECT id,revision,actor_kind,actor_ref,kind,payload_text,payload_hash,signature,created_at,payload_minimized,retained_payload,retained_hash,signer_public_key,signer_control_chain FROM deletion_events WHERE request_id=$1 AND revision>$2 ORDER BY revision LIMIT 21`, id, after)
		if e != nil {
			return nil, e
		}
		result := deletionReceipt(row, s.Endpoint)
		result["request"] = Object{"payloadJson": row["payload_text"], "signature": row["signature"], "publicKeyPem": row["requester_public_key"]}
		result["events"] = events[:min(20, len(events))]
		result["nextAfterRevision"] = nil
		if len(events) > 20 {
			result["nextAfterRevision"] = integer(events[19]["revision"])
		}
		return result, nil
	})
}
func (s *Service) QueryDeletions(ctx context.Context, a Actor, after string, limit int) (any, error) {
	if limit == 0 {
		limit = 10
	}
	if after != "" && !validID(after) || limit < 1 || limit > 20 {
		return nil, invalidDeletion()
	}
	return s.run(ctx, a, "data-delete", false, func(tx pgx.Tx, _ deviceauth.ControlAuthorization) (any, error) {
		var cursor *string
		if after != "" {
			cursor = &after
		}
		rows, e := rows(ctx, tx, "SELECT * FROM deletion_requests WHERE subject_id=$1 AND ($2::uuid IS NULL OR id>$2) ORDER BY id LIMIT $3", a.SubjectID, cursor, limit+1)
		if e != nil {
			return nil, e
		}
		items := []Object{}
		for _, row := range rows[:min(limit, len(rows))] {
			items = append(items, deletionReceipt(row, s.Endpoint))
		}
		var next any
		if len(rows) > limit {
			next = items[len(items)-1]["id"]
		}
		return Object{"version": 1, "endpoint": s.Endpoint, "subjectId": a.SubjectID, "items": items, "nextAfter": next}, nil
	})
}
func (s *Service) DeletionStatus(ctx context.Context, signed string) (any, error) {
	if protocol.TextLength(signed) > 12000 {
		return nil, fault.New("invalid_deletion_status", 400)
	}
	deny := func() (any, error) { return nil, fault.New("deletion_status_unavailable", 403) }
	parts := strings.Split(signed, ".")
	if len(parts) != 3 {
		return deny()
	}
	payload, e := base64.RawURLEncoding.Strict().DecodeString(parts[1])
	if e != nil {
		return deny()
	}
	intent, e := parseIntent(payload, true)
	if e != nil {
		return deny()
	}
	if s == nil || s.Pool == nil {
		return nil, fault.New("subject_lifecycle_unavailable", 503)
	}
	return postgres.InTx(ctx, s.Pool, func(tx pgx.Tx) (any, error) {
		row, e := one(ctx, tx, "SELECT * FROM deletion_requests WHERE id=$1 AND subject_id=$2", intent.RequestID, intent.SubjectID)
		if errors.Is(e, pgx.ErrNoRows) {
			return deny()
		}
		if e != nil {
			return nil, e
		}
		verified, e := openSigned(signed, text(row["requester_public_key"]), "galaxy-deletion-status+jws")
		if e != nil || string(verified) != string(payload) || intent.Endpoint != s.Endpoint || intent.IssuedAt > s.now() || intent.ExpiresAt <= s.now() {
			return deny()
		}
		result := deletionReceipt(row, s.Endpoint)
		result["statusIntentId"] = intent.ID
		result["checkedAt"] = s.now()
		result["holderProofVerified"] = true
		return result, nil
	})
}

// Execute is deliberately unavailable until the complete original maintenance
// inventory, approval, retention and delegated-store consumers are connected.
// Request acceptance or a successful partial consumer is never completion.
func (s *Service) Execute(context.Context, any) (any, error) {
	return nil, fault.New("deletion_execution_unavailable", 503)
}
