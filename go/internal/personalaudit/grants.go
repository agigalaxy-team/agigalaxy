package personalaudit

import (
	"context"
	"crypto/ed25519"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"github.com/agigalaxy-team/agigalaxy/go/internal/deviceauth"
	"github.com/agigalaxy-team/agigalaxy/go/internal/identity"
	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
	"github.com/jackc/pgx/v5"
	"strings"
	"time"
	"unicode/utf8"
)

func verifyApproval(token, pub string) (string, error) {
	parts := strings.Split(token, ".")
	if len(parts) != 3 {
		return "", fail("invalid_audit_approval", 403)
	}
	head, e := base64.RawURLEncoding.DecodeString(parts[0])
	if e != nil {
		return "", fail("invalid_audit_approval", 403)
	}
	var h Object
	if json.Unmarshal(head, &h) != nil || len(h) != 2 || h["alg"] != "Ed25519" || h["typ"] != "galaxy-audit-approval+jws" {
		return "", fail("invalid_audit_approval", 403)
	}
	payload, e := base64.RawURLEncoding.DecodeString(parts[1])
	if e != nil || !utf8.Valid(payload) {
		return "", fail("invalid_audit_approval", 403)
	}
	signature, e := base64.RawURLEncoding.DecodeString(parts[2])
	if e != nil {
		return "", fail("invalid_audit_approval", 403)
	}
	block, _ := pem.Decode([]byte(pub))
	if block == nil {
		return "", fail("invalid_audit_approval", 403)
	}
	key, e := x509.ParsePKIXPublicKey(block.Bytes)
	if e != nil {
		return "", fail("invalid_audit_approval", 403)
	}
	ed, ok := key.(ed25519.PublicKey)
	if !ok || !ed25519.Verify(ed, []byte(parts[0]+"."+parts[1]), signature) {
		return "", fail("invalid_audit_approval", 403)
	}
	return string(payload), nil
}
func (s *Service) Approve(ctx context.Context, a Actor, signed string) (any, error) {
	if protocol.TextLength(signed) > 16384 {
		return nil, fail("invalid_audit_approval", 409)
	}
	return s.run(ctx, a, "audit-review", func(tx pgx.Tx, auth deviceauth.ControlAuthorization) (any, error) {
		if !has(s.ReviewerIDs, a.Device.SubjectID) {
			return nil, fail("audit_reviewer_denied", 403)
		}
		payload, e := verifyApproval(signed, auth.PublicKey)
		if e != nil {
			return nil, e
		}
		var g Object
		if e = protocol.Decode([]byte(payload), &g); e != nil {
			return nil, e
		}
		if _, e = parseGrant(g); e != nil {
			return nil, e
		}
		issued, _ := integer(g["issuedAt"])
		expires, _ := integer(g["expiresAt"])
		if str(g, "endpoint") != s.Endpoint || str(g, "reviewerId") != a.Device.SubjectID || str(g, "reviewerBindingId") != a.Device.BindingID || !has(s.ReaderIDs, str(g, "readerId")) || issued > s.now() || expires <= s.now() {
			return nil, fail("audit_approval_denied", 403)
		}
		var bindingExpiry time.Time
		if e = tx.QueryRow(ctx, "SELECT expires_at FROM bindings WHERE id=$1", a.Device.BindingID).Scan(&bindingExpiry); e != nil {
			return nil, e
		}
		if expires > bindingExpiry.Unix() {
			return nil, fail("audit_approval_denied", 403)
		}
		hash := identity.Digest([]byte(payload))
		prior, e := one(ctx, tx, "SELECT jsonb_build_object('payload_hash',payload_hash,'revoked_at',revoked_at) FROM audit_access_grants WHERE id=$1", g["id"])
		if e != nil {
			return nil, e
		}
		result := Object{"id": g["id"], "expiresAt": expires, "approved": true}
		if prior != nil {
			if str(prior, "payload_hash") != hash || prior["revoked_at"] != nil {
				return nil, fail("audit_grant_conflict", 409)
			}
			return result, nil
		}
		tag, e := tx.Exec(ctx, `INSERT INTO audit_access_grants(id,reviewer_id,reviewer_binding_id,reader_id,payload_text,payload_hash,signature,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(id) DO NOTHING`, g["id"], a.Device.SubjectID, g["reviewerBindingId"], g["readerId"], payload, hash, signed, time.Unix(expires, 0))
		if e != nil {
			return nil, e
		}
		if tag.RowsAffected() == 0 {
			prior, e = one(ctx, tx, "SELECT jsonb_build_object('payload_hash',payload_hash,'revoked_at',revoked_at) FROM audit_access_grants WHERE id=$1", g["id"])
			if e != nil {
				return nil, e
			}
			if prior == nil || str(prior, "payload_hash") != hash || prior["revoked_at"] != nil {
				return nil, fail("audit_grant_conflict", 409)
			}
			return result, nil
		}
		if e = s.record(ctx, tx, a, auth, "audit.grant", str(g, "id"), "audit-review"); e != nil {
			return nil, e
		}
		return result, nil
	})
}
func (s *Service) Revoke(ctx context.Context, a Actor, input Object) (any, error) {
	if !strict(input, "id") || len(input) != 1 || !id(input["id"]) {
		return nil, invalid()
	}
	return s.run(ctx, a, "audit-review", func(tx pgx.Tx, auth deviceauth.ControlAuthorization) (any, error) {
		r, e := one(ctx, tx, "SELECT jsonb_build_object('reviewer_id',reviewer_id,'revoked_at',revoked_at) FROM audit_access_grants WHERE id=$1 FOR UPDATE", input["id"])
		if e != nil {
			return nil, e
		}
		if r == nil || str(r, "reviewer_id") != a.Device.SubjectID {
			return nil, fail("not_found", 404)
		}
		if r["revoked_at"] == nil {
			if _, e = tx.Exec(ctx, "UPDATE audit_access_grants SET revoked_at=$2 WHERE id=$1", input["id"], time.Unix(s.now(), 0)); e != nil {
				return nil, e
			}
			if e = s.record(ctx, tx, a, auth, "audit.grant.revoke", str(input, "id"), "audit-review"); e != nil {
				return nil, e
			}
		}
		return Object{"id": input["id"], "revoked": true}, nil
	})
}
