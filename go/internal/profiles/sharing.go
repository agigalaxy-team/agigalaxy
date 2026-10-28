package profiles

import (
	"context"
	"crypto/ed25519"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"errors"
	"reflect"
	"sort"
	"strings"
	"time"

	"github.com/agigalaxy-team/agigalaxy/go/internal/deviceauth"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/identity"
	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
	"github.com/jackc/pgx/v5"
)

type consentRow struct {
	Intent                   deviceauth.ConsentIntent
	RawIntent                []byte
	BindingID, SignatureHash string
	Envelope, Payload        *string
	Revoked, BindingRevoked  *time.Time
	Expires, BindingExpires  time.Time
}

func loadConsent(ctx context.Context, tx pgx.Tx, subject, id string, lock bool) (*consentRow, error) {
	query := `SELECT c.intent,c.binding_id::text,c.signature_hash,c.signature_envelope,c.signed_payload_text,c.revoked_at,b.revoked_at,c.expires_at,b.expires_at FROM consents c JOIN bindings b ON b.id=c.binding_id WHERE c.id=$1 AND c.subject_id=$2`
	if lock {
		query += " FOR SHARE OF c,b"
	}
	var r consentRow
	e := tx.QueryRow(ctx, query, id, subject).Scan(&r.RawIntent, &r.BindingID, &r.SignatureHash, &r.Envelope, &r.Payload, &r.Revoked, &r.BindingRevoked, &r.Expires, &r.BindingExpires)
	if errors.Is(e, pgx.ErrNoRows) {
		return nil, nil
	}
	if e != nil {
		return nil, e
	}
	if json.Unmarshal(r.RawIntent, &r.Intent) != nil {
		return nil, fault.New("consent_required", 403)
	}
	return &r, nil
}
func canonicalEqual(a, b any) bool {
	x, e := identity.Canonical(a)
	if e != nil {
		return false
	}
	y, e := identity.Canonical(b)
	return e == nil && string(x) == string(y)
}
func verifySignature(envelope, payload, public string) bool {
	parts := strings.Split(envelope, ".")
	if len(parts) != 3 {
		return false
	}
	decoded := make([][]byte, 3)
	for i, p := range parts {
		b, e := base64.RawURLEncoding.DecodeString(p)
		if e != nil || base64.RawURLEncoding.EncodeToString(b) != p {
			return false
		}
		decoded[i] = b
	}
	var h Object
	if protocol.Decode(decoded[0], &h) != nil || len(h) != 2 || h["alg"] != "Ed25519" || h["typ"] != "galaxy-consent+jws" || string(decoded[1]) != payload {
		return false
	}
	block, rest := pem.Decode([]byte(public))
	if block == nil || block.Type != "PUBLIC KEY" || len(strings.TrimSpace(string(rest))) > 0 {
		return false
	}
	parsed, e := x509.ParsePKIXPublicKey(block.Bytes)
	if e != nil {
		return false
	}
	key, ok := parsed.(ed25519.PublicKey)
	return ok && ed25519.Verify(key, []byte(parts[0]+"."+parts[1]), decoded[2])
}

type readGrant struct {
	Intent    deviceauth.ConsentIntent
	Unlimited bool
}

