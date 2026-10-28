package deviceauth

import (
	"context"
	"encoding/json"
	"errors"
	"net/url"
	"regexp"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/identity"
	"github.com/agigalaxy-team/agigalaxy/go/internal/postgres"
	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
	"github.com/jackc/pgx/v5"
)

type ConsentOptions struct {
	Forum, TaskMaterial bool
	HTTPRequestID       *string
}
type ConsentAuthorization struct {
	CallerBindingID                 string
	CredentialScopes, BindingScopes []string
	DeviceID                        *string
	KeyID                           string
	Epoch                           int64
	ChainHead                       *string
}
type ConsentCapture struct {
	ConsentID     string               `json:"consentId"`
	Status        string               `json:"status"`
	Intent        ConsentIntent        `json:"intent"`
	Authorization ConsentAuthorization `json:"-"`
}
type ConsentVisibility struct {
	DeletionPending bool `json:"deletionPending"`
}
type ConsentIntent struct {
	Version           int                `json:"version"`
	ID                string             `json:"id"`
	SubjectID         string             `json:"subjectId"`
	BindingID         string             `json:"bindingId"`
	Endpoint          string             `json:"endpoint"`
	ObjectID          string             `json:"objectId"`
	Action            string             `json:"action"`
	Purpose           string             `json:"purpose"`
	Recipient         string             `json:"recipient"`
	Fields            []string           `json:"fields"`
	Visibility        string             `json:"visibility"`
	Viewers           []string           `json:"viewers"`
	PayloadHash       string             `json:"payloadHash"`
	PolicyVersion     string             `json:"policyVersion"`
	IssuedAt          int64              `json:"issuedAt"`
	ExpiresAt         int64              `json:"expiresAt"`
	CurrentVisibility *ConsentVisibility `json:"currentVisibility,omitempty"`
}
type ConsentRequirement struct{ ID, SubjectID, Action, ObjectID, Recipient, PayloadJSON string }

var consentSubject = regexp.MustCompile(`^GUID[0-9A-Z]{28}$`)
var consentUUID = regexp.MustCompile(`(?i)^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`)
var consentField = regexp.MustCompile(`^[a-zA-Z][a-zA-Z0-9]{0,63}$`)
var consentActions = []string{"hub.publish", "qualification.request", "configuration.publish", "ci.observe", "proof.publish", "case.teaser.publish", "history.query", "profile.publish", "project.write", "contact.write", "recruitment.write", "contribution.publish", "experience.submit", "qualification.compute", "qualification.source-permission", "context.grant", "evidence.submit", "outcome.material", "assistance.publish", "task.owner-read", "comment.publish", "moderation.publish", "capsule.publish", "capsule.use", "capsule.permission", "builder.publish", "forum.post.publish", "forum.reply.publish", "forum.withdraw", "forum.report.publish", "forum.report.event", "forum.governance.resolve", "forum.section.write", "forum.section.classify"}

