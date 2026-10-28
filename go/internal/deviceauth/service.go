package deviceauth

import (
	"context"
	"encoding/base64"
	"errors"
	"regexp"
	"time"

	"github.com/agigalaxy-team/agigalaxy/go/internal/failureaudit"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/httpboundary"
	"github.com/agigalaxy-team/agigalaxy/go/internal/identity"
	"github.com/agigalaxy-team/agigalaxy/go/internal/postgres"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
)

type SQLReader interface {
	QueryRow(context.Context, string, ...any) pgx.Row
}
type Service struct {
	oauthResourceAccess   *OAuthResourceAccess
	Pool                  *pgxpool.Pool
	Endpoint              string
	Signer                SessionSigner
	Now                   func() time.Time
	AllowedScopes         []string
	BindingGate           func(context.Context, SQLReader, string) error
	ConsentPolicy         func(context.Context, ConsentIntent, Actor) error
	ReceiptStatusDeadline func() (int64, error)
}
type ChallengeInput struct {
	BindingID      string `json:"bindingId"`
	CredentialHash string `json:"credentialHash"`
}
type ActivateInput struct {
	Challenge string `json:"challenge"`
	Signature string `json:"signature"`
}
type Result struct {
	BindingID string   `json:"bindingId"`
	ExpiresAt int64    `json:"expiresAt"`
	Scopes    []string `json:"scopes"`
}
type Authentication struct {
	Profile          string   `json:"profile,omitempty"`
	Endpoint         string   `json:"endpoint,omitempty"`
	Version          int      `json:"version"`
	ClientID         string   `json:"clientId"`
	Audience         string   `json:"audience"`
	Scope            string   `json:"scope"`
	BindingScopes    []string `json:"bindingScopes"`
	CredentialScopes []string `json:"credentialScopes"`
}
type Actor struct {
	oauthResourceAuthority    *oauthResourceProof
	informationWatchAuthority *informationWatchAuthority
	SubjectID                 string         `json:"subjectId"`
	BindingID                 string         `json:"bindingId"`
	Scopes                    []string       `json:"scopes"`
	CredentialHash            string         `json:"-"`
	DeviceID                  *string        `json:"deviceId"`
	KeyID                     *string        `json:"keyId"`
	ControlEpoch              int64          `json:"controlEpoch"`
	Authentication            Authentication `json:"authentication"`
}

var bindingPattern = regexp.MustCompile(`^[0-9a-f-]{36}$`)
var hashPattern = regexp.MustCompile(`^[0-9a-f]{64}$`)

