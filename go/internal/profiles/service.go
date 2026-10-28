package profiles

import (
	"context"
	"errors"
	"fmt"
	"reflect"
	"time"

	"github.com/agigalaxy-team/agigalaxy/go/internal/deviceauth"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/identity"
	"github.com/agigalaxy-team/agigalaxy/go/internal/postgres"
	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

type Service struct {
	Pool     *pgxpool.Pool
	Endpoint string
	Devices  *deviceauth.Service
	Now      func() time.Time
}
type statementRow struct {
	ID, Subject, ConsentID, Payload, Hash string
	Revision                              int64
	Created                               time.Time
}

func (s *Service) now() int64 {
	if s.Now != nil {
		return s.Now().Unix()
	}
	return time.Now().Unix()
}
func latest(ctx context.Context, tx pgx.Tx, subject string) (*statementRow, error) {
	var r statementRow
	e := tx.QueryRow(ctx, `SELECT id::text,subject_id,revision,consent_id::text,payload_text,payload_hash,created_at FROM profile_statements WHERE subject_id=$1 ORDER BY revision DESC LIMIT 1`, subject).Scan(&r.ID, &r.Subject, &r.Revision, &r.ConsentID, &r.Payload, &r.Hash, &r.Created)
	if errors.Is(e, pgx.ErrNoRows) {
		return nil, nil
	}
	return &r, e
}
func (s *Service) authorize(ctx context.Context, tx pgx.Tx, a deviceauth.Actor) (deviceauth.ControlAuthorization, error) {
	if s.Devices == nil {
		return deviceauth.ControlAuthorization{}, fault.New("profile_service_unavailable", 503)
	}
	return s.Devices.CurrentControlWithin(ctx, tx, a, "history")
}
func (s *Service) grant(ctx context.Context, tx pgx.Tx, subject string, r statementRow) (deviceauth.ConsentIntent, error) {
	if s.Devices == nil {
		return deviceauth.ConsentIntent{}, fault.New("profile_service_unavailable", 503)
	}
	return s.Devices.RequireConsentWithin(ctx, tx, deviceauth.ConsentRequirement{ID: r.ConsentID, SubjectID: subject, Action: "profile.publish", ObjectID: r.ID, Recipient: s.Endpoint, PayloadJSON: r.Payload})
}
func receipt(id string, revision int64) Object {
	return Object{"id": id, "revision": revision, "classification": "self-declared", "capabilityVerified": false}
}
func (s *Service) Publish(ctx context.Context, a deviceauth.Actor, raw []byte, requestID string) (Object, error) {
	var input Object
	if protocol.Decode(raw, &input) != nil {
		return nil, invalid()
	}
	p, ok := shape(input, []string{"consentId", "payloadJson"}, nil)
	if !ok || !uuidPattern.MatchString(str(p, "consentId")) {
		return nil, invalid()
	}
	payload, ok := p["payloadJson"].(string)
	if !ok || protocol.TextLength(payload) > 12000 {
		return nil, invalid()
	}
	statement, e := ParseStatement([]byte(payload))
	if e != nil {
		return nil, e
	}
	if s.Pool == nil {
		return nil, fault.New("profile_service_unavailable", 503)
	}
	return postgres.InTx(ctx, s.Pool, func(tx pgx.Tx) (Object, error) {
		authorization, e := s.authorize(ctx, tx, a)
		if e != nil {
			return nil, e
		}
		r := statementRow{ID: statement.ID, Subject: a.SubjectID, ConsentID: str(p, "consentId"), Payload: payload, Hash: identity.Digest([]byte(payload))}
		grant, e := s.grant(ctx, tx, a.SubjectID, r)
		if e != nil {
			return nil, e
		}
		if grant.Visibility != "Private" && grant.Visibility != "Public" {
			return nil, fault.New("profile_visibility_unsupported", 403)
		}
		if sharing := statement.Sharing; sharing != nil {
			if sharing.Visibility != grant.Visibility || !reflect.DeepEqual(sharing.Viewers, grant.Viewers) || sharing.ExpiresAt != nil && *sharing.ExpiresAt <= s.now() {
				return nil, fault.New("profile_sharing_mismatch", 403)
			}
		}
		if _, e = tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended($1,734912307))`, a.SubjectID); e != nil {
			return nil, e
		}
		var owner, hash, consent string
		var revision int64
		e = tx.QueryRow(ctx, `SELECT subject_id,revision,payload_hash,consent_id::text FROM profile_statements WHERE id=$1`, statement.ID).Scan(&owner, &revision, &hash, &consent)
		if e == nil {
			if owner != a.SubjectID || hash != r.Hash || consent != r.ConsentID {
				return nil, fault.New("profile_statement_conflict", 409)
			}
			return receipt(statement.ID, revision), nil
		}
		if !errors.Is(e, pgx.ErrNoRows) {
			return nil, e
		}
		var prior int64
		e = tx.QueryRow(ctx, `SELECT revision FROM profile_statements WHERE subject_id=$1 ORDER BY revision DESC LIMIT 1`, a.SubjectID).Scan(&prior)
		if e != nil && !errors.Is(e, pgx.ErrNoRows) {
			return nil, e
		}
		if prior != statement.ExpectedRevision {
			return nil, fault.New("profile_revision_conflict", 409)
		}
		revision = prior + 1
		if _, e = tx.Exec(ctx, `INSERT INTO profile_statements(id,subject_id,revision,consent_id,payload_text,payload_hash) VALUES($1,$2,$3,$4,$5,$6)`, statement.ID, a.SubjectID, revision, r.ConsentID, payload, r.Hash); e != nil {
			return nil, e
		}
		var httpID any
		if requestID != "" {
			httpID = requestID
		}
		tag, e := tx.Exec(ctx, `INSERT INTO audit_events(actor,action,object_id,request_id,outcome,context_version,client_id,audience,scope,consent_id,binding_id,http_request_id,idempotency_key,binding_scopes,credential_scopes,caller_binding_id,caller_client_id,caller_audience,caller_binding_scopes)
  SELECT $1,'profile.publish',$2::text,$2::text,'accepted',1,ch.payload->>'installationId',b.audience,'history',c.id,b.id,$3,$2::text,b.scopes,$4::jsonb,cb.id,cch.payload->>'installationId',cb.audience,cb.scopes
  FROM consents c JOIN bindings b ON b.id=c.binding_id JOIN binding_challenges ch ON ch.id=b.challenge_id JOIN bindings cb ON cb.id=$5::uuid AND cb.subject_id=$1 JOIN binding_challenges cch ON cch.id=cb.challenge_id
  WHERE c.id=(SELECT consent_id FROM profile_statements WHERE id=$2::text::uuid AND subject_id=$1) AND c.subject_id=$1 AND b.subject_id=$1 AND NOT EXISTS(SELECT 1 FROM audit_events WHERE actor=$1 AND action='profile.publish' AND object_id=$2::text)`, a.SubjectID, statement.ID, httpID, string(encode(authorization.CredentialScopes)), a.BindingID)
		if e != nil {
			return nil, e
		}
		if tag.RowsAffected() != 1 {
			var exists bool
			e = tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM audit_events WHERE actor=$1 AND action='profile.publish' AND object_id=$2)`, a.SubjectID, statement.ID).Scan(&exists)
			if e != nil {
				return nil, e
			}
			if !exists {
				return nil, fmt.Errorf("profile audit context unavailable")
			}
		}
		return receipt(statement.ID, revision), nil
	})
}
func (s *Service) Receipt(ctx context.Context, a deviceauth.Actor, raw []byte) (Object, error) {
	var v Object
	if protocol.Decode(raw, &v) != nil {
		return nil, fault.New("invalid_profile_receipt", 400)
	}
	p, ok := shape(v, []string{"operationId", "payloadHash"}, nil)
	if !ok || !uuidPattern.MatchString(str(p, "operationId")) || !hashPattern.MatchString(str(p, "payloadHash")) {
		return nil, fault.New("invalid_profile_receipt", 400)
	}
	return postgres.InTx(ctx, s.Pool, func(tx pgx.Tx) (Object, error) {
		if _, e := s.authorize(ctx, tx, a); e != nil {
			return nil, e
		}
		result := Object{"state": "absent", "operationId": p["operationId"], "payloadHash": p["payloadHash"]}
		var revision int64
		var hash string
		e := tx.QueryRow(ctx, `SELECT revision,payload_hash FROM profile_statements WHERE id=$1 AND subject_id=$2`, p["operationId"], a.SubjectID).Scan(&revision, &hash)
		if errors.Is(e, pgx.ErrNoRows) {
			return result, nil
		}
		if e != nil {
			return nil, e
		}
		result["state"] = "conflict"
		if hash == p["payloadHash"] {
			result = receipt(str(p, "operationId"), revision)
			result["state"] = "acknowledged"
			result["operationId"] = p["operationId"]
			result["payloadHash"] = p["payloadHash"]
		}
		return result, nil
	})
}
func (s *Service) OwnerCurrent(ctx context.Context, a deviceauth.Actor) (Object, error) {
	return postgres.InTx(ctx, s.Pool, func(tx pgx.Tx) (Object, error) {
		if _, e := s.authorize(ctx, tx, a); e != nil {
			return nil, e
		}
		r, e := latest(ctx, tx, a.SubjectID)
		if e != nil {
			return nil, e
		}
		var erased bool
		if e = tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM deletion_requests WHERE subject_id=$1 AND state IN ('partial','primary-erased'))`, a.SubjectID).Scan(&erased); e != nil {
			return nil, e
		}
		revision := int64(0)
		if r != nil {
			revision = r.Revision
		}
		out := Object{"subjectId": a.SubjectID, "revision": revision, "selfDeclared": Object{}, "statement": nil, "sharing": nil, "readable": false, "checkedAt": s.now()}
		if r == nil || erased {
			return out, nil
		}
		statement, e := ParseStatement([]byte(r.Payload))
		if e != nil || statement.ID != r.ID || statement.ExpectedRevision+1 != r.Revision || identity.Digest([]byte(r.Payload)) != r.Hash {
			return nil, fmt.Errorf("profile source mismatch")
		}
		sharing, e := s.sharing(ctx, tx, a.SubjectID, *r)
		if e != nil {
			return nil, e
		}
		out["selfDeclared"] = statement.SelfDeclared
		out["statement"] = Object{"id": r.ID, "revision": r.Revision, "payloadHash": r.Hash}
		out["sharing"] = sharing
		out["readable"] = true
		return out, nil
	})
}