func consentError() error { return fault.New("invalid_consent", 400) }
func parseConsent(raw []byte) (ConsentIntent, error) {
	var v ConsentIntent
	if !exactJSON(raw, "version", "id", "subjectId", "bindingId", "endpoint", "objectId", "action", "purpose", "recipient", "fields", "visibility", "viewers", "payloadHash", "policyVersion", "issuedAt", "expiresAt") || protocol.Decode(raw, &v) != nil {
		return v, consentError()
	}
	u, e := url.Parse(v.Endpoint)
	if e != nil || u.Scheme == "" || v.Version != 1 || !consentUUID.MatchString(v.ID) || !consentSubject.MatchString(v.SubjectID) || !consentUUID.MatchString(v.BindingID) || utf8.RuneCountInString(v.ObjectID) < 1 || utf8.RuneCountInString(v.ObjectID) > 128 || !contains(consentActions, v.Action) || !contains([]string{"operational", "public-profile", "federated-proof"}, v.Purpose) || utf8.RuneCountInString(v.Recipient) < 1 || utf8.RuneCountInString(v.Recipient) > 240 || len(v.Fields) < 1 || len(v.Fields) > 32 || !contains([]string{"Local", "Private", "Hub-scoped", "Proof-only", "Public"}, v.Visibility) || v.Viewers == nil || len(v.Viewers) > 16 || !hashPattern.MatchString(v.PayloadHash) || v.PolicyVersion != "0.1" || v.IssuedAt < 0 || v.IssuedAt > 9007199254740991 || v.ExpiresAt <= 0 || v.ExpiresAt > 9007199254740991 {
		return v, consentError()
	}
	for _, f := range v.Fields {
		if !consentField.MatchString(f) {
			return v, consentError()
		}
	}
	for _, viewer := range v.Viewers {
		if !consentSubject.MatchString(viewer) {
			return v, consentError()
		}
	}
	return v, nil
}
func unique(values []string) bool {
	seen := map[string]bool{}
	for _, v := range values {
		if seen[v] {
			return false
		}
		seen[v] = true
	}
	return true
}
func (s *Service) consentPolicy(v ConsentIntent, a Actor) error {
	forbidden := []string{"privateKey", "privateKeyPem", "token", "password", "credentials", "rawContext", "cookie", "authorization"}
	bad := false
	for _, field := range v.Fields {
		if contains(forbidden, field) {
			bad = true
		}
	}
	if v.SubjectID != a.SubjectID || v.BindingID != a.BindingID || v.Endpoint != s.Endpoint || v.IssuedAt > s.now() || v.IssuedAt < s.now()-300 || v.ExpiresAt <= s.now() || v.ExpiresAt-v.IssuedAt > 2592000 || v.Visibility == "Local" || bad || !unique(v.Fields) || !unique(v.Viewers) || v.Visibility == "Hub-scoped" && (!strings.HasPrefix(v.Recipient, "https://") || len(v.Viewers) == 0) || v.Visibility == "Public" && v.Purpose != "public-profile" {
		return fault.New("consent_policy_denied", 403)
	}
	return nil
}
func (s *Service) consentAuthorization(ctx context.Context, tx pgx.Tx, a Actor) (control, ConsentAuthorization, error) {
	b, e := s.authorizationWithin(ctx, tx, a)
	if e != nil {
		return control{}, ConsentAuthorization{}, e
	}
	c := b.Control
	return c, ConsentAuthorization{a.BindingID, append([]string(nil), b.Scopes...), append([]string(nil), b.BindingScopes...), c.DeviceID, c.KeyID, c.Epoch, c.ChainHead}, nil
}