func (s *Service) now() int64 {
	if s.Now != nil {
		return s.Now().Unix()
	}
	return time.Now().Unix()
}
func (s *Service) Challenge(ctx context.Context, input ChallengeInput) (map[string]string, error) {
	if !bindingPattern.MatchString(input.BindingID) || !hashPattern.MatchString(input.CredentialHash) {
		return nil, fault.New("invalid_request", 400)
	}
	var scopes []string
	var expiry time.Time
	var revoked *time.Time
	e := s.Pool.QueryRow(ctx, "SELECT scopes,expires_at,revoked_at FROM bindings WHERE id=$1", input.BindingID).Scan(&scopes, &expiry, &revoked)
	if errors.Is(e, pgx.ErrNoRows) || e == nil && (revoked != nil || expiry.Unix() <= s.now()) {
		return nil, denied()
	}
	if e != nil {
		return nil, e
	}
	if s.Signer == nil {
		return nil, fault.New("signing_unavailable", 503)
	}
	at := s.now()
	id := uuid.NewString()
	token, e := s.Signer.Sign(ctx, Challenge{input.BindingID, input.CredentialHash, "session", scopes, min(at+600, expiry.Unix())}, id, at)
	if e != nil {
		return nil, e
	}
	_, e = s.Pool.Exec(ctx, "INSERT INTO session_challenges(id,binding_id,challenge_hash,credential_hash,expires_at) VALUES($1,$2,$3,$4,$5)", id, input.BindingID, identity.Digest([]byte(token)), input.CredentialHash, time.Unix(at+120, 0))
	var pgerr *pgconn.PgError
	if errors.As(e, &pgerr) && pgerr.Code == "23505" {
		return nil, fault.New("credential_conflict", 409)
	}
	if e != nil {
		return nil, e
	}
	return map[string]string{"challenge": token}, nil
}
func (s *Service) Activate(ctx context.Context, input ActivateInput, httpRequestID *string) (Result, error) {
	if len(input.Challenge) > 16384 || len(input.Signature) > 24000 {
		return Result{}, fault.New("invalid_request", 400)
	}
	if s.Signer == nil {
		return Result{}, denied()
	}
	opened, e := s.Signer.Verify(ctx, input.Challenge, s.now())
	if e != nil {
		return Result{}, denied()
	}
	return postgres.InTx(ctx, s.Pool, func(tx pgx.Tx) (Result, error) {
		b, e := lockedBinding(ctx, tx, opened.Data.BindingID)
		if e != nil {
			return Result{}, e
		}
		if b.Revoked != nil || b.Expires.Unix() <= s.now() {
			return Result{}, denied()
		}
		if e = VerifyResponse(input.Signature, input.Challenge, b.Control.PublicKey); e != nil {
			return Result{}, e
		}
		var id, hash, bindingID, credential string
		var expiry time.Time
		var consumed *time.Time
		e = tx.QueryRow(ctx, "SELECT id::text,challenge_hash,binding_id::text,credential_hash,expires_at,consumed_at FROM session_challenges WHERE id=$1 FOR UPDATE", opened.ID).Scan(&id, &hash, &bindingID, &credential, &expiry, &consumed)
		if errors.Is(e, pgx.ErrNoRows) || e == nil && (hash != identity.Digest([]byte(input.Challenge)) || bindingID != b.ID || expiry.Unix() <= s.now()) {
			return Result{}, denied()
		}
		if e != nil {
			return Result{}, e
		}
		if consumed == nil {
			if _, e = tx.Exec(ctx, `INSERT INTO access_credentials(token_hash,binding_id,scopes,expires_at,device_id,key_id,control_epoch) SELECT $1,id,$3,$4,device_id,key_id,control_epoch FROM bindings WHERE id=$2`, credential, b.ID, opened.Data.Scopes, time.Unix(opened.Data.CredentialExpiresAt, 0)); e != nil {
				return Result{}, e
			}
			if _, e = tx.Exec(ctx, "UPDATE session_challenges SET consumed_at=$2 WHERE id=$1", id, time.Unix(s.now(), 0)); e != nil {
				return Result{}, e
			}
			if e = auditSession(ctx, tx, b.Subject, b.ID, id, httpRequestID); e != nil {
				return Result{}, e
			}
		}
		return Result{b.ID, opened.Data.CredentialExpiresAt, opened.Data.Scopes}, nil
	})
}
func auditSession(ctx context.Context, tx pgx.Tx, subject, bindingID, id string, httpID *string) error {
	result, e := tx.Exec(ctx, `INSERT INTO audit_events(actor,action,object_id,request_id,outcome,context_version,client_id,audience,scope,consent_id,binding_id,http_request_id,idempotency_key,binding_scopes,credential_scopes,caller_binding_id,caller_client_id,caller_audience,caller_binding_scopes)
 SELECT $1,'session.create',b.id::text,$3,'accepted',1,ch.payload->>'installationId',b.audience,'binding',NULL,b.id,$4,$3,b.scopes,ac.scopes,b.id,ch.payload->>'installationId',b.audience,b.scopes
 FROM bindings b JOIN binding_challenges ch ON ch.id=b.challenge_id JOIN session_challenges sc ON sc.id=$3::uuid AND sc.binding_id=b.id JOIN access_credentials ac ON ac.token_hash=sc.credential_hash AND ac.binding_id=b.id WHERE b.id=$2 AND b.subject_id=$1`, subject, bindingID, id, httpID)
	if e != nil {
		return e
	}
	if result.RowsAffected() != 1 {
		return errors.New("audit_context_unavailable")
	}
	return nil
}
func (s *Service) Authenticate(ctx context.Context, token, scope string) (Actor, error) {
	b, e := base64.RawURLEncoding.Strict().DecodeString(token)
	if e != nil || len(token) != 43 || len(b) != 32 {
		return Actor{}, denied()
	}
	if scope == "" {
		scope = "binding"
	}
	hash := identity.Digest([]byte(token))
	return postgres.InTx(ctx, s.Pool, func(tx pgx.Tx) (Actor, error) {
		var row binding
		e := tx.QueryRow(ctx, `SELECT b.subject_id,b.id::text,b.audience,b.device_id::text,b.key_id,b.control_epoch,c.scopes,b.scopes,ch.payload->>'installationId' FROM access_credentials c JOIN bindings b ON b.id=c.binding_id JOIN binding_challenges ch ON ch.id=b.challenge_id WHERE c.token_hash=$1 AND c.revoked_at IS NULL AND b.revoked_at IS NULL AND c.expires_at>$2 AND b.expires_at>$2 AND c.control_epoch IS NOT DISTINCT FROM b.control_epoch AND c.device_id IS NOT DISTINCT FROM b.device_id`, hash, time.Unix(s.now(), 0)).Scan(&row.Subject, &row.ID, &row.Audience, &row.DeviceID, &row.KeyID, &row.Epoch, &row.Scopes, &row.BindingScopes, &row.ClientID)
		if errors.Is(e, pgx.ErrNoRows) {
			return Actor{}, denied()
		}
		if e != nil {
			return Actor{}, e
		}
		row, e = applyControl(ctx, tx, row)
		if e != nil {
			return Actor{}, e
		}
		if row.Audience != s.Endpoint || !contains(row.Scopes, scope) {
			return Actor{}, denied()
		}
		failureaudit.CaptureActor(ctx, failureaudit.Actor{SubjectID: row.Subject, BindingID: row.ID,
			Authentication: &failureaudit.Authentication{Version: 1, ClientID: row.ClientID, Audience: row.Audience, Scope: scope, BindingScopes: row.BindingScopes, CredentialScopes: row.Scopes}})
		if e := httpboundary.CaptureAuthenticated(ctx, row.Subject, token); e != nil {
			return Actor{}, e
		}
		c := row.Control
		key := c.KeyID
		return Actor{SubjectID: row.Subject, BindingID: row.ID, Scopes: row.Scopes, CredentialHash: hash, DeviceID: c.DeviceID, KeyID: &key, ControlEpoch: c.Epoch, Authentication: Authentication{Version: 1, ClientID: row.ClientID, Audience: row.Audience, Scope: scope, BindingScopes: row.BindingScopes, CredentialScopes: append([]string(nil), row.Scopes...)}}, nil
	})
}