func (s *Service) durable(ctx context.Context, tx pgx.Tx, subject string, r statementRow) (readGrant, error) {
	var out readGrant
	if s.Devices == nil {
		return out, fault.New("profile_service_unavailable", 503)
	}
	var device, key *string
	var epoch int64
	e := tx.QueryRow(ctx, `SELECT b.device_id::text,COALESCE(c.signer_key_id,b.key_id),COALESCE(c.control_epoch,b.control_epoch,0) FROM consents c JOIN bindings b ON b.id=c.binding_id WHERE c.id=$1 AND c.subject_id=$2`, r.ConsentID, subject).Scan(&device, &key, &epoch)
	if errors.Is(e, pgx.ErrNoRows) {
		return out, fault.New("consent_required", 403)
	}
	if e != nil {
		return out, e
	}
	control, e := s.Devices.CurrentSignerWithin(ctx, tx, subject, device, key, epoch, "consent")
	if e != nil {
		return out, e
	}
	c, e := loadConsent(ctx, tx, subject, r.ConsentID, true)
	if e != nil {
		return out, e
	}
	if c == nil {
		return out, fault.New("consent_required", 403)
	}
	intent := c.Intent
	if c.Revoked != nil || c.BindingRevoked != nil || intent.SubjectID != subject || intent.BindingID != c.BindingID || intent.Endpoint != s.Endpoint || intent.Recipient != s.Endpoint || intent.Action != "profile.publish" || intent.ObjectID != r.ID || intent.PayloadHash != r.Hash || identity.Digest([]byte(r.Payload)) != r.Hash || c.Envelope == nil || c.Payload == nil || *c.Envelope == "" || *c.Payload == "" || identity.Digest([]byte(*c.Envelope)) != c.SignatureHash {
		return out, fault.New("consent_required", 403)
	}
	p, e := ParseStatement([]byte(r.Payload))
	if e != nil {
		return out, e
	}
	fields := append([]string(nil), intent.Fields...)
	sort.Strings(fields)
	expected := []string{"expectedRevision", "id", "selfDeclared", "sharing"}
	if p.Sharing == nil || p.ID != r.ID || p.ExpectedRevision+1 != r.Revision || !reflect.DeepEqual(fields, expected) || p.Sharing.Visibility != intent.Visibility || !reflect.DeepEqual(p.Sharing.Viewers, intent.Viewers) || intent.Visibility == "Public" && intent.Purpose != "public-profile" {
		return out, fault.New("profile_sharing_mismatch", 403)
	}
	var signed, stored Object
	if protocol.Decode([]byte(*c.Payload), &signed) != nil || protocol.Decode(c.RawIntent, &stored) != nil || !verifySignature(*c.Envelope, *c.Payload, control.PublicKey) || !canonicalEqual(signed, stored) {
		return out, fault.New("profile_signature_unavailable", 403)
	}
	var pending bool
	if e = tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM deletion_requests WHERE subject_id=$1 AND state IN ('requested','review-needed','approved','partial','primary-erased'))`, subject).Scan(&pending); e != nil {
		return out, e
	}
	if pending {
		return out, fault.New("profile_content_unavailable", 403)
	}
	out.Intent = intent
	if p.Sharing.ExpiresAt == nil {
		out.Unlimited = true
	} else {
		out.Intent.ExpiresAt = *p.Sharing.ExpiresAt
		if out.Intent.ExpiresAt <= s.now() {
			return readGrant{}, fault.New("profile_sharing_expired", 403)
		}
	}
	return out, nil
}
func (s *Service) sharing(ctx context.Context, tx pgx.Tx, subject string, r statementRow) (Object, error) {
	c, e := loadConsent(ctx, tx, subject, r.ConsentID, false)
	if e != nil {
		return nil, e
	}
	if c == nil {
		return nil, nil
	}
	intent := c.Intent
	if intent.Action != "profile.publish" || intent.ObjectID != r.ID || intent.Recipient != s.Endpoint || intent.PayloadHash != r.Hash || intent.Visibility != "Private" && intent.Visibility != "Public" {
		return nil, nil
	}
	p, e := ParseStatement([]byte(r.Payload))
	if e != nil {
		return nil, e
	}
	var expires any
	var expiry *float64
	visibility := intent.Visibility
	viewers := intent.Viewers
	mode := "legacy-consent"
	if p.Sharing != nil {
		mode = "declared-sharing"
		visibility = p.Sharing.Visibility
		viewers = p.Sharing.Viewers
		if p.Sharing.ExpiresAt != nil {
			n := float64(*p.Sharing.ExpiresAt)
			expiry = &n
			expires = *p.Sharing.ExpiresAt
		}
	}
	if p.Sharing == nil {
		n := float64(c.Expires.UnixMilli()) / 1000
		b := float64(c.BindingExpires.UnixMilli()) / 1000
		if b < n {
			n = b
		}
		expiry = &n
		expires = n
	}
	status := "active"
	if c.Revoked != nil || c.BindingRevoked != nil {
		status = "revoked"
	} else if expiry != nil && *expiry <= float64(s.now()) {
		status = "expired"
	}
	if p.Sharing != nil && status == "active" {
		if _, e = s.durable(ctx, tx, subject, r); e != nil {
			if fault.Code(e) == "internal_error" {
				return nil, e
			}
			status = "revoked"
			if fault.Code(e) == "profile_sharing_expired" {
				status = "expired"
			}
		}
	}
	readUntil := float64(s.now() + 60)
	if expiry != nil && *expiry < readUntil {
		readUntil = *expiry
	}
	return Object{"visibility": visibility, "viewers": viewers, "expiresAt": expires, "readExpiresAt": readUntil, "status": status, "authorizationExpiresAt": intent.ExpiresAt, "bindingExpiresAt": c.BindingExpires.Unix(), "mode": mode}, nil
}
func (s *Service) canRead(g readGrant, viewer string) bool {
	v := g.Intent
	if v.IssuedAt > s.now() || !g.Unlimited && v.ExpiresAt <= s.now() {
		return false
	}
	if viewer == v.SubjectID {
		return true
	}
	if v.CurrentVisibility != nil && v.CurrentVisibility.DeletionPending {
		return false
	}
	switch v.Visibility {
	case "Public":
		return v.Purpose == "public-profile"
	case "Private":
		if viewer != "" {
			for _, id := range v.Viewers {
				if id == viewer {
					return true
				}
			}
		}
	}
	return false
}

// ReadWithin reads only the latest declaration under current source authority.
// A nil viewer is anonymous. An ID viewer must retain current history scope in
// this same transaction; an online account cannot stand in for that ID.
func (s *Service) ReadWithin(ctx context.Context, tx pgx.Tx, viewer *deviceauth.Actor, subject string) (Object, error) {
	who := ""
	if viewer != nil {
		if _, e := s.authorize(ctx, tx, *viewer); e != nil {
			return nil, e
		}
		who = viewer.SubjectID
	}
	return s.readForSubjectWithin(ctx, tx, who, subject)
}

// ReadForContactWithin is the original internal contact-discovery projection.
// Its owning consumer must first prove the initiator from the signed contact
// context in this transaction. No HTTP input may select this viewer identity.
func (s *Service) ReadForContactWithin(ctx context.Context, tx pgx.Tx, viewerSubjectID, subject string) (Object, error) {
	return s.readForSubjectWithin(ctx, tx, viewerSubjectID, subject)
}
func (s *Service) readForSubjectWithin(ctx context.Context, tx pgx.Tx, who, subject string) (Object, error) {
	r, e := latest(ctx, tx, subject)
	if e != nil {
		return nil, e
	}
	var sharing Object
	if r != nil {
		sharing, e = s.sharing(ctx, tx, subject, *r)
		if e != nil {
			return nil, e
		}
	}
	out := Object{"selfDeclared": Object{}}
	if who == subject {
		revision := int64(0)
		var statement any
		if r != nil {
			revision = r.Revision
			statement = Object{"id": r.ID, "revision": r.Revision, "payloadHash": r.Hash}
		}
		out["selfDeclaredRevision"] = revision
		out["selfDeclaredSharing"] = sharing
		out["selfDeclaredStatement"] = statement
	}
	if r == nil {
		return out, nil
	}
	statement, e := ParseStatement([]byte(r.Payload))
	if e != nil {
		return nil, e
	}
	var grant readGrant
	if statement.Sharing != nil {
		grant, e = s.durable(ctx, tx, subject, *r)
	} else {
		grant.Intent, e = s.grant(ctx, tx, subject, *r)
	}
	if e != nil {
		switch fault.Status(e) {
		case 401, 403, 404, 409:
			return out, nil
		}
		return nil, e
	}
	if !s.canRead(grant, who) {
		return out, nil
	}
	if statement.ID != r.ID || statement.ExpectedRevision+1 != r.Revision {
		return nil, errors.New("profile source mismatch")
	}
	out["selfDeclared"] = statement.SelfDeclared
	if sharing != nil {
		out["selfDeclaredReadExpiresAt"] = sharing["readExpiresAt"]
	}
	out["selfDeclaredSource"] = Object{"id": r.ID, "classification": "self-declared", "capabilityVerified": false}
	return out, nil
}