// CaptureConsentWithin runs in the caller's business transaction. A failed
// publication therefore rolls back both the grant and its original audit.
func (s *Service) CaptureConsentWithin(ctx context.Context, tx pgx.Tx, a Actor, signedIntent string, o ConsentOptions) (ConsentCapture, error) {
	var out ConsentCapture
	if protocol.TextLength(signedIntent) > 16384 {
		return out, consentError()
	}
	control, authorization, e := s.consentAuthorization(ctx, tx, a)
	if e != nil {
		return out, e
	}
	if !contains(authorization.CredentialScopes, "consent") || !contains(control.Scopes, "*") && !contains(control.Scopes, "consent") {
		if o.Forum || o.TaskMaterial {
			return out, fault.New("consent_scope_required", 403)
		}
		return out, denied()
	}
	_, payload, _, _, e := splitCompact(signedIntent)
	if e != nil || verifyTypedResponse(signedIntent, string(payload), control.PublicKey, "galaxy-consent+jws") != nil {
		return out, consentError()
	}
	intent, e := parseConsent(payload)
	if e != nil {
		return out, e
	}
	if strings.HasPrefix(intent.Action, "forum.") && !o.Forum {
		return out, fault.New("forum_atomic_write_required", 403)
	}
	if o.Forum && !strings.HasPrefix(intent.Action, "forum.") {
		return out, fault.New("forum_permission_mismatch", 403)
	}
	material := intent.Action == "assistance.publish" && contains(intent.Fields, "materials")
	if material && !o.TaskMaterial {
		return out, fault.New("task_material_atomic_write_required", 403)
	}
	if o.TaskMaterial && !material {
		return out, fault.New("task_material_reuse_consent_required", 403)
	}
	if e = s.consentPolicy(intent, a); e != nil {
		return out, e
	}
	if s.ConsentPolicy != nil {
		if e = s.ConsentPolicy(ctx, intent, a); e != nil {
			return out, e
		}
	}
	raw, e := protocol.Encode(intent)
	if e != nil {
		return out, e
	}
	hash := identity.Digest([]byte(signedIntent))
	_, e = tx.Exec(ctx, `INSERT INTO consents(id,subject_id,binding_id,intent,signature_hash,expires_at,signature_envelope,signed_payload_text,signer_key_id,control_epoch,control_event_hash) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT(id) DO NOTHING`, intent.ID, a.SubjectID, a.BindingID, raw, hash, time.Unix(intent.ExpiresAt, 0), signedIntent, string(payload), control.KeyID, control.Epoch, control.ChainHead)
	if e != nil {
		return out, e
	}
	var subject, priorHash string
	var revoked *time.Time
	e = tx.QueryRow(ctx, "SELECT subject_id,signature_hash,revoked_at FROM consents WHERE id=$1 FOR UPDATE", intent.ID).Scan(&subject, &priorHash, &revoked)
	if e != nil {
		return out, e
	}
	if subject != a.SubjectID || priorHash != hash || revoked != nil {
		return out, fault.New("consent_conflict", 409)
	}
	if e = s.auditConsent(ctx, tx, a, intent.ID, "consent.create", o.HTTPRequestID, authorization); e != nil {
		return out, e
	}
	return ConsentCapture{intent.ID, "active", intent, authorization}, nil
}
func (s *Service) auditConsent(ctx context.Context, tx pgx.Tx, a Actor, id, action string, httpID *string, authorization ConsentAuthorization) error {
	result, e := tx.Exec(ctx, `INSERT INTO audit_events(actor,action,object_id,request_id,outcome,context_version,client_id,audience,scope,consent_id,binding_id,http_request_id,idempotency_key,binding_scopes,credential_scopes,caller_binding_id,caller_client_id,caller_audience,caller_binding_scopes)
 SELECT $1,$3,$2::text,$2::text,'accepted',1,ch.payload->>'installationId',b.audience,'consent',c.id,b.id,$4,$2::text,b.scopes,$5::jsonb,cb.id,cch.payload->>'installationId',cb.audience,cb.scopes
 FROM consents c JOIN bindings b ON b.id=c.binding_id JOIN binding_challenges ch ON ch.id=b.challenge_id JOIN bindings cb ON cb.id=$6::uuid AND cb.subject_id=$1 JOIN binding_challenges cch ON cch.id=cb.challenge_id WHERE c.id=$2::text::uuid AND c.subject_id=$1 AND b.subject_id=$1 AND NOT EXISTS(SELECT 1 FROM audit_events WHERE actor=$1 AND action=$3 AND object_id=$2::text)`, a.SubjectID, id, action, httpID, authorization.CredentialScopes, authorization.CallerBindingID)
	if e != nil {
		return e
	}
	if result.RowsAffected() == 1 {
		return nil
	}
	var count int
	e = tx.QueryRow(ctx, "SELECT count(*) FROM audit_events WHERE actor=$1 AND action=$2 AND object_id=$3", a.SubjectID, action, id).Scan(&count)
	if e != nil {
		return e
	}
	if count != 1 {
		return errors.New("audit_context_unavailable")
	}
	return nil
}
func (s *Service) RequireConsentWithin(ctx context.Context, tx pgx.Tx, r ConsentRequirement) (ConsentIntent, error) {
	return s.requireConsentRead(ctx, tx, r, `SELECT c.intent FROM consents c JOIN bindings b ON b.id=c.binding_id WHERE c.id=$1 AND c.subject_id=$2 AND c.revoked_at IS NULL AND b.revoked_at IS NULL AND c.expires_at>$3 AND b.expires_at>$3 FOR SHARE OF c,b`)
}
func (s *Service) requireConsentRead(ctx context.Context, tx pgx.Tx, r ConsentRequirement, query string) (ConsentIntent, error) {
	var intent ConsentIntent
	var raw []byte
	e := tx.QueryRow(ctx, query, r.ID, r.SubjectID, time.Unix(s.now(), 0)).Scan(&raw)
	if errors.Is(e, pgx.ErrNoRows) {
		return intent, fault.New("consent_required", 403)
	}
	if e != nil {
		return intent, e
	}
	if json.Unmarshal(raw, &intent) != nil {
		return intent, fault.New("consent_required", 403)
	}
	if intent.Action != r.Action || intent.ObjectID != r.ObjectID || intent.Recipient != r.Recipient || identity.Digest([]byte(r.PayloadJSON)) != intent.PayloadHash {
		return intent, fault.New("consent_required", 403)
	}
	var payload map[string]json.RawMessage
	if json.Unmarshal([]byte(r.PayloadJSON), &payload) != nil {
		return intent, fault.New("invalid_payload", 400)
	}
	if payload == nil {
		return intent, fault.New("disclosure_mismatch", 403)
	}
	for field := range payload {
		if !contains(intent.Fields, field) {
			return intent, fault.New("disclosure_mismatch", 403)
		}
	}
	var pending bool
	e = tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM deletion_requests WHERE subject_id=$1 AND state IN ('requested','review-needed','approved','partial','primary-erased'))`, r.SubjectID).Scan(&pending)
	if e != nil {
		return intent, e
	}
	if pending {
		intent.CurrentVisibility = &ConsentVisibility{true}
	}
	return intent, nil
}
func (s *Service) CaptureConsent(ctx context.Context, a Actor, signed string) (ConsentCapture, error) {
	return postgres.InTx(ctx, s.Pool, func(tx pgx.Tx) (ConsentCapture, error) {
		return s.CaptureConsentWithin(ctx, tx, a, signed, ConsentOptions{})
	})
}
func (s *Service) RevokeConsent(ctx context.Context, a Actor, id string, httpID *string) (map[string]string, error) {
	if !consentUUID.MatchString(id) {
		return nil, fault.New("not_found", 404)
	}
	return postgres.InTx(ctx, s.Pool, func(tx pgx.Tx) (map[string]string, error) {
		_, auth, e := s.consentAuthorization(ctx, tx, a)
		if e != nil {
			return nil, e
		}
		if !contains(auth.CredentialScopes, "consent") {
			return nil, denied()
		}
		var revoked *time.Time
		e = tx.QueryRow(ctx, "SELECT revoked_at FROM consents WHERE id=$1 AND subject_id=$2 FOR UPDATE", id, a.SubjectID).Scan(&revoked)
		if errors.Is(e, pgx.ErrNoRows) {
			return nil, fault.New("not_found", 404)
		}
		if e != nil {
			return nil, e
		}
		if revoked == nil {
			if _, e = tx.Exec(ctx, "UPDATE consents SET revoked_at=$2 WHERE id=$1", id, time.Unix(s.now(), 0)); e != nil {
				return nil, e
			}
			if e = s.auditConsent(ctx, tx, a, id, "consent.revoke", httpID, auth); e != nil {
				return nil, e
			}
		}
		return map[string]string{"consentId": id, "status": "revoked"}, nil
	})
}