// AuthorizeWithin is called in the real business transaction. Subject control,
// binding and credential locks fence recovery and revocation through commit.
func (s *Service) AuthorizeWithin(ctx context.Context, tx pgx.Tx, a Actor, scope string) error {
	row, e := s.authorizationWithin(ctx, tx, a)
	if e != nil {
		return e
	}
	if !contains(row.Scopes, scope) {
		return denied()
	}
	if a.oauthResourceAuthority != nil {
		return s.recordOAuthAccessWithin(ctx, tx, a, row, scope)
	}
	return nil
}
func (s *Service) authorizationWithin(ctx context.Context, tx pgx.Tx, a Actor) (binding, error) {
	if a.oauthResourceAuthority != nil {
		return s.oauthAuthorizationWithin(ctx, tx, a)
	}
	if a.informationWatchAuthority != nil {
		return s.watchAuthorizationWithin(ctx, tx, a)
	}
	var row binding
	if !hashPattern.MatchString(a.CredentialHash) {
		return row, denied()
	}
	if _, e := lockSubject(ctx, tx, a.SubjectID); e != nil {
		return row, e
	}
	e := tx.QueryRow(ctx, `SELECT b.subject_id,b.id::text,b.device_id::text,b.key_id,b.control_epoch,c.scopes,b.scopes FROM bindings b JOIN access_credentials c ON c.binding_id=b.id WHERE b.id=$1 AND b.subject_id=$2 AND c.token_hash=$3 AND b.audience=$4 AND b.revoked_at IS NULL AND c.revoked_at IS NULL AND b.expires_at>$5 AND c.expires_at>$5 AND c.control_epoch IS NOT DISTINCT FROM b.control_epoch AND c.device_id IS NOT DISTINCT FROM b.device_id FOR SHARE OF b,c`, a.BindingID, a.SubjectID, a.CredentialHash, s.Endpoint, time.Unix(s.now(), 0)).Scan(&row.Subject, &row.ID, &row.DeviceID, &row.KeyID, &row.Epoch, &row.Scopes, &row.BindingScopes)
	if errors.Is(e, pgx.ErrNoRows) {
		return row, denied()
	}
	if e != nil {
		return row, e
	}
	return applyControl(ctx, tx, row)
}
